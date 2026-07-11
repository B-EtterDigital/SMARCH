#!/usr/bin/env node
/* Defensive external-input guards and JavaScript coercion semantics are intentional in this behavior-preserving strict-type pass. */
/* eslint @typescript-eslint/no-unnecessary-boolean-literal-compare: "off", @typescript-eslint/no-unnecessary-condition: "off", @typescript-eslint/no-useless-default-assignment: "off", @typescript-eslint/prefer-nullish-coalescing: "off", @typescript-eslint/array-type: "off", max-lines-per-function: "off", complexity: "off", @typescript-eslint/prefer-optional-chain: "off", @typescript-eslint/no-base-to-string: "off", @typescript-eslint/no-unnecessary-type-conversion: "off", @typescript-eslint/restrict-template-expressions: "off", @typescript-eslint/use-unknown-in-catch-callback-variable: "off" */
/**
 * WHAT: Compares a cleanup dispatch with current state and records observed outcomes.
 * WHY: Predicted wave gains are not proof that assigned dirty paths were actually reduced.
 * HOW: Reads a dispatch manifest and the live wave-monitor report, then derives packet outcomes.
 * OUTPUTS: Prints an observation and optionally writes durable files under handoffs/waves/observations.
 * CALLERS: Controllers run it before assigning the next cleanup wave.
 * USAGE: `node tools/sma-wave-observe.ts --help`
 * Glossary: [Gen3](../docs/GLOSSARY.md).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { argv, exit, execPath } from 'node:process';
import { fileURLToPath } from 'node:url';
import { readContextLog } from './lib/context-log.ts';
import { readActiveLeases } from './lib/gen3-state.ts';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = resolve(SMA_ROOT, 'tools');
const WAVE_DIR = resolve(SMA_ROOT, 'handoffs/waves');
const OBSERVATION_DIR = resolve(WAVE_DIR, 'observations');
const args = parseArgs(argv.slice(2));
const CLAIM_KINDS = new Set(['lease_acquired', 'lease_force_acquired', 'edit_planned']);
const COMPLETE_KINDS = new Set(['edit_applied']);

interface WaveArgs extends Record<string, string | boolean | undefined> {
  help?: boolean;
  write?: string | boolean;
  json?: boolean;
  strict?: boolean;
  dispatch?: string;
  limit?: string;
  noAutoRefresh?: boolean;
  allowStale?: boolean;
  timeoutMs?: string;
}
interface CleanupAssignment {
  agent_slot?: unknown;
  rank?: unknown;
  project?: string;
  brick?: string;
  group?: string;
  dirty_path_count?: unknown;
  wave_gain_percent?: unknown;
  project_gain_percent?: unknown;
  claim_command?: string;
  conflict_command?: string;
}
interface DispatchManifest {
  kind?: string;
  dispatch_id?: string;
  created_at?: string;
  assignments?: CleanupAssignment[];
  summary?: { targeted_dirty_paths?: unknown; claimable_dirty_paths?: unknown };
  readiness?: { top_wave_gain_percent?: unknown; top_project_gain_percent?: unknown };
}
interface ClaimPinning {
  assignment_count: number;
  pinned_assignment_count: number;
  legacy_rank_only_assignment_count: number;
  required_flags: string[];
}
interface LoadedDispatch {
  path: string;
  manifest: DispatchManifest;
  dispatch_id: string;
  created_at: string | null;
  assignment_count: number;
  claim_pinning: ClaimPinning;
  targeted_dirty_paths: number;
  claimable_dirty_paths: number;
  top_wave_gain_percent: number;
  top_project_gain_percent: number | null;
  assignments: CleanupAssignment[];
}
interface MonitorData {
  status?: string;
  readiness_score_percent?: unknown;
  blockers?: string[];
  warnings?: string[];
  wave?: Record<string, unknown>;
  conflicts?: Record<string, unknown>;
  controller?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  gains?: Record<string, unknown>;
  current_slice?: string;
  outlook?: string[];
  horizon?: string[];
  next?: string;
}
interface ToolResult { label: string; data: MonitorData | null; error?: string }
interface ContextEvent {
  _malformed?: boolean;
  event_id?: string;
  kind?: string;
  timestamp?: string;
  actor_id?: string;
  task_id?: string;
  lease_id?: string;
  decision_rationale?: string;
  intent?: string;
  files_touched?: string[];
}
interface ActiveLease {
  lease_id?: string;
  project?: string;
  resource_kind?: string;
  resource_id?: string;
  agent_id?: string;
  acquired_at?: string;
  expires_at?: string;
  intent?: string;
}
interface LeaseState { generated_at: string | null; leases: ActiveLease[]; error: string | null }
interface ReceiptSummary {
  assignment_count: number; dispatched_count: number; claimed_count: number; active_count: number; completed_count: number; unclaimed_count: number; context_error_count: number;
  status_counts: Record<string, number>;
  active_lease_registry_generated_at: string | null;
  active_lease_registry_error: string | null;
  assignments: ReturnType<typeof assignmentReceipt>[];
}
interface NextInput {
  status: string;
  openConflicts: number;
  criticalConflicts: number;
  stalePackets: number;
  heldPackets: number;
  remainingPaths: number;
  graphPackets: number;
  dispatchMissing: boolean;
  legacyDispatch: boolean;
  limit: number;
  monitorNext?: string;
}

function isActiveLease(value: unknown): value is ActiveLease {
  if (typeof value !== 'object' || value === null) return false;
  const lease = value as Record<string, unknown>;
  return ['lease_id', 'project', 'resource_kind', 'resource_id', 'agent_id', 'acquired_at', 'expires_at', 'intent']
    .every((key) => lease[key] === undefined || typeof lease[key] === 'string');
}

try {
  if (args.help) {
    usage();
    exit(0);
  }
  const report: ReturnType<typeof summarizeObservation> & { observation_artifacts?: ReturnType<typeof writeObservation> } = observeWave();
  if (args.write) {
    report.observation_artifacts = writeObservation(report);
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printText(report);
  }
  if (args.strict && report.status === 'blocked') exit(4);
} catch (error: unknown) {
  console.error(`sma-wave-observe: ${error instanceof Error ? error.message : String(error)}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-wave-observe.ts [--dispatch latest|path] [--limit 12]
                       [--write [path]] [--json] [--strict]
                       [--no-auto-refresh] [--allow-stale]

Compares a cleanup-wave dispatch manifest with current Gen3 wave monitor data.
Use --write to persist JSON and Markdown observations under handoffs/waves/.
`);
}

function observeWave(): ReturnType<typeof summarizeObservation> {
  const dispatch = loadDispatch(args.dispatch || 'latest');
  const limit = positiveInt(args.limit, dispatch?.assignment_count || dispatch?.manifest?.assignments?.length || 12);
  const monitorArgs = [
    resolve(TOOLS_DIR, 'sma-wave-monitor.ts'),
    '--limit', String(limit),
    '--json',
  ];
  if (args.noAutoRefresh) monitorArgs.push('--no-auto-refresh');
  if (args.allowStale) monitorArgs.push('--allow-stale');
  const monitor = runJsonTool('monitor', monitorArgs);
  const report = summarizeObservation({
    generatedAt: new Date().toISOString(),
    limit,
    dispatch,
    monitor,
  });
  return report;
}

function loadDispatch(input: unknown): LoadedDispatch | null {
  const raw = String(input || '').trim();
  const path = raw === 'latest' ? latestDispatchPath() : resolve(SMA_ROOT, raw);
  if (!path) return null;
  if (!existsSync(path)) throw new Error(`dispatch manifest not found: ${path}`);
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as DispatchManifest;
  if (manifest.kind !== 'cleanup-wave-dispatch') {
    throw new Error(`not a cleanup-wave-dispatch manifest: ${path}`);
  }
  return {
    path,
    manifest,
    dispatch_id: manifest.dispatch_id || basename(path, '.json'),
    created_at: manifest.created_at || null,
    assignment_count: Array.isArray(manifest.assignments) ? manifest.assignments.length : 0,
    claim_pinning: summarizeDispatchClaimPinning(manifest.assignments),
    targeted_dirty_paths: number(manifest.summary?.targeted_dirty_paths),
    claimable_dirty_paths: number(manifest.summary?.claimable_dirty_paths),
    top_wave_gain_percent: number(manifest.readiness?.top_wave_gain_percent),
    top_project_gain_percent: nullableNumber(manifest.readiness?.top_project_gain_percent),
    assignments: Array.isArray(manifest.assignments) ? manifest.assignments : [],
  };
}

function latestDispatchPath(): string | null {
  if (!existsSync(WAVE_DIR)) return null;
  const candidates = readdirSync(WAVE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^cleanup-wave-.*\.json$/.test(entry.name))
    .map((entry) => resolve(WAVE_DIR, entry.name))
    .sort((left, right) => right.localeCompare(left));
  return candidates[0] || null;
}

function summarizeObservation({ generatedAt, limit, dispatch, monitor }: { generatedAt: string; limit: number; dispatch: LoadedDispatch | null; monitor: ToolResult }) {
  const mon = monitor.data ?? {};
  const wave = mon.wave ?? {};
  const conflicts = mon.conflicts ?? {};
  const controller = mon.controller ?? {};
  const receipts = summarizeReceipts(dispatch);
  const blockers = [
    monitor.error ? `monitor: ${monitor.error}` : null,
    ...(Array.isArray(mon.blockers) ? mon.blockers : []),
  ].filter((item): item is string => typeof item === 'string' && item.length > 0);
  const warnings = Array.isArray(mon.warnings) ? mon.warnings.slice() : [];
  const dispatchMissing = !dispatch;
  const legacyAssignmentCount = dispatch?.claim_pinning.legacy_rank_only_assignment_count ?? 0;
  if (dispatchMissing) warnings.push('no dispatch manifest found; observation is monitor-only');
  if (legacyAssignmentCount > 0) {
    blockers.push(`${legacyAssignmentCount} dispatch assignment(s) use legacy rank-only claim commands`);
    warnings.push('legacy rank-only dispatch manifest; regenerate dispatch before assigning agents');
  }

  const baselinePaths = number(dispatch?.targeted_dirty_paths || wave.baseline_paths);
  const remainingPaths = number(wave.remaining_paths);
  const reducedPaths = number(wave.reduced_paths);
  const reductionPercent = baselinePaths > 0 ? percent(reducedPaths, baselinePaths) : 0;
  const completionPercent = baselinePaths > 0 ? percent(Math.max(0, baselinePaths - remainingPaths), baselinePaths) : 0;
  const openConflicts = number(conflicts.open);
  const criticalConflicts = number(conflicts.critical);
  const heldPackets = number(wave.held_packets);
  const stalePackets = number(wave.stale_packets);
  const grewPackets = number(wave.grew_packets);
  const graphPackets = number(controller.graph_packets);

  let status = dispatchMissing ? 'dispatch-missing' : 'no-movement';
  if (monitor.error || mon.status === 'blocked' || openConflicts > 0 || criticalConflicts > 0 || heldPackets > 0 || stalePackets > 0 || (dispatch?.claim_pinning.legacy_rank_only_assignment_count ?? 0) > 0) {
    status = 'blocked';
  } else if (baselinePaths > 0 && remainingPaths === 0) {
    status = 'complete';
  } else if (reducedPaths > 0) {
    status = 'improving';
  } else if (number(controller.active_leases) > 0) {
    status = 'in-progress';
  }

  const next = chooseNext({
    status,
    openConflicts,
    criticalConflicts,
    stalePackets,
    heldPackets,
    remainingPaths,
    graphPackets,
    dispatchMissing,
    legacyDispatch: (dispatch?.claim_pinning.legacy_rank_only_assignment_count ?? 0) > 0,
    limit,
    monitorNext: mon.next,
  });

  return {
    schema_version: '1.0.0',
    kind: 'cleanup-wave-observation',
    generated_at: generatedAt,
    status,
    limit,
    dispatch: dispatch
      ? {
          dispatch_id: dispatch.dispatch_id,
          path: relativeToSma(dispatch.path),
          created_at: dispatch.created_at,
          assignment_count: dispatch.assignment_count,
          targeted_dirty_paths: dispatch.targeted_dirty_paths,
          claimable_dirty_paths: dispatch.claimable_dirty_paths,
          top_wave_gain_percent: dispatch.top_wave_gain_percent,
          top_project_gain_percent: dispatch.top_project_gain_percent,
          claim_pinning: dispatch.claim_pinning,
          assignments: dispatch.assignments.map((item) => ({
            agent_slot: item.agent_slot,
            rank: item.rank,
            project: item.project,
            group: item.group,
            dirty_path_count: item.dirty_path_count,
            wave_gain_percent: item.wave_gain_percent,
            project_gain_percent: item.project_gain_percent,
            claim_command: item.claim_command,
            conflict_command: item.conflict_command,
            receipt: receiptForAssignment(receipts, item),
          })),
        }
      : null,
    receipts,
    observed: {
      monitor_status: mon.status || 'unknown',
      readiness_score_percent: number(mon.readiness_score_percent),
      recommended_agents: number(mon.agents?.recommended),
      launch_slots: number(mon.agents?.launch_slots),
      baseline_paths: baselinePaths,
      remaining_paths: remainingPaths,
      reduced_paths: reducedPaths,
      reduction_percent: reductionPercent,
      completion_percent: completionPercent,
      cleared_packets: number(wave.cleared_packets),
      reduced_packets: number(wave.reduced_packets),
      grew_packets: grewPackets,
      held_packets: heldPackets,
      stale_packets: stalePackets,
      packet_age_seconds: number(wave.packet_age_seconds),
      open_conflicts: openConflicts,
      warning_conflicts: number(conflicts.warning),
      critical_conflicts: criticalConflicts,
      graph_packets: graphPackets,
      project_graph_gaps: number(controller.project_graph_gaps),
      module_graph_gaps: number(controller.module_graph_gaps),
      active_leases: number(controller.active_leases),
      dirty_unleased_projects: number(controller.dirty_unleased_projects),
      active_dirty_scope_projects: number(controller.active_dirty_scope_projects),
      top_wave_gain_percent: number(mon.gains?.top_wave_percent),
      top_project_gain_percent: number(mon.gains?.top_project_percent),
      command_roundtrip_reduction_percent: number(mon.gains?.command_roundtrip_reduction_percent),
      dirty_status_token_reduction_percent: number(mon.gains?.dirty_status_token_reduction_percent),
    },
    comparison: {
      predicted_targeted_dirty_paths: dispatch?.targeted_dirty_paths ?? null,
      actual_baseline_paths: baselinePaths,
      predicted_top_wave_gain_percent: dispatch?.top_wave_gain_percent ?? null,
      observed_reduction_percent: reductionPercent,
      observed_completion_percent: completionPercent,
      dispatch_vs_observed_path_delta: dispatch ? baselinePaths - number(dispatch.targeted_dirty_paths) : null,
    },
    blockers,
    warnings,
    current_slice: mon.current_slice || '',
    outlook: Array.isArray(mon.outlook) ? mon.outlook.slice(0, 3) : [],
    horizon: Array.isArray(mon.horizon) ? mon.horizon.slice(0, 3) : [],
    next,
  };
}

function chooseNext({ status, openConflicts, criticalConflicts, stalePackets, heldPackets, remainingPaths, graphPackets, dispatchMissing, legacyDispatch, limit, monitorNext }: NextInput): string {
  if (dispatchMissing) return `npm run gen3:dispatch -- --limit ${limit || 12}`;
  if (legacyDispatch) return `npm run gen3:dispatch -- --limit ${limit || 12}`;
  if (openConflicts > 0 || criticalConflicts > 0) return 'npm run conflict:summary';
  if (graphPackets > 0) return 'npm run graph:claim -- --next';
  if (stalePackets > 0) return 'npm run controller:sweep:write';
  if (heldPackets > 0) return 'npm run cleanup:progress -- --limit 12';
  if (status === 'complete' || remainingPaths === 0) return 'npm run controller:sweep:write';
  return monitorNext || 'npm run gen3:watch -- --no-auto-refresh';
}

function summarizeDispatchClaimPinning(assignments: CleanupAssignment[] | undefined): ClaimPinning {
  const list = Array.isArray(assignments) ? assignments : [];
  const pinned = list.filter((item) => isPinnedClaimCommand(item.claim_command));
  return {
    assignment_count: list.length,
    pinned_assignment_count: pinned.length,
    legacy_rank_only_assignment_count: Math.max(0, list.length - pinned.length),
    required_flags: ['--project', '--brick', '--group', '--dispatch-rank', '--expected-dirty-path-count', '--dispatch-id'],
  };
}

function isPinnedClaimCommand(command: unknown): boolean {
  const text = String(command || '');
  return ['--project', '--brick', '--group', '--dispatch-rank', '--expected-dirty-path-count', '--dispatch-id']
    .every((flag) => text.includes(flag));
}

function summarizeReceipts(dispatch: LoadedDispatch | null): ReceiptSummary {
  const assignments = Array.isArray(dispatch?.assignments) ? dispatch.assignments : [];
  if (!assignments.length) return emptyReceiptSummary();

  const leaseState = safeReadActiveLeases();
  const receipts = assignments.map((assignment) => assignmentReceipt(assignment, leaseState.leases));
  const statusCounts: Record<string, number> = {};
  for (const receipt of receipts) statusCounts[receipt.status] = (statusCounts[receipt.status] || 0) + 1;

  return {
    assignment_count: assignments.length,
    dispatched_count: assignments.length,
    claimed_count: receipts.filter((receipt) => receipt.claimed).length,
    active_count: receipts.filter((receipt) => receipt.active).length,
    completed_count: receipts.filter((receipt) => receipt.completed).length,
    unclaimed_count: receipts.filter((receipt) => !receipt.claimed).length,
    context_error_count: receipts.filter((receipt) => receipt.context_error).length,
    status_counts: statusCounts,
    active_lease_registry_generated_at: leaseState.generated_at,
    active_lease_registry_error: leaseState.error || null,
    assignments: receipts,
  };
}

function emptyReceiptSummary(): ReceiptSummary {
  return {
    assignment_count: 0,
    dispatched_count: 0,
    claimed_count: 0,
    active_count: 0,
    completed_count: 0,
    unclaimed_count: 0,
    context_error_count: 0,
    status_counts: {},
    active_lease_registry_generated_at: null,
    active_lease_registry_error: null,
    assignments: [] as ReturnType<typeof assignmentReceipt>[],
  };
}

function safeReadActiveLeases(): LeaseState {
  try {
    const stateValue: unknown = readActiveLeases({
      excludeVolatileSmaRegenLeases: true,
    });
    const state = typeof stateValue === 'object' && stateValue !== null ? stateValue as Record<string, unknown> : {};
    const leases = Array.isArray(state.leases)
      ? (state.leases as unknown[]).filter(isActiveLease)
      : [];
    return {
      generated_at: typeof state.generated_at === 'string' ? state.generated_at : null,
      leases,
      error: typeof state._error === 'string' ? state._error : null,
    };
  } catch (error: unknown) {
    return {
      generated_at: null,
      leases: [],
      error: error instanceof Error ? error.message : 'failed to read active leases',
    };
  }
}

function assignmentReceipt(assignment: CleanupAssignment, activeLeases: readonly ActiveLease[]) {
  const activeMatches = activeLeases.filter((lease) => leaseMatchesAssignment(lease, assignment));
  const context = safeReadAssignmentContext(assignment);
  const events = context.events;
  const claimEvents = events.filter((event) => typeof event.kind === 'string' && CLAIM_KINDS.has(event.kind) && eventMatchesAssignment(event, assignment));
  const claimLeaseIds = new Set([
    ...claimEvents.map((event) => event.lease_id).filter((id): id is string => typeof id === 'string'),
    ...activeMatches.map((lease) => lease.lease_id).filter((id): id is string => typeof id === 'string'),
  ]);
  const completionEvents = events.filter((event) => (
    typeof event.kind === 'string' && COMPLETE_KINDS.has(event.kind)
    && (eventMatchesAssignment(event, assignment) || (typeof event.lease_id === 'string' && claimLeaseIds.has(event.lease_id)))
  ));
  const active = activeMatches.length > 0;
  const completed = completionEvents.length > 0;
  const claimed = completed || active || claimEvents.length > 0;
  const status = completed
    ? 'completed'
    : active
      ? 'active'
      : claimEvents.length
        ? 'claimed'
        : context.error
          ? 'context-error'
          : 'unclaimed';

  return {
    key: assignmentKey(assignment),
    agent_slot: assignment.agent_slot ?? null,
    rank: assignment.rank ?? null,
    project: assignment.project ?? null,
    brick: assignment.brick ?? null,
    group: assignment.group ?? null,
    dirty_path_count: number(assignment.dirty_path_count),
    status,
    claimed,
    active,
    completed,
    context_error: context.error || null,
    context_events_checked: events.length,
    claim_event_count: claimEvents.length,
    completion_event_count: completionEvents.length,
    active_lease_count: activeMatches.length,
    latest_claim_event: summarizeContextEvent(latestEvent(claimEvents)),
    latest_completion_event: summarizeContextEvent(latestEvent(completionEvents)),
    active_leases: activeMatches.map(summarizeLease),
  };
}

function safeReadAssignmentContext(assignment: CleanupAssignment): { events: ContextEvent[]; error: string | null } {
  try {
    if (!assignment.project || !assignment.brick) return { events: [], error: 'assignment project or brick is missing' };
    return { events: readContextLog(assignment.project, assignment.brick), error: null };
  } catch (error: unknown) {
    return { events: [], error: error instanceof Error ? error.message : 'failed to read context log' };
  }
}

function leaseMatchesAssignment(lease: ActiveLease, assignment: CleanupAssignment): boolean {
  return lease
    && lease.project === assignment.project
    && lease.resource_kind === 'brick'
    && lease.resource_id === assignment.brick;
}

function eventMatchesAssignment(event: ContextEvent, assignment: CleanupAssignment): boolean {
  if (!event || event._malformed) return false;
  const taskId = cleanupTaskId(assignment);
  if (event.task_id && event.task_id === taskId) return true;
  const text = eventSearchText(event);
  if (text.includes(taskId)) return true;
  if (text.includes(`cleanup_packet_rank=${assignment.rank}`)) return true;
  const group = String(assignment.group || '');
  const dirtyPaths = String(number(assignment.dirty_path_count));
  if (group && text.includes(`group=${group}`) && text.includes(`dirty_paths=${dirtyPaths}`)) return true;
  if (group && text.includes(`claim dirty group ${group}`)) return true;
  return false;
}

function eventSearchText(event: ContextEvent): string {
  return [
    event.task_id,
    event.decision_rationale,
    event.intent,
    event.lease_id,
    ...(Array.isArray(event.files_touched) ? event.files_touched : []),
  ].filter(Boolean).join(' ');
}

function cleanupTaskId(assignment: CleanupAssignment): string {
  const rank = String(assignment.rank ?? 'unknown').replace(/[^a-z0-9._-]/gi, '-');
  const project = String(assignment.project ?? 'project').replace(/[^a-z0-9._-]/gi, '-');
  return `cleanup-packet-${project}-${rank}`;
}

function receiptForAssignment(receipts: ReceiptSummary, assignment: CleanupAssignment) {
  const key = assignmentKey(assignment);
  return receipts.assignments.find((receipt) => receipt.key === key) || null;
}

function assignmentKey(assignment: CleanupAssignment): string {
  return [
    assignment.project ?? '',
    assignment.brick ?? '',
    assignment.rank ?? '',
  ].join(':');
}

function latestEvent(events: readonly ContextEvent[]): ContextEvent | null {
  if (!events.length) return null;
  const sorted: ContextEvent[] = [...events];
  sorted.sort((left, right) => Date.parse(right.timestamp || '') - Date.parse(left.timestamp || ''));
  return sorted[0] ?? null;
}

function summarizeContextEvent(event: ContextEvent | null) {
  if (!event) return null;
  return {
    event_id: event.event_id || null,
    kind: event.kind || null,
    timestamp: event.timestamp || null,
    actor_id: event.actor_id || null,
    lease_id: event.lease_id || null,
    task_id: event.task_id || null,
  };
}

function summarizeLease(lease: ActiveLease) {
  return {
    lease_id: lease.lease_id || null,
    agent_id: lease.agent_id || null,
    acquired_at: lease.acquired_at || null,
    expires_at: lease.expires_at || null,
    intent: lease.intent || null,
  };
}

function writeObservation(report: ReturnType<typeof summarizeObservation>) {
  const base = observationBasePath(report);
  const jsonPath = `${base}.json`;
  const markdownPath = `${base}.md`;
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderObservationMarkdown(report));
  return {
    json_path: relativeToSma(jsonPath),
    markdown_path: relativeToSma(markdownPath),
  };
}

function observationBasePath(report: ReturnType<typeof summarizeObservation>): string {
  if (args.write !== true) {
    return resolve(SMA_ROOT, String(args.write || '').trim()).replace(/\.(json|md)$/i, '');
  }
  const dispatchId = report.dispatch?.dispatch_id || 'monitor-only';
  return resolve(OBSERVATION_DIR, `${dispatchId}-observed-${timestampSlug(new Date())}`);
}

function renderObservationMarkdown(report: ReturnType<typeof summarizeObservation>): string {
  const lines: string[] = [
    '# SMA Gen3 Cleanup Wave Observation',
    '',
    `- Status: ${report.status}`,
    `- Generated: ${report.generated_at}`,
    `- Dispatch: ${report.dispatch ? report.dispatch.dispatch_id : 'none'}`,
    `- Agents: ${report.observed.recommended_agents}/${report.limit} recommended; ${report.observed.launch_slots} launch slots`,
    `- Receipts: ${report.receipts.claimed_count}/${report.receipts.assignment_count} claimed, ${report.receipts.active_count} active, ${report.receipts.completed_count} completed, ${report.receipts.unclaimed_count} unclaimed`,
    `- Paths: ${report.observed.reduced_paths}/${report.observed.baseline_paths} reduced (${formatPercent(report.observed.reduction_percent)}), ${report.observed.remaining_paths} remaining`,
    `- Packets: ${report.observed.cleared_packets} cleared, ${report.observed.reduced_packets} reduced, ${report.observed.grew_packets} grew, ${report.observed.held_packets} held, ${report.observed.stale_packets} stale`,
    `- Conflicts: ${report.observed.open_conflicts} open, ${report.observed.warning_conflicts}/${report.observed.critical_conflicts} warning/critical`,
    `- Graphs: ${report.observed.graph_packets} packets, ${report.observed.project_graph_gaps} project gaps, ${report.observed.module_graph_gaps} module gaps`,
    `- Gains: top wave ${formatPercent(report.observed.top_wave_gain_percent)}, top project ${formatPercent(report.observed.top_project_gain_percent)}, ${formatPercent(report.observed.command_roundtrip_reduction_percent)} fewer controller round trips`,
    `- Next: \`${report.next}\``,
    '',
    '## Comparison',
    '',
    `- Predicted targeted dirty paths: ${formatNullable(report.comparison.predicted_targeted_dirty_paths)}`,
    `- Actual baseline paths: ${formatNullable(report.comparison.actual_baseline_paths)}`,
    `- Predicted top wave gain: ${formatPercent(report.comparison.predicted_top_wave_gain_percent)}`,
    `- Observed reduction: ${formatPercent(report.comparison.observed_reduction_percent)}`,
    `- Observed completion: ${formatPercent(report.comparison.observed_completion_percent)}`,
    `- Dispatch/observed path delta: ${formatNullable(report.comparison.dispatch_vs_observed_path_delta)}`,
    '',
  ];

  if (report.current_slice) {
    lines.push('## Big Picture', '', `- Current: ${report.current_slice}`);
    for (const [index, item] of report.outlook.entries()) {
      lines.push(`- Outlook ${index + 1}: ${item}`);
    }
    if (report.horizon.length) lines.push(`- Horizon: ${report.horizon.join(' | ')}`);
    lines.push('');
  }

  if (report.blockers.length) {
    lines.push('## Blockers', '');
    for (const blocker of report.blockers) lines.push(`- ${blocker}`);
    lines.push('');
  }
  if (report.warnings.length) {
    lines.push('## Warnings', '');
    for (const warning of report.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  if (report.dispatch?.assignments?.length) {
    lines.push('## Claim Receipts', '');
    for (const item of report.receipts.assignments) {
      const leaseLabel = item.active_lease_count ? `, active leases ${item.active_lease_count}` : '';
      const contextLabel = item.context_error ? `, context error: ${item.context_error}` : '';
      lines.push(`- #${item.rank} ${item.project} ${item.group}: ${item.status}, ${item.claim_event_count} claim events, ${item.completion_event_count} completion events${leaseLabel}${contextLabel}`);
    }
    lines.push('');

    lines.push('## Assignments', '');
    for (const item of report.dispatch.assignments) {
      lines.push(`- #${item.rank} ${item.project} ${item.group}: ${item.dirty_path_count} paths, claim \`${item.claim_command}\``);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function runJsonTool(label: string, commandArgs: string[]): ToolResult {
  try {
    const stdout = execFileSync(execPath, commandArgs, {
      cwd: SMA_ROOT,
      encoding: 'utf8',
      timeout: positiveInt(args.timeoutMs, 180000),
      maxBuffer: 32 * 1024 * 1024,
    });
    return { label, data: JSON.parse(stdout) as MonitorData };
  } catch (error: unknown) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error
      ? (error as { stderr?: unknown }).stderr
      : undefined;
    return {
      label,
      data: null,
      error: firstLine(stderr) || firstLine(error instanceof Error ? error.message : error) || 'failed',
    };
  }
}

function printText(report: ReturnType<typeof summarizeObservation> & { observation_artifacts?: ReturnType<typeof writeObservation> }) {
  console.log('SMA Gen3 Wave Observation');
  console.log(`status:           ${report.status}`);
  console.log(`dispatch:         ${report.dispatch ? `${report.dispatch.dispatch_id} (${report.dispatch.assignment_count} agents)` : 'none'}`);
  console.log(`receipts:         ${report.receipts.claimed_count}/${report.receipts.assignment_count} claimed, ${report.receipts.active_count} active, ${report.receipts.completed_count} completed, ${report.receipts.unclaimed_count} unclaimed`);
  console.log(`wave progress:    ${report.observed.reduced_paths}/${report.observed.baseline_paths} paths reduced (${formatPercent(report.observed.reduction_percent)}), ${report.observed.remaining_paths} remaining`);
  console.log(`packets:          ${report.observed.cleared_packets} cleared, ${report.observed.reduced_packets} reduced, ${report.observed.grew_packets} grew, ${report.observed.held_packets} held, ${report.observed.stale_packets} stale`);
  console.log(`conflicts:        ${report.observed.open_conflicts} open, ${report.observed.warning_conflicts}/${report.observed.critical_conflicts} warning/critical`);
  console.log(`graphs:           ${report.observed.graph_packets} packets, ${report.observed.project_graph_gaps} project gaps, ${report.observed.module_graph_gaps} module gaps`);
  console.log(`gains:            top wave ${formatPercent(report.observed.top_wave_gain_percent)}, observed reduction ${formatPercent(report.comparison.observed_reduction_percent)}, ${formatPercent(report.observed.command_roundtrip_reduction_percent)} fewer controller round trips`);
  if (report.current_slice) console.log(`current slice:    ${report.current_slice}`);
  for (const [index, item] of report.outlook.entries()) {
    console.log(`outlook ${index + 1}:        ${item}`);
  }
  if (report.blockers.length) console.log(`blockers:         ${report.blockers.join('; ')}`);
  if (report.warnings.length) console.log(`warnings:         ${report.warnings.join('; ')}`);
  if (report.observation_artifacts) {
    console.log(`observation json: ${report.observation_artifacts.json_path}`);
    console.log(`observation md:   ${report.observation_artifacts.markdown_path}`);
  }
  console.log(`next:             ${report.next}`);
}

function parseArgs(list: string[]): WaveArgs {
  const out: WaveArgs = {};
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (item === '--help' || item === '-h') {
      out.help = true;
      continue;
    }
    if (!item.startsWith('--')) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_match, character: string) => character.toUpperCase());
    const next = list[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function relativeToSma(path: string): string {
  return path.startsWith(`${SMA_ROOT}/`) ? path.slice(SMA_ROOT.length + 1) : path;
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percent(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function formatPercent(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'n/a';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 'n/a';
  return `${parsed}%`;
}

function formatNullable(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'n/a';
  return String(value);
}

function firstLine(value: unknown): string {
  return String(value || '').split(/\r?\n/).find(Boolean) || '';
}
