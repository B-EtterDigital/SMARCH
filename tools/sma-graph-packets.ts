#!/usr/bin/env node
/**
 * WHAT: Lists, inspects, and claims bounded graph-repair work packets.
 * WHY: Agents need targeted graph gaps without loading the full controller state.
 * HOW: Reads generated ranked packets, checks freshness and leases, and delegates safe claims.
 * INPUTS: A list, show, or claim command with project, rank, freshness, and lease options.
 * OUTPUTS: Packet summaries, claim instructions, or a lease-backed claim receipt.
 * CALLERS: Graph repair agents and controllers dispatching missing or stale graph work.
 * Usage: `node tools/sma-graph-packets.ts list --project sma --limit 1 --no-auto-refresh`
 */
/**
 * sma-graph-packets.ts — low-token dispatch surface for graph repair work.
 *
 * Reads handoffs/graph-packets.generated.json and lets agents list, inspect,
 * or claim one ranked project/module graph gap without printing broad status.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, exit } from 'node:process';
import { spawnSync } from 'node:child_process';
import { readActiveLeases } from './lib/gen3-state.ts';
import {
  assertFreshPacketReport,
  formatPacketFreshness,
  maxAgeSeconds,
  packetLeaseFingerprint,
  packetFreshness,
} from './lib/packet-freshness.ts';

type GraphPacketArgs = {
  help?: boolean;
  json?: boolean;
  ttl?: string | boolean;
  dryRun?: boolean;
  allowStale?: boolean;
  noAutoRefresh?: boolean;
  packetFile?: string;
  project?: string | boolean;
  maxAgeSeconds?: string | boolean;
  availableOnly?: boolean;
  limit?: string | boolean;
  next?: boolean;
  rank?: string | boolean;
  [key: string]: string | boolean | undefined;
};

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PACKET_FILE = resolve(SMA_ROOT, 'handoffs/graph-packets.generated.json');
const START_EDIT = resolve(SMA_ROOT, 'tools/sma-start-edit.ts');

const command = argv[2] || 'list';
const args = parseArgs(argv.slice(3));

try {
  if (args.help || command === 'help' || command === '--help' || command === '-h') {
    usage();
    exit(0);
  }
  if (command === 'list') exit(runList());
  if (command === 'show') exit(runShow());
  if (command === 'claim') exit(runClaim());
  throw new Error(`unknown command: ${command}`);
} catch (err) {
  console.error(`sma-graph-packets: ${err.message}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-graph-packets.ts list [--project <id>] [--limit 12] [--available-only] [--json]
                             [--allow-stale] [--no-auto-refresh]
  sma-graph-packets.ts show [--project <id>] (--rank <n>|--next) [--json]
                             [--allow-stale] [--no-auto-refresh]
  sma-graph-packets.ts claim [--project <id>] (--rank <n>|--next) [--ttl 1200] [--json] [--dry-run]
                            [--max-age-seconds 900] [--allow-stale] [--no-auto-refresh]

Reads ${relativeToSma(DEFAULT_PACKET_FILE)} by default.
Use --packet-file <path> to read a different generated packet file.
`);
}

function runList() {
  const { report: decorated, autoRefreshed } = decoratedPacketReportWithOptionalRefresh();
  const packets = limitedPackets(decorated);
  if (args.json) {
    console.log(JSON.stringify({
      generated_at: decorated.generated_at,
      summary: decorated.summary,
      freshness: decorated.freshness,
      auto_refreshed: autoRefreshed,
      packets,
    }, null, 2));
    return 0;
  }

  if (autoRefreshed) {
    console.log('auto-refreshed stale graph packets before listing');
  }
  console.log(`graph packets: ${decorated.summary?.packet_count ?? packets.length}, module gaps ${decorated.summary?.module_graph_gap_count ?? 0}, project gaps ${decorated.summary?.project_graph_gaps ?? 0}`);
  console.log(`packet file: ${formatPacketFreshness(decorated.freshness)}`);
  if (decorated.freshness.stale) {
    console.log('refresh: npm run controller:sweep:write');
  } else if (Number(decorated.summary?.stale_packet_count || 0) > 0) {
    console.log(`stale packets: ${decorated.summary.stale_packet_count}; fresh packets can still be claimed, refresh before stale ranks`);
  }
  for (const packet of packets) {
    const held = packet.held ? ` [held by ${packet.held_by}, ttl ${packet.held_ttl_seconds}s]` : '';
    const stale = packet.packet_stale ? ' [stale]' : '';
    const impact = graphPacketImpact(packet);
    console.log(`${packet.rank}. ${packet.project} ${packet.kind} (${impact})${held}${stale}`);
    console.log(`   claim: npm run graph:claim -- --rank ${packet.rank}`);
  }
  if (Number(decorated.summary?.packet_count || 0) > packets.length) {
    console.log(`... ${Number(decorated.summary.packet_count) - packets.length} more hidden; rerun with --limit ${decorated.summary.packet_count}`);
  }
  return 0;
}

function runShow() {
  const { report, autoRefreshed } = packetReportWithOptionalRefresh();
  const packet = selectPacket(report);
  const freshness = packet.report_freshness?.stale
    ? packet.report_freshness
    : packet.packet_freshness || packetFreshness(report, { maxAge: maxPacketAgeSeconds() });
  if (args.json) {
    console.log(JSON.stringify({ freshness, auto_refreshed: autoRefreshed, packet }, null, 2));
    return 0;
  }

  if (autoRefreshed) {
    console.log('auto-refreshed stale graph packets before showing');
  }
  console.log(`#${packet.rank} ${packet.project} ${packet.kind}`);
  console.log(`packet file: ${formatPacketFreshness(freshness)}`);
  console.log(`brick: ${packet.brick}`);
  if (packet.repair_kind) console.log(`repair kind: ${packet.repair_kind}`);
  if (packet.module_graph_gap_count) console.log(`module gaps: ${packet.module_graph_gap_count}`);
  if (packet.missing_target_count) console.log(`missing targets: ${packet.missing_target_count}`);
  if (packet.detail) console.log(`detail: ${packet.detail}`);
  for (const fix of packet.target_fixes || []) {
    console.log(`target fix: ${fix.source_path || fix.module_id || 'unknown source'}`);
    for (const candidate of fix.candidates || []) {
      if (candidate.path) console.log(`  candidate: ${candidate.path} (${candidate.reason || 'candidate'}; score ${candidate.score ?? 0})`);
    }
  }
  console.log(`claim: ${packet.claim_packet_command || `npm run graph:claim -- --rank ${packet.rank}`}`);
  console.log(`fallback claim: ${packet.claim_command}`);
  console.log(`repair: ${packet.repair_command}`);
  console.log(`verify: ${packet.verify_command}`);
  console.log(`inspect: ${packet.inspect_command}`);
  console.log(`finish: ${packet.finish_rule}`);
  return 0;
}

function runClaim() {
  const { packet, freshness, autoRefreshed } = claimSelectionWithOptionalRefresh();
  const intent = packet.claim_intent || `repair ${packet.kind} for ${packet.project}`;
  const startArgs = [
    START_EDIT,
    '--project', packet.project,
    '--brick', packet.brick,
    '--intent', intent,
    '--ttl', String(args.ttl ?? 1200),
  ];
  if (args.json) startArgs.push('--json');

  if (args.dryRun) {
    const dry = {
      packet_rank: packet.rank,
      project: packet.project,
      kind: packet.kind,
      brick: packet.brick,
      repair_command: packet.repair_command,
      verify_command: packet.verify_command,
      repair_kind: packet.repair_kind || null,
      target_fixes: packet.target_fixes || [],
      freshness,
      auto_refreshed: autoRefreshed,
      command: ['node', ...startArgs].map(shellArg).join(' '),
    };
    console.log(args.json ? JSON.stringify(dry, null, 2) : dry.command);
    return 0;
  }

  if (autoRefreshed && !args.json) {
    console.log('auto-refreshed stale graph packets before claiming');
  }
  console.log(`claiming graph packet #${packet.rank}: ${packet.project} ${packet.kind}`);
  const result = spawnSync(process.execPath, startArgs, {
    cwd: SMA_ROOT,
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

function claimSelectionWithOptionalRefresh() {
  try {
    return { ...claimSelection(), autoRefreshed: false };
  } catch (err) {
    if (!shouldAutoRefreshClaim(err)) throw err;
    refreshControllerPackets('graph');
    return { ...claimSelection(), autoRefreshed: true };
  }
}

function claimSelection() {
  const report = readPacketReport();
  assertFreshPacketReport(report, {
    allowStale: Boolean(args.allowStale),
    currentLeaseFingerprint: currentLeaseFingerprint(),
    expectedLeaseFingerprint: report.lease_fingerprint || null,
    label: 'graph',
    maxAge: maxPacketAgeSeconds(),
    refreshCommand: 'npm run controller:sweep:write',
  });
  const packet = selectPacket(report);
  const freshness = assertFreshPacketReport(report, {
    allowStale: Boolean(args.allowStale),
    currentLeaseFingerprint: currentLeaseFingerprint(packet.project),
    expectedLeaseFingerprint: packet.lease_fingerprint || report.lease_fingerprint || null,
    label: 'graph',
    maxAge: maxPacketAgeSeconds(),
    refreshCommand: 'npm run controller:sweep:write',
  });
  return { packet, freshness };
}

function shouldAutoRefreshClaim(err) {
  if (args.dryRun || args.allowStale || args.noAutoRefresh || args.packetFile) return false;
  return /stale|no available fresh|packet file not found/i.test(String(err?.message || ''));
}

function packetReportWithOptionalRefresh() {
  let report = readPacketReport();
  const freshness = packetFreshness(report, {
    currentLeaseFingerprint: currentLeaseFingerprint(),
    expectedLeaseFingerprint: report.lease_fingerprint || null,
    maxAge: maxPacketAgeSeconds(),
  });
  if (!shouldAutoRefreshDisplay(freshness)) {
    return { report, autoRefreshed: false };
  }
  refreshControllerPackets('graph');
  report = readPacketReport();
  return { report, autoRefreshed: true };
}

function decoratedPacketReportWithOptionalRefresh() {
  let report = readPacketReport();
  let decorated = decoratePacketReport(report);
  if (!shouldAutoRefreshDisplay(decorated.freshness)) {
    return { report: decorated, autoRefreshed: false };
  }
  refreshControllerPackets('graph');
  report = readPacketReport();
  decorated = decoratePacketReport(report);
  return { report: decorated, autoRefreshed: true };
}

function shouldAutoRefreshDisplay(freshness) {
  if (args.allowStale || args.noAutoRefresh || args.packetFile) return false;
  return Boolean(freshness?.stale);
}

function refreshControllerPackets(label) {
  const maxAttempts = 30;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!args.json) {
      const suffix = attempt === 1 ? 'refreshing controller sweep once' : `waiting for controller refresh lease (${attempt}/${maxAttempts})`;
      console.error(`${label}: packet handoff is stale; ${suffix}`);
    }
    const result = spawnSync('npm', ['run', 'controller:sweep:write'], {
      cwd: SMA_ROOT,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.status === 0) return;

    const output = result.stderr || result.stdout || '';
    if (!isControllerRefreshLeaseHeld(output) || attempt === maxAttempts) {
      throw new Error(`${label}: controller refresh failed: ${tailOutput(output)}`);
    }
    sleep(1000);
    if (isDefaultPacketReportFresh()) return;
  }
}

function isControllerRefreshLeaseHeld(value) {
  return /resource is leased: other:controller-actions/.test(String(value || ''));
}

function isDefaultPacketReportFresh() {
  if (args.packetFile) return false;
  try {
    const report = readPacketReport();
    const freshness = packetFreshness(report, {
      currentLeaseFingerprint: currentLeaseFingerprint(),
      expectedLeaseFingerprint: report.lease_fingerprint || null,
      maxAge: maxPacketAgeSeconds(),
    });
    return !freshness.stale;
  } catch {
    // A missing, unreadable, or invalid report is not fresh.
    return false;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readPacketReport() {
  const file = resolve(args.packetFile || DEFAULT_PACKET_FILE);
  if (!existsSync(file)) {
    throw new Error(`graph packet file not found: ${file}; run npm run controller:sweep:write`);
  }
  const report = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(report.packets)) throw new Error(`invalid graph packet file: ${file}`);
  return report;
}

function decoratePacketReport(report) {
  const active = readActiveLeases({ excludeCurrentWrapperLease: true });
  const freshness = packetFreshness(report, {
    currentLeaseFingerprint: packetLeaseFingerprint(active),
    expectedLeaseFingerprint: report.lease_fingerprint || null,
    maxAge: maxPacketAgeSeconds(),
  });
  const fingerprintsByProject = new Map();
  const fingerprintForProject = (project) => {
    const key = String(project || '');
    if (!fingerprintsByProject.has(key)) {
      fingerprintsByProject.set(key, packetLeaseFingerprint(active, { project }));
    }
    return fingerprintsByProject.get(key);
  };
  const leasesByPacket = new Map();
  for (const lease of active.leases || []) {
    if (lease.resource_kind !== 'brick' || !lease.project || !lease.resource_id) continue;
    leasesByPacket.set(packetLeaseKey(lease.project, lease.resource_id), lease);
  }

  const packets = report.packets.map((packet) => {
    const lease = leasesByPacket.get(packetLeaseKey(packet.project, packet.brick));
    const packetFreshnessStatus = packetFreshness(report, {
      currentLeaseFingerprint: fingerprintForProject(packet.project),
      expectedLeaseFingerprint: packet.lease_fingerprint || report.lease_fingerprint || null,
      maxAge: maxPacketAgeSeconds(),
    });
    return {
      ...packet,
      report_freshness: freshness,
      packet_freshness: packetFreshnessStatus,
      packet_stale: args.project ? packetFreshnessStatus.stale : freshness.stale || packetFreshnessStatus.stale,
      held: Boolean(lease),
      held_by: lease?.agent_id || null,
      held_lease_id: lease?.lease_id || null,
      held_ttl_seconds: lease?.ttl_remaining_seconds ?? null,
    };
  });
  const scopedPackets = projectScopedPackets(packets);

  return {
    ...report,
    freshness,
    summary: {
      ...graphScopedSummary(report.summary || {}, scopedPackets),
      packet_age_seconds: freshness.age_seconds,
      packet_max_age_seconds: freshness.max_age_seconds,
      packet_stale: freshness.stale,
      stale_packet_count: scopedPackets.filter((packet) => packet.packet_stale).length,
      held_packet_count: scopedPackets.filter((packet) => packet.held).length,
      available_packet_count: scopedPackets.filter((packet) => !packet.held).length,
    },
    packets: scopedPackets,
  };
}

function graphScopedSummary(baseSummary, packets) {
  if (!args.project) return baseSummary;
  return {
    ...baseSummary,
    scoped_project: String(args.project),
    packet_count: packets.length,
    module_graph_gap_count: packets.reduce((sum, packet) => sum + Number(packet.module_graph_gap_count || 0), 0),
    project_graph_gaps: packets.filter((packet) => packet.kind === 'project-graph-gap').length,
    target_drift_count: packets.reduce((sum, packet) => sum + Number(packet.missing_target_count || 0), 0),
  };
}

function maxPacketAgeSeconds() {
  return maxAgeSeconds(args.maxAgeSeconds);
}

function currentLeaseFingerprint(project = null) {
  return packetLeaseFingerprint(readActiveLeases({ excludeCurrentWrapperLease: true }), { project });
}

function limitedPackets(report) {
  const source = args.availableOnly
    ? projectScopedPackets(report.packets).filter((packet) => !packet.held)
    : projectScopedPackets(report.packets);
  const limit = Number(args.limit ?? report.packets.length);
  const safeLimit = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : report.packets.length;
  return source.slice(0, safeLimit);
}

function selectPacket(report) {
  const decorated = decoratePacketReport(report);
  if (args.next && args.rank) throw new Error('use either --next or --rank <n>, not both');
  if (args.next) {
    const packet = projectScopedPackets(decorated.packets).find((item) => !item.held && !item.packet_stale);
    if (!packet) throw new Error('no available fresh graph packets; generated packets are held or stale. Run npm run controller:sweep:write');
    return assertPacket(packet);
  }

  const rank = Number(args.rank);
  if (!Number.isInteger(rank) || rank <= 0) throw new Error('select a packet with --rank <n>');
  const packet = projectScopedPackets(decorated.packets).find((item) => Number(item.rank) === rank);
  if (!packet) throw new Error(`graph packet rank not found: ${rank}`);
  return assertPacket(packet);
}

function projectScopedPackets(packets) {
  if (!args.project) return packets;
  return packets.filter((packet) => String(packet.project) === String(args.project));
}

function assertPacket(packet) {
  for (const key of ['project', 'kind', 'brick', 'repair_command', 'verify_command']) {
    if (!packet[key]) throw new Error(`graph packet #${packet.rank} is missing ${key}`);
  }
  return packet;
}

function graphPacketImpact(packet) {
  if (packet.repair_kind === 'target-drift') {
    const count = Number(packet.missing_target_count || packet.module_graph_gap_count || 0);
    return `${count} target drift${count === 1 ? '' : 's'}`;
  }
  if (packet.kind === 'module-graph-gap') {
    const count = Number(packet.module_graph_gap_count || 0);
    return `${count} module gap${count === 1 ? '' : 's'}`;
  }
  return 'missing project graph';
}

function packetLeaseKey(project, brick) {
  return `${project}\0${brick}`;
}

function relativeToSma(filePath) {
  return filePath.startsWith(SMA_ROOT) ? filePath.slice(SMA_ROOT.length + 1) : filePath;
}

function shellArg(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function tailOutput(value) {
  const text = String(value || '').trim();
  if (!text) return 'no output';
  return text.split('\n').slice(-8).join('\n');
}

function parseArgs(list: string[]): GraphPacketArgs {
  const out: GraphPacketArgs = {};
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = list[i + 1];
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}
