#!/usr/bin/env node
/**
 * WHAT: Lists, inspects, dispatches, or claims low-token cleanup packets for dirty ownership groups.
 * WHY: Agents must coordinate cleanup without dumping full repository status or racing another live [lease](../docs/GLOSSARY.md#lease).
 * HOW: Reads generated packet and lease state, prints compact actions, and is called by cleanup controllers and assigned agents.
 * Usage: `node tools/sma-cleanup-packets.ts --help`
 */
/**
 * sma-cleanup-packets.ts — low-token dispatch surface for dirty cleanup work.
 *
 * Reads handoffs/cleanup-packets.generated.json and lets agents list, inspect,
 * or claim one ranked dirty group without printing a full git status.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, exit } from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
import { readActiveLeases } from './lib/gen3-state.ts';
import { projectRoot } from './lib/context-log.ts';
import {
  assertFreshPacketReport,
  formatPacketFreshness,
  maxAgeSeconds,
  packetLeaseFingerprint,
  packetFreshness,
} from './lib/packet-freshness.ts';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PACKET_FILE = resolve(SMA_ROOT, 'handoffs/cleanup-packets.generated.json');
const DEFAULT_DISPATCH_DIR = resolve(SMA_ROOT, 'handoffs/waves');
const START_EDIT = resolve(SMA_ROOT, 'tools/sma-start-edit.ts');

const command = argv[2] || 'list';
const args = parseArgs(argv.slice(3));

try {
  if (args.help || command === 'help' || command === '--help' || command === '-h') {
    usage();
    exit(0);
  }
  if (command === 'list') exit(runList());
  if (command === 'progress') exit(runProgress());
  if (command === 'wave') exit(runWave());
  if (command === 'show') exit(runShow());
  if (command === 'claim') exit(runClaim());
  throw new Error(`unknown command: ${command}`);
} catch (err) {
  console.error(`sma-cleanup-packets: ${err.message}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-cleanup-packets.ts list [--project <id>] [--limit 12] [--available-only] [--progress] [--json]
                               [--allow-stale] [--no-auto-refresh]
  sma-cleanup-packets.ts progress [--project <id>] [--limit 12] [--available-only] [--json]
                                   [--allow-stale] [--no-auto-refresh]
  sma-cleanup-packets.ts wave [--project <id>] [--limit 12] [--available-only] [--json]
                               [--write-dispatch [path]]
                               [--allow-blocked-dispatch]
                               [--allow-stale] [--no-auto-refresh]
  sma-cleanup-packets.ts show (--rank <n>|--next) [--json]
                               [--allow-stale] [--no-auto-refresh]
  sma-cleanup-packets.ts claim (--rank <n>|--next|--project <id> --brick <id> --group <path>)
                              [--dispatch-rank <n>] [--dispatch-id <id>]
                              [--expected-dirty-path-count <n>]
                              [--ttl 1200] [--json] [--dry-run]
                              [--max-age-seconds 900] [--allow-stale] [--no-auto-refresh]

Reads ${relativeToSma(DEFAULT_PACKET_FILE)} by default.
Use --packet-file <path> to read a different generated packet file.
`);
}

function runList(options: Record<string, any> = {}) {
  const includeProgress = Boolean(options.includeProgress || args.progress);
  const { report: decorated, autoRefreshed } = decoratedPacketReportWithOptionalRefresh({ includeProgress });
  const packets = limitedPackets(decorated);
  const summary = includeProgress
    ? {
        ...decorated.summary,
        ...cleanupProgressSummary(packets),
        progress_selected_packet_count: packets.length,
      }
    : decorated.summary;
  if (args.json) {
    console.log(JSON.stringify({
      generated_at: decorated.generated_at,
      summary,
      freshness: decorated.freshness,
      auto_refreshed: autoRefreshed,
      packets,
    }, null, 2));
    return 0;
  }

  if (autoRefreshed) {
    console.log('auto-refreshed stale cleanup packets before listing');
  }
  console.log(`cleanup packets: ${summary?.packet_count ?? packets.length}, covering ${summary?.dirty_paths_covered ?? 0} dirty paths (${summary?.active_scope_packet_count ?? 0} active-scope packets)`);
  if (includeProgress) {
    console.log(`progress: claimable ${summary?.progress_claimable_remaining_paths ?? 0}/${summary?.progress_claimable_baseline_paths ?? 0} paths remaining, ${summary?.progress_claimable_reduced_paths ?? 0} reduced, ${summary?.progress_claimable_cleared_packet_count ?? 0} cleared packets`);
    if (Number(summary?.progress_stale_packet_count || 0) > 0 || Number(summary?.progress_held_packet_count || 0) > 0) {
      console.log(`progress held/stale: ${summary?.progress_held_packet_count ?? 0} held packets, ${summary?.progress_stale_packet_count ?? 0} stale packets, ${summary?.progress_stale_remaining_paths ?? 0} stale paths remaining`);
    }
  }
  console.log(`packet file: ${formatPacketFreshness(decorated.freshness)}`);
  if (decorated.freshness.stale) {
    console.log('refresh: npm run controller:sweep:write');
  } else if (Number(decorated.summary?.stale_packet_count || 0) > 0) {
    console.log(`stale packets: ${decorated.summary.stale_packet_count}; fresh packets can still be claimed, refresh before stale ranks`);
  }
  for (const packet of packets) {
    const held = packet.held ? ` [held by ${packet.held_by}, ttl ${packet.held_ttl_seconds}s]` : '';
    const stale = packet.packet_stale ? ' [stale]' : '';
    const progress = includeProgress ? ` [${formatProgress(packet.progress)}]` : '';
    const type = packet.packet_type ? ` ${packet.packet_type}` : '';
    console.log(`${packet.rank}. ${packet.project} ${packet.group} (${packet.dirty_path_count} paths${type})${held}${stale}${progress}`);
    console.log(`   claim: ${cleanupPinnedClaimCommand(packet)}`);
  }
  if (Number(decorated.summary?.packet_count || 0) > packets.length) {
    console.log(`... ${Number(decorated.summary.packet_count) - packets.length} more hidden; rerun with --limit ${decorated.summary.packet_count}`);
  }
  return 0;
}

function runProgress() {
  return runList({ includeProgress: true });
}

function runWave() {
  const { report: decorated, autoRefreshed } = decoratedPacketReportWithOptionalRefresh({ includeProgress: true });
  const packets = limitedPackets(decorated);
  const assignments = cleanupWaveAssignments(packets);
  const targetPaths = assignments.reduce((sum, item) => sum + Number(item.dirty_path_count || 0), 0);
  const claimablePaths = assignments
    .filter((item) => !item.held && !item.packet_stale)
    .reduce((sum, item) => sum + Number(item.dirty_path_count || 0), 0);
  const totalCandidates = Number(decorated.summary?.total_candidate_count ?? assignments.length);
  const overflowAfterAssignments = Math.max(0, totalCandidates - assignments.length);
  const readiness = cleanupWaveReadiness(assignments, {
    targetPaths,
    claimablePaths,
    totalCandidates,
    overflowAfterAssignments,
  });
  const result: Record<string, any> = {
    generated_at: decorated.generated_at,
    auto_refreshed: autoRefreshed,
    freshness: decorated.freshness,
    summary: {
      ...(args.project ? { scoped_project: String(args.project) } : {}),
      packet_count: decorated.summary?.packet_count ?? packets.length,
      assignment_count: assignments.length,
      claimable_assignment_count: assignments.filter((item) => !item.held && !item.packet_stale).length,
      targeted_dirty_paths: targetPaths,
      claimable_dirty_paths: claimablePaths,
      total_candidate_count: totalCandidates,
      overflow_count: overflowAfterAssignments,
      graph_note: 'Use npm run graph:packets for graph repair waves; cleanup wave is dirty-tree only.',
    },
    readiness,
    assignments,
  };
  const dispatchManifest = args.writeDispatch ? maybeWriteDispatchManifest(result) : null;
  if (dispatchManifest) result.dispatch_manifest = dispatchManifest;

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }

  if (autoRefreshed) {
    console.log('auto-refreshed stale cleanup packets before wave dispatch');
  }
  console.log(`cleanup wave: ${result.summary.assignment_count} assignments, ${targetPaths} dirty paths targeted (${claimablePaths} currently claimable)`);
  console.log(`readiness: ${readiness.status}, ${readiness.claimable_assignment_count}/${readiness.assignment_count} assignments claimable, ${readiness.claimable_percent}% paths claimable, top gain ${readiness.top_wave_gain_percent}%`);
  if (readiness.status !== 'ready') {
    console.log(`blockers: ${readiness.held_assignment_count} held, ${readiness.stale_assignment_count} stale; next: ${readiness.recommended_next_command}`);
  }
  console.log(`packet file: ${formatPacketFreshness(decorated.freshness)}`);
  if (dispatchManifest) {
    console.log(`dispatch manifest: ${relativeToSma(dispatchManifest.json_path)}`);
    console.log(`dispatch handoff: ${relativeToSma(dispatchManifest.markdown_path)}`);
  }
  console.log(`candidate groups: ${result.summary.total_candidate_count}, overflow after this wave: ${result.summary.overflow_count}`);
  if (!assignments.length) {
    console.log('No cleanup assignments available.');
    return 0;
  }
  console.log('');
  for (const item of assignments) {
    const held = item.held ? ` held by ${item.held_by || 'unknown'}` : 'claimable';
    const stale = item.packet_stale ? ', stale' : '';
    console.log(`Agent ${item.agent_slot} / packet #${item.rank}: ${item.project} ${item.group}`);
    console.log(`  status: ${held}${stale}`);
    console.log(`  gain: ${item.dirty_path_count} paths, ${item.wave_gain_percent}% of wave${item.project_gain_percent === null ? '' : `, ${item.project_gain_percent}% of project dirty`}`);
    console.log(`  claim: ${item.claim_command}`);
    console.log(`  prompt: ${item.prompt}`);
    if (item.sample_paths.length) console.log(`  samples: ${item.sample_paths.join(', ')}`);
  }
  console.log('');
  console.log('Controller follow-up: npm run cleanup:progress -- --limit 12');
  return 0;
}

function writeDispatchManifest(result) {
  const dispatchId = `cleanup-wave-${timestampSlug(new Date())}`;
  const base = dispatchBasePath(dispatchId);
  const manifest = {
    schema_version: '1.0.0',
    kind: 'cleanup-wave-dispatch',
    dispatch_id: dispatchId,
    created_at: new Date().toISOString(),
    source_packet_generated_at: result.generated_at,
    freshness: result.freshness,
    summary: result.summary,
    readiness: result.readiness,
    claim_pinning: {
      mode: 'identity-pinned',
      required_flags: ['--project', '--brick', '--group', '--dispatch-rank', '--expected-dirty-path-count', '--dispatch-id'],
      rank_only_dispatch_safe: false,
    },
    controller_commands: {
      monitor: 'npm run gen3:watch -- --no-auto-refresh',
      status: 'npm run gen3:status -- --no-auto-refresh',
      progress: `npm run cleanup:progress -- --limit ${result.summary.assignment_count || 12}`,
      conflict_summary: 'npm run conflict:summary',
      refresh_packets: 'npm run controller:sweep:write',
    },
    assignments: result.assignments.map((item) => {
      const claimCommand = cleanupPinnedClaimCommand(item, { dispatchId });
      return {
        agent_slot: item.agent_slot,
        rank: item.rank,
        project: item.project,
        group: item.group,
        brick: item.brick,
        packet_type: item.packet_type,
        dirty_path_count: item.dirty_path_count,
        wave_gain_percent: item.wave_gain_percent,
        project_gain_percent: item.project_gain_percent,
        claim_command: claimCommand,
        inspect_command: item.inspect_command,
        conflict_command: item.conflict_command,
        finish_rule: item.finish_rule,
        monitor_command: item.monitor_command,
        status_command: item.status_command,
        prompt: cleanupWavePrompt(item, { claimCommand }),
        sample_paths: item.sample_paths,
      };
    }),
  };
  const jsonPath = `${base}.json`;
  const markdownPath = `${base}.md`;
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(markdownPath, renderDispatchMarkdown(manifest));
  return {
    dispatch_id: dispatchId,
    json_path: jsonPath,
    markdown_path: markdownPath,
    assignment_count: manifest.assignments.length,
    targeted_dirty_paths: manifest.summary.targeted_dirty_paths,
  };
}

function maybeWriteDispatchManifest(result) {
  if (result.readiness?.status !== 'ready' && !args.allowBlockedDispatch) {
    throw new Error(`refusing to write dispatch manifest for ${result.readiness?.status || 'unknown'} wave; refresh packets or pass --allow-blocked-dispatch for an explicit controller override`);
  }
  return writeDispatchManifest(result);
}

function dispatchBasePath(dispatchId) {
  if (args.writeDispatch === true) {
    return resolve(DEFAULT_DISPATCH_DIR, dispatchId);
  }
  const raw = String(args.writeDispatch || '').trim();
  const resolved = resolve(SMA_ROOT, raw);
  return resolved.replace(/\.(json|md)$/i, '');
}

function renderDispatchMarkdown(manifest) {
  const lines = [
    '# SMA Gen3 Cleanup Wave Dispatch',
    '',
    `- Dispatch: ${manifest.dispatch_id}`,
    `- Created: ${manifest.created_at}`,
    `- Status: ${manifest.readiness.status}`,
    `- Agents: ${manifest.summary.assignment_count}`,
    `- Targeted dirty paths: ${manifest.summary.targeted_dirty_paths}`,
    `- Claimable dirty paths: ${manifest.summary.claimable_dirty_paths}`,
    `- Monitor: \`${manifest.controller_commands.monitor}\``,
    `- Progress: \`${manifest.controller_commands.progress}\``,
    `- Conflict SLA: \`${manifest.controller_commands.conflict_summary}\``,
    '',
    '## Assignments',
    '',
  ];
  for (const item of manifest.assignments) {
    lines.push(
      `### Agent ${item.agent_slot}: ${item.project} ${item.group}`,
      '',
      `- Packet: #${item.rank}`,
      `- Dirty paths: ${item.dirty_path_count}`,
      `- Wave gain: ${formatNullablePercent(item.wave_gain_percent)}`,
      `- Project gain: ${formatNullablePercent(item.project_gain_percent)}`,
      `- Claim: \`${item.claim_command}\``,
      `- Monitor: \`${item.monitor_command}\``,
      `- Status: \`${item.status_command}\``,
      `- Conflict: \`${item.conflict_command}\``,
      `- Finish: ${item.finish_rule}`,
      `- Prompt: ${item.prompt}`,
      '',
    );
    if (item.sample_paths?.length) {
      lines.push('- Samples:');
      for (const sample of item.sample_paths) lines.push(`  - \`${sample}\``);
      lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
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
    console.log('auto-refreshed stale cleanup packets before showing');
  }
  console.log(`#${packet.rank} ${packet.project} ${packet.group}`);
  console.log(`packet file: ${formatPacketFreshness(freshness)}`);
  if (packet.packet_type) console.log(`type: ${packet.packet_type}`);
  console.log(`dirty paths: ${packet.dirty_path_count}`);
  console.log(`brick: ${packet.brick}`);
  console.log(`claim: ${cleanupPinnedClaimCommand(packet)}`);
  console.log(`fallback claim: ${packet.claim_command}`);
  console.log(`inspect: ${packet.inspect_command}`);
  if (packet.conflict_command) console.log(`conflict: ${packet.conflict_command}`);
  const samples = packetSamplePaths(packet);
  if (samples.length) {
    console.log(`sample paths (${samples.length}):`);
    for (const file of samples) console.log(`  ${file}`);
  }
  console.log(`finish: ${packet.finish_rule}`);
  return 0;
}

function runClaim() {
  const { packet, freshness, autoRefreshed } = claimSelectionWithOptionalRefresh();
  const claimedPacket = dispatchDecoratedPacket(packet);
  const intent = packet.claim_intent || `claim dirty group ${packet.group} (${packet.dirty_path_count} paths)`;
  const startArgs = [
    START_EDIT,
    '--project', packet.project,
    '--brick', packet.brick,
    '--intent', intent,
    '--rationale', cleanupClaimRationale(claimedPacket),
    '--task', cleanupTaskId(claimedPacket),
    '--ttl', String(args.ttl ?? 1200),
  ];
  for (const file of packetSamplePaths(packet)) startArgs.push('--file', file);
  if (args.json) startArgs.push('--json');

  if (args.dryRun) {
    const samples = packetSamplePaths(packet);
    const dry = {
      packet_rank: packet.rank,
      dispatch_rank: claimedPacket.dispatch_rank ?? null,
      dispatch_id: claimedPacket.dispatch_id ?? null,
      project: packet.project,
      group: packet.group,
      brick: packet.brick,
      dirty_path_count: packet.dirty_path_count,
      packet_type: packet.packet_type || 'dirty-unleased',
      sample_paths: samples,
      freshness,
      auto_refreshed: autoRefreshed,
      command: ['node', ...startArgs].map(shellArg).join(' '),
    };
    console.log(args.json ? JSON.stringify(dry, null, 2) : dry.command);
    return 0;
  }

  if (autoRefreshed && !args.json) {
    console.log('auto-refreshed stale cleanup packets before claiming');
  }
  console.log(`claiming cleanup packet #${packet.rank}: ${packet.project} ${packet.group} (${packet.dirty_path_count} paths, ${packet.packet_type || 'dirty-unleased'})`);
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
    refreshControllerPackets('cleanup');
    return { ...claimSelection(), autoRefreshed: true };
  }
}

function claimSelection() {
  const report = readPacketReport();
  assertFreshPacketReport(report, {
    allowStale: Boolean(args.allowStale),
    currentLeaseFingerprint: currentLeaseFingerprint(),
    expectedLeaseFingerprint: report.lease_fingerprint || null,
    label: 'cleanup',
    maxAge: maxPacketAgeSeconds(),
    refreshCommand: 'npm run controller:sweep:write',
  });
  const packet = selectPacket(report);
  const freshness = assertFreshPacketReport(report, {
    allowStale: Boolean(args.allowStale),
    currentLeaseFingerprint: currentLeaseFingerprint(packet.project),
    expectedLeaseFingerprint: packet.lease_fingerprint || report.lease_fingerprint || null,
    label: 'cleanup',
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
  refreshControllerPackets('cleanup');
  report = readPacketReport();
  return { report, autoRefreshed: true };
}

function decoratedPacketReportWithOptionalRefresh(options: Record<string, any> = {}) {
  let report = readPacketReport();
  let decorated = decoratePacketReport(report, options);
  if (!shouldAutoRefreshDisplay(decorated.freshness)) {
    return { report: decorated, autoRefreshed: false };
  }
  refreshControllerPackets('cleanup');
  report = readPacketReport();
  decorated = decoratePacketReport(report, options);
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
    return false;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readPacketReport() {
  const file = resolve(args.packetFile || DEFAULT_PACKET_FILE);
  if (!existsSync(file)) {
    throw new Error(`cleanup packet file not found: ${file}; run npm run controller:sweep:write`);
  }
  const report = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(report.packets)) throw new Error(`invalid cleanup packet file: ${file}`);
  return report;
}

function decoratePacketReport(report, { includeProgress = false } = {}) {
  const active = readActiveLeases({ excludeCurrentWrapperLease: true });
  const freshness = packetFreshness(report, {
    currentLeaseFingerprint: packetLeaseFingerprint(active),
    expectedLeaseFingerprint: report.lease_fingerprint || null,
    maxAge: maxPacketAgeSeconds(),
  });
  const dirtyStatusByProject = new Map();
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
      ...(includeProgress ? { progress: packetProgress(packet, dirtyStatusByProject) } : {}),
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
      ...cleanupScopedSummary(report.summary || {}, scopedPackets, {
        includeProgress,
      }),
      packet_age_seconds: freshness.age_seconds,
      packet_max_age_seconds: freshness.max_age_seconds,
      packet_stale: freshness.stale,
      stale_packet_count: scopedPackets.filter((packet) => packet.packet_stale).length,
      held_packet_count: scopedPackets.filter((packet) => packet.held).length,
      available_packet_count: scopedPackets.filter((packet) => !packet.held).length,
      ...(includeProgress ? cleanupProgressSummary(scopedPackets) : {}),
    },
    packets: scopedPackets,
  };
}

function cleanupScopedSummary(baseSummary, packets, { includeProgress = false } = {}) {
  if (!args.project) return baseSummary;
  const dirtyPaths = packets.reduce((sum, packet) => sum + Number(packet.dirty_path_count || 0), 0);
  const activeScopePackets = packets.filter((packet) => packet.packet_type === 'active-dirty-scope');
  const activeScopePaths = activeScopePackets.reduce((sum, packet) => sum + Number(packet.dirty_path_count || 0), 0);
  const defaultWave = packets.slice(0, 12);
  const defaultWavePaths = defaultWave.reduce((sum, packet) => sum + Number(packet.dirty_path_count || 0), 0);
  return {
    ...baseSummary,
    scoped_project: String(args.project),
    packet_count: packets.length,
    dirty_paths_covered: dirtyPaths,
    dirty_unleased_packet_count: packets.length - activeScopePackets.length,
    active_scope_packet_count: activeScopePackets.length,
    active_scope_paths_covered: activeScopePaths,
    default_wave_agent_count: defaultWave.length,
    default_wave_dirty_paths: defaultWavePaths,
    default_wave_top_gain_percent: percent(defaultWave[0]?.dirty_path_count || 0, defaultWavePaths),
    default_wave_top_project_gain_percent: defaultWave[0]?.project_gain_percent ?? null,
    total_candidate_count: packets.length,
    overflow_count: 0,
    ...(includeProgress ? cleanupProgressSummary(packets) : {}),
  };
}

function maxPacketAgeSeconds() {
  return maxAgeSeconds(args.maxAgeSeconds);
}

function currentLeaseFingerprint(project = null) {
  return packetLeaseFingerprint(readActiveLeases({ excludeCurrentWrapperLease: true }), { project });
}

function packetProgress(packet, dirtyStatusByProject) {
  const baseline = Number(packet.dirty_path_count || 0);
  const status = projectDirtyStatus(packet.project, dirtyStatusByProject);
  if (status.error) {
    return {
      baseline_count: baseline,
      current_count: null,
      delta_count: null,
      reduced_count: null,
      reduction_percent: null,
      state: 'unknown',
      error: status.error,
    };
  }

  const group = status.groups.find((item) => item.group === packet.group);
  const current = Number(group?.count || 0);
  const delta = current - baseline;
  const reduced = Math.max(0, baseline - current);
  return {
    baseline_count: baseline,
    current_count: current,
    delta_count: delta,
    reduced_count: reduced,
    reduction_percent: baseline > 0 ? Math.round((reduced / baseline) * 100) : null,
    state: progressState({ baseline, current }),
  };
}

function cleanupProgressSummary(packets) {
  const progressedPackets = packets.filter((packet) => packet.progress);
  const progressed = progressedPackets.map((packet) => packet.progress);
  const known = progressed.filter((item) => item.current_count !== null);
  const claimablePackets = progressedPackets.filter((packet) => !packet.held && !packet.packet_stale && packet.progress?.current_count !== null);
  const heldPackets = progressedPackets.filter((packet) => packet.held && packet.progress?.current_count !== null);
  const stalePackets = progressedPackets.filter((packet) => packet.packet_stale && packet.progress?.current_count !== null);
  return {
    progress_packet_count: progressed.length,
    progress_known_packet_count: known.length,
    progress_unknown_packet_count: progressed.length - known.length,
    progress_baseline_paths: known.reduce((sum, item) => sum + Number(item.baseline_count || 0), 0),
    progress_remaining_paths: known.reduce((sum, item) => sum + Number(item.current_count || 0), 0),
    progress_reduced_paths: known.reduce((sum, item) => sum + Number(item.reduced_count || 0), 0),
    progress_cleared_packet_count: known.filter((item) => item.state === 'cleared').length,
    progress_reduced_packet_count: known.filter((item) => item.state === 'reduced').length,
    progress_grew_packet_count: known.filter((item) => item.state === 'grew').length,
    progress_claimable_packet_count: claimablePackets.length,
    progress_claimable_baseline_paths: sumProgress(claimablePackets, 'baseline_count'),
    progress_claimable_remaining_paths: sumProgress(claimablePackets, 'current_count'),
    progress_claimable_reduced_paths: sumProgress(claimablePackets, 'reduced_count'),
    progress_claimable_cleared_packet_count: claimablePackets.filter((packet) => packet.progress.state === 'cleared').length,
    progress_claimable_reduced_packet_count: claimablePackets.filter((packet) => packet.progress.state === 'reduced').length,
    progress_claimable_grew_packet_count: claimablePackets.filter((packet) => packet.progress.state === 'grew').length,
    progress_held_packet_count: heldPackets.length,
    progress_held_remaining_paths: sumProgress(heldPackets, 'current_count'),
    progress_stale_packet_count: stalePackets.length,
    progress_stale_remaining_paths: sumProgress(stalePackets, 'current_count'),
  };
}

function sumProgress(packets, key) {
  return packets.reduce((sum, packet) => sum + Number(packet.progress?.[key] || 0), 0);
}

function progressState({ baseline, current }) {
  if (current === 0) return 'cleared';
  if (current < baseline) return 'reduced';
  if (current > baseline) return 'grew';
  return 'unchanged';
}

function formatProgress(progress) {
  if (!progress) return 'progress unknown';
  if (progress.state === 'unknown') return `progress unknown: ${progress.error || 'status unavailable'}`;
  const current = Number(progress.current_count || 0);
  const baseline = Number(progress.baseline_count || 0);
  const delta = Number(progress.delta_count || 0);
  const pct = progress.reduction_percent === null ? 'n/a' : `${progress.reduction_percent}%`;
  const sign = delta > 0 ? '+' : '';
  return `${progress.state} ${current}/${baseline} remaining, ${sign}${delta}, ${pct} reduced`;
}

function projectDirtyStatus(project, dirtyStatusByProject) {
  const key = String(project || '');
  if (dirtyStatusByProject.has(key)) return dirtyStatusByProject.get(key);
  const status = readProjectDirtyStatus(key);
  dirtyStatusByProject.set(key, status);
  return status;
}

function readProjectDirtyStatus(project) {
  let root;
  try {
    root = projectRoot(project);
  } catch (err) {
    return { error: err.message, groups: [] };
  }

  try {
    const raw = execFileSync('git', ['status', '--short'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
    });
    return { groups: dirtyGroups(raw.split(/\r?\n/).filter(Boolean)) };
  } catch (err) {
    return { error: err.message, groups: [] };
  }
}

function dirtyGroups(changes) {
  const groups = new Map();
  for (const line of changes) {
    const key = dirtyGroupKey(statusPath(line));
    const current = groups.get(key) || { group: key, count: 0, modified_count: 0, untracked_count: 0 };
    current.count += 1;
    if (line.startsWith('??')) current.untracked_count += 1;
    else current.modified_count += 1;
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => right.count - left.count || left.group.localeCompare(right.group));
}

function statusPath(line) {
  const raw = String(line || '').slice(3).trim();
  return raw.includes(' -> ') ? raw.split(' -> ').pop().trim() : raw;
}

function dirtyGroupKey(filePath) {
  const path = String(filePath || '').replace(/\\/g, '/');
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return '(root)';
  if (parts[0] === '.smarch') return parts.slice(0, 3).join('/') || '.smarch';
  if (parts[0] === 'supabase' && parts[1] === 'functions') return parts.slice(0, 3).join('/');
  if (parts[0] === 'apps' || parts[0] === 'packages') return parts.slice(0, 2).join('/');
  if (parts[0] === 'web' && parts[1] === 'src' && parts[2] === 'modules') return parts.slice(0, 4).join('/');
  if (parts[0] === 'src' && parts[1] === 'renderer' && (parts[2] === 'modules' || parts[2] === 'features')) {
    return parts.slice(0, 4).join('/');
  }
  if (parts[0] === 'src' && parts[1] === 'main' && parts[2] === 'services' && parts[3]) {
    return parts.slice(0, 4).join('/');
  }
  if (parts[0] === 'src' && parts[1] === 'shared' && parts[2]) {
    return parts.slice(0, 3).join('/');
  }
  if (parts[0] === 'src' && (parts[1] === 'services' || parts[1] === 'components' || parts[1] === 'hooks' || parts[1] === 'systems')) {
    return parts.slice(0, 3).join('/');
  }
  if (parts.length === 1) return '(root)';
  return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

function cleanupWaveAssignments(packets) {
  const waveTotal = packets.reduce((sum, packet) => sum + Number(packet.dirty_path_count || 0), 0);
  return packets.map((packet, index) => {
    const count = Number(packet.dirty_path_count || 0);
    const projectTotal = Number(packet.parent_dirty_count || 0);
    const claimCommand = cleanupPinnedClaimCommand(packet);
    return {
      agent_slot: index + 1,
      rank: packet.rank,
      project: packet.project,
      group: packet.group,
      brick: packet.brick,
      packet_type: packet.packet_type || 'dirty-unleased',
      dirty_path_count: count,
      parent_dirty_count: projectTotal || null,
      wave_gain_percent: percent(count, waveTotal),
      project_gain_percent: projectTotal > 0 ? percent(count, projectTotal) : null,
      held: Boolean(packet.held),
      held_by: packet.held_by || null,
      held_lease_id: packet.held_lease_id || null,
      packet_stale: Boolean(packet.packet_stale),
      progress: packet.progress || null,
      claim_command: claimCommand,
      inspect_command: packet.inspect_command || null,
      conflict_command: packet.conflict_command || null,
      finish_rule: packet.finish_rule || '',
      monitor_command: 'npm run gen3:watch -- --no-auto-refresh',
      status_command: 'npm run gen3:status -- --no-auto-refresh',
      sample_paths: packetSamplePaths(packet, 5),
      prompt: cleanupWavePrompt(packet),
    };
  });
}

function cleanupWaveReadiness(assignments, { targetPaths, claimablePaths, totalCandidates, overflowAfterAssignments }) {
  const held = assignments.filter((item) => item.held);
  const stale = assignments.filter((item) => item.packet_stale);
  const blocked = assignments.filter((item) => item.held || item.packet_stale);
  const claimableAssignments = assignments.filter((item) => !item.held && !item.packet_stale);
  const blockedPaths = blocked.reduce((sum, item) => sum + Number(item.dirty_path_count || 0), 0);
  let status = 'ready';
  let recommendedNextCommand = 'npm run cleanup:claim -- --next';
  if (!assignments.length) {
    status = 'empty';
    recommendedNextCommand = 'npm run controller:sweep:write';
  } else if (stale.length && claimableAssignments.length) {
    status = 'partial-stale';
    recommendedNextCommand = 'npm run controller:sweep:write';
  } else if (stale.length) {
    status = 'stale';
    recommendedNextCommand = 'npm run controller:sweep:write';
  } else if (held.length && claimableAssignments.length) {
    status = 'partial';
    recommendedNextCommand = 'npm run cleanup:claim -- --next';
  } else if (held.length) {
    status = 'blocked';
    recommendedNextCommand = 'npm run cleanup:progress -- --limit 12';
  }

  return {
    status,
    assignment_count: assignments.length,
    claimable_assignment_count: claimableAssignments.length,
    held_assignment_count: held.length,
    stale_assignment_count: stale.length,
    blocked_assignment_count: blocked.length,
    targeted_dirty_paths: Number(targetPaths || 0),
    claimable_dirty_paths: Number(claimablePaths || 0),
    blocked_dirty_paths: blockedPaths,
    claimable_percent: percent(claimablePaths, targetPaths),
    top_wave_gain_percent: assignments[0]?.wave_gain_percent ?? 0,
    top_project_gain_percent: assignments[0]?.project_gain_percent ?? null,
    total_candidate_count: Number(totalCandidates || assignments.length),
    overflow_count: Number(overflowAfterAssignments || 0),
    recommended_next_command: recommendedNextCommand,
  };
}

function cleanupWavePrompt(packet, options: Record<string, any> = {}) {
  const claim = options.claimCommand || cleanupPinnedClaimCommand(packet);
  const inspect = packet.inspect_command || `npm run controller:snapshot:quiet -- --project ${shellArg(packet.project)}`;
  const conflict = packet.conflict_command || `npm run conflict -- report --project ${shellArg(packet.project)} --brick ${shellArg(packet.brick)} --intent ${shellArg(`dirty group ${packet.group} overlaps my work`)} --resolution-plan ${shellArg('claim, split, clean, or hand off before integration')}`;
  return [
    'Use $sma-gen3.',
    `From ~/DEV/SMARCH run \`${claim}\`.`,
    'Clean or commit only the claimed dirty group.',
    `Use \`${inspect}\` only if exact paths are needed.`,
    `If overlap, uncertainty, or shared-path contention appears, conflict reporting is mandatory: run \`${conflict}\` and back off.`,
    'Keep interim updates big-picture compatible; the controller monitors the wave with `npm run gen3:watch -- --no-auto-refresh`.',
    'Finish with the packet finish rule, use end-edit, and report gates/proof plus the post-release Gen3 TLDR.',
  ].join(' ');
}

function cleanupPinnedClaimCommand(packet, options: Record<string, any> = {}) {
  const parts = [
    'npm run cleanup:claim --',
    '--project', shellArg(packet.project),
    '--brick', shellArg(packet.brick),
    '--group', shellArg(packet.group),
    '--dispatch-rank', shellArg(packet.rank ?? 'unknown'),
    '--expected-dirty-path-count', shellArg(Number(packet.dirty_path_count || 0)),
  ];
  if (options.dispatchId) parts.push('--dispatch-id', shellArg(options.dispatchId));
  return parts.join(' ');
}

function percent(part, whole) {
  const numerator = Number(part || 0);
  const denominator = Number(whole || 0);
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function formatNullablePercent(value) {
  if (value === null || value === undefined) return 'n/a';
  return `${Number(value).toFixed(1).replace(/\.0$/, '')}%`;
}

function timestampSlug(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
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
  const hasPinnedIdentity = Boolean(args.brick || args.group);
  if (args.next && (args.rank || hasPinnedIdentity)) throw new Error('use either --next, --rank <n>, or pinned --project/--brick/--group, not a mix');
  if (hasPinnedIdentity) {
    return selectPinnedPacket(decorated);
  }
  if (args.next) {
    const packet = projectScopedPackets(decorated.packets).find((item) => !item.held && !item.packet_stale);
    if (!packet) throw new Error('no available fresh cleanup packets; generated packets are held or stale. Run npm run controller:sweep:write');
    return assertPacket(packet);
  }

  const rank = Number(args.rank);
  if (!Number.isInteger(rank) || rank <= 0) throw new Error('select a packet with --rank <n>');
  const packet = projectScopedPackets(decorated.packets).find((item) => Number(item.rank) === rank);
  if (!packet) throw new Error(`cleanup packet rank not found: ${rank}`);
  return assertPacket(packet);
}

function projectScopedPackets(packets) {
  if (!args.project) return packets;
  return packets.filter((packet) => String(packet.project) === String(args.project));
}

function selectPinnedPacket(decorated) {
  for (const key of ['project', 'brick', 'group']) {
    if (!args[key]) throw new Error(`pinned cleanup claim requires --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  const matches = decorated.packets.filter((item) => (
    String(item.project) === String(args.project)
    && String(item.brick) === String(args.brick)
    && String(item.group) === String(args.group)
  ));
  if (!matches.length) {
    throw new Error(`pinned cleanup packet not found: project=${args.project} brick=${args.brick} group=${args.group}; refresh dispatch before assigning this slot`);
  }
  if (matches.length > 1) {
    throw new Error(`pinned cleanup packet is ambiguous: project=${args.project} brick=${args.brick} group=${args.group}`);
  }
  const packet = assertPacket(matches[0]);
  const expectedCount = nullablePositiveInt(args.expectedDirtyPathCount);
  if (expectedCount !== null && Number(packet.dirty_path_count || 0) !== expectedCount) {
    throw new Error(`pinned cleanup packet dirty count changed: expected ${expectedCount}, current ${Number(packet.dirty_path_count || 0)} for ${packet.project} ${packet.group}; refresh dispatch before assigning this slot`);
  }
  if (packet.held) {
    throw new Error(`pinned cleanup packet is already held: ${packet.project} ${packet.group} by ${packet.held_by || 'unknown'} (${packet.held_lease_id || 'unknown lease'})`);
  }
  return packet;
}

function assertPacket(packet) {
  for (const key of ['project', 'group', 'brick']) {
    if (!packet[key]) throw new Error(`cleanup packet #${packet.rank} is missing ${key}`);
  }
  return packet;
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

function cleanupClaimRationale(packet) {
  const fields = [
    `cleanup_packet_rank=${packet.dispatch_rank ?? packet.rank ?? 'unknown'}`,
    `packet_type=${packet.packet_type || 'dirty-unleased'}`,
    `group=${packet.group || 'unknown'}`,
    `dirty_paths=${Number(packet.dirty_path_count || 0)}`,
  ];
  if (packet.dispatch_id) fields.push(`dispatch_id=${packet.dispatch_id}`);
  if (packet.dispatch_rank && Number(packet.dispatch_rank) !== Number(packet.rank)) {
    fields.push(`current_packet_rank=${packet.rank ?? 'unknown'}`);
  }
  if (Number(packet.parent_dirty_count || 0) > 0) {
    fields.push(`parent_dirty_paths=${Number(packet.parent_dirty_count || 0)}`);
  }
  return fields.join(' | ');
}

function cleanupTaskId(packet) {
  const rank = String(packet.dispatch_rank ?? packet.rank ?? 'unknown').replace(/[^a-z0-9._-]/gi, '-');
  const project = String(packet.project ?? 'project').replace(/[^a-z0-9._-]/gi, '-');
  return `cleanup-packet-${project}-${rank}`;
}

function dispatchDecoratedPacket(packet) {
  const dispatchRank = nullablePositiveInt(args.dispatchRank);
  const out: Record<string, any> = {
    ...packet,
    dispatch_rank: dispatchRank ?? null,
    dispatch_id: args.dispatchId ? String(args.dispatchId) : null,
  };
  if (!out.dispatch_rank && args.rank) out.dispatch_rank = nullablePositiveInt(args.rank);
  return out;
}

function nullablePositiveInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function packetSamplePaths(packet, limit = 8) {
  const out = [];
  for (const value of packet.sample_paths || []) {
    const file = String(value || '').trim();
    if (!file || out.includes(file)) continue;
    out.push(file);
    if (out.length >= limit) break;
  }
  return out;
}

function tailOutput(value) {
  const text = String(value || '').trim();
  if (!text) return 'no output';
  return text.split('\n').slice(-8).join('\n');
}

function parseArgs(list) {
  const out: Record<string, any> = {};
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
