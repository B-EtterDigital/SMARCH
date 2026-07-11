#!/usr/bin/env node
/**
 * WHAT: Reports the live state of a Gen3 cleanup wave in one compact view.
 * WHY: Controllers otherwise have to reconcile preflight, dirty progress, and conflicts manually.
 * HOW: Invokes parallel preflight, cleanup progress, and conflict summary tools as read-only inputs.
 * OUTPUTS: Prints text or structured blockers, gains, packet states, and the next action.
 * CALLERS: Controllers poll it while cleanup agents are active.
 * USAGE: `node tools/sma-wave-monitor.ts --limit 12 --json --no-auto-refresh`
 * Glossary: [Gen3](../docs/GLOSSARY.md).
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { argv, exit, execPath } from 'node:process';
import { fileURLToPath } from 'node:url';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = resolve(SMA_ROOT, 'tools');
const args = parseArgs(argv.slice(2));

interface MonitorArgs { help: boolean; json: boolean; strict: boolean; noAutoRefresh: boolean; allowStale: boolean; limit: string }
interface ToolData {
  summary?: Record<string, unknown>;
  big_picture?: Record<string, unknown>;
  cleanup_wave?: Record<string, unknown>;
  gains?: Record<string, unknown>;
  controller?: Record<string, unknown>;
  graph_packets?: Record<string, unknown>;
  conflict_sla?: Record<string, unknown>;
  status?: string;
  blockers?: string[];
  readiness_score_percent?: unknown;
  recommended_agents?: unknown;
  requested_agents?: unknown;
  primary_next_command?: string;
}
interface ToolProbe { label: string; data?: ToolData; error?: string }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

try {
  if (args.help) {
    usage();
    exit(0);
  }
  const result = runMonitor();
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printText(result);
  }
  if (args.strict && result.status === 'blocked') exit(4);
} catch (err) {
  console.error(`sma-wave-monitor: ${message(err)}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-wave-monitor.ts [--limit 12] [--json] [--strict]
                       [--no-auto-refresh] [--allow-stale]

Reports Gen3 wave progress, conflicts, blockers, gains, and next controller
action without dumping dirty paths.
`);
}

function runMonitor() {
  const limit = positiveInt(args.limit, 12);
  const preflightArgs = [
    resolve(TOOLS_DIR, 'sma-parallel-preflight.ts'),
    '--limit', String(limit),
    '--json',
  ];
  const progressArgs = [
    resolve(TOOLS_DIR, 'sma-cleanup-packets.ts'),
    'progress',
    '--limit', String(limit),
    '--json',
  ];
  if (args.noAutoRefresh) {
    preflightArgs.push('--no-auto-refresh');
    progressArgs.push('--no-auto-refresh');
  }
  if (args.allowStale) {
    preflightArgs.push('--allow-stale');
    progressArgs.push('--allow-stale');
  }

  const preflight = runJsonTool('preflight', preflightArgs);
  const progress = runJsonTool('progress', progressArgs);
  const conflicts = runJsonTool('conflicts', [
    resolve(TOOLS_DIR, 'sma-conflict.ts'),
    'summary',
    '--all',
    '--json',
  ]);

  return summarize({ limit, preflight, progress, conflicts });
}

function summarize({ limit, preflight, progress, conflicts }: { limit: number; preflight: ToolProbe; progress: ToolProbe; conflicts: ToolProbe }) {
  const pre = preflight.data || {};
  const progressSummary = record(progress.data?.summary);
  const conflictSummary = record(conflicts.data?.summary);
  const bigPicture = record(pre.big_picture);
  const cleanupWave = record(pre.cleanup_wave);
  const gains = record(pre.gains);
  const controller = record(pre.controller);
  const graphPackets = record(pre.graph_packets);
  const conflictSla = record(pre.conflict_sla);
  const conflictCount = number(conflictSummary.open_conflicts ?? conflictSla.open_conflicts);
  const criticalConflicts = number(conflictSummary.critical_conflicts);
  const warningConflicts = number(conflictSummary.warning_conflicts);
  const baselinePaths = number(progressSummary.progress_baseline_paths || cleanupWave.targeted_dirty_paths || progressSummary.default_wave_dirty_paths);
  const remainingPaths = number(progressSummary.progress_remaining_paths || cleanupWave.claimable_dirty_paths);
  const reducedPaths = number(progressSummary.progress_reduced_paths);
  const reductionPercent = baselinePaths > 0 ? percent(reducedPaths, baselinePaths) : 0;
  const heldPackets = number(progressSummary.progress_held_packet_count ?? cleanupWave.held_assignment_count);
  const stalePackets = number(progressSummary.progress_stale_packet_count ?? cleanupWave.stale_assignment_count);
  const grewPackets = number(progressSummary.progress_grew_packet_count);
  const clearedPackets = number(progressSummary.progress_cleared_packet_count);
  const reducedPackets = number(progressSummary.progress_reduced_packet_count);
  const packetAgeSeconds = number(progressSummary.packet_age_seconds);
  const packetMaxAgeSeconds = number(progressSummary.packet_max_age_seconds || 900);
  const packetStale = Boolean(progressSummary.packet_stale || cleanupWave.packet_file_stale);
  const toolErrors = [preflight, progress, conflicts].filter((probe) => probe.error);
  const blocked = toolErrors.length > 0
    || pre.status === 'blocked'
    || conflictCount > 0
    || criticalConflicts > 0
    || packetStale
    || heldPackets > 0
    || stalePackets > 0;
  const status = blocked ? 'blocked' : 'ready';
  const blockers = [
    ...toolErrors.map((probe) => `${probe.label}: ${probe.error}`),
    pre.status === 'blocked' ? (pre.blockers || []).join('; ') : null,
    conflictCount > 0 ? `${conflictCount} open conflict(s)` : null,
    criticalConflicts > 0 ? `${criticalConflicts} critical conflict SLA item(s)` : null,
    packetStale ? 'cleanup packet file is stale' : null,
    heldPackets > 0 ? `${heldPackets} cleanup packet(s) held` : null,
    stalePackets > 0 ? `${stalePackets} cleanup packet(s) stale` : null,
  ].filter((value): value is string => Boolean(value));
  const warnings = [
    warningConflicts > 0 ? `${warningConflicts} warning conflict SLA item(s)` : null,
    grewPackets > 0 ? `${grewPackets} cleanup packet(s) grew` : null,
    number(controller.active_leases) > 0 ? `${number(controller.active_leases)} active lease(s)` : null,
    number(gains.overflow_groups) > 0 ? `${number(gains.overflow_groups)} cleanup group(s) outside selected wave` : null,
  ].filter((value): value is string => Boolean(value));
  const next = chooseNext({
    conflictCount,
    criticalConflicts,
    packetStale,
    heldPackets,
    stalePackets,
    remainingPaths,
    baselinePaths,
    primaryNext: pre.primary_next_command,
    limit,
  });

  return {
    generated_at: new Date().toISOString(),
    status,
    limit,
    big_picture: bigPicture.tldr || pre.status || 'unknown',
    readiness_score_percent: number(pre.readiness_score_percent),
    agents: {
      recommended: number(pre.recommended_agents),
      requested: number(pre.requested_agents || limit),
      launch_slots: number(record(bigPicture.current_state).launch_slots ?? cleanupWave.launch_plan_slots),
    },
    wave: {
      baseline_paths: baselinePaths,
      remaining_paths: remainingPaths,
      reduced_paths: reducedPaths,
      reduction_percent: reductionPercent,
      cleared_packets: clearedPackets,
      reduced_packets: reducedPackets,
      grew_packets: grewPackets,
      held_packets: heldPackets,
      stale_packets: stalePackets,
      claimable_percent: number(cleanupWave.claimable_percent),
      packet_age_seconds: packetAgeSeconds,
      packet_max_age_seconds: packetMaxAgeSeconds,
      packet_stale: packetStale,
    },
    conflicts: {
      open: conflictCount,
      warning: warningConflicts,
      critical: criticalConflicts,
      oldest_age_minutes: number(conflictSummary.oldest_age_minutes),
      status: conflictSummary.status || 'unknown',
    },
    controller: {
      active_leases: number(controller.active_leases),
      dirty_unleased_projects: number(controller.dirty_unleased_projects),
      active_dirty_scope_projects: number(controller.active_dirty_scope_projects),
      active_dirty_scope_paths: number(controller.active_dirty_scope_paths),
      graph_packets: number(graphPackets.packet_count),
      project_graph_gaps: number(graphPackets.project_graph_gaps ?? graphPackets.project_gap_count),
      module_graph_gaps: number(graphPackets.module_graph_gap_count ?? graphPackets.module_gap_count),
    },
    gains: {
      top_wave_percent: number(gains.selected_wave_top_gain_percent),
      top_project_percent: number(gains.selected_project_top_gain_percent),
      command_roundtrip_reduction_percent: number(gains.coordination_roundtrip_reduction_percent_estimate),
      dirty_status_token_reduction_percent: number(gains.dirty_status_token_reduction_percent_estimate),
      overflow_groups: number(gains.overflow_groups),
    },
    blockers,
    warnings,
    next,
    current_slice: bigPicture.current_slice || '',
    outlook: Array.isArray(bigPicture.next_slices) ? bigPicture.next_slices.map(String) : [],
    horizon: Array.isArray(bigPicture.horizon) ? bigPicture.horizon.map(String) : [],
  };
}

function chooseNext({ conflictCount, criticalConflicts, packetStale, heldPackets, stalePackets, remainingPaths, baselinePaths, primaryNext, limit }: {
  conflictCount: number; criticalConflicts: number; packetStale: boolean; heldPackets: number;
  stalePackets: number; remainingPaths: number; baselinePaths: number; primaryNext?: string; limit: number;
}): string {
  if (conflictCount > 0 || criticalConflicts > 0) return 'npm run conflict:summary';
  if (packetStale || stalePackets > 0) return 'npm run controller:sweep:write';
  if (heldPackets > 0) return `npm run cleanup:progress -- --limit ${limit}`;
  if (baselinePaths > 0 && remainingPaths === 0) return 'npm run controller:sweep:write';
  if (primaryNext) return primaryNext;
  return `npm run cleanup:progress -- --limit ${limit}`;
}

function printText(result: ReturnType<typeof summarize>): void {
  console.log('SMA Gen3 Wave Monitor');
  console.log(`big picture:      ${result.big_picture}`);
  if (result.current_slice) console.log(`current slice:    ${result.current_slice}`);
  console.log(`score:            ${result.readiness_score_percent}%`);
  console.log(`status:           ${result.status}`);
  console.log(`agents:           ${result.agents.recommended}/${result.agents.requested} recommended; ${result.agents.launch_slots} launch slots`);
  console.log(`wave progress:    ${result.wave.reduced_paths}/${result.wave.baseline_paths} paths reduced (${formatPercent(result.wave.reduction_percent)}), ${result.wave.remaining_paths} remaining`);
  console.log(`packets:          ${result.wave.cleared_packets} cleared, ${result.wave.reduced_packets} reduced, ${result.wave.grew_packets} grew, ${result.wave.held_packets} held, ${result.wave.stale_packets} stale`);
  console.log(`packet age:       ${result.wave.packet_age_seconds}s/${result.wave.packet_max_age_seconds}s${result.wave.packet_stale ? ' stale' : ''}`);
  console.log(`conflicts:        ${result.conflicts.open} open, ${result.conflicts.warning}/${result.conflicts.critical} warning/critical, oldest ${result.conflicts.oldest_age_minutes}m`);
  console.log(`controller:       ${result.controller.active_leases} leases, ${result.controller.dirty_unleased_projects} dirty-unleased projects, ${result.controller.active_dirty_scope_projects} dirty-scope blockers`);
  console.log(`graphs:           ${result.controller.graph_packets} packets, ${result.controller.project_graph_gaps} project gaps, ${result.controller.module_graph_gaps} module gaps`);
  console.log(`gains:            top wave ${formatPercent(result.gains.top_wave_percent)}, top project ${formatPercent(result.gains.top_project_percent)}, ${result.gains.command_roundtrip_reduction_percent}% fewer controller command round trips`);
  if (result.blockers.length) console.log(`blockers:         ${result.blockers.join('; ')}`);
  if (result.warnings.length) console.log(`warnings:         ${result.warnings.join('; ')}`);
  for (const [index, item] of result.outlook.slice(0, 3).entries()) {
    console.log(`outlook ${index + 1}:        ${item}`);
  }
  if (result.horizon.length) console.log(`horizon:          ${result.horizon.slice(0, 3).join(' | ')}`);
  console.log(`next:             ${result.next}`);
}

function runJsonTool(label: string, commandArgs: string[]): ToolProbe {
  try {
    const stdout = execFileSync(execPath, commandArgs, {
      cwd: SMA_ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    return { label, data: JSON.parse(stdout) };
  } catch (err) {
    return {
      label,
      error: firstLine(err && typeof err === 'object' && 'stderr' in err ? err.stderr : '') || firstLine(message(err)) || 'failed',
    };
  }
}

function parseArgs(list: string[]): MonitorArgs {
  const out: MonitorArgs = { help: false, json: false, strict: false, noAutoRefresh: false, allowStale: false, limit: '' };
  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item === '--help' || item === '-h') {
      out.help = true;
      continue;
    }
    if (!item.startsWith('--')) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_match: string, character: string) => character.toUpperCase());
    const next = list[i + 1];
    if (!next || next.startsWith('--')) {
      Object.assign(out, { [key]: true });
      continue;
    }
    Object.assign(out, { [key]: next });
    i += 1;
  }
  return out;
}

function positiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percent(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function formatPercent(value: number): string {
  return `${number(value).toFixed(1).replace(/\.0$/, '')}%`;
}

function firstLine(value: unknown): string {
  return String(value || '').split(/\r?\n/).find((line) => line.trim())?.trim() || '';
}
