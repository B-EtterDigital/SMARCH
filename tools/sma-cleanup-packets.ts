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
  type LeaseFingerprint,
  type PacketFreshness,
} from './lib/packet-freshness.ts';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PACKET_FILE = resolve(SMA_ROOT, 'handoffs/cleanup-packets.generated.json');
const DEFAULT_DISPATCH_DIR = resolve(SMA_ROOT, 'handoffs/waves');
const START_EDIT = resolve(SMA_ROOT, 'tools/sma-start-edit.ts');

interface CleanupArgs extends Record<string, string | boolean | undefined> {
  help?: boolean; project?: string; progress?: boolean; json?: boolean; availableOnly?: boolean;
  limit?: string; writeDispatch?: string | boolean; allowBlockedDispatch?: boolean; dryRun?: boolean;
  allowStale?: boolean; noAutoRefresh?: boolean; packetFile?: string; maxAgeSeconds?: string;
  brick?: string; group?: string; next?: boolean; rank?: string; dispatchRank?: string;
  dispatchId?: string; expectedDirtyPathCount?: string; ttl?: string;
}
interface DirtyGroup { group: string; count: number; modified_count: number; untracked_count: number }
interface CleanupProgress {
  baseline_count: number; current_count: number | null; delta_count: number | null;
  reduced_count: number | null; reduction_percent: number | null; state: string; error?: string;
}
interface CleanupPacket {
  rank: number; project: string; group: string; brick: string; dirty_path_count: number;
  parent_dirty_count?: number | null; project_gain_percent?: number | null; packet_type?: string;
  sample_paths?: string[]; inspect_command?: string | null; conflict_command?: string | null; finish_rule?: string;
  claim_command?: string; claim_intent?: string;
  lease_fingerprint?: LeaseFingerprint | null; held?: boolean; held_by?: string | null;
  held_lease_id?: string | null; held_ttl_seconds?: number | null; packet_stale?: boolean;
  progress?: CleanupProgress | null; dispatch_rank?: number | null; dispatch_id?: string | null;
  report_freshness?: PacketFreshness; packet_freshness?: PacketFreshness;
}
interface CleanupSummary extends Record<string, unknown> {
  packet_count?: number; dirty_paths_covered?: number; active_scope_packet_count?: number;
  stale_packet_count?: number; total_candidate_count?: number; assignment_count?: number;
  targeted_dirty_paths?: number; claimable_dirty_paths?: number; overflow_count?: number;
  progress_claimable_remaining_paths?: number; progress_claimable_baseline_paths?: number;
  progress_claimable_reduced_paths?: number; progress_claimable_cleared_packet_count?: number;
  progress_stale_packet_count?: number; progress_held_packet_count?: number;
  progress_stale_remaining_paths?: number;
}
interface CleanupReport {
  generated_at?: string | null; lease_fingerprint?: LeaseFingerprint | null;
  summary: CleanupSummary; packets: CleanupPacket[]; freshness?: PacketFreshness;
}
interface CleanupAssignment extends CleanupPacket {
  agent_slot: number; wave_gain_percent: number; project_gain_percent: number | null;
  parent_dirty_count: number | null;
  claim_command: string; inspect_command: string | null; conflict_command: string | null;
  finish_rule: string; monitor_command: string; status_command: string; sample_paths: string[]; prompt: string;
}
interface WaveReadiness extends Record<string, unknown> {
  status: string; assignment_count: number; claimable_assignment_count: number; held_assignment_count: number;
  stale_assignment_count: number; claimable_percent: number; top_wave_gain_percent: number;
  recommended_next_command: string;
}
interface WaveResult extends Record<string, unknown> {
  generated_at?: string | null; freshness: PacketFreshness; summary: CleanupSummary;
  readiness: WaveReadiness; assignments: CleanupAssignment[];
}
interface DispatchAssignment {
  agent_slot: number; rank: number; project: string; group: string; brick: string; packet_type: string;
  dirty_path_count: number; wave_gain_percent: number; project_gain_percent: number | null;
  claim_command: string; inspect_command: string | null; conflict_command: string | null; finish_rule: string;
  monitor_command: string; status_command: string; prompt: string; sample_paths: string[];
}
interface DispatchManifest {
  dispatch_id: string; created_at: string; readiness: WaveReadiness; summary: CleanupSummary;
  controller_commands: Record<string, string>; assignments: DispatchAssignment[];
}
interface DirtyStatus { error?: string; groups: DirtyGroup[] }

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
  console.error(`sma-cleanup-packets: ${err instanceof Error ? err.message : String(err)}`);
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

function runList(options: { includeProgress?: boolean } = {}) {
  const includeProgress = Boolean(options.includeProgress ?? args.progress);
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

  printCleanupSummary(decorated, summary, packets, includeProgress, autoRefreshed);
  printCleanupPackets(decorated, packets, includeProgress);
  return 0;
}

