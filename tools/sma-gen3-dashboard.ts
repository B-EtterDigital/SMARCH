#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-base-to-string, @typescript-eslint/no-unnecessary-type-conversion -- Dashboard generation accepts version-skewed controller snapshots and preserves defensive guards and existing coercion. */
/* eslint-disable complexity, max-lines-per-function -- Dashboard functions are ordered snapshot serializers; keeping conditional sections contiguous preserves byte-stable HTML and visibility precedence. */
/**
 * WHAT: Builds a standalone web dashboard for generation-three coordination state.
 * WHY: Dense controller evidence needs one navigable view for readiness and work allocation.
 * HOW: Joins state, leases, snapshots, graph status, goals, and dispatch evidence into a page.
 * INPUTS: Optional project filters, source paths, output path, and display controls.
 * OUTPUTS: A stable generated dashboard page and a write-or-unchanged status message.
 * CALLERS: Dashboard scripts and operators reviewing portfolio or project readiness.
 * Usage: `node tools/sma-gen3-dashboard.mjs --help`
 */
/**
 * sma-gen3-dashboard.mjs — standalone HTML dashboard for the Gen-3 surfaces.
 *
 * Reads:
 *   - wiki/SMA_STATE.generated.json (the snapshot, gen3 block)
 *   - registry/active-leases.generated.json (local runtime cache for fresher lease data)
 *
 * Writes:
 *   - wiki/GEN3_DASHBOARD.generated.html for the global view
 *   - wiki/projects/<project-id>/GEN3_DASHBOARD.generated.html for one-project views
 *   - or the path passed via --out
 *
 * This is intentionally separate from the main sma-wiki.mjs (~4k lines). When
 * the Gen-3 layer matures, we promote selected metrics into the main wiki; for
 * now keeping it standalone makes iteration cheap.
 *
 * Subcommands:
 *   build    [--out wiki/GEN3_DASHBOARD.generated.html] [--state <path>]
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { pathToFileURL } from 'node:url';
import { isVolatileSmaRegenLease, readActiveLeases } from './lib/gen3-state.ts';
import { buildGoalProgressReport, goalProgressDashboardStyles, renderGoalProgressSection } from './lib/gen3-goal-progress.ts';
import { writeTextIfChanged } from './lib/stable-generated.ts';
import { SMA_ROOT } from "./lib/sma-paths.ts";

interface LooseRecord extends Record<string, unknown> {
  action_items?: LooseRecord[]; actionable_gap_count?: number; active?: number; active_count?: number; actor_id?: string;
  age_bucket?: string; age_label?: string; agent_id?: string; assignment_count?: number; assignments?: LooseRecord[];
  available?: boolean; baseline_paths?: number; big_picture?: LooseRecord; blocked?: number; brick_id?: string;
  bricks_with_context?: number; by_project?: Record<string, LooseRecord>; by_resource_kind?: Record<string, number>;
  check_count?: number; claim_command?: string; claim_packet_command?: string; claim_pinning?: LooseRecord;
  claimable_dirty_paths?: number; claimed?: number; claimed_count?: number; command?: string; commands?: LooseRecord[];
  comparison?: LooseRecord; completed?: number; completed_count?: number; conflict_detected?: number; conflict_resolved?: number;
  conflicts?: LooseRecord[] | LooseRecord; context_coverage?: LooseRecord; context_error_count?: number; count?: number;
  created_at?: string; critical?: number; current_slice?: string; default_wave_agent_count?: number;
  default_wave_dirty_paths?: number; default_wave_top_gain_percent?: number; detail?: string; dirty_count?: number;
  dispatch?: LooseRecord | null; dispatch_command?: string; dispatch_id?: string; dispatched_count?: number; edge_count?: number;
  error?: string; file?: string; gains?: LooseRecord; generated_at?: string; git?: LooseRecord; graph?: LooseRecord;
  graph_packets?: number; graph_path?: string; group?: string; held_slots?: number; horizon?: string[]; id?: string | null;
  impact_score?: number; intent?: string; json?: LooseRecord; json_path?: string; kind?: string; known_empty_count?: number;
  label?: string; last_event_at?: string; lease_id?: string; leases?: LooseRecord[]; legacy_rank_only_assignment_count?: number;
  md_path?: string; message?: string; missing_graph_count?: number; missing_target_count?: number; module_dispatch?: LooseRecord;
  module_graph?: LooseRecord; module_graph_gap_count?: number; module_work?: LooseRecord; modules?: unknown[]; merge_proposals?: LooseRecord;
  modified_count?: number; name?: string; newest_updated_at?: string; next?: string; next_command?: string;
  next_slices?: string[]; node_count?: number; observation?: LooseRecord | null; observe_command?: string; observe_write_command?: string;
  observed?: LooseRecord; observed_reduction_percent?: number; open_conflicts?: number; open_count?: number;
  open_merge_proposals?: number; out?: string; overflow_count?: number; packet_count?: number; packets?: LooseRecord[];
  parallel_wave?: LooseRecord; path?: string; primary_next_command?: string; project?: string; project_gain_percent?: number;
  project_graph_gaps?: number; projects?: LooseRecord[] | number; projects_with_logs?: number; rank?: number; readiness?: LooseRecord;
  ready?: boolean; ready_count?: number; receipts?: LooseRecord | ReceiptSummary | null; recommended_agent_count?: number; reduced_paths?: number;
  reduction_percent?: number; remaining_paths?: number; repair_command?: string; requested_agents?: number; resolve_command?: string;
  resolved_count?: number; resolved_merge_proposals?: number; resource_id?: string; resource_kind?: string; root?: string;
  satisfied_count?: number; severity?: string; sla_status?: string; status?: string; summary?: LooseRecord;
  targeted_dirty_paths?: number; title?: string; tldr?: string; top_wave_gain_percent?: number | null; total?: number;
  total_bricks_with_context?: number; total_context_events?: number; total_count?: number; total_impact?: number;
  unclaimed?: number; unclaimed_count?: number; unreadable_count?: number; untracked_count?: number; updated_at?: string;
  verify_command?: string; warning?: number; wave_gain_percent?: number;
  nextCommand?: string; launch_ready_slots?: number; graph_blocked_modules?: number;
  actionableGapCount?: number; edgeCount?: number; knownEmptyCount?: number; missingGraphCount?: number;
  missingTargetCount?: number; moduleCount?: number; newestGraphUpdatedAt?: string; nodeCount?: number; readyCount?: number;
  satisfiedCount?: number; nodes?: unknown[]; edges?: unknown[]; links?: unknown[]; elements?: LooseRecord; metadata?: LooseRecord;
  known_empty?: boolean; sma_status?: string;
  launch_plan?: unknown[]; limit_mode?: string; readiness_score_percent?: number;
  recommended_agents?: number; report_path?: string | null;
  dashboard_command?: string; graph_ready_modules?: number; modules_total?: number; path_overlap_blocked_slots?: number;
  plan_command?: string; task_is_placeholder?: boolean; uncovered_dirty_count?: number; watch_command?: string;
  oldest_graph_updated_at?: string; oldest_updated_at?: string; newest_graph_updated_at?: string;
}

interface DashboardArgs {
  controllerTimeoutMs?: string; dirtyLimit?: string; goalHours?: string; maxAgents?: string; noDirty?: boolean;
  noGoalProgress?: boolean; noGraphs?: boolean; out?: string; priorityOnly?: boolean; project?: string | string[];
  state?: string; task?: string;
}

interface ModuleGraphSummary { actionable_gap_count: number; cache_count?: number; edge_count: number; known_empty_count: number; missing_graph_count?: number; missing_target_count?: number; newest_updated_at?: string | null; node_count: number; oldest_updated_at?: string | null; project: string; ready_count: number; satisfied_count: number; total_count: number; unreadable_count: number }
interface ModuleGraphCheckSummary { actionableGapCount?: number; edgeCount?: number; knownEmptyCount?: number; missingGraphCount?: number; missingTargetCount?: number; moduleCount?: number; newestGraphUpdatedAt?: string; nodeCount?: number; readyCount?: number; satisfiedCount?: number }
interface GraphStats { edge_count: number; max_nodes: number; missing: number; node_count: number; percent: number; ready: number; total: number }
interface ReceiptSummary { active_count: number; assignment_count: number; claimed_count: number; completed_count: number; context_error_count: number; unclaimed_count: number }
interface WaveDispatch { assignment_count: number; claim_pinning: LooseRecord; claimable_dirty_paths: number; created_at: string; file: string; id: string | null; readiness: string; targeted_dirty_paths: number; top_wave_gain_percent: number | null }
interface WaveObservation { baseline_paths: number; dispatch_id: string | null; file: string; generated_at: string; graph_packets: number; observed_reduction_percent: number | null; open_conflicts: number; receipts: ReceiptSummary | null; reduced_paths: number; remaining_paths: number; status: string }
interface WaveProof { dispatch: WaveDispatch | null; kind?: string; message: string; module_dispatch?: LooseRecord | null; nextCommand: string; observation: WaveObservation | null; project?: string; receipts: ReceiptSummary | null; status: string; summary: string }

const DEFAULT_STATE = resolve(SMA_ROOT, 'wiki/SMA_STATE.generated.json');
const DEFAULT_OUT = resolve(SMA_ROOT, 'wiki/GEN3_DASHBOARD.generated.html');
const DEFAULT_CLEANUP_PACKETS = resolve(SMA_ROOT, 'handoffs/cleanup-packets.generated.json');
const DEFAULT_GRAPH_PACKETS = resolve(SMA_ROOT, 'handoffs/graph-packets.generated.json');
const DEFAULT_GRAPH_PACKETS_MD = resolve(SMA_ROOT, 'handoffs/graph-packets.generated.md');
const DEFAULT_OPERATOR_PACKET = resolve(SMA_ROOT, 'handoffs/operator-packet.generated.json');
const DEFAULT_WAVE_DIR = resolve(SMA_ROOT, 'handoffs/waves');
const DEFAULT_WAVE_OBSERVATION_DIR = resolve(DEFAULT_WAVE_DIR, 'observations');

const cmd = argv[2];
const args = parseArgs(argv.slice(3));

try {
  switch (cmd) {
    case 'build':
    case undefined:
      runBuild();
      break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      exit(0);
      break;
    case 'selftest':
    case '--selftest':
      runSelftest();
      break;
    default:
      console.error(`unknown subcommand: ${cmd}`);
      usage();
      exit(2);
  }
} catch (err: unknown) {
  console.error(`sma-gen3-dashboard: ${err instanceof Error ? err.message : String(err)}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-gen3-dashboard.mjs build [--out <path>] [--state <path>]
                               [--project <id>]... [--priority-only]
                               [--task "..."] [--max-agents <n>]
                               [--dirty-limit <n>] [--no-dirty] [--no-graphs]
                               [--goal-hours 100] [--no-goal-progress]

Default is global: the dashboard asks the controller snapshot for every SMA
portfolio project, with dirty file names hidden and graph readiness included.
When exactly one --project is supplied and --out is omitted, output defaults to
wiki/projects/<project-id>/GEN3_DASHBOARD.generated.html so project dashboards
do not overwrite the global dashboard.
`);
}

function runSelftest() {
  args.noGoalProgress = true;
  const html = render({
    gen3: null,
    liveLeases: dashboardVisibleLeases({ generated_at: null, active_count: 0, by_resource_kind: {}, by_agent: {}, leases: [], _error: '' }),
    controller: { projects: [], action_items: [], summary: {} },
  });
  for (const marker of ['<h2>Active leases</h2>', '<h2>Conflict SLA queue</h2>', '<h2>Global project control plane</h2>']) {
    if (!html.includes(marker)) throw new Error(`selftest missing dashboard marker: ${marker}`);
  }
  console.log('sma-gen3-dashboard selftest passed');
}

function runBuild() {
  const statePath = args.state ? resolve(args.state) : DEFAULT_STATE;
  const outPath = resolveDashboardOutPath(args);
  const state = existsSync(statePath) ? safeJson(readFileSync(statePath, 'utf8')) : null;
  const gen3 = isRecord(state?.gen3) ? state.gen3 : null;
  const liveLeases = dashboardVisibleLeases(readActiveLeases({
    excludeCurrentWrapperLease: true,
    excludeVolatileSmaRegenLeases: true,
  }));
  const controller = readControllerSnapshot();

  const html = render({
    gen3,
    liveLeases,
    controller,
  });
  const writeResult = writeTextIfChanged(outPath, html);
  console.log(`${writeResult.written ? 'wrote' : 'unchanged'} ${outPath}`);
}

function resolveDashboardOutPath(options: DashboardArgs): string {
  if (options.out) return resolve(options.out);
  const projects = asArray(options.project);
  if (projects.length === 1) {
    return resolve(SMA_ROOT, 'wiki/projects', safePathSegment(projects[0]), 'GEN3_DASHBOARD.generated.html');
  }
  return DEFAULT_OUT;
}

function safePathSegment(value: unknown): string {
  return String(value ?? 'project')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'project';
}

function readControllerSnapshot(): LooseRecord {
  const controllerArgs = [
    resolve(SMA_ROOT, 'tools/sma-controller-snapshot.ts'),
    '--json',
    '--module-graphs',
    '--exclude-volatile-sma-regen',
    '--dirty-limit',
    String(args.dirtyLimit ?? 0),
  ];
  for (const project of asArray(args.project)) {
    controllerArgs.push('--project', project);
  }
  if (!args.priorityOnly && asArray(args.project).length === 0) controllerArgs.push('--all');
  if (args.noDirty) controllerArgs.push('--no-dirty');
  if (args.noGraphs) controllerArgs.push('--no-graphs');

  try {
    const raw = execFileSync(process.execPath, controllerArgs, {
      cwd: SMA_ROOT,
      encoding: 'utf8',
      timeout: numberArg(args.controllerTimeoutMs, 120000),
      maxBuffer: 24 * 1024 * 1024,
    });
    return safeJson(raw) ?? { error: 'controller returned invalid JSON', projects: [], summary: {} };
  } catch (err: unknown) {
    return {
      error: err instanceof Error ? err.message : String(err),
      projects: [],
      summary: {
        projects: 0,
        active_leases: 0,
        open_conflicts: 0,
        dirty_projects: 0,
        dirty_unleased_projects: 0,
        graph_gaps: 0,
      },
    };
  }
}

function render({ gen3, liveLeases, controller }: { gen3: LooseRecord | null; liveLeases: ReturnType<typeof dashboardVisibleLeases>; controller: LooseRecord }): string {
  const ctx: LooseRecord = gen3?.context_coverage ?? { projects_with_logs: 0, total_bricks_with_context: 0, total_context_events: 0, by_project: {} };
  const conflicts = isRecord(gen3?.conflicts) ? gen3.conflicts : { detected_count: 0, resolved_count: 0, open_count: 0 };
  const projectFilters = asArray(args.project);
  const projectScoped = projectFilters.length > 0;
  const conflictSla = readConflictSummary();
  const parallelPreflight: LooseRecord = readParallelPreflight();
  const moduleWork = parallelPreflight.module_work ?? { available: false };
  const moduleDispatch = parallelPreflight.module_dispatch ?? { available: false, status: 'not-requested' };
  const waveProof = projectScoped ? projectScopedWaveProof(projectFilters, moduleDispatch, parallelPreflight) : readWaveProof();
  const mp = gen3?.merge_proposals ?? { open_count: 0, resolved_count: 0 };
  const controllerProjects = Array.isArray(controller.projects) ? controller.projects : [];
  const goalProgress = args.noGoalProgress ? null : buildGoalProgressReport({
    projects: goalProgressProjects(controllerProjects, projectFilters),
    hours: numberArg(args.goalHours, 100),
    projectFilter: projectFilters,
  });
  const goalProgressSection = goalProgress ? renderGoalProgressSection(goalProgress) : '';
  const goalProgressStyles = goalProgress ? goalProgressDashboardStyles() : '';
  const graphStats = summarizeGraphs(controllerProjects);
  const moduleGraphSummaries = controllerProjects
    .map((project) => normalizeModuleGraphSummary(project) ?? readCachedModuleGraphSummary(project))
    .filter((summary): summary is ModuleGraphSummary => summary !== null);
  const moduleGraphStats = summarizeModuleGraphCache(moduleGraphSummaries);
  const operatorPacket = readOperatorPacketSummary(projectFilters);
  const globalGraph = controllerProjects.find((project) => project.id === 'sma')?.graph ?? readSmaGlobalGraph();
  const controllerSummary = controller.summary ?? {};
  const actionItems = (controller.action_items ?? []).filter((item) => !isVolatileSmaRegenAction(item));
  const parallelWave = controller.parallel_wave ?? { commands: [], recommended_agent_count: 0, total_impact: 0, limit: 0 };
  const actionStats = summarizeActions(actionItems);
  const cleanupPacketReport = projectScoped ? null : readJsonIfExists(DEFAULT_CLEANUP_PACKETS);
  const cleanupPacketSummary = cleanupPacketReport?.summary ?? summarizeCleanupPackets(parallelWave);
  const cleanupWaveAgents = cleanupPacketSummary.default_wave_agent_count ?? parallelWave.recommended_agent_count ?? 0;
  const cleanupWavePaths = cleanupPacketSummary.default_wave_dirty_paths ?? parallelWave.total_impact ?? 0;
  const cleanupTopGain = formatPercent(cleanupPacketSummary.default_wave_top_gain_percent) || 'n/a';
  const cleanupOverflow = cleanupPacketSummary.overflow_count ?? parallelWave.overflow_count ?? 0;
  const graphPacketReport = projectScoped ? null : readJsonIfExists(DEFAULT_GRAPH_PACKETS);
  const graphPackets = graphPacketReport?.packets?.length
    ? graphPacketReport.packets
    : graphPacketsFromActions(actionItems);
  const graphPacketSummary = graphPacketReport?.summary ?? summarizeGraphPackets(graphPackets);
  const contextRows = (Object.entries(ctx.by_project ?? {}))
    .sort((a, b) => (b[1].total_context_events ?? 0) - (a[1].total_context_events ?? 0))
    .map(([id, info]) => `
      <tr>
        <td>${esc(id)}</td>
        <td class="num">${String(info.bricks_with_context ?? 0)}</td>
        <td class="num">${String(info.total_context_events ?? 0)}</td>
        <td class="num">${String(info.open_conflicts ?? 0)}</td>
        <td class="num">${String(info.conflict_detected ?? 0)}/${String(info.conflict_resolved ?? 0)}</td>
        <td class="num">${String(info.open_merge_proposals ?? 0)}</td>
        <td class="num">${String(info.resolved_merge_proposals ?? 0)}</td>
        <td class="ts">${esc(info.last_event_at ?? '')}</td>
      </tr>`)
    .join('');
  const controllerRows = controllerProjects
    .sort((a, b) => statusRank(a.status) - statusRank(b.status) || String(a.id).localeCompare(String(b.id)))
    .map((project) => {
      const graph = project.graph;
      const moduleGraph = normalizeModuleGraphSummary(project);
      const dirty = project.git ? `${String(project.git.dirty_count ?? 0)} (${String(project.git.modified_count ?? 0)} mod, ${String(project.git.untracked_count ?? 0)} new)` : 'skipped';
      const graphLabel = graph ? (graph.ready ? `${String(graph.node_count ?? 0)} nodes / ${String(graph.edge_count ?? 0)} edges` : 'missing') : 'skipped';
      const moduleGraphLabel = moduleGraph ? `${String(moduleGraph.satisfied_count)}/${String(moduleGraph.total_count)} modules · ${String(moduleGraph.actionable_gap_count)} gaps` : 'none';
      return `
      <tr>
        <td><span class="status ${esc(project.status)}">${esc(project.status)}</span></td>
        <td>${esc(project.id)}</td>
        <td class="num">${dirty}</td>
        <td class="num">${String(isRecord(project.conflicts) ? project.conflicts.open_count ?? 0 : 0)}</td>
        <td>${esc(graphLabel)}</td>
        <td>${esc(moduleGraphLabel)}</td>
        <td>${graphLinks(graph)}</td>
        <td class="path">${esc(project.root ?? '')}</td>
      </tr>`;
    })
    .join('');
  const actionRows = actionItems
    .slice(0, 40)
    .map((item) => `
      <tr>
        <td><span class="severity ${esc(item.severity)}">${esc(item.severity)}</span></td>
        <td>${esc(item.kind)}</td>
        <td class="num">${esc(formatActionImpact(item))}</td>
        <td>${esc(item.project)}</td>
        <td>${esc(item.title)}</td>
        <td class="path">${esc(item.detail ?? '')}</td>
        <td><code>${esc(item.command ?? '')}</code></td>
      </tr>`)
    .join('');
  const waveRows = (parallelWave.commands ?? [])
    .map((item) => `
      <tr>
        <td class="num">${(String(item.rank ?? 0))}</td>
        <td>${esc(item.project)}</td>
        <td>${esc(item.group)}</td>
        <td class="num">${(String(item.count ?? 0))}</td>
        <td class="num">${formatPercent(item.wave_gain_percent)}</td>
        <td class="num">${formatPercent(item.project_gain_percent)}</td>
        <td><code>${esc(item.command ?? '')}</code></td>
      </tr>`)
    .join('');
  const conflictEvents: LooseRecord[] = Array.isArray(conflictSla.conflicts) ? conflictSla.conflicts : [];
  const conflictSlaRows = conflictEvents
    .slice(0, 20)
    .map((event) => `
      <tr>
        <td><span class="severity ${esc(event.sla_status)}">${esc(event.sla_status)}</span></td>
        <td>${esc(event.project)}</td>
        <td>${esc(event.brick_id)}</td>
        <td class="num">${esc((event.age_bucket ?? event.age_label) ?? '')}</td>
        <td>${esc(event.actor_id ?? '')}</td>
        <td>${esc(event.intent ?? '')}</td>
        <td><code>${esc(event.resolve_command ?? '')}</code></td>
      </tr>`)
    .join('');
  const graphCards = controllerProjects
    .filter((project) => project.graph)
    .sort((a, b) => Number(Boolean(b.graph?.ready)) - Number(Boolean(a.graph?.ready)) || (b.graph?.node_count ?? 0) - (a.graph?.node_count ?? 0))
    .map((project) => graphCard(project, graphStats.max_nodes))
    .join('');
  const moduleGraphRows = moduleGraphSummaries
    .sort((a, b) => (b.satisfied_count || 0) - (a.satisfied_count || 0) || a.project.localeCompare(b.project))
    .map((summary) => `
      <tr>
        <td>${esc(summary.project)}</td>
        <td class="num">${String(summary.satisfied_count)}/${String(summary.total_count)}</td>
        <td class="num">${String(summary.ready_count)}</td>
        <td class="num">${String(summary.known_empty_count)}</td>
        <td class="num">${String(summary.actionable_gap_count ?? summary.unreadable_count)}</td>
        <td class="num">${String(summary.missing_graph_count ?? 0)}</td>
        <td class="num">${String(summary.missing_target_count ?? 0)}</td>
        <td class="num">${String(summary.node_count)}</td>
        <td class="num">${String(summary.edge_count)}</td>
        <td class="ts">${esc(summary.newest_updated_at ?? '')}</td>
      </tr>`)
    .join('');
  const graphHubRows = renderGraphHubRows({
    globalGraph,
    graphStats,
    moduleGraphStats,
    actionItems,
    controllerProjects,
    graphPacketSummary,
  });
  const moduleWorkRows = renderModuleWorkRows(moduleWork, moduleDispatch, parallelPreflight);
  const graphPacketRows = graphPackets
    .slice(0, 20)
    .map((packet) => `
      <tr>
        <td class="num">${(String(packet.rank ?? 0))}</td>
        <td>${esc(packet.project)}</td>
        <td>${esc(packet.kind)}</td>
        <td class="num">${esc(formatGraphPacketImpact(packet))}</td>
        <td><code>${esc(packet.claim_packet_command ?? '')}</code></td>
        <td><code>${esc(packet.repair_command ?? '')}</code></td>
        <td><code>${esc(packet.verify_command ?? '')}</code></td>
      </tr>`)
    .join('');
  const fallbackBigPicture = fallbackParallelPreflight().big_picture;
  const bigPicture = isRecord(parallelPreflight.big_picture)
    ? parallelPreflight.big_picture
    : isRecord(fallbackBigPicture) ? fallbackBigPicture : { tldr: '', next_slices: [], horizon: [] };
  const bigPictureNextRows = (bigPicture.next_slices ?? [])
    .map((item, index) => `
      <tr>
        <td class="num">${String(index + 1)}</td>
        <td>${esc(item)}</td>
      </tr>`)
    .join('');
  const bigPictureHorizonRows = (bigPicture.horizon ?? [])
    .map((item) => `<li>${esc(item)}</li>`)
    .join('');

  const leaseRows = liveLeases.leases.map((l) => `
      <tr>
        <td><code>${esc(l.lease_id)}</code></td>
        <td>${esc(l.resource_kind)}</td>
        <td>${esc(l.resource_id)}</td>
        <td>${esc(l.agent_id)}</td>
        <td class="ts">${esc(l.acquired_at ?? '')}</td>
        <td>${esc(l.intent)}</td>
      </tr>`).join('');

  const noLeases = liveLeases.active_count === 0
    ? '<p class="empty">No active leases — all clear.</p>' : '';
  const noProjects = Object.keys(ctx.by_project ?? {}).length === 0
    ? '<p class="empty">No projects with agent-context logs yet. Run <code>npm run touch:backfill -- from-git --manifest &lt;path&gt; --commit &lt;sha&gt; --intent-from-message --project &lt;id&gt;</code> to seed.</p>' : '';
  const noControllerProjects = controllerRows
    ? '<!-- controller project rows available -->' : '<p class="empty">No controller project rows available.</p>';
  const controllerError = controller.error
    ? `<p class="warn">Controller snapshot unavailable: ${esc(controller.error)}</p>` : '<!-- controller snapshot available -->';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>SMARCH · Gen-3 Multi-Agent Dashboard</title>
  <style>
    :root { color-scheme: light dark; --bd: #ddd; --mute: #666; --hi: #0a7; --bad: #b42318; --warn: #b54708; --ok: #067647; }
    body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI"; margin: 0; padding: 24px; max-width: 1480px; line-height: 1.5; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    .meta { color: var(--mute); font-size: 13px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 16px 0 24px; }
    .card { border: 1px solid var(--bd); border-radius: 6px; padding: 14px; }
    .card .label { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--mute); }
    .card .value { font-size: 28px; font-weight: 600; margin-top: 4px; }
    .card .sub { font-size: 12px; color: var(--mute); margin-top: 4px; }
    section { margin-top: 24px; }
    h2 { font-size: 16px; margin-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--bd); }
    th { background: rgba(0,0,0,0.04); font-weight: 600; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    td.ts { color: var(--mute); font-size: 12px; }
    td.path { color: var(--mute); font-size: 12px; max-width: 360px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    a { color: var(--hi); text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { background: rgba(0,0,0,0.06); padding: 1px 4px; border-radius: 3px; font-size: 12px; }
    .empty { color: var(--mute); font-style: italic; padding: 12px; border: 1px dashed var(--bd); border-radius: 4px; }
    .warn { color: var(--warn); padding: 12px; border: 1px solid var(--warn); border-radius: 4px; }
    .status { display: inline-block; min-width: 92px; padding: 2px 7px; border-radius: 999px; text-align: center; font-size: 12px; background: rgba(0,0,0,0.06); }
    .status.clear { color: var(--ok); }
    .status.active, .status.graph-gap { color: var(--warn); }
    .status.blocked, .status.dirty-unleased, .status.missing { color: var(--bad); }
    .graph-map { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
    .graph-node { border: 1px solid var(--bd); border-radius: 6px; padding: 10px; min-height: 74px; }
    .graph-node strong { display: block; font-size: 13px; margin-bottom: 4px; }
    .graph-node span { color: var(--mute); font-size: 12px; }
    .graph-node.missing { opacity: .62; }
    .graph-node .links { margin-top: 8px; font-size: 12px; }
    .bar { height: 4px; background: rgba(0,0,0,0.08); margin-top: 9px; overflow: hidden; border-radius: 999px; }
    .bar i { display: block; height: 100%; background: var(--hi); }
    .footer { margin-top: 32px; color: var(--mute); font-size: 12px; }
    .footer a { color: var(--hi); }
    .severity { display: inline-block; min-width: 64px; padding: 2px 7px; border-radius: 999px; text-align: center; font-size: 12px; background: rgba(0,0,0,0.06); }
    .severity.blocker { color: var(--bad); }
    .severity.critical { color: var(--bad); }
    .severity.warning { color: var(--warn); }
    .severity.open { color: var(--warn); }
    .severity.watch { color: var(--ok); }
    .brief { border: 1px solid var(--bd); border-radius: 6px; padding: 14px; font-size: 14px; background: rgba(0,0,0,0.03); }
    .horizon { margin: 8px 0 0 18px; color: var(--mute); font-size: 13px; }
${goalProgressStyles}
  </style>
</head>
<body>
  <h1>SMARCH · Gen-3 Multi-Agent Dashboard</h1>
  <div class="meta">Stable generated view · volatile lease TTLs are intentionally omitted from tracked HTML.</div>

  <div class="grid">
    <div class="card">
      <div class="label">Parallel readiness</div>
      <div class="value">${String(parallelPreflight.readiness_score_percent ?? 0)}%</div>
      <div class="sub">${esc(parallelPreflight.status ?? 'unknown')} · ${String(parallelPreflight.recommended_agents ?? 0)}/${String(parallelPreflight.requested_agents ?? 0)} agents ${esc(parallelPreflight.limit_mode ?? 'fixed')} · ${String(parallelPreflight.launch_plan?.length ?? 0)} launch slots · top gain ${formatPercent(parallelPreflight.gains?.selected_wave_top_gain_percent)}</div>
    </div>
    <div class="card">
      <div class="label">Operator packet</div>
      <div class="value">${operatorPacket.ready ? operatorPacket.size_label : 'missing'}</div>
      <div class="sub">${operatorPacket.ready ? `<a href="${esc(fileHref(operatorPacket.md_path))}">md</a> <a href="${esc(fileHref(operatorPacket.json_path))}">json</a> · first context, not full dashboard` : '<code>npm run operator:packet</code>'}</div>
    </div>
    <div class="card">
      <div class="label">Active leases</div>
      <div class="value">${String(liveLeases.active_count)}</div>
      <div class="sub">${esc(formatLeaseKinds(liveLeases.by_resource_kind))}</div>
    </div>
    <div class="card">
      <div class="label">Controller actions</div>
      <div class="value">${String(actionItems.length)}</div>
      <div class="sub">${String(actionStats.blocker)} blockers · ${String(actionStats.warning)} warnings · ${String(actionStats.watch)} watch</div>
    </div>
    <div class="card">
      <div class="label">Next cleanup wave</div>
      <div class="value">${String(cleanupWaveAgents)}</div>
      <div class="sub">${String(cleanupWavePaths)} dirty paths · top gain ${cleanupTopGain} · overflow ${String(cleanupOverflow)}</div>
    </div>
    <div class="card">
      <div class="label">Module work lane</div>
      <div class="value">${moduleWork.available ? `${String(moduleWork.launch_ready_slots)}/${String(moduleWork.requested_agents)}` : 'n/a'}</div>
      <div class="sub">${moduleWork.available ? `${String(moduleWork.graph_ready_modules)}/${String(moduleWork.modules_total)} graphs · held ${String(moduleWork.held_slots)} · overlap ${String(moduleWork.path_overlap_blocked_slots)}` : 'build with --project &lt;id&gt;'}</div>
    </div>
    <div class="card">
      <div class="label">Module dispatch</div>
      <div class="value">${formatModuleDispatchValue(moduleDispatch)}</div>
      <div class="sub">${esc(formatModuleDispatchSub(moduleDispatch))}</div>
    </div>
    <div class="card">
      <div class="label">Wave proof</div>
      <div class="value">${esc(waveProof.status)}</div>
      <div class="sub">${esc(waveProof.summary)}</div>
    </div>
    <div class="card">
      <div class="label">Bricks with context</div>
      <div class="value">${String(ctx.total_bricks_with_context ?? 0)}</div>
      <div class="sub">across ${String(ctx.projects_with_logs ?? 0)} project${ctx.projects_with_logs === 1 ? '' : 's'}</div>
    </div>
    <div class="card">
      <div class="label">Context events</div>
      <div class="value">${String(ctx.total_context_events ?? 0)}</div>
      <div class="sub">total appended</div>
    </div>
    <div class="card">
      <div class="label">Open conflicts</div>
      <div class="value">${String(conflicts.open_count ?? 0)}</div>
      <div class="sub">${String(conflicts.detected_count ?? 0)} detected · ${String(conflicts.resolved_count ?? 0)} resolved</div>
    </div>
    <div class="card">
      <div class="label">Conflict SLA</div>
      <div class="value">${esc(conflictSla.summary?.status ?? 'unknown')}</div>
      <div class="sub">${String(conflictSla.summary?.warning_conflicts ?? 0)} warning · ${String(conflictSla.summary?.critical_conflicts ?? 0)} critical · oldest ${esc(conflictSla.summary?.oldest_age_bucket ?? 'none')}</div>
    </div>
    <div class="card">
      <div class="label">Projects tracked</div>
      <div class="value">${String(controllerSummary.projects ?? controllerProjects.length)}</div>
      <div class="sub">${String(controllerSummary.dirty_projects ?? 0)} dirty · ${String(controllerSummary.dirty_unleased_projects ?? 0)} unleased</div>
    </div>
    <div class="card">
      <div class="label">Graph readiness</div>
      <div class="value">${String(graphStats.percent)}%</div>
      <div class="sub">${String(graphStats.ready)}/${String(graphStats.total)} ready · ${String(graphStats.node_count)} nodes</div>
    </div>
    <div class="card">
      <div class="label">Module graph cache</div>
      <div class="value">${String(moduleGraphStats.satisfied)}/${String(moduleGraphStats.total)}</div>
      <div class="sub">${String(moduleGraphStats.gaps)} gaps · ${String(moduleGraphStats.nodes)} nodes · ${String(moduleGraphStats.projects)} projects</div>
    </div>
    <div class="card">
      <div class="label">Graph repair packets</div>
      <div class="value">${String(graphPacketSummary.packet_count ?? graphPackets.length)}</div>
      <div class="sub">${String(graphPacketSummary.project_graph_gaps ?? 0)} project · ${String(graphPacketSummary.module_graph_gap_count ?? 0)} module gaps</div>
    </div>
    <div class="card">
      <div class="label">Merge proposals</div>
      <div class="value">${String(mp.open_count)}</div>
      <div class="sub">open · ${String(mp.resolved_count)} resolved</div>
    </div>
  </div>

  <section>
    <h2>Big picture TLDR</h2>
    <p class="brief">${esc(bigPicture.tldr ?? 'No preflight TLDR available.')}</p>
    ${bigPictureNextRows
      ? `<table>
          <thead>
            <tr><th class="num">next</th><th>multi-slice outlook</th></tr>
          </thead>
          <tbody>${bigPictureNextRows}</tbody>
        </table>`
      : '<p class="empty">No next-slice outlook available.</p>'}
    ${bigPictureHorizonRows ? `<ul class="horizon">${bigPictureHorizonRows}</ul>` : ''}
  </section>

${goalProgressSection}

  <section>
    <h2>Operator packet</h2>
    <p class="brief">${operatorPacket.ready
      ? `Low-token reusable decision cache: ${esc(operatorPacket.size_label)} Markdown, ${esc(operatorPacket.json_size_label)} JSON. Agents should read this before the full dashboard/state.`
      : 'No operator packet yet. Run npm run operator:packet to write the compact reusable decision cache.'}</p>
    <table>
      <thead>
        <tr><th>surface</th><th>purpose</th><th>links</th><th>command</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>operator packet</td>
          <td>first context for agents and humans; executive TLDR, gains, proof, next command</td>
          <td>${operatorPacket.ready ? `<a href="${esc(fileHref(operatorPacket.md_path))}">md</a> <a href="${esc(fileHref(operatorPacket.json_path))}">json</a>` : 'missing'}</td>
          <td><code>${esc(operatorPacket.command)}</code></td>
        </tr>
      </tbody>
    </table>
  </section>

  <section>
    <h2>Module work capacity</h2>
    ${moduleWorkRows
      ? `<table>
          <thead>
            <tr><th>surface</th><th>status</th><th>detail</th><th>command / artifact</th></tr>
          </thead>
          <tbody>${moduleWorkRows}</tbody>
        </table>`
      : '<p class="empty">No project-scoped module-work capacity loaded. Rebuild with <code>npm run gen3:dashboard -- --project &lt;project-id&gt;</code>.</p>'}
  </section>

  <section>
    <h2>Dispatch to observation proof</h2>
    <p class="brief">${esc(waveProof.message)}</p>
    <table>
      <thead>
        <tr><th>surface</th><th>status</th><th>detail</th><th>command / artifact</th></tr>
      </thead>
      <tbody>${renderWaveProofRows(waveProof)}</tbody>
    </table>
  </section>

  <section>
    <h2>Graph command center</h2>
    <table>
      <thead>
        <tr><th>surface</th><th>coverage</th><th>links</th><th>agent command</th></tr>
      </thead>
      <tbody>${graphHubRows}</tbody>
    </table>
  </section>

  <section>
    <h2>Graph repair packets</h2>
    ${graphPacketRows
      ? `<table>
          <thead>
            <tr><th class="num">rank</th><th>project</th><th>kind</th><th class="num">impact</th><th>claim command</th><th>repair command</th><th>verify command</th></tr>
          </thead>
          <tbody>${graphPacketRows}</tbody>
        </table>`
      : '<p class="empty">No graph repair packets available.</p>'}
  </section>

  <section>
    <h2>Parallel cleanup wave</h2>
    ${waveRows
      ? `<table>
          <thead>
            <tr><th class="num">rank</th><th>project</th><th>group</th><th class="num">dirty</th><th class="num">wave gain</th><th class="num">project gain</th><th>claim command</th></tr>
          </thead>
          <tbody>${waveRows}</tbody>
        </table>`
      : '<p class="empty">No safe dirty-cleanup wave available.</p>'}
  </section>

  <section>
    <h2>Controller action queue</h2>
    ${actionRows
      ? `<table>
          <thead>
            <tr><th>severity</th><th>kind</th><th class="num">impact</th><th>project</th><th>action</th><th>detail</th><th>command</th></tr>
          </thead>
          <tbody>${actionRows}</tbody>
        </table>`
      : '<p class="empty">No controller actions.</p>'}
  </section>

  <section>
    <h2>Active leases</h2>
    ${noLeases}
    ${liveLeases.active_count
      ? `<table>
          <thead>
            <tr><th>lease</th><th>kind</th><th>resource</th><th>agent</th><th>acquired</th><th>intent</th></tr>
          </thead>
          <tbody>${leaseRows}</tbody>
        </table>`
      : ''}
  </section>

  <section>
    <h2>Conflict SLA queue</h2>
    ${conflictSlaRows
      ? `<table>
          <thead>
            <tr><th>sla</th><th>project</th><th>brick</th><th class="num">age</th><th>actor</th><th>intent</th><th>resolve command</th></tr>
          </thead>
          <tbody>${conflictSlaRows}</tbody>
        </table>`
      : '<p class="empty">No open conflict reports.</p>'}
  </section>

  <section>
    <h2>Global project control plane</h2>
    ${controllerError}
    ${noControllerProjects}
    ${controllerRows
      ? `<table>
          <thead>
            <tr><th>status</th><th>project</th><th class="num">dirty</th><th class="num">conflicts</th><th>project graph</th><th>module graphs</th><th>links</th><th>root</th></tr>
          </thead>
          <tbody>${controllerRows}</tbody>
        </table>`
      : ''}
  </section>

  <section>
    <h2>Graphify project graph map</h2>
    ${graphCards ? `<div class="graph-map">${graphCards}</div>` : '<p class="empty">No project graph records available.</p>'}
  </section>

  <section>
    <h2>Cached module graphs</h2>
    ${moduleGraphRows
      ? `<table>
          <thead>
            <tr><th>project</th><th class="num">satisfied</th><th class="num">ready</th><th class="num">known empty</th><th class="num">gaps</th><th class="num">missing graphs</th><th class="num">missing targets</th><th class="num">nodes</th><th class="num">edges</th><th>newest graph</th></tr>
          </thead>
          <tbody>${moduleGraphRows}</tbody>
        </table>`
      : '<p class="empty">No cached module graph directories found. Run <code>npm run graphify:refresh:modules -- --project &lt;id&gt; --missing-only</code>.</p>'}
  </section>

  <section>
    <h2>Per-project context coverage</h2>
    ${noProjects}
    ${contextRows
      ? `<table>
          <thead>
            <tr><th>project</th><th class="num">bricks</th><th class="num">events</th><th class="num">open conflicts</th><th class="num">conflicts d/r</th><th class="num">open mp</th><th class="num">resolved mp</th><th>last event</th></tr>
          </thead>
          <tbody>${contextRows}</tbody>
        </table>`
      : ''}
  </section>

  <div class="footer">
    Operator's guide: <code>docs/MULTI_AGENT_OPERATIONS.md</code>
  </div>
</body>
</html>
`;
}

function summarizeGraphs(projects: LooseRecord[]): GraphStats {
  const graphProjects = projects.filter((project) => project.graph);
  const readyProjects = graphProjects.filter((project) => project.graph?.ready);
  const nodeCount = readyProjects.reduce((sum, project) => sum + (project.graph?.node_count ?? 0), 0);
  const edgeCount = readyProjects.reduce((sum, project) => sum + (project.graph?.edge_count ?? 0), 0);
  const maxNodes = readyProjects.reduce((max, project) => Math.max(max, (project.graph?.node_count ?? 0)), 0);
  return {
    total: graphProjects.length,
    ready: readyProjects.length,
    missing: graphProjects.length - readyProjects.length,
    percent: graphProjects.length ? Math.round((readyProjects.length / graphProjects.length) * 100) : 0,
    node_count: nodeCount,
    edge_count: edgeCount,
    max_nodes: maxNodes,
  };
}

function summarizeActions(actions: LooseRecord[]) {
  return {
    blocker: actions.filter((item) => item.severity === 'blocker').length,
    warning: actions.filter((item) => item.severity === 'warning').length,
    watch: actions.filter((item) => item.severity === 'watch').length,
  };
}

function graphPacketsFromActions(actionItems: LooseRecord[]): LooseRecord[] {
  return actionItems
    .filter((item) => item.kind === 'graph-gap' || item.kind === 'module-graph-gap')
    .map((item, index) => ({
      rank: index + 1,
      project: item.project,
      kind: item.kind,
      claim_packet_command: 'npm run controller:sweep:write',
      repair_command: item.command,
      verify_command: item.kind === 'module-graph-gap'
        ? `npm run graphify:check:modules -- --project ${shellArg(item.project)} --strict --summary-json`
        : `npm run graphify:check -- --project ${shellArg(item.project)} --strict`,
      impact_score: (item.impact_score ?? 0),
      module_graph_gap_count: (item.module_graph_gap_count ?? 0),
    }));
}

function summarizeGraphPackets(packets: LooseRecord[]) {
  return {
    packet_count: packets.length,
    project_graph_gaps: packets.filter((packet) => packet.kind === 'graph-gap').length,
    module_graph_gap_count: packets.reduce((sum, packet) => sum + (packet.module_graph_gap_count ?? 0), 0),
  };
}

function summarizeCleanupPackets(parallelWave: LooseRecord) {
  const commands = parallelWave.commands ?? [];
  return {
    packet_count: commands.length,
    default_wave_agent_count: (parallelWave.recommended_agent_count ?? commands.length),
    default_wave_dirty_paths: (parallelWave.total_impact ?? 0),
    default_wave_top_gain_percent: commands[0]?.wave_gain_percent ?? null,
    default_wave_top_project_gain_percent: commands[0]?.project_gain_percent ?? null,
    overflow_count: (parallelWave.overflow_count ?? 0),
  };
}

function projectScopedWaveProof(projectFilters: string[], moduleDispatch: LooseRecord, parallelPreflight: LooseRecord | null = null): WaveProof {
  const project = projectFilters[0] || '<project-id>';
  const dispatchCommand = (parallelPreflight?.primary_next_command ?? moduleDispatch.next_command)
    ?? `npm run module:dispatch -- --project ${shellArg(project)} --task ${shellArg(args.task ?? '<task>')} --max-agents ${String(numberArg(args.maxAgents, 12))}`;
  const observeCommand = (moduleDispatch.observe_write_command ?? moduleDispatch.observe_command)
    ?? `npm run module:observe:write -- --dispatch latest --project ${shellArg(project)}`;
  const summary = moduleDispatch.available
    ? `${String(moduleDispatch.claimed)}/${String(moduleDispatch.assignment_count)} claimed, ${String(moduleDispatch.active)} active, ${String(moduleDispatch.completed)} completed, ${String(moduleDispatch.unclaimed)} unclaimed`
    : 'module dispatch proof is pending';
  const message = moduleDispatch.available
    ? `Project-scoped module dispatch ${moduleDispatch.dispatch_id ?? 'latest'} is observed in the module-work table. Persist observation before assigning the next module wave.`
    : `Project-scoped cleanup is clear. Write a module dispatch before launching ${project} agents, then persist module observation proof.`;
  return {
    kind: 'project-module-dispatch',
    project,
    module_dispatch: moduleDispatch || null,
    status: moduleDispatch.available ? (moduleDispatch.status ?? 'observed') : 'module-dispatch-pending',
    summary,
    message,
    nextCommand: moduleDispatch.available ? (moduleDispatch.next_command ?? observeCommand) : dispatchCommand,
    receipts: null,
    dispatch: null,
    observation: null,
  };
}

function readWaveProof(): WaveProof {
  const dispatch = readLatestWaveFile(DEFAULT_WAVE_DIR, /^cleanup-wave-.*\.json$/);
  const observation = readLatestWaveFile(DEFAULT_WAVE_OBSERVATION_DIR, /^cleanup-wave-.*-observed-.*\.json$|^monitor-only-observed-.*\.json$/);
  const observed = observation?.json.observed ?? {};
  const comparison = observation?.json.comparison ?? {};
  const receipts = observationMatchesReceipts(dispatch, observation)
    ? normalizeReceiptSummary(observation?.json.receipts)
    : null;
  const dispatchSummary = dispatch?.json.summary ?? {};
  const dispatchReadiness = dispatch?.json.readiness ?? {};
  const claimPinning = summarizeDispatchClaimPinning(dispatch?.json.assignments, dispatch?.json.claim_pinning);
  const legacyDispatch = Boolean(dispatch && claimPinning.legacy_rank_only_assignment_count > 0);
  const dispatchId = dispatch?.json.dispatch_id ?? null;
  const observationDispatchId = observation?.json.dispatch?.dispatch_id ?? null;
  const observationMatchesDispatch = Boolean(dispatchId && observationDispatchId && dispatchId === observationDispatchId);

  let status = 'missing';
  if (legacyDispatch) status = 'legacy-dispatch';
  else if (dispatch && observationMatchesDispatch) status = observation?.json.status ?? 'observed';
  else if (dispatch && observation) status = 'stale-observation';
  else if (dispatch) status = 'dispatch-only';

  const nextCommand = !dispatch
    ? 'npm run gen3:dispatch -- --limit 12'
    : legacyDispatch
      ? 'npm run gen3:dispatch -- --limit 12'
    : observationMatchesDispatch
      ? (observation?.json.next ?? 'npm run gen3:watch -- --no-auto-refresh')
      : 'npm run gen3:observe:write -- --dispatch latest';

  const summary = !dispatch
    ? 'no dispatch manifest yet'
    : legacyDispatch
      ? `${String(claimPinning.legacy_rank_only_assignment_count)}/${String(claimPinning.assignment_count)} assignments use rank-only claims`
    : observationMatchesDispatch
      ? `${String(observed.reduced_paths ?? 0)}/${String(observed.baseline_paths ?? dispatchSummary.targeted_dirty_paths ?? 0)} paths reduced${receipts ? ` · ${formatReceiptSummary(receipts)}` : ''}`
      : `${String(dispatchSummary.assignment_count ?? dispatch.json.assignments?.length ?? 0)} agents dispatched; observation pending`;

  const message = !dispatch
    ? 'Predicted readiness is available, but no dispatch manifest has been written. Write dispatch before launching agents so the wave can be observed later.'
    : legacyDispatch
      ? `Latest dispatch ${String(dispatchId)} uses legacy rank-only claim commands. Regenerate dispatch before assigning agents so packet auto-refresh cannot claim the wrong slot.`
    : observationMatchesDispatch
      ? `Latest dispatch ${String(dispatchId)} has an observation: ${String(observed.reduced_paths ?? 0)}/${String(observed.baseline_paths ?? 0)} paths reduced, ${receipts ? `${formatReceiptSummary(receipts)}, ` : ''}conflicts ${String(observed.open_conflicts ?? 0)}, next ${observation?.json.next ?? 'watch'}.`
      : `Latest dispatch ${String(dispatchId)} has no matching observation yet. Run observe:write after agents start or finish so predicted gain is not mistaken for achieved gain.`;

  return {
    status,
    summary,
    message,
    nextCommand,
    receipts,
    dispatch: dispatch
      ? {
          id: dispatchId,
          file: dispatch.path,
          created_at: dispatch.json.created_at ?? '',
          assignment_count: (dispatchSummary.assignment_count ?? dispatch.json.assignments?.length ?? 0),
          targeted_dirty_paths: (dispatchSummary.targeted_dirty_paths ?? 0),
          claimable_dirty_paths: (dispatchSummary.claimable_dirty_paths ?? 0),
          readiness: dispatchReadiness.status ?? 'unknown',
          top_wave_gain_percent: dispatchReadiness.top_wave_gain_percent ?? null,
          claim_pinning: claimPinning,
        }
      : null,
    observation: observation
      ? {
          dispatch_id: observationDispatchId,
          file: observation.path,
          generated_at: observation.json.generated_at ?? '',
          status: observation.json.status ?? 'unknown',
          reduced_paths: (observed.reduced_paths ?? 0),
          baseline_paths: Number(observed.baseline_paths ?? comparison.actual_baseline_paths ?? 0),
          remaining_paths: (observed.remaining_paths ?? 0),
          open_conflicts: (observed.open_conflicts ?? 0),
          graph_packets: (observed.graph_packets ?? 0),
          observed_reduction_percent: comparison.observed_reduction_percent ?? observed.reduction_percent ?? null,
          receipts,
        }
      : null,
  };
}

function summarizeDispatchClaimPinning(assignments: unknown, manifestClaimPinning: unknown) {
  const list = Array.isArray(assignments) ? assignments : [];
  const pinned = list.filter((item) => isRecord(item) && isPinnedClaimCommand(item.claim_command));
  return {
    ...(manifestClaimPinning && typeof manifestClaimPinning === 'object' ? manifestClaimPinning : {}),
    assignment_count: list.length,
    pinned_assignment_count: pinned.length,
    legacy_rank_only_assignment_count: Math.max(0, list.length - pinned.length),
  };
}

function isPinnedClaimCommand(command: unknown): boolean {
  const text = String(command ?? '');
  return ['--project', '--brick', '--group', '--dispatch-rank', '--expected-dirty-path-count', '--dispatch-id']
    .every((flag) => text.includes(flag));
}

function observationMatchesReceipts(dispatch: LooseRecord | null, observation: LooseRecord | null): boolean {
  const dispatchId = dispatch?.json?.dispatch_id ?? null;
  const observationDispatchId = observation?.json?.dispatch?.dispatch_id ?? null;
  return Boolean(dispatchId && observationDispatchId && dispatchId === observationDispatchId && observation?.json?.receipts);
}

function normalizeReceiptSummary(raw: unknown): ReceiptSummary | null {
  if (!isRecord(raw)) return null;
  return {
    assignment_count: (raw.assignment_count ?? raw.dispatched_count ?? 0),
    claimed_count: (raw.claimed_count ?? 0),
    active_count: (raw.active_count ?? 0),
    completed_count: (raw.completed_count ?? 0),
    unclaimed_count: (raw.unclaimed_count ?? 0),
    context_error_count: (raw.context_error_count ?? 0),
  };
}

function formatReceiptSummary(receipts: ReceiptSummary | null): string {
  if (!receipts) return '';
  return `${String(receipts.claimed_count)}/${String(receipts.assignment_count)} claimed, ${String(receipts.active_count)} active, ${String(receipts.completed_count)} completed, ${String(receipts.unclaimed_count)} unclaimed`;
}

function receiptStatus(receipts: { assignment_count: number; context_error_count: number; unclaimed_count: number; completed_count: number; active_count: number; claimed_count: number; }) {
  if (!receipts || receipts.assignment_count === 0) return 'missing';
  if (receipts.context_error_count > 0) return 'warning';
  if (receipts.unclaimed_count === 0 && receipts.completed_count >= receipts.assignment_count) return 'complete';
  if (receipts.unclaimed_count === 0) return receipts.active_count > 0 ? 'active' : 'claimed';
  if (receipts.claimed_count > 0) return 'partial';
  return 'unclaimed';
}

function readLatestWaveFile(root: string, pattern: RegExp): (LooseRecord & { path: string; json: LooseRecord }) | null {
  if (!existsSync(root)) return null;
  let files = [];
  try {
    files = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => resolve(root, entry.name))
      .sort((left, right) => right.localeCompare(left));
  } catch {
    // A missing or unreadable observation directory means no wave proof exists yet.
    return null;
  }
  for (const file of files) {
    const json = readJsonIfExists(file);
    if (json) return { path: file, json };
  }
  return null;
}

function renderWaveProofRows(proof: WaveProof): string {
  if (proof.kind === 'project-module-dispatch') return renderProjectModuleProofRows(proof);
  const dispatch = proof.dispatch;
  const observation = proof.observation;
  const claimPinning = dispatch?.claim_pinning ?? null;
  const rows = [
    {
      surface: 'latest dispatch',
      status: dispatch ? ((claimPinning?.legacy_rank_only_assignment_count ?? 0) > 0 ? 'legacy-rank-only' : dispatch.readiness) : 'missing',
      detail: dispatch
        ? `${String(dispatch.assignment_count)} agents · ${String(dispatch.targeted_dirty_paths)} targeted paths · top gain ${formatPercent(dispatch.top_wave_gain_percent)}${(claimPinning?.legacy_rank_only_assignment_count ?? 0) > 0 ? ` · ${String(claimPinning?.legacy_rank_only_assignment_count ?? 0)} legacy rank-only claims` : ''}`
        : 'no cleanup-wave dispatch manifest in handoffs/waves',
      command: dispatch ? fileLink(dispatch.file ?? '', 'json') : 'npm run gen3:dispatch -- --limit 12',
    },
    {
      surface: 'latest observation',
      status: observation ? observation.status : 'missing',
      detail: observation
        ? `${String(observation.reduced_paths)}/${String(observation.baseline_paths)} paths reduced · ${String(observation.remaining_paths)} remaining · conflicts ${String(observation.open_conflicts)}`
        : 'no persisted observation for latest dispatch',
      command: observation ? fileLink(observation.file ?? '', 'json') : 'npm run gen3:observe:write -- --dispatch latest',
    },
    {
      surface: 'next proof action',
      status: proof.status,
      detail: proof.summary,
      command: proof.nextCommand,
    },
  ];
  const receiptSummary = proof.receipts;
  if (receiptSummary) {
    rows.splice(2, 0, {
      surface: 'claim receipts',
      status: receiptStatus(receiptSummary),
      detail: formatReceiptSummary(receiptSummary),
      command: observation ? fileLink(observation.file ?? '', 'observation') : 'npm run gen3:observe:write -- --dispatch latest',
    });
  }
  return rows.map((row) => `
      <tr>
        <td>${esc(row.surface)}</td>
        <td><span class="status ${esc(row.status)}">${esc(row.status)}</span></td>
        <td>${esc(row.detail)}</td>
        <td>${row.command.startsWith('<a ') ? row.command : `<code>${esc(row.command)}</code>`}</td>
      </tr>`).join('');
}

function renderProjectModuleProofRows(proof: WaveProof): string {
  const moduleDispatch = proof.module_dispatch ?? {};
  const dispatchAvailable = Boolean(moduleDispatch.available);
  const rows = [
    {
      surface: 'module dispatch',
      status: dispatchAvailable ? moduleDispatch.status : 'missing',
      detail: dispatchAvailable
        ? `${moduleDispatch.dispatch_id ?? 'latest'} · ${String(moduleDispatch.claimed)}/${String(moduleDispatch.assignment_count)} claimed · ${String(moduleDispatch.active)} active · ${String(moduleDispatch.completed)} done · ${String(moduleDispatch.unclaimed)} open`
        : `no module dispatch manifest for ${proof.project ?? '<project-id>'}`,
      command: dispatchAvailable
        ? moduleDispatch.observe_command ?? proof.nextCommand
        : proof.nextCommand,
    },
    {
      surface: 'module observation',
      status: dispatchAvailable ? moduleDispatch.status : 'pending',
      detail: dispatchAvailable
        ? `conflicts ${String(moduleDispatch.open_conflicts ?? 0)} · graph ready ${String(moduleDispatch.graph_ready ?? 0)}/${String(moduleDispatch.assignment_count ?? 0)}`
        : 'observation starts after a dispatch manifest exists',
      command: dispatchAvailable
        ? (moduleDispatch.observe_write_command ?? moduleDispatch.observe_command) ?? proof.nextCommand
        : proof.nextCommand,
    },
    {
      surface: 'next proof action',
      status: proof.status,
      detail: proof.summary,
      command: proof.nextCommand,
    },
  ];
  return rows.map((row) => `
      <tr>
        <td>${esc(row.surface)}</td>
        <td><span class="status ${esc(row.status)}">${esc(row.status)}</span></td>
        <td>${esc(row.detail)}</td>
        <td><code>${esc(row.command)}</code></td>
      </tr>`).join('');
}

function renderModuleWorkRows(moduleWork: LooseRecord, moduleDispatch: LooseRecord, parallelPreflight: LooseRecord): string {
  const rows = [];
  if (moduleWork.available) {
    rows.push(
      {
        surface: 'safe module slots',
        status: moduleWork.status ?? 'unknown',
        detail: `${String(moduleWork.launch_ready_slots)}/${String(moduleWork.requested_agents)} slots safe · ${moduleWork.modules?.join(', ') ?? 'no modules'}`,
        command: moduleWork.plan_command ?? '',
      },
      {
        surface: 'module graphs',
        status: (moduleWork.graph_blocked_modules ?? 0) > 0 ? 'blocked' : 'ready',
        detail: `${String(moduleWork.graph_ready_modules)}/${String(moduleWork.modules_total)} module graphs ready · ${String(moduleWork.graph_blocked_modules)} graph blocked`,
        command: moduleWork.plan_command ?? '',
      },
      {
        surface: 'project dashboard',
        status: moduleWork.dashboard_command ? 'ready' : 'missing',
        detail: `${moduleWork.project ?? 'project'} scoped Gen3 dashboard with module slots, graph coverage, and dispatch proof`,
        command: moduleWork.dashboard_command ?? '',
      },
      {
        surface: 'module wave watch',
        status: moduleWork.watch_command ? 'ready' : 'missing',
        detail: 'low-token dispatch/progress/conflict monitor for module waves',
        command: moduleWork.watch_command ?? '',
      },
      {
        surface: 'blocked capacity',
        status: moduleWork.held_slots || moduleWork.path_overlap_blocked_slots ? 'watch' : 'clear',
        detail: `${String(moduleWork.held_slots)} held slot(s) · ${String(moduleWork.path_overlap_blocked_slots)} overlap-blocked slot(s)`,
        command: 'npm run controller:snapshot:quiet -- --project ' + shellArg(moduleWork.project ?? ''),
      },
      {
        surface: 'dispatch next wave',
        status: moduleWork.task_is_placeholder
          ? 'needs-task'
          : (moduleWork.launch_ready_slots ?? 0) > 0
            ? 'write-dispatch-first'
            : 'blocked',
        detail: moduleWork.task_is_placeholder
          ? 'provide a concrete module task, then write a dispatch manifest before launching agents'
          : `${formatPercent(moduleWork.gains?.module_graph_first_token_reduction_percent_estimate)} graph-first token reduction · ${formatPercent(moduleWork.gains?.collision_reduction_percent_estimate)} collision reduction estimate`,
        command: (moduleWork.dispatch_command ?? moduleWork.plan_command) ?? '',
      },
    );
  }
  if (moduleDispatch.status && moduleDispatch.status !== 'not-requested') {
    rows.push({
      surface: 'current module dispatch',
      status: moduleDispatch.status,
      detail: moduleDispatch.available
        ? `${String(moduleDispatch.claimed)}/${String(moduleDispatch.assignment_count)} claimed · ${String(moduleDispatch.active)} active · ${String(moduleDispatch.completed)} done · ${String(moduleDispatch.unclaimed)} open · conflicts ${String(moduleDispatch.open_conflicts)}`
        : 'no project-scoped module dispatch manifest is open',
      command: moduleDispatch.available
        ? (moduleDispatch.next_command ?? (moduleDispatch.observe_write_command ?? moduleDispatch.observe_command)) ?? ''
        : moduleDispatch.observe_command ?? '',
    });
  }
  if (parallelPreflight.primary_next_command) {
    rows.push({
      surface: 'controller next action',
      status: parallelPreflight.status ?? 'unknown',
      detail: (parallelPreflight.big_picture?.current_slice ?? parallelPreflight.big_picture?.tldr) ?? 'preflight next command',
      command: parallelPreflight.primary_next_command,
    });
  }
  if (!rows.length) return '';
  return rows.map((row) => `
      <tr>
        <td>${esc(row.surface)}</td>
        <td><span class="status ${esc(row.status)}">${esc(row.status)}</span></td>
        <td>${esc(row.detail)}</td>
        <td><code>${esc(row.command)}</code></td>
      </tr>`).join('');
}

function formatModuleDispatchValue(moduleDispatch: LooseRecord): string {
  if (!moduleDispatch || moduleDispatch.status === 'not-requested') return 'n/a';
  if (!moduleDispatch.available) return moduleDispatch.status ?? 'missing';
  return `${String(Number(moduleDispatch.claimed ?? 0))}/${String(Number(moduleDispatch.assignment_count ?? 0))}`;
}

function formatModuleDispatchSub(moduleDispatch: LooseRecord): string {
  if (!moduleDispatch || moduleDispatch.status === 'not-requested') return 'build with --project <id>';
  if (!moduleDispatch.available) return 'no open module dispatch';
  return `${String(moduleDispatch.status)} · ${String(Number(moduleDispatch.active ?? 0))} active · ${String(Number(moduleDispatch.completed ?? 0))} done · ${String(Number(moduleDispatch.unclaimed ?? 0))} open`;
}

function formatGraphPacketImpact(packet: LooseRecord): string {
  if (packet.kind === 'module-graph-gap') return `${(String(packet.module_graph_gap_count ?? packet.impact_score ?? 0))} gaps`;
  if (packet.kind === 'graph-gap') return 'missing';
  return String(packet.impact_score ?? '');
}

function formatPercent(value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  return `${String(n)}%`;
}

function formatActionImpact(item: LooseRecord): string {
  if (!item) return '';
  if (item.kind === 'dirty-unleased') return `${(String(item.dirty_count ?? item.impact_score ?? 0))} dirty`;
  if (item.kind === 'active-dirty-scope') return `${(String(item.uncovered_dirty_count ?? item.impact_score ?? 0))} uncovered`;
  if (item.kind === 'module-graph-gap') return `${(String(item.module_graph_gap_count ?? item.impact_score ?? 0))} gaps`;
  if (item.kind === 'graph-gap') return 'missing';
  return '';
}

function normalizeModuleGraphSummary(project: LooseRecord): ModuleGraphSummary | null {
  const summary = project.module_graph;
  if (!summary || !project.id) return null;
  return {
    project: project.id,
    cache_count: Number(summary.cache_count ?? summary.module_count ?? 0),
    total_count: Number(summary.total_count ?? summary.module_count ?? 0),
    ready_count: (summary.ready_count ?? 0),
    known_empty_count: (summary.known_empty_count ?? 0),
    unreadable_count: (summary.unreadable_count ?? 0),
    actionable_gap_count: (summary.actionable_gap_count ?? 0),
    missing_graph_count: (summary.missing_graph_count ?? 0),
    missing_target_count: (summary.missing_target_count ?? 0),
    satisfied_count: (summary.satisfied_count ?? 0),
    node_count: (summary.node_count ?? 0),
    edge_count: (summary.edge_count ?? 0),
    oldest_updated_at: stringOrNull(summary.oldest_graph_updated_at ?? summary.oldest_updated_at),
    newest_updated_at: stringOrNull(summary.newest_graph_updated_at ?? summary.newest_updated_at),
  };
}

function readCachedModuleGraphSummary(project: LooseRecord): ModuleGraphSummary | null {
  if (!project.root) return null;
  const modulesRoot = resolve(project.root, 'graphify-out/modules');
  if (!existsSync(modulesRoot)) return null;

  let entries = [];
  try {
    entries = readdirSync(modulesRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    // Module graph cache absence is represented as an unavailable summary.
    return null;
  }

  let readyCount = 0;
  let knownEmptyCount = 0;
  let unreadableCount = 0;
  let nodeCount = 0;
  let edgeCount = 0;
  const updatedTimes = [];

  for (const entry of entries) {
    const graphPath = resolve(modulesRoot, entry.name, 'graphify-out/graph.json');
    if (!existsSync(graphPath)) {
      unreadableCount += 1;
      continue;
    }
    try {
      const stat = statSync(graphPath);
      updatedTimes.push(stat.mtime.toISOString());
      const counts = readGraphJsonCounts(graphPath);
      if (counts.ready) {
        readyCount += 1;
        nodeCount += counts.node_count;
        edgeCount += counts.edge_count;
      } else if (counts.known_empty) {
        knownEmptyCount += 1;
      } else {
        unreadableCount += 1;
      }
    } catch {
      // Individual corrupt graph caches are counted without hiding the aggregate gap.
      unreadableCount += 1;
    }
  }

  if (!entries.length) return null;
  updatedTimes.sort();
  if (!project.id) return null;
  const checkSummary = readModuleGraphCheckSummary(project.id);
  return {
    project: project.id,
    cache_count: entries.length,
    total_count: checkSummary?.moduleCount ?? entries.length,
    ready_count: checkSummary?.readyCount ?? readyCount,
    known_empty_count: checkSummary?.knownEmptyCount ?? knownEmptyCount,
    unreadable_count: unreadableCount,
    actionable_gap_count: checkSummary?.actionableGapCount ?? unreadableCount,
    missing_graph_count: checkSummary?.missingGraphCount ?? 0,
    missing_target_count: checkSummary?.missingTargetCount ?? 0,
    satisfied_count: checkSummary?.satisfiedCount ?? (readyCount + knownEmptyCount),
    node_count: checkSummary?.nodeCount ?? nodeCount,
    edge_count: checkSummary?.edgeCount ?? edgeCount,
    oldest_updated_at: updatedTimes[0] || null,
    newest_updated_at: checkSummary?.newestGraphUpdatedAt ?? updatedTimes[updatedTimes.length - 1] ?? null,
  };
}

function readModuleGraphCheckSummary(projectId: string): ModuleGraphCheckSummary | null {
  try {
    const raw = execFileSync(process.execPath, [
      resolve(SMA_ROOT, 'tools/sma-graphify.ts'),
      'check-modules',
      '--project',
      projectId,
      '--summary-json',
    ], {
      cwd: SMA_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 12 * 1024 * 1024,
    });
    const parsed = safeJson(raw);
    return parsed ? {
      actionableGapCount: (parsed.actionableGapCount ?? 0),
      edgeCount: (parsed.edgeCount ?? 0),
      knownEmptyCount: (parsed.knownEmptyCount ?? 0),
      missingGraphCount: (parsed.missingGraphCount ?? 0),
      missingTargetCount: (parsed.missingTargetCount ?? 0),
      moduleCount: (parsed.moduleCount ?? 0),
      newestGraphUpdatedAt: typeof parsed.newestGraphUpdatedAt === 'string' ? parsed.newestGraphUpdatedAt : undefined,
      nodeCount: (parsed.nodeCount ?? 0),
      readyCount: (parsed.readyCount ?? 0),
      satisfiedCount: (parsed.satisfiedCount ?? 0),
    } : null;
  } catch {
    // The dashboard degrades to cached/unknown graph state when the helper fails.
    return null;
  }
}

function readGraphJsonCounts(graphPath: string): { edge_count: number; known_empty: boolean; node_count: number; ready: boolean } {
  const graph = safeJson(readFileSync(graphPath, 'utf8'));
  if (!graph) return { ready: false, known_empty: false, node_count: 0, edge_count: 0 };
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : graph.elements?.nodes;
  const edges = Array.isArray(graph.edges) ? graph.edges : graph.links ?? graph.elements?.edges;
  const nodeCount = countGraphCollection(nodes);
  const edgeCount = countGraphCollection(edges);
  const metadata = isRecord(graph.metadata) ? graph.metadata : {};
  return {
    ready: nodeCount > 0,
    known_empty: nodeCount === 0 && metadata.sma_status === 'empty',
    node_count: nodeCount,
    edge_count: edgeCount,
  };
}

function countGraphCollection(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return 0;
}

function summarizeModuleGraphCache(summaries: ModuleGraphSummary[]) {
  return {
    projects: summaries.length,
    total: summaries.reduce((sum, item) => sum + item.total_count, 0),
    satisfied: summaries.reduce((sum, item) => sum + item.satisfied_count, 0),
    gaps: summaries.reduce((sum, item) => sum + (item.actionable_gap_count ?? 0), 0),
    missing_graphs: summaries.reduce((sum, item) => sum + (item.missing_graph_count ?? 0), 0),
    missing_targets: summaries.reduce((sum, item) => sum + (item.missing_target_count ?? 0), 0),
    nodes: summaries.reduce((sum, item) => sum + item.node_count, 0),
    edges: summaries.reduce((sum, item) => sum + item.edge_count, 0),
  };
}

function readSmaGlobalGraph(): LooseRecord {
  const graphPath = resolve(SMA_ROOT, 'graphify-out/graph.json');
  const reportPath = resolve(SMA_ROOT, 'graphify-out/GRAPH_REPORT.md');
  if (!existsSync(graphPath)) {
    return {
      ready: false,
      graph_path: graphPath,
      report_path: existsSync(reportPath) ? reportPath : null,
    };
  }
  const counts = readGraphJsonCounts(graphPath);
  const stat = statSync(graphPath);
  return {
    ready: counts.ready,
    node_count: counts.node_count,
    edge_count: counts.edge_count,
    graph_path: graphPath,
    report_path: existsSync(reportPath) ? reportPath : null,
    updated_at: stat.mtime.toISOString(),
  };
}

function goalProgressProjects(controllerProjects: LooseRecord[], projectFilters: string[]): { id: string; root: string }[] {
  const filters = new Set((projectFilters || []).map((project) => project.toLowerCase()));
  const rows: { id: string; root: string }[] = [];
  const seen = new Set();
  const add = (project: unknown) => {
    if (!isRecord(project)) return;
    const id = (project.id ?? '').trim();
    const root = typeof project.root === 'string' ? project.root : '';
    if (!id || !root) return;
    if (filters.size && !filters.has(id.toLowerCase())) return;
    const key = `${id}:${root}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ id, root });
  };
  add({ id: 'sma', root: SMA_ROOT });
  for (const project of controllerProjects || []) add(project);
  return rows;
}

function renderGraphHubRows({ globalGraph, graphStats, moduleGraphStats, actionItems, controllerProjects, graphPacketSummary }: { globalGraph: LooseRecord | null; graphStats: GraphStats; moduleGraphStats: ReturnType<typeof summarizeModuleGraphCache>; actionItems: LooseRecord[]; controllerProjects: LooseRecord[]; graphPacketSummary: LooseRecord }): string {
  const missingProjectGraphs = Math.max(0, (graphStats.total || 0) - (graphStats.ready || 0));
  const moduleGaps = (moduleGraphStats.gaps || 0);
  const rows = [
    {
      surface: 'Global SMA graph',
      coverage: globalGraph?.ready
        ? `${String(globalGraph.node_count ?? 0)} nodes / ${String(globalGraph.edge_count ?? 0)} edges`
        : 'missing',
      links: graphLinks(globalGraph),
      command: 'npm run graphify:query:self -- -- "where is <feature or module>?"',
    },
    {
      surface: 'Portfolio project graphs',
      coverage: `${String(graphStats.ready)}/${String(graphStats.total)} ready · ${String(missingProjectGraphs)} missing`,
      links: 'see project graph map below',
      command: 'npm run graphify:refresh -- --project <project-id> --global',
    },
    {
      surface: 'Mandatory module graphs',
      coverage: `${String(moduleGraphStats.satisfied)}/${String(moduleGraphStats.total)} satisfied · ${String(moduleGaps)} gaps`,
      links: 'see cached module graphs below',
      command: 'npm run graphify:refresh:modules -- --project <project-id> --missing-only --limit 25 --global',
    },
    {
      surface: 'Graph repair packets',
      coverage: `${String(graphPacketSummary.packet_count ?? 0)} packets · ${String(graphPacketSummary.project_graph_gaps ?? 0)} project · ${String(graphPacketSummary.module_graph_gap_count ?? 0)} module gaps`,
      links: graphPacketLinks(),
      command: 'npm run graph:packets',
    },
    {
      surface: 'Agent retrieval',
      coverage: `${String(controllerProjects.length)} tracked projects · ${String(actionItems.length)} controller actions`,
      links: 'query local graph first',
      command: 'npm run graphify:query -- --project <project-id> --module <module-id> -- "question"',
    },
  ];

  return rows.map((row) => `
      <tr>
        <td>${esc(row.surface)}</td>
        <td>${esc(row.coverage)}</td>
        <td>${row.links || ''}</td>
        <td><code>${esc(row.command)}</code></td>
      </tr>`).join('');
}

function dashboardVisibleLeases(liveLeases: ReturnType<typeof readActiveLeases>) {
  const leases = (liveLeases.leases || []).filter((lease: Partial<{ lease_id: string; resource_kind: string; resource_id: string; agent_id: string; project?: string|null; acquired_at: string; expires_at: string; intent?: string; }>|null|undefined) => !isVolatileSmaRegenLease(lease));
  return {
    ...liveLeases,
    active_count: leases.length,
    by_resource_kind: bucketLeases(leases, 'resource_kind'),
    by_agent: bucketLeases(leases, 'agent_id'),
    leases,
  };
}

function isVolatileSmaRegenAction(item: LooseRecord): boolean {
  return item.project === 'sma'
    && item.kind === 'active-lease'
    && /^Watch active (registry-regen|state-regen|wiki-regen):/.test((item.title ?? ''));
}

function bucketLeases(leases: { agent_id?: string; resource_kind?: string }[], key: 'agent_id' | 'resource_kind'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const lease of leases) {
    const value = lease[key] ?? 'unknown';
    out[value] = (out[value] || 0) + 1;
  }
  return out;
}

function graphPacketLinks() {
  return `<a href="${esc(fileHref(DEFAULT_GRAPH_PACKETS_MD))}">packets</a> <a href="${esc(fileHref(DEFAULT_GRAPH_PACKETS))}">json</a>`;
}

function graphLinks(graph: LooseRecord | null | undefined): string {
  if (!graph) return '';
  const links = [];
  if (graph.report_path) links.push(`<a href="${esc(fileHref(graph.report_path))}">report</a>`);
  if (graph.graph_path) links.push(`<a href="${esc(fileHref(graph.graph_path))}">json</a>`);
  return links.join(' ');
}

function readJsonIfExists(filePath: string): LooseRecord | null {
  if (!existsSync(filePath)) return null;
  try {
    return safeJson(readFileSync(filePath, 'utf8'));
  } catch {
    // Optional generated controller artifacts may not exist during bootstrap.
    return null;
  }
}

function readOperatorPacketSummary(projectFilters: string[] = []) {
  const project = projectFilters.length === 1 ? projectFilters[0] : null;
  const jsonPath = project
    ? resolve(SMA_ROOT, 'handoffs', `operator-packet.${safePathSegment(project)}.generated.json`)
    : DEFAULT_OPERATOR_PACKET;
  const mdPath = jsonPath.replace(/\.json$/i, '.md');
  const ready = existsSync(jsonPath) && existsSync(mdPath);
  const mdSize = ready ? statSync(mdPath).size : 0;
  const jsonSize = ready ? statSync(jsonPath).size : 0;
  return {
    ready,
    json_path: jsonPath,
    md_path: mdPath,
    size_bytes: mdSize,
    json_size_bytes: jsonSize,
    size_label: formatBytes(mdSize),
    json_size_label: formatBytes(jsonSize),
    command: project
      ? `npm run operator:packet -- --project ${shellArg(project)}`
      : 'npm run operator:packet',
  };
}

function formatBytes(bytes: unknown): string {
  const value = Number(bytes ?? 0);
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${String(value)}B`;
}

function readConflictSummary(): LooseRecord {
  try {
    const raw = execFileSync(process.execPath, [
      resolve(SMA_ROOT, 'tools/sma-conflict.ts'),
      'summary',
      '--all',
      '--json',
      '--limit',
      '20',
    ], {
      cwd: SMA_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 12 * 1024 * 1024,
    });
    return safeJson(raw) ?? { conflicts: [] };
  } catch {
    // Conflict telemetry is optional for rendering; preserve an explicit unknown state.
    return {
      summary: {
        status: 'unknown',
        open_conflicts: 0,
        warning_conflicts: 0,
        critical_conflicts: 0,
        oldest_age_bucket: 'unknown',
      },
      conflicts: [],
    };
  }
}

function readParallelPreflight(): LooseRecord {
  try {
    const projectFilters = asArray(args.project);
    const preflightArgs = [
      resolve(SMA_ROOT, 'tools/sma-parallel-preflight.ts'),
      '--auto-limit',
      '--max-agents',
      String(numberArg(args.maxAgents, 12)),
      '--json',
      '--no-auto-refresh',
    ];
    if (projectFilters.length === 1) preflightArgs.push('--project', projectFilters[0]);
    if (args.task) preflightArgs.push('--task', args.task);
    const raw = execFileSync(process.execPath, preflightArgs, {
      cwd: SMA_ROOT,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 96 * 1024 * 1024,
    });
    return safeJson(raw) ?? fallbackParallelPreflight();
  } catch {
    // Parallel preflight failure is rendered through the explicit fallback payload.
    return fallbackParallelPreflight();
  }
}

function fallbackParallelPreflight(): LooseRecord {
  return {
    status: 'unknown',
    readiness_score_percent: 0,
    requested_agents: 0,
    recommended_agents: 0,
    limit_mode: 'unknown',
    launch_plan: [],
    big_picture: {
      tldr: 'Parallel preflight unavailable.',
      next_slices: [],
      horizon: [],
    },
    gains: {
      selected_wave_top_gain_percent: null,
    },
  };
}

function graphCard(project: LooseRecord, maxNodes: number): string {
  const graph = project.graph;
  const ready = Boolean(graph?.ready);
  const nodes = (graph?.node_count ?? 0);
  const edges = (graph?.edge_count ?? 0);
  const width = ready && maxNodes > 0 ? Math.max(8, Math.round((nodes / maxNodes) * 100)) : 0;
  const updated = graph?.updated_at ? ` · ${graph.updated_at.slice(0, 10)}` : '';
  const links = graphLinks(graph);
  return `
    <div class="graph-node ${ready ? 'ready' : 'missing'}">
      <strong>${esc(project.id)}</strong>
      <span>${ready ? `${String(nodes)} nodes / ${String(edges)} edges${updated}` : 'graph missing'}</span>
      <div class="bar"><i style="width:${String(width)}%"></i></div>
      ${links ? `<div class="links">${links}</div>` : ''}
    </div>`;
}

function statusRank(status: unknown) {
  const ranks = {
    blocked: 0,
    'dirty-unleased': 1,
    'graph-gap': 2,
    active: 3,
    missing: 4,
    clear: 5,
  };
  return typeof status === 'string' && status in ranks ? ranks[status as keyof typeof ranks] : 9;
}

function fileHref(filePath: string): string {
  return pathToFileURL((filePath || '')).href;
}

function fileLink(filePath: string, label = 'file'): string {
  return `<a href="${esc(fileHref(filePath))}">${esc(label)}</a>`;
}

function formatLeaseKinds(byKind: Record<string, unknown>|ArrayLike<unknown>) {
  if (!byKind || !Object.keys(byKind).length) return 'idle';
  return Object.entries(byKind).map(([k, v]) => `${k}: ${String(v)}`).join(' · ');
}

function numberArg(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asArray(value: string | string[] | null | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function safeJson(raw: string): LooseRecord | null {
  try { const value: unknown = JSON.parse(raw); return isRecord(value) ? value : null; }
  catch { return null; } // Invalid optional snapshots are handled by each caller's fallback.
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function shellArg(value: unknown): string {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function parseArgs(list: string[]): DashboardArgs {
  const out: DashboardArgs = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_, character: string) => character.toUpperCase());
    const next = list[i + 1];
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) {
      if (camel === 'noDirty' || camel === 'noGoalProgress' || camel === 'noGraphs' || camel === 'priorityOnly') out[camel] = true;
      continue;
    }
    if (camel === 'project') {
      out.project = [...asArray(out.project), next];
    } else {
      setDashboardArg(out, camel, next);
    }
    i += 1;
  }
  return out;
}

function setDashboardArg(out: DashboardArgs, key: string, value: string): void {
  if (key === 'controllerTimeoutMs' || key === 'dirtyLimit' || key === 'goalHours' || key === 'maxAgents' || key === 'out' || key === 'state' || key === 'task') out[key] = value;
}

function isRecord(value: unknown): value is LooseRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