function printCleanupSummary(decorated: CleanupReport & { freshness: PacketFreshness }, summary: CleanupSummary, packets: CleanupPacket[], includeProgress: boolean, autoRefreshed: boolean) {
  if (autoRefreshed) console.log('auto-refreshed stale cleanup packets before listing');
  console.log(`cleanup packets: ${String(summary.packet_count ?? packets.length)}, covering ${String(summary.dirty_paths_covered ?? 0)} dirty paths (${String(summary.active_scope_packet_count ?? 0)} active-scope packets)`);
  if (includeProgress) printProgressSummary(summary);
  console.log(`packet file: ${formatPacketFreshness(decorated.freshness)}`);
  if (decorated.freshness.stale) {
    console.log('refresh: npm run controller:sweep:write');
  } else if ((decorated.summary.stale_packet_count ?? 0) > 0) {
    console.log(`stale packets: ${String(decorated.summary.stale_packet_count)}; fresh packets can still be claimed, refresh before stale ranks`);
  }
}

function printProgressSummary(summary: CleanupSummary) {
  console.log(`progress: claimable ${String(summary.progress_claimable_remaining_paths ?? 0)}/${String(summary.progress_claimable_baseline_paths ?? 0)} paths remaining, ${String(summary.progress_claimable_reduced_paths ?? 0)} reduced, ${String(summary.progress_claimable_cleared_packet_count ?? 0)} cleared packets`);
  if ((summary.progress_stale_packet_count ?? 0) > 0 || (summary.progress_held_packet_count ?? 0) > 0) {
    console.log(`progress held/stale: ${String(summary.progress_held_packet_count ?? 0)} held packets, ${String(summary.progress_stale_packet_count ?? 0)} stale packets, ${String(summary.progress_stale_remaining_paths ?? 0)} stale paths remaining`);
  }
}

function printCleanupPackets(decorated: CleanupReport, packets: CleanupPacket[], includeProgress: boolean) {
  for (const packet of packets) {
    const held = packet.held ? ` [held by ${String(packet.held_by)}, ttl ${String(packet.held_ttl_seconds)}s]` : '';
    const stale = packet.packet_stale ? ' [stale]' : '';
    const progress = includeProgress ? ` [${formatProgress(packet.progress)}]` : '';
    const type = packet.packet_type ? ` ${packet.packet_type}` : '';
    console.log(`${String(packet.rank)}. ${packet.project} ${packet.group} (${String(packet.dirty_path_count)} paths${type})${held}${stale}${progress}`);
    console.log(`   claim: ${cleanupPinnedClaimCommand(packet)}`);
  }
  if ((decorated.summary.packet_count ?? 0) > packets.length) {
    console.log(`... ${String(Number(decorated.summary.packet_count) - packets.length)} more hidden; rerun with --limit ${String(decorated.summary.packet_count)}`);
  }
}

function runProgress() {
  return runList({ includeProgress: true });
}

function runWave() {
  const { report: decorated, autoRefreshed } = decoratedPacketReportWithOptionalRefresh({ includeProgress: true });
  const packets = limitedPackets(decorated);
  const assignments = cleanupWaveAssignments(packets);
  const targetPaths = assignments.reduce((sum: number, item) => sum + (item.dirty_path_count || 0), 0);
  const claimablePaths = assignments
    .filter((item) => !item.held && !item.packet_stale)
    .reduce((sum: number, item) => sum + (item.dirty_path_count || 0), 0);
  const totalCandidates = (decorated.summary.total_candidate_count ?? assignments.length);
  const overflowAfterAssignments = Math.max(0, totalCandidates - assignments.length);
  const readiness = cleanupWaveReadiness(assignments, {
    targetPaths,
    claimablePaths,
    totalCandidates,
    overflowAfterAssignments,
  });
  const result: WaveResult = {
    generated_at: decorated.generated_at,
    auto_refreshed: autoRefreshed,
    freshness: decorated.freshness,
    summary: {
      ...(args.project ? { scoped_project: args.project } : {}),
      packet_count: decorated.summary.packet_count ?? packets.length,
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
  return printCleanupWave(result, autoRefreshed, dispatchManifest);
}

function printCleanupWave(result: WaveResult, autoRefreshed: boolean, dispatchManifest: ReturnType<typeof writeDispatchManifest> | null) {
  const { assignments, readiness, summary, freshness } = result;
  if (autoRefreshed) console.log('auto-refreshed stale cleanup packets before wave dispatch');
  console.log(`cleanup wave: ${String(summary.assignment_count)} assignments, ${String(summary.targeted_dirty_paths)} dirty paths targeted (${String(summary.claimable_dirty_paths)} currently claimable)`);
  console.log(`readiness: ${readiness.status}, ${String(readiness.claimable_assignment_count)}/${String(readiness.assignment_count)} assignments claimable, ${String(readiness.claimable_percent)}% paths claimable, top gain ${String(readiness.top_wave_gain_percent)}%`);
  if (readiness.status !== 'ready') {
    console.log(`blockers: ${String(readiness.held_assignment_count)} held, ${String(readiness.stale_assignment_count)} stale; next: ${readiness.recommended_next_command}`);
  }
  console.log(`packet file: ${formatPacketFreshness(freshness)}`);
  if (dispatchManifest) {
    console.log(`dispatch manifest: ${relativeToSma(dispatchManifest.json_path)}`);
    console.log(`dispatch handoff: ${relativeToSma(dispatchManifest.markdown_path)}`);
  }
  console.log(`candidate groups: ${String(summary.total_candidate_count)}, overflow after this wave: ${String(summary.overflow_count)}`);
  if (!assignments.length) {
    console.log('No cleanup assignments available.');
    return 0;
  }
  console.log('');
  for (const item of assignments) {
    const held = item.held ? ` held by ${item.held_by ?? 'unknown'}` : 'claimable';
    const stale = item.packet_stale ? ', stale' : '';
    console.log(`Agent ${String(item.agent_slot)} / packet #${String(item.rank)}: ${item.project} ${item.group}`);
    console.log(`  status: ${held}${stale}`);
    console.log(`  gain: ${String(item.dirty_path_count)} paths, ${String(item.wave_gain_percent)}% of wave${item.project_gain_percent === null ? '' : `, ${String(item.project_gain_percent)}% of project dirty`}`);
    console.log(`  claim: ${item.claim_command}`);
    console.log(`  prompt: ${item.prompt}`);
    if (item.sample_paths.length) console.log(`  samples: ${item.sample_paths.join(', ')}`);
  }
  console.log('');
  console.log('Controller follow-up: npm run cleanup:progress -- --limit 12');
  return 0;
}

function writeDispatchManifest(result: WaveResult) {
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
      progress: `npm run cleanup:progress -- --limit ${String(result.summary.assignment_count ?? 12)}`,
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
        packet_type: item.packet_type ?? 'dirty-unleased',
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

function maybeWriteDispatchManifest(result: WaveResult) {
  if (result.readiness.status !== 'ready' && !args.allowBlockedDispatch) {
    throw new Error(`refusing to write dispatch manifest for ${result.readiness.status || 'unknown'} wave; refresh packets or pass --allow-blocked-dispatch for an explicit controller override`);
  }
  return writeDispatchManifest(result);
}

function dispatchBasePath(dispatchId: string) {
  if (args.writeDispatch === true) {
    return resolve(DEFAULT_DISPATCH_DIR, dispatchId);
  }
  const raw = String(args.writeDispatch ?? '').trim();
  const resolved = resolve(SMA_ROOT, raw);
  return resolved.replace(/\.(json|md)$/i, '');
}

function renderDispatchMarkdown(manifest: DispatchManifest) {
  const lines = [
    '# SMA Gen3 Cleanup Wave Dispatch',
    '',
    `- Dispatch: ${manifest.dispatch_id}`,
    `- Created: ${manifest.created_at}`,
    `- Status: ${manifest.readiness.status}`,
    `- Agents: ${String(manifest.summary.assignment_count)}`,
    `- Targeted dirty paths: ${String(manifest.summary.targeted_dirty_paths)}`,
    `- Claimable dirty paths: ${String(manifest.summary.claimable_dirty_paths)}`,
    `- Monitor: \`${manifest.controller_commands.monitor}\``,
    `- Progress: \`${manifest.controller_commands.progress}\``,
    `- Conflict SLA: \`${manifest.controller_commands.conflict_summary}\``,
    '',
    '## Assignments',
    '',
  ];
  for (const item of manifest.assignments) {
    lines.push(
      `### Agent ${String(item.agent_slot)}: ${item.project} ${item.group}`,
      '',
      `- Packet: #${String(item.rank)}`,
      `- Dirty paths: ${String(item.dirty_path_count)}`,
      `- Wave gain: ${formatNullablePercent(item.wave_gain_percent)}`,
      `- Project gain: ${formatNullablePercent(item.project_gain_percent)}`,
      `- Claim: \`${item.claim_command}\``,
      `- Monitor: \`${item.monitor_command}\``,
      `- Status: \`${item.status_command}\``,
      `- Conflict: \`${String(item.conflict_command)}\``,
      `- Finish: ${item.finish_rule}`,
      `- Prompt: ${item.prompt}`,
      '',
    );
    if (item.sample_paths.length) {
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
    : packet.packet_freshness ?? packetFreshness(report, { maxAge: maxPacketAgeSeconds() });
  if (args.json) {
    console.log(JSON.stringify({ freshness, auto_refreshed: autoRefreshed, packet }, null, 2));
    return 0;
  }

  if (autoRefreshed) {
    console.log('auto-refreshed stale cleanup packets before showing');
  }
  console.log(`#${String(packet.rank)} ${packet.project} ${packet.group}`);
  console.log(`packet file: ${formatPacketFreshness(freshness)}`);
  if (packet.packet_type) console.log(`type: ${packet.packet_type}`);
  console.log(`dirty paths: ${String(packet.dirty_path_count)}`);
  console.log(`brick: ${packet.brick}`);
  console.log(`claim: ${cleanupPinnedClaimCommand(packet)}`);
  console.log(`fallback claim: ${String(packet.claim_command)}`);
  console.log(`inspect: ${String(packet.inspect_command)}`);
  if (packet.conflict_command) console.log(`conflict: ${packet.conflict_command}`);
  const samples = packetSamplePaths(packet);
  if (samples.length) {
    console.log(`sample paths (${String(samples.length)}):`);
    for (const file of samples) console.log(`  ${file}`);
  }
  console.log(`finish: ${String(packet.finish_rule)}`);
  return 0;
}

function runClaim() {
  const { packet, freshness, autoRefreshed } = claimSelectionWithOptionalRefresh();
  const claimedPacket = dispatchDecoratedPacket(packet);
  const intent = packet.claim_intent ?? `claim dirty group ${packet.group} (${String(packet.dirty_path_count)} paths)`;
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
      packet_type: packet.packet_type ?? 'dirty-unleased',
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
  console.log(`claiming cleanup packet #${String(packet.rank)}: ${packet.project} ${packet.group} (${String(packet.dirty_path_count)} paths, ${packet.packet_type ?? 'dirty-unleased'})`);
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
    expectedLeaseFingerprint: report.lease_fingerprint ?? null,
    label: 'cleanup',
    maxAge: maxPacketAgeSeconds(),
    refreshCommand: 'npm run controller:sweep:write',
  });
  const packet = selectPacket(report);
  const freshness = assertFreshPacketReport(report, {
    allowStale: Boolean(args.allowStale),
    currentLeaseFingerprint: currentLeaseFingerprint(packet.project),
    expectedLeaseFingerprint: (packet.lease_fingerprint ?? report.lease_fingerprint) ?? null,
    label: 'cleanup',
    maxAge: maxPacketAgeSeconds(),
    refreshCommand: 'npm run controller:sweep:write',
  });
  return { packet, freshness };
}

function shouldAutoRefreshClaim(err: unknown) {
  if (args.dryRun || args.allowStale || args.noAutoRefresh || args.packetFile) return false;
  return /stale|no available fresh|packet file not found/i.test(err instanceof Error ? err.message : String(err));
}

function packetReportWithOptionalRefresh() {
  let report = readPacketReport();
  const freshness = packetFreshness(report, {
    currentLeaseFingerprint: currentLeaseFingerprint(),
    expectedLeaseFingerprint: report.lease_fingerprint ?? null,
    maxAge: maxPacketAgeSeconds(),
  });
  if (!shouldAutoRefreshDisplay(freshness)) {
    return { report, autoRefreshed: false };
  }
  refreshControllerPackets('cleanup');
  report = readPacketReport();
  return { report, autoRefreshed: true };
}

function decoratedPacketReportWithOptionalRefresh(options: { includeProgress?: boolean } = {}) {
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

function shouldAutoRefreshDisplay(freshness: PacketFreshness) {
  if (args.allowStale || args.noAutoRefresh || args.packetFile) return false;
  return freshness.stale;
}

function refreshControllerPackets(label: string) {
  const maxAttempts = 30;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!args.json) {
      const suffix = attempt === 1 ? 'refreshing controller sweep once' : `waiting for controller refresh lease (${String(attempt)}/${String(maxAttempts)})`;
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

function isControllerRefreshLeaseHeld(value: unknown) {
  return (typeof value === 'string' ? value : '').includes('resource is leased: other:controller-actions');
}

function isDefaultPacketReportFresh() {
  if (args.packetFile) return false;
  try {
    const report = readPacketReport();
    const freshness = packetFreshness(report, {
      currentLeaseFingerprint: currentLeaseFingerprint(),
      expectedLeaseFingerprint: report.lease_fingerprint ?? null,
      maxAge: maxPacketAgeSeconds(),
    });
    return !freshness.stale;
  } catch {
    return false;
  }
}

function sleep(ms: number|undefined) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readPacketReport(): CleanupReport {
  const file = resolve(args.packetFile ?? DEFAULT_PACKET_FILE);
  if (!existsSync(file)) {
    throw new Error(`cleanup packet file not found: ${file}; run npm run controller:sweep:write`);
  }
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!isRecord(parsed) || !Array.isArray(parsed.packets)) throw new Error(`invalid cleanup packet file: ${file}`);
  const packets = parsed.packets.map(parseCleanupPacket);
  if (!isRecord(parsed.summary)) throw new Error(`invalid cleanup packet summary: ${file}`);
  return { ...parsed, summary: parsed.summary, packets };
}

function parseCleanupPacket(value: unknown): CleanupPacket {
  if (!isRecord(value) || typeof value.rank !== 'number' || typeof value.project !== 'string'
    || typeof value.group !== 'string' || typeof value.brick !== 'string' || typeof value.dirty_path_count !== 'number') {
    throw new Error('invalid cleanup packet entry');
  }
  return { ...value, rank: value.rank, project: value.project, group: value.group, brick: value.brick, dirty_path_count: value.dirty_path_count };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decoratePacketReport(report: CleanupReport, { includeProgress = false } = {}) {
  const active = readActiveLeases({ excludeCurrentWrapperLease: true });
  const freshness = packetFreshness(report, {
    currentLeaseFingerprint: packetLeaseFingerprint(active),
    expectedLeaseFingerprint: report.lease_fingerprint ?? null,
    maxAge: maxPacketAgeSeconds(),
  });
  const dirtyStatusByProject = new Map<string, DirtyStatus>();
  const fingerprintsByProject = new Map<string, LeaseFingerprint>();
  const fingerprintForProject = (project: string) => {
    const key = (project || '');
    if (!fingerprintsByProject.has(key)) {
      fingerprintsByProject.set(key, packetLeaseFingerprint(active, { project }));
    }
    return fingerprintsByProject.get(key);
  };
  const leasesByPacket = new Map<string, ReturnType<typeof readActiveLeases>['leases'][number]>();
  for (const lease of active.leases) {
    if (lease.resource_kind !== 'brick' || !lease.project || !lease.resource_id) continue;
    leasesByPacket.set(packetLeaseKey(lease.project, lease.resource_id), lease);
  }

  const packets = report.packets.map((packet) => {
    const lease = leasesByPacket.get(packetLeaseKey(packet.project, packet.brick));
    const packetFreshnessStatus = packetFreshness(report, {
      currentLeaseFingerprint: fingerprintForProject(packet.project),
      expectedLeaseFingerprint: (packet.lease_fingerprint ?? report.lease_fingerprint) ?? null,
      maxAge: maxPacketAgeSeconds(),
    });
    return {
      ...packet,
      report_freshness: freshness,
      packet_freshness: packetFreshnessStatus,
      packet_stale: args.project ? packetFreshnessStatus.stale : freshness.stale || packetFreshnessStatus.stale,
      ...(includeProgress ? { progress: packetProgress(packet, dirtyStatusByProject) } : {}),
      held: Boolean(lease),
      held_by: lease?.agent_id ?? null,
      held_lease_id: lease?.lease_id ?? null,
      held_ttl_seconds: lease?.ttl_remaining_seconds ?? null,
    };
  });
  const scopedPackets = projectScopedPackets(packets);

  return {
    ...report,
    freshness,
    summary: {
      ...cleanupScopedSummary(report.summary, scopedPackets, {
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

function cleanupScopedSummary(baseSummary: CleanupSummary, packets: CleanupPacket[], { includeProgress = false } = {}) {
  if (!args.project) return baseSummary;
  const dirtyPaths = packets.reduce((sum: number, packet) => sum + (packet.dirty_path_count || 0), 0);
  const activeScopePackets = packets.filter((packet) => packet.packet_type === 'active-dirty-scope');
  const activeScopePaths = activeScopePackets.reduce((sum: number, packet) => sum + (packet.dirty_path_count || 0), 0);
  const defaultWave = packets.slice(0, 12);
  const defaultWavePaths = defaultWave.reduce((sum: number, packet) => sum + (packet.dirty_path_count || 0), 0);
  return {
    ...baseSummary,
    scoped_project: args.project,
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

function currentLeaseFingerprint(project: string | null = null) {
  return packetLeaseFingerprint(readActiveLeases({ excludeCurrentWrapperLease: true }), { project });
}

function packetProgress(packet: CleanupPacket, dirtyStatusByProject: Map<string, DirtyStatus>): CleanupProgress {
  const baseline = (packet.dirty_path_count || 0);
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
  const current = (group?.count ?? 0);
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

function cleanupProgressSummary(packets: CleanupPacket[]) {
  const progressedPackets = packets.filter((packet): packet is CleanupPacket & { progress: CleanupProgress } => packet.progress != null);
  const progressed = progressedPackets.map((packet) => packet.progress);
  const known = progressed.filter((item) => item.current_count !== null);
  const claimablePackets = progressedPackets.filter((packet) => !packet.held && !packet.packet_stale && packet.progress.current_count !== null);
  const heldPackets = progressedPackets.filter((packet) => packet.held && packet.progress.current_count !== null);
  const stalePackets = progressedPackets.filter((packet) => packet.packet_stale && packet.progress.current_count !== null);
  return {
    progress_packet_count: progressed.length,
    progress_known_packet_count: known.length,
    progress_unknown_packet_count: progressed.length - known.length,
    progress_baseline_paths: known.reduce((sum: number, item) => sum + (item.baseline_count || 0), 0),
    progress_remaining_paths: known.reduce((sum: number, item) => sum + (item.current_count ?? 0), 0),
    progress_reduced_paths: known.reduce((sum: number, item) => sum + (item.reduced_count ?? 0), 0),
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

function sumProgress(packets: CleanupPacket[], key: keyof CleanupProgress) {
  return packets.reduce((sum: number, packet) => sum + Number(packet.progress?.[key] ?? 0), 0);
}

function progressState({ baseline, current }: { baseline: number; current: number }) {
  if (current === 0) return 'cleared';
  if (current < baseline) return 'reduced';
  if (current > baseline) return 'grew';
  return 'unchanged';
}

function formatProgress(progress: CleanupProgress | null | undefined) {
  if (!progress) return 'progress unknown';
  if (progress.state === 'unknown') return `progress unknown: ${progress.error ?? 'status unavailable'}`;
  const current = (progress.current_count ?? 0);
  const baseline = (progress.baseline_count || 0);
  const delta = (progress.delta_count ?? 0);
  const pct = progress.reduction_percent === null ? 'n/a' : `${String(progress.reduction_percent)}%`;
  const sign = delta > 0 ? '+' : '';
  return `${progress.state} ${String(current)}/${String(baseline)} remaining, ${sign}${String(delta)}, ${pct} reduced`;
}

function projectDirtyStatus(project: string, dirtyStatusByProject: Map<string, DirtyStatus>): DirtyStatus {
  const key = (project || '');
  const cached = dirtyStatusByProject.get(key);
  if (cached) return cached;
  const status = readProjectDirtyStatus(key);
  dirtyStatusByProject.set(key, status);
  return status;
}

function readProjectDirtyStatus(project: string): DirtyStatus {
  let root;
  try {
    root = projectRoot(project);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), groups: [] };
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
    return { error: err instanceof Error ? err.message : String(err), groups: [] };
  }
}

function dirtyGroups(changes: string[]) {
  const groups = new Map<string, DirtyGroup>();
  for (const line of changes) {
    const key = dirtyGroupKey(statusPath(line));
    const current = groups.get(key) ?? { group: key, count: 0, modified_count: 0, untracked_count: 0 };
    current.count += 1;
    if (line.startsWith('??')) current.untracked_count += 1;
    else current.modified_count += 1;
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => right.count - left.count || left.group.localeCompare(right.group));
}

function statusPath(line: string) {
  const raw = (line || '').slice(3).trim();
  return raw.includes(' -> ') ? (raw.split(' -> ').pop() ?? raw).trim() : raw;
}

function dirtyGroupKey(filePath: string) {
  const path = filePath.replace(/\\/g, '/');
  const parts = path.split('/').filter(Boolean);
  if (!parts.length) return '(root)';
  return infrastructureGroup(parts) ?? sourceGroup(parts) ?? (parts.length === 1 ? '(root)' : parts.slice(0, Math.min(2, parts.length - 1)).join('/'));
}

function infrastructureGroup(parts: string[]): string | null {
  if (parts[0] === '.smarch') return parts.slice(0, 3).join('/') || '.smarch';
  if (parts[0] === 'supabase' && parts[1] === 'functions') return parts.slice(0, 3).join('/');
  if (parts[0] === 'apps' || parts[0] === 'packages') return parts.slice(0, 2).join('/');
  if (parts[0] === 'web' && parts[1] === 'src' && parts[2] === 'modules') return parts.slice(0, 4).join('/');
  return null;
}

function sourceGroup(parts: string[]): string | null {
  if (parts[0] !== 'src') return null;
  return rendererSourceGroup(parts) ?? serviceSourceGroup(parts);
}

function rendererSourceGroup(parts: string[]): string | null {
  if (parts[1] === 'renderer' && (parts[2] === 'modules' || parts[2] === 'features')) {
    return parts.slice(0, 4).join('/');
  }
  if (parts[1] === 'main' && parts[2] === 'services' && parts[3]) {
    return parts.slice(0, 4).join('/');
  }
  return null;
}

function serviceSourceGroup(parts: string[]): string | null {
  if (parts[1] === 'shared' && parts[2]) {
    return parts.slice(0, 3).join('/');
  }
  if (parts[1] === 'services' || parts[1] === 'components' || parts[1] === 'hooks' || parts[1] === 'systems') {
    return parts.slice(0, 3).join('/');
  }
  return null;
}

function cleanupWaveAssignments(packets: CleanupPacket[]): CleanupAssignment[] {
  const waveTotal = packets.reduce((sum: number, packet) => sum + (packet.dirty_path_count || 0), 0);
  return packets.map((packet, index: number) => {
    const count = (packet.dirty_path_count || 0);
    const projectTotal = (packet.parent_dirty_count ?? 0);
    const claimCommand = cleanupPinnedClaimCommand(packet);
    return {
      agent_slot: index + 1,
      rank: packet.rank,
      project: packet.project,
      group: packet.group,
      brick: packet.brick,
      packet_type: packet.packet_type ?? 'dirty-unleased',
      dirty_path_count: count,
      parent_dirty_count: projectTotal || null,
      wave_gain_percent: percent(count, waveTotal),
      project_gain_percent: projectTotal > 0 ? percent(count, projectTotal) : null,
      held: Boolean(packet.held),
      held_by: packet.held_by ?? null,
      held_lease_id: packet.held_lease_id ?? null,
      packet_stale: Boolean(packet.packet_stale),
      progress: packet.progress ?? null,
      claim_command: claimCommand,
      inspect_command: packet.inspect_command ?? null,
      conflict_command: packet.conflict_command ?? null,
      finish_rule: packet.finish_rule ?? '',
      monitor_command: 'npm run gen3:watch -- --no-auto-refresh',
      status_command: 'npm run gen3:status -- --no-auto-refresh',
      sample_paths: packetSamplePaths(packet, 5),
      prompt: cleanupWavePrompt(packet),
    };
  });
}

function cleanupWaveReadiness(assignments: CleanupAssignment[], { targetPaths, claimablePaths, totalCandidates, overflowAfterAssignments }: {
  targetPaths: number; claimablePaths: number; totalCandidates: number; overflowAfterAssignments: number;
}): WaveReadiness {
  const held = assignments.filter((item) => item.held);
  const stale = assignments.filter((item) => item.packet_stale);
  const blocked = assignments.filter((item) => item.held);
  const claimableAssignments = assignments.filter((item) => !item.held && !item.packet_stale);
  const blockedPaths = blocked.reduce((sum: number, item) => sum + (item.dirty_path_count || 0), 0);
  let status = 'ready';
  let recommendedNextCommand = 'npm run cleanup:claim -- --next';
  if (!assignments.length) {
    status = 'empty';
    recommendedNextCommand = 'npm run controller:sweep:write';
  } else if (hasBoth(stale, claimableAssignments)) {
    status = 'partial-stale';
    recommendedNextCommand = 'npm run controller:sweep:write';
  } else if (stale.length) {
    status = 'stale';
    recommendedNextCommand = 'npm run controller:sweep:write';
  } else if (hasBoth(held, claimableAssignments)) {
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
    targeted_dirty_paths: (targetPaths || 0),
    claimable_dirty_paths: (claimablePaths || 0),
    blocked_dirty_paths: blockedPaths,
    claimable_percent: percent(claimablePaths, targetPaths),
    top_wave_gain_percent: assignments[0]?.wave_gain_percent ?? 0,
    top_project_gain_percent: assignments[0]?.project_gain_percent ?? null,
    total_candidate_count: (totalCandidates || assignments.length),
    overflow_count: (overflowAfterAssignments || 0),
    recommended_next_command: recommendedNextCommand,
  };
}

function hasBoth(left: unknown[], right: unknown[]) {
  return left.length > 0 && right.length > 0;
}

function cleanupWavePrompt(packet: CleanupPacket | CleanupAssignment, options: { claimCommand?: string } = {}) {
  const claim = options.claimCommand ?? cleanupPinnedClaimCommand(packet);
  const inspect = packet.inspect_command ?? `npm run controller:snapshot:quiet -- --project ${shellArg(packet.project)}`;
  const conflict = packet.conflict_command ?? `npm run conflict -- report --project ${shellArg(packet.project)} --brick ${shellArg(packet.brick)} --intent ${shellArg(`dirty group ${packet.group} overlaps my work`)} --resolution-plan ${shellArg('claim, split, clean, or hand off before integration')}`;
  return [
    'Use $sma-gen3.',
    `From $SMARCH_DIR run \`${claim}\`.`,
    'Clean or commit only the claimed dirty group.',
    `Use \`${inspect}\` only if exact paths are needed.`,
    `If overlap, uncertainty, or shared-path contention appears, conflict reporting is mandatory: run \`${conflict}\` and back off.`,
    'Keep interim updates big-picture compatible; the controller monitors the wave with `npm run gen3:watch -- --no-auto-refresh`.',
    'Finish with the packet finish rule, use end-edit, and report gates/proof plus the post-release Gen3 TLDR.',
  ].join(' ');
}

function cleanupPinnedClaimCommand(packet: CleanupPacket | CleanupAssignment, options: { dispatchId?: string } = {}) {
  const parts = [
    'npm run cleanup:claim --',
    '--project', shellArg(packet.project),
    '--brick', shellArg(packet.brick),
    '--group', shellArg(packet.group),
    '--dispatch-rank', shellArg(packet.rank),
    '--expected-dirty-path-count', shellArg((packet.dirty_path_count || 0)),
  ];
  if (options.dispatchId) parts.push('--dispatch-id', shellArg(options.dispatchId));
  return parts.join(' ');
}

function percent(part: number, whole: number) {
  const numerator = (part || 0);
  const denominator = (whole || 0);
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function formatNullablePercent(value: number | null | undefined) {
  if (value === null || value === undefined) return 'n/a';
  return `${value.toFixed(1).replace(/\.0$/, '')}%`;
}

function timestampSlug(date: Date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function limitedPackets(report: CleanupReport) {
  const source = args.availableOnly
    ? projectScopedPackets(report.packets).filter((packet) => !packet.held)
    : projectScopedPackets(report.packets);
  const limit = Number(args.limit ?? report.packets.length);
  const safeLimit = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : report.packets.length;
  return source.slice(0, safeLimit);
}

function selectPacket(report: CleanupReport) {
  const decorated = decoratePacketReport(report);
  const hasPinnedIdentity = Boolean(args.brick ?? args.group);
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
  const packet = projectScopedPackets(decorated.packets).find((item) => item.rank === rank);
  if (!packet) throw new Error(`cleanup packet rank not found: ${String(rank)}`);
  return assertPacket(packet);
}

function projectScopedPackets(packets: CleanupPacket[]) {
  if (!args.project) return packets;
  return packets.filter((packet) => packet.project === String(args.project));
}

function selectPinnedPacket(decorated: CleanupReport) {
  for (const key of ['project', 'brick', 'group']) {
    if (!args[key]) throw new Error(`pinned cleanup claim requires --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  const matches = decorated.packets.filter((item) => (
    item.project === String(args.project)
    && item.brick === String(args.brick)
    && item.group === String(args.group)
  ));
  if (!matches.length) {
    throw new Error(`pinned cleanup packet not found: project=${String(args.project)} brick=${String(args.brick)} group=${String(args.group)}; refresh dispatch before assigning this slot`);
  }
  if (matches.length > 1) {
    throw new Error(`pinned cleanup packet is ambiguous: project=${String(args.project)} brick=${String(args.brick)} group=${String(args.group)}`);
  }
  const packet = assertPacket(matches[0]);
  const expectedCount = nullablePositiveInt(args.expectedDirtyPathCount);
  if (expectedCount !== null && (packet.dirty_path_count || 0) !== expectedCount) {
    throw new Error(`pinned cleanup packet dirty count changed: expected ${String(expectedCount)}, current ${(String(packet.dirty_path_count || 0))} for ${packet.project} ${packet.group}; refresh dispatch before assigning this slot`);
  }
  if (packet.held) {
    throw new Error(`pinned cleanup packet is already held: ${packet.project} ${packet.group} by ${packet.held_by ?? 'unknown'} (${packet.held_lease_id ?? 'unknown lease'})`);
  }
  return packet;
}

function assertPacket(packet: CleanupPacket) {
  if (!packet.project) throw new Error(`cleanup packet #${String(packet.rank)} is missing project`);
  if (!packet.group) throw new Error(`cleanup packet #${String(packet.rank)} is missing group`);
  if (!packet.brick) throw new Error(`cleanup packet #${String(packet.rank)} is missing brick`);
  return packet;
}

function packetLeaseKey(project: string, brick: string) {
  return `${project}\0${brick}`;
}

function relativeToSma(filePath: string) {
  return filePath.startsWith(SMA_ROOT) ? filePath.slice(SMA_ROOT.length + 1) : filePath;
}

function shellArg(value: string|number) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function cleanupClaimRationale(packet: CleanupPacket) {
  const fields = [
    `cleanup_packet_rank=${String(packet.dispatch_rank ?? packet.rank)}`,
    `packet_type=${packet.packet_type ?? 'dirty-unleased'}`,
    `group=${packet.group || 'unknown'}`,
    `dirty_paths=${(String(packet.dirty_path_count || 0))}`,
  ];
  if (packet.dispatch_id) fields.push(`dispatch_id=${packet.dispatch_id}`);
  if (packet.dispatch_rank && packet.dispatch_rank !== packet.rank) {
    fields.push(`current_packet_rank=${String(packet.rank)}`);
  }
  if ((packet.parent_dirty_count ?? 0) > 0) {
    fields.push(`parent_dirty_paths=${(String(packet.parent_dirty_count ?? 0))}`);
  }
  return fields.join(' | ');
}

function cleanupTaskId(packet: CleanupPacket) {
  const rank = String(packet.dispatch_rank ?? packet.rank).replace(/[^a-z0-9._-]/gi, '-');
  const project = packet.project.replace(/[^a-z0-9._-]/gi, '-');
  return `cleanup-packet-${project}-${rank}`;
}

function dispatchDecoratedPacket(packet: CleanupPacket): CleanupPacket {
  const dispatchRank = nullablePositiveInt(args.dispatchRank);
  const out: CleanupPacket = {
    ...packet,
    dispatch_rank: dispatchRank ?? null,
    dispatch_id: args.dispatchId ?? null,
  };
  if (!out.dispatch_rank && args.rank) out.dispatch_rank = nullablePositiveInt(args.rank);
  return out;
}

function nullablePositiveInt(value: string|null|undefined) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function packetSamplePaths(packet: CleanupPacket, limit = 8) {
  const out: string[] = [];
  for (const value of packet.sample_paths ?? []) {
    const file = (value || '').trim();
    if (!file || out.includes(file)) continue;
    out.push(file);
    if (out.length >= limit) break;
  }
  return out;
}

function tailOutput(value: unknown) {
  const text = (typeof value === 'string' || typeof value === 'number' ? String(value) : '').trim();
  if (!text) return 'no output';
  return text.split('\n').slice(-8).join('\n');
}

function parseArgs(list: string[]): CleanupArgs {
  const out: CleanupArgs = {};
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_match: string, character: string) => character.toUpperCase());
    const next = list.at(i + 1);
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
