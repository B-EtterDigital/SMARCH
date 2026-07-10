#!/usr/bin/env node
/**
 * sma-controller-snapshot.mjs — fast read-only Gen3 controller view.
 *
 * Summarizes the live surfaces that matter while multiple agents are working:
 * active leases, unresolved conflicts, project graph readiness, and dirty git
 * state. It does not regenerate files, acquire leases, or mutate projects.
 */

import { argv, exit } from 'node:process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readActiveLeases } from './lib/gen3-state.mjs';
import {
  listBricksWithContext,
  readContextLog,
  projectRoot,
} from './lib/context-log.mjs';
import { discoverPortfolioProjects, priorityProjectIds } from './lib/portfolio-projects.mjs';
import {
  buildActionReport,
  buildCleanupPacketReport,
  buildGraphPacketReport,
  renderActionReportMarkdown,
  renderCleanupPacketMarkdown,
  renderGraphPacketMarkdown,
} from './lib/controller-action-report.mjs';

const args = parseArgs(argv.slice(2));
const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIRTY_LIMIT = 0;
const DEFAULT_ACTION_LIMIT = 25;
const DEFAULT_PARALLEL_WAVE_LIMIT = 12;
const GRAPH_REPAIR_TIMEOUT_SECONDS = 240;
const DIRTY_PARALLEL_CLAIM_LIMIT = 5;
const DIRTY_PARALLEL_CLAIM_MIN_DIRTY = 20;
const DIRTY_GROUP_SAMPLE_LIMIT = 5;
const DEFAULT_STALE_AGENT_PROCESS_SECONDS = 24 * 60 * 60;
const AGENT_PROCESS_SAMPLE_LIMIT = 6;
const STALE_CONTEXT_RECEIPT_SECONDS = 24 * 60 * 60;
const DEFAULT_ACTION_REPORT_JSON = resolve('handoffs/controller-actions.generated.json');
const CLEANUP_PACKETS_BASENAME = 'cleanup-packets.generated';
const GRAPH_PACKETS_BASENAME = 'graph-packets.generated';
const SMA_SELF_GENERATED_PATHS = new Set([
  'registry/active-leases.generated.json',
  'registry/global-modules.generated.json',
  'scans/all-projects/latest.registry.json',
  'wiki/SMA_STATE.generated.json',
  'wiki/GEN3_DASHBOARD.generated.html',
  'handoffs/controller-actions.generated.json',
  'handoffs/controller-actions.generated.md',
  'handoffs/cleanup-packets.generated.json',
  'handoffs/cleanup-packets.generated.md',
  'handoffs/graph-packets.generated.json',
  'handoffs/graph-packets.generated.md',
  'handoffs/operator-packet.generated.json',
  'handoffs/operator-packet.generated.md',
]);
const SMA_SELF_GENERATED_PATTERNS = [
  /^scans\/[^/]+\/latest\.registry\.json$/,
  /^wiki\/projects\/[^/]+\/GEN3_DASHBOARD\.generated\.html$/,
  /^handoffs\/operator-packet\.[^/]+\.generated\.(json|md)$/,
];
const LEASE_SCOPE_STOP_WORDS = new Set([
  'active',
  'add',
  'agent',
  'agents',
  'brick',
  'command',
  'commands',
  'dirty',
  'direct',
  'edit',
  'file',
  'files',
  'for',
  'from',
  'gen3',
  'global',
  'inspect',
  'inspection',
  'lease',
  'leases',
  'local',
  'module',
  'modules',
  'page',
  'path',
  'paths',
  'project',
  'projects',
  'context',
  'docs',
  'report',
  'reports',
  'renderer',
  'scope',
  'sma',
  'src',
  'state',
  'task',
  'test',
  'tests',
  'the',
  'this',
  'type',
  'typing',
  'using',
  'with',
  'without',
  'work',
]);
const STALE_CONTEXT_PENDING_KINDS = new Set([
  'lease_acquired',
  'lease_renewed',
  'lease_force_acquired',
  'lease_expired',
  'edit_planned',
]);
const STALE_CONTEXT_TERMINAL_KINDS = new Set([
  'edit_applied',
  'lease_released',
]);
const STALE_CONTEXT_RELEVANT_KINDS = new Set([
  ...STALE_CONTEXT_PENDING_KINDS,
  ...STALE_CONTEXT_TERMINAL_KINDS,
]);
let PROCESS_TABLE_CACHE = null;
let PROCESS_TABLE_ERROR = null;
let CURRENT_PROCESS_ANCESTOR_PIDS = null;
let CURRENT_AGENT_SUBTREE_PIDS = null;

try {
  if (args.help) {
    usage();
    exit(0);
  }
  if (args.selftest) {
    runSelfTest();
    exit(0);
  }
  const snapshot = await buildSnapshot();
  if (args.writeActions !== undefined) {
    writeActionReport(snapshot);
  }
  if (args.json) {
    console.log(JSON.stringify(snapshot, null, 2));
  } else {
    printText(snapshot);
  }
  if (args.strict && snapshot.summary.open_conflicts > 0) exit(3);
  if (isDirtyStrict() && hasStrictDirtyBlockers(snapshot)) exit(4);
} catch (err) {
  console.error(`sma-controller-snapshot: ${err.message}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-controller-snapshot.mjs [--project <id>]... [--all] [--json] [--strict]
                              [--dirty-strict|--require-clean-or-leased]
                              [--actions-only] [--action-limit <n>]
                              [--write-actions [path]]
                              [--module-graphs]
                              [--no-dirty] [--no-graphs]
                              [--dirty-limit <n>|--dirty-full] [--max-status <n>]

Default projects: sma, priority projects, and any project currently holding a
lease. The command is read-only and safe to run during parallel work.

  --strict      exit 3 when unresolved conflicts are present
  --dirty-strict
                exit 4 when dirty files are unleased or outside active lease scope
  --require-clean-or-leased
                alias for --dirty-strict
  --all         include every portfolio project discovered by SMA
  --actions-only
                print only the ranked controller action queue
  --action-limit <n>
                print at most n action items in text output; default is 25
  --write-actions [path]
                write JSON and Markdown action reports plus compact cleanup
                and graph packet reports; default action path is
                handoffs/controller-actions.generated.json
  --module-graphs
                include cached module graph health and module graph actions;
                intended for dashboards/reports, not every quick status read
  --no-dirty    skip git status checks
  --no-graphs   skip project graph readiness checks
  --exclude-volatile-sma-regen
                hide SMA registry/state/wiki regen leases from the snapshot;
                intended for tracked dashboards and state snapshots
  --processes   include stale project-rooted agent process detection; disabled
                by default because interactive Codex sessions are also
                project-rooted processes
  --no-processes
                skip stale project-rooted agent process detection; kept as an
                explicit override for scripts
  --stale-process-seconds <n>
                age threshold for project-rooted agent processes;
                default is ${DEFAULT_STALE_AGENT_PROCESS_SECONDS}
  --selftest    run local Gen3 controller regression checks and exit
  --include-generated-dirty
                include SMA generated snapshots in dirty status; default hides
                them so dashboard/state churn does not become controller work
  --dirty-limit <n>
                print at most n dirty paths per project in text/json output;
                default is 0 to keep agent status reports compact
  --dirty-full  print every dirty path; use only for controller audits
`);
}

function writeActionReport(snapshot) {
  const jsonPath = args.writeActions && args.writeActions !== true
    ? resolve(String(args.writeActions))
    : DEFAULT_ACTION_REPORT_JSON;
  const mdPath = jsonPath.endsWith('.json')
    ? jsonPath.replace(/\.json$/, '.md')
    : `${jsonPath}.md`;
  const report = buildActionReport(snapshot);
  const cleanupReport = buildCleanupPacketReport(report);
  const graphReport = buildGraphPacketReport(report);
  const cleanupPaths = cleanupPacketPaths(jsonPath);
  const graphPaths = graphPacketPaths(jsonPath);

  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(mdPath, renderActionReportMarkdown(report));
  writeFileSync(cleanupPaths.jsonPath, JSON.stringify(cleanupReport, null, 2) + '\n');
  writeFileSync(cleanupPaths.mdPath, renderCleanupPacketMarkdown(cleanupReport));
  writeFileSync(graphPaths.jsonPath, JSON.stringify(graphReport, null, 2) + '\n');
  writeFileSync(graphPaths.mdPath, renderGraphPacketMarkdown(graphReport));
  if (!args.json) {
    console.log(`wrote ${jsonPath}`);
    console.log(`wrote ${mdPath}`);
    console.log(`wrote ${cleanupPaths.jsonPath}`);
    console.log(`wrote ${cleanupPaths.mdPath}`);
    console.log(`wrote ${graphPaths.jsonPath}`);
    console.log(`wrote ${graphPaths.mdPath}`);
  }
}

function cleanupPacketPaths(actionJsonPath) {
  const dir = dirname(actionJsonPath);
  return {
    jsonPath: resolve(dir, `${CLEANUP_PACKETS_BASENAME}.json`),
    mdPath: resolve(dir, `${CLEANUP_PACKETS_BASENAME}.md`),
  };
}

function graphPacketPaths(actionJsonPath) {
  const dir = dirname(actionJsonPath);
  return {
    jsonPath: resolve(dir, `${GRAPH_PACKETS_BASENAME}.json`),
    mdPath: resolve(dir, `${GRAPH_PACKETS_BASENAME}.md`),
  };
}

async function buildSnapshot() {
  const leases = readActiveLeases({
    excludeCurrentWrapperLease: true,
    excludeVolatileSmaRegenLeases: Boolean(args.excludeVolatileSmaRegen),
  });
  const projectIds = await resolveProjectIds(leases);
  const projects = [];
  for (const projectId of projectIds) {
    projects.push(buildProjectSnapshot(projectId, leases));
  }

  const dirtyProjects = projects.filter((project) => project.git?.dirty_count > 0);
  const dirtyUnleasedProjects = projects.filter((project) => project.status === 'dirty-unleased');
  const staleContextProjects = projects.filter((project) => Number(project.stale_context?.receipt_count ?? 0) > 0);
  const graphGaps = projects.filter((project) => project.graph && !project.graph.ready);
  const moduleGraphGaps = projects.filter((project) => moduleGraphGapCount(project.module_graph) > 0);
  const staleAgentProcessProjects = projects.filter((project) => Number(project.agent_processes?.stale_count ?? 0) > 0);
  const agentProcessScanErrorProjects = projects.filter((project) => project.agent_processes?.process_scan_error).length;
  const openConflicts = projects.flatMap((project) => project.conflicts.open.map((event) => ({
    project: project.id,
    brick: event.brick_id,
    timestamp: event.timestamp,
    actor: event.actor_id,
    intent: event.intent,
  })));
  const actionItems = buildActionItems(projects);
  const activeDirtyScopeItems = actionItems.filter((item) => item.kind === 'active-dirty-scope');
  const parallelWave = buildParallelWave(actionItems);

  return {
    generated_at: new Date().toISOString(),
    summary: {
      projects: projects.length,
      active_leases: leases.active_count,
      open_conflicts: openConflicts.length,
      dirty_projects: dirtyProjects.length,
      dirty_unleased_projects: dirtyUnleasedProjects.length,
      stale_context_projects: staleContextProjects.length,
      stale_context_dirty_paths: staleContextProjects.reduce((sum, project) => sum + Number(project.stale_context?.dirty_count ?? 0), 0),
      active_dirty_scope_projects: new Set(activeDirtyScopeItems.map((item) => item.project)).size,
      active_dirty_scope_paths: activeDirtyScopeItems.reduce((sum, item) => sum + Number(item.uncovered_dirty_count ?? item.impact_score ?? 0), 0),
      stale_agent_process_projects: staleAgentProcessProjects.length,
      stale_agent_processes: staleAgentProcessProjects.reduce((sum, project) => sum + Number(project.agent_processes?.stale_count ?? 0), 0),
      agent_process_scan_error_projects: agentProcessScanErrorProjects,
      graph_gaps: graphGaps.length,
      module_graph_gaps: moduleGraphGaps.length,
      controller_actions: actionItems.length,
      parallel_wave_agents: parallelWave.recommended_agent_count,
      parallel_wave_impact: parallelWave.total_impact,
    },
    leases,
    projects,
    action_items: actionItems,
    parallel_wave: parallelWave,
    open_conflicts: openConflicts,
    dirty_unleased_projects: dirtyUnleasedProjects.map((project) => ({
      id: project.id,
      root: project.root,
      branch: project.git?.branch ?? null,
      dirty_count: project.git?.dirty_count ?? 0,
      dirty_groups: project.git?.groups ?? [],
      sample: project.git?.sample ?? [],
    })),
  };
}

function buildActionItems(projects) {
  const items = [];
  for (const project of projects) {
    for (const conflict of project.conflicts.open) {
      items.push({
        severity: 'blocker',
        kind: 'open-conflict',
        project: project.id,
        brick: conflict.brick_id || null,
        title: `Resolve open conflict on ${project.id}`,
        detail: conflict.intent || 'conflict report has no intent',
        command: `npm run conflict -- resolve --project ${shellArg(project.id)} --brick ${shellArg(conflict.brick_id || '<brick>')} --intent "<resolution>" --decision "<decision>"`,
      });
    }

    if (project.status === 'dirty-unleased') {
      const dirtyCount = project.git?.dirty_count ?? 0;
      const modifiedCount = project.git?.modified_count ?? 0;
      const untrackedCount = project.git?.untracked_count ?? 0;
      const groups = formatDirtyGroups(project.git?.groups);
      const commands = dirtyGroupCommands(project, project.git?.groups, dirtyCount >= DIRTY_PARALLEL_CLAIM_MIN_DIRTY);
      const topGroup = firstDirtyGroup(project.git?.groups);
      items.push({
        severity: 'blocker',
        kind: 'dirty-unleased',
        project: project.id,
        brick: commands.brick,
        impact_score: dirtyCount,
        dirty_count: dirtyCount,
        modified_count: modifiedCount,
        untracked_count: untrackedCount,
        top_dirty_group: topGroup.group,
        top_dirty_group_count: topGroup.count,
        top_dirty_group_sample_paths: topGroup.sample_paths || [],
        title: `Claim, clean, or conflict-report ${dirtyCount} unleased dirty path${dirtyCount === 1 ? '' : 's'}`,
        detail: `${modifiedCount} modified, ${untrackedCount} untracked; full paths hidden by default${groups ? `; groups: ${groups}` : ''}`,
        command: commands.claim,
        next_commands: {
          inspect: commands.inspect,
          conflict: commands.conflict,
        },
        ...(commands.parallel_claims.length > 1 ? { parallel_claims: commands.parallel_claims } : {}),
      });
    }

    if (Number(project.stale_context?.receipt_count ?? 0) > 0) {
      const stale = project.stale_context || emptyStaleContext();
      const receipts = Array.isArray(stale.receipts) ? stale.receipts : [];
      for (const receipt of receipts) {
        const topGroup = firstDirtyGroup(receipt.groups || []);
        const brick = receipt.brick_id || dirtyGroupBrick(topGroup.group || 'stale-context');
        const dirtyCount = Number(receipt.dirty_count ?? topGroup.count ?? 0);
        const renewIntent = `renew or hand off stale Gen3 context ${brick} (${dirtyCount} dirty path${dirtyCount === 1 ? '' : 's'})`;
        items.push({
          severity: 'blocker',
          kind: 'stale-context',
          project: project.id,
          brick,
          impact_score: dirtyCount,
          dirty_count: project.git?.dirty_count ?? dirtyCount,
          stale_context_dirty_count: dirtyCount,
          stale_context_receipt_count: 1,
          stale_context_total_receipt_count: Number(stale.receipt_count ?? receipts.length),
          top_dirty_group: topGroup.group,
          top_dirty_group_count: topGroup.count,
          top_dirty_group_sample_paths: topGroup.sample_paths || [],
          title: `Renew, hand off, or conflict-report stale Gen3 context ${brick}`,
          detail: formatStaleContextReceiptDetail(receipt),
          command: `npm run start:edit -- --project ${shellArg(project.id)} --brick ${shellArg(brick)} --intent ${shellArg(renewIntent)}`,
          next_commands: {
            inspect: `npm run controller:snapshot -- --project ${shellArg(project.id)} --dirty-limit 20`,
            conflict: `npm run conflict -- report --project ${shellArg(project.id)} --brick ${shellArg(brick)} --intent ${shellArg('stale Gen3 context receipt overlaps current cleanup or module work')} --resolution-plan ${shellArg('renew the lease, hand off the work, or document the conflict before cleanup claims this scope')}`,
          },
          stale_context_receipts: [receipt],
        });
      }
    }

    const staleProcesses = Array.isArray(project.agent_processes?.stale)
      ? project.agent_processes.stale
      : [];
    const staleProcessCount = Number(project.agent_processes?.stale_count ?? staleProcesses.length);
    if (staleProcessCount > 0) {
      const pids = staleProcesses.map((item) => item.pid).filter(Boolean);
      const oldest = staleProcesses.reduce((max, item) => Math.max(max, Number(item.age_seconds || 0)), 0);
      const sampleSuffix = staleProcessCount > pids.length ? `; sample pids ${pids.join(', ')}` : `; pids ${pids.join(', ')}`;
      items.push({
        severity: 'blocker',
        kind: 'stale-agent-process',
        project: project.id,
        brick: 'stale-agent-process',
        impact_score: staleProcessCount,
        stale_process_count: staleProcessCount,
        stale_process_pids: pids,
        oldest_age_seconds: oldest,
        threshold_seconds: Number(project.agent_processes?.threshold_seconds ?? staleProcessSeconds()),
        title: `Inspect ${staleProcessCount} stale-looking project-rooted agent process${staleProcessCount === 1 ? '' : 'es'}`,
        detail: `oldest ${formatDuration(oldest)}, threshold ${formatDuration(project.agent_processes?.threshold_seconds ?? staleProcessSeconds())}${sampleSuffix}; verify owner before any termination`,
        command: `npm run controller:snapshot:quiet -- --project ${shellArg(project.id)} --dirty-limit 0`,
        next_commands: {
          inspect: pids.length ? `ps -o pid,ppid,etimes,cmd -p ${pids.join(',')}` : `npm run controller:snapshot:quiet -- --project ${shellArg(project.id)} --dirty-limit 0`,
          conflict: `npm run conflict -- report --project ${shellArg(project.id)} --brick 'stale-agent-process' --intent 'stale project-rooted agent process overlaps current Gen3 wave' --resolution-plan 'verify owner, attach or renew lease, and only terminate after explicit owner check'`,
        },
        process_sample: staleProcesses,
      });
    }

    const uncoveredGroups = activeDirtyScopeGaps(project);
    if (uncoveredGroups.length) {
      const dirtyCount = project.git?.dirty_count ?? 0;
      const leaseCount = project.active_leases.length;
      const uncoveredDirtyCount = sumDirtyGroups(uncoveredGroups);
      const commands = dirtyGroupCommands(project, uncoveredGroups, uncoveredDirtyCount >= DIRTY_PARALLEL_CLAIM_MIN_DIRTY);
      const topGroup = firstDirtyGroup(uncoveredGroups);
      items.push({
        severity: 'blocker',
        kind: 'active-dirty-scope',
        project: project.id,
        brick: commands.brick,
        impact_score: uncoveredDirtyCount,
        dirty_count: dirtyCount,
        uncovered_dirty_count: uncoveredDirtyCount,
        uncovered_group_count: uncoveredGroups.length,
        top_dirty_group: topGroup.group,
        top_dirty_group_count: topGroup.count,
        top_dirty_group_sample_paths: topGroup.sample_paths || [],
        title: `Verify active dirty scope for ${uncoveredDirtyCount} uncovered dirty path${uncoveredDirtyCount === 1 ? '' : 's'}`,
        detail: `${leaseCount} active lease${leaseCount === 1 ? '' : 's'}; suspect uncovered groups: ${formatDirtyGroups(uncoveredGroups)}`,
        command: commands.claim,
        next_commands: {
          inspect: commands.inspect,
          conflict: commands.conflict,
        },
        ...(commands.parallel_claims.length > 1 ? { parallel_claims: commands.parallel_claims } : {}),
      });
    }

    if (project.graph && !project.graph.ready) {
      items.push({
        severity: 'warning',
        kind: 'graph-gap',
        project: project.id,
        brick: null,
        impact_score: 1,
        title: `Refresh missing project graph for ${project.id}`,
        detail: project.graph.graph_path,
        command: graphGapCommand(project),
      });
    }

    if (moduleGraphGapCount(project.module_graph) > 0) {
      const gapCount = moduleGraphGapCount(project.module_graph);
      items.push({
        severity: 'warning',
        kind: 'module-graph-gap',
        project: project.id,
        brick: null,
        impact_score: gapCount,
        module_graph_gap_count: gapCount,
        missing_graph_count: Number(project.module_graph?.missing_graph_count ?? 0),
        missing_target_count: Number(project.module_graph?.missing_target_count ?? 0),
        repair_kind: moduleGraphGapRepairKind(project.module_graph),
        target_fixes: moduleGraphTargetFixes(project.module_graph),
        title: `Repair module graph gaps for ${project.id}`,
        detail: moduleGraphGapDetail(project.module_graph),
        command: moduleGraphGapCommand(project),
      });
    }

    for (const lease of project.active_leases) {
      items.push({
        severity: 'watch',
        kind: 'active-lease',
        project: project.id,
        brick: lease.resource_kind === 'brick' ? lease.resource_id : null,
        title: `Watch active ${lease.resource_kind}:${lease.resource_id}`,
        detail: `${lease.agent_id}; ${lease.intent || 'no intent'}`,
        command: `npm run controller:snapshot:quiet -- --project ${shellArg(project.id)}`,
      });
    }
  }

  return items.sort((left, right) => actionRank(left) - actionRank(right)
    || actionImpact(right) - actionImpact(left)
    || actionParallelBreadth(right) - actionParallelBreadth(left)
    || String(left.project).localeCompare(String(right.project))
    || String(left.kind).localeCompare(String(right.kind)));
}

function actionRank(item) {
  const severityRank = { blocker: 0, warning: 1, watch: 2 };
  const kindRank = {
    'open-conflict': 0,
    'stale-agent-process': 1,
    'stale-context': 2,
    'dirty-unleased': 3,
    'active-dirty-scope': 4,
    'graph-gap': 5,
    'module-graph-gap': 6,
    'active-lease': 7,
  };
  return (severityRank[item.severity] ?? 9) * 10 + (kindRank[item.kind] ?? 9);
}

function buildParallelWave(actionItems, limit = DEFAULT_PARALLEL_WAVE_LIMIT) {
  const candidates = [];
  for (const item of actionItems) {
    if (item.severity !== 'blocker' || item.kind !== 'dirty-unleased') continue;
    const claims = Array.isArray(item.parallel_claims) && item.parallel_claims.length
      ? item.parallel_claims
      : [{
        group: item.top_dirty_group || item.brick || 'dirty',
        count: Number(item.top_dirty_group_count ?? item.dirty_count ?? 0),
        brick: item.brick,
        command: item.command,
        conflict: item.next_commands?.conflict,
        sample_paths: item.top_dirty_group_sample_paths || [],
      }];

    for (const claim of claims) {
      const count = Number(claim.count ?? 0);
      if (!claim.command || count <= 0) continue;
      candidates.push({
        project: item.project,
        group: claim.group || item.top_dirty_group || item.brick || 'dirty',
        count,
        parent_dirty_count: Number(item.dirty_count ?? item.impact_score ?? 0),
        brick: claim.brick || item.brick || null,
        command: claim.command,
        inspect: item.next_commands?.inspect || null,
        conflict: claim.conflict || item.next_commands?.conflict || null,
        sample_paths: claim.sample_paths || [],
      });
    }
  }

  candidates.sort((left, right) => right.count - left.count
    || right.parent_dirty_count - left.parent_dirty_count
    || left.project.localeCompare(right.project)
    || left.group.localeCompare(right.group));

  const selectedSource = candidates.slice(0, limit);
  const selectedTotal = selectedSource.reduce((sum, item) => sum + Number(item.count || 0), 0);
  const selected = selectedSource.map((item, index) => ({
    rank: index + 1,
    wave_gain_percent: percent(item.count, selectedTotal),
    project_gain_percent: Number(item.parent_dirty_count || 0) > 0 ? percent(item.count, item.parent_dirty_count) : null,
    ...item,
  }));

  return {
    limit,
    recommended_agent_count: selected.length,
    total_candidate_count: candidates.length,
    overflow_count: Math.max(0, candidates.length - selected.length),
    total_impact: selectedTotal,
    selection_rule: 'dirty-unleased groups only; sorted by dirty group count, then parent project dirty count; one command per disjoint group',
    commands: selected,
  };
}

function actionImpact(item) {
  const explicit = Number(item?.impact_score ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  if (item?.kind === 'stale-context') return Number(item.stale_context_dirty_count ?? item.dirty_count ?? 0);
  if (item?.kind === 'dirty-unleased') return Number(item.dirty_count ?? 0);
  if (item?.kind === 'active-dirty-scope') return Number(item.uncovered_dirty_count ?? item.dirty_count ?? 0);
  if (item?.kind === 'module-graph-gap') return Number(item.module_graph_gap_count ?? 0);
  if (item?.kind === 'graph-gap') return 1;
  return 0;
}

function percent(part, whole) {
  const numerator = Number(part || 0);
  const denominator = Number(whole || 0);
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function formatNullablePercent(value) {
  if (value === null || value === undefined || value === '') return 'n/a';
  return `${value}%`;
}

function formatDuration(seconds) {
  const value = Number(seconds || 0);
  if (!Number.isFinite(value) || value <= 0) return '0s';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m${String(secs).padStart(2, '0')}s`;
  return `${secs}s`;
}

function truncate(value, limit) {
  const text = String(value || '');
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

function actionParallelBreadth(item) {
  return Array.isArray(item?.parallel_claims) ? item.parallel_claims.length : 0;
}

async function resolveProjectIds(leases) {
  const ids = new Set();
  const explicit = asArray(args.project);
  if (explicit.length) {
    explicit.forEach((id) => ids.add(id));
    return [...ids];
  }

  ids.add('sma');
  priorityProjectIds.forEach((id) => ids.add(id));
  for (const lease of leases.leases) {
    if (lease.project) ids.add(lease.project);
  }

  if (args.all) {
    for (const project of await discoverPortfolioProjects()) {
      ids.add(project.id);
    }
  }

  return dedupeByResolvedRoot([...ids]);
}

function dedupeByResolvedRoot(projectIds) {
  const out = [];
  const seenRoots = new Set();
  for (const id of projectIds) {
    const root = safeProjectRoot(id);
    const key = root || `missing:${id}`;
    if (seenRoots.has(key)) continue;
    seenRoots.add(key);
    out.push(id);
  }
  return out;
}

function buildProjectSnapshot(projectId, leases) {
  const root = safeProjectRoot(projectId);
  const conflicts = root ? readConflictSummary(projectId) : emptyConflicts();
  const git = root && !args.noDirty ? readGitStatus(root) : null;
  const projectLeases = leases.leases.filter((lease) => leaseAppliesToProject(lease, projectId, git));
  const graph = root && !args.noGraphs ? readGraphStatus(root) : null;
  const moduleGraph = root && args.moduleGraphs ? readModuleGraphStatus(projectId, root) : null;
  const staleContext = root && git ? readStaleContextReceipts(projectId, git, projectLeases) : emptyStaleContext();
  const processScanEnabled = args.processes || args.staleProcessSeconds !== undefined;
  const agentProcesses = root && processScanEnabled && !args.noProcesses
    ? readProjectAgentProcesses(root, projectLeases)
    : null;

  return {
    id: projectId,
    root,
    status: projectStatus({ root, projectLeases, conflicts, git, graph, moduleGraph, agentProcesses, staleContext }),
    active_leases: projectLeases,
    stale_context: staleContext,
    conflicts,
    git,
    graph,
    module_graph: moduleGraph,
    agent_processes: agentProcesses,
  };
}

function projectStatus({ root, projectLeases, conflicts, git, graph, moduleGraph, agentProcesses, staleContext }) {
  if (!root) return 'missing';
  if (conflicts.open_count > 0) return 'blocked';
  if (git?.dirty_count > 0 && projectLeases.length === 0 && Number(staleContext?.receipt_count ?? 0) > 0) return 'stale-context';
  if (git?.dirty_count > 0 && projectLeases.length === 0) return 'dirty-unleased';
  if (Number(agentProcesses?.stale_count ?? 0) > 0) return 'stale-agent-process';
  if (graph && !graph.ready) return 'graph-gap';
  if (moduleGraphGapCount(moduleGraph) > 0) return 'graph-gap';
  if (projectLeases.length > 0 || git?.dirty_count > 0) return 'active';
  return 'clear';
}

function safeProjectRoot(projectId) {
  try { return projectRoot(projectId); } catch { return null; }
}

function readConflictSummary(projectId) {
  const all = [];
  let detected = 0;
  let resolved = 0;
  try {
    for (const brick of listBricksWithContext(projectId)) {
      const events = readContextLog(projectId, brick)
        .filter((event) => event.kind === 'conflict_detected' || event.kind === 'conflict_resolved')
        .map((event) => ({ ...event, brick_id: event.brick_id || brick, project: event.project || projectId }));
      for (const event of events) {
        if (event.kind === 'conflict_detected') detected += 1;
        if (event.kind === 'conflict_resolved') resolved += 1;
      }
      all.push(...openConflicts(events));
    }
  } catch {
    return { detected_count: detected, resolved_count: resolved, open_count: 0, open: [] };
  }
  all.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
  return {
    detected_count: detected,
    resolved_count: resolved,
    open_count: all.length,
    open: all,
  };
}

function openConflicts(events) {
  let openCount = 0;
  const out = [];
  for (const event of events) {
    if (event.kind === 'conflict_detected') {
      openCount += 1;
      out.push(event);
    } else if (event.kind === 'conflict_resolved' && openCount > 0) {
      openCount -= 1;
    }
  }
  return openCount > 0 ? out.slice(-openCount) : [];
}

function emptyConflicts() {
  return { detected_count: 0, resolved_count: 0, open_count: 0, open: [] };
}

function emptyStaleContext() {
  return { receipt_count: 0, dirty_count: 0, receipts: [] };
}

function readStaleContextReceipts(projectId, git, activeLeases = []) {
  const groups = Array.isArray(git?.groups) ? git.groups : [];
  const contextBrickIds = dirtyContextBrickIdsFromGit(git);
  if (!groups.length || !contextBrickIds.size) return emptyStaleContext();

  const activeResources = new Set((Array.isArray(activeLeases) ? activeLeases : [])
    .map((lease) => normalizeScopeId(lease.resource_id))
    .filter(Boolean));
  const receipts = [];
  for (const brickId of [...contextBrickIds].sort()) {
    if (activeResources.has(brickId)) continue;
    const latest = latestRelevantContextEvent(safeReadContextEvents(projectId, brickId));
    if (!latest || !STALE_CONTEXT_PENDING_KINDS.has(latest.kind)) continue;
    const ageSeconds = eventAgeSeconds(latest);
    if (ageSeconds === null || ageSeconds > STALE_CONTEXT_RECEIPT_SECONDS) continue;
    const pseudoLease = {
      resource_kind: 'brick',
      resource_id: brickId,
      intent: '',
      project: projectId,
    };
    const matchedGroups = groups.filter((group) => dirtyGroupCoveredByLeases(group, [pseudoLease]));
    if (!matchedGroups.length) continue;
    receipts.push({
      brick_id: brickId,
      actor_id: latest.actor_id || null,
      session_id: latest.session_id || null,
      lease_id: latest.lease_id || null,
      kind: latest.kind,
      intent: latest.intent || '',
      timestamp: latest.timestamp || null,
      age_seconds: ageSeconds,
      matched_group_count: matchedGroups.length,
      dirty_count: sumDirtyGroups(matchedGroups),
      groups: matchedGroups.slice(0, 5).map((group) => ({
        group: group.group,
        count: Number(group.count || 0),
        sample_paths: normalizeSamplePaths(group.sample_paths),
      })),
    });
  }
  const dirtyCount = sumUniqueReceiptGroups(receipts);
  return {
    receipt_count: receipts.length,
    dirty_count: dirtyCount,
    receipts,
  };
}

function sumUniqueReceiptGroups(receipts) {
  const groups = new Map();
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    for (const group of receipt.groups || []) {
      if (!group?.group) continue;
      const previous = Number(groups.get(group.group) || 0);
      groups.set(group.group, Math.max(previous, Number(group.count || 0)));
    }
  }
  return [...groups.values()].reduce((sum, count) => sum + count, 0);
}

function safeReadContextEvents(projectId, brickId) {
  try {
    return readContextLog(projectId, brickId);
  } catch {
    return [];
  }
}

function latestRelevantContextEvent(events) {
  const relevant = (Array.isArray(events) ? events : [])
    .filter((event) => STALE_CONTEXT_RELEVANT_KINDS.has(event?.kind))
    .filter((event) => event?.timestamp)
    .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')));
  return relevant[0] || null;
}

function eventAgeSeconds(event) {
  const parsed = Date.parse(event?.timestamp || '');
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((Date.now() - parsed) / 1000));
}

function readGitStatus(root) {
  try {
    const raw = execFileSync('git', ['status', '--short', '--branch'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 8000,
    });
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const branch = lines[0] || '';
    const changes = filterSelfGeneratedDirty(lines.slice(1), root);
    const dirtyLimit = dirtySampleLimit();
    const sample = changes.slice(0, dirtyLimit);
    return {
      branch,
      dirty_count: changes.length,
      untracked_count: changes.filter((line) => line.startsWith('??')).length,
      modified_count: changes.filter((line) => !line.startsWith('??')).length,
      dirty_limit: Number.isFinite(dirtyLimit) ? dirtyLimit : null,
      dirty_hidden_count: Math.max(0, changes.length - sample.length),
      groups: dirtyGroups(changes),
      sample,
    };
  } catch (err) {
    return {
      branch: null,
      dirty_count: 0,
      untracked_count: 0,
      modified_count: 0,
      dirty_limit: dirtySampleLimit(),
      dirty_hidden_count: 0,
      groups: [],
      sample: [],
      error: err.message,
    };
  }
}

function filterSelfGeneratedDirty(changes, root) {
  if (args.includeGeneratedDirty) return changes;
  const resolvedRoot = root ? resolve(root) : '';
  if (resolvedRoot !== SMA_ROOT) return changes;
  return changes.filter((line) => !isSmaSelfGeneratedDirtyPath(statusPath(line)));
}

function readProjectAgentProcesses(root, projectLeases) {
  const threshold = staleProcessSeconds();
  const resolvedRoot = resolve(root);
  const table = processTable();
  const currentAgentSubtree = currentAgentSubtreePids(table);
  const activeLeaseCount = Array.isArray(projectLeases) ? projectLeases.length : 0;
  const processes = table
    .filter((proc) => proc.cwd && pathInside(proc.cwd, resolvedRoot))
    .filter((proc) => isAgentCommand(proc.command))
    .filter((proc) => !currentAgentSubtree.has(proc.pid))
    .map((proc) => ({
      pid: proc.pid,
      ppid: proc.ppid,
      age_seconds: proc.age_seconds,
      cwd: proc.cwd,
      command: truncate(proc.command, 220),
    }))
    .sort((left, right) => right.age_seconds - left.age_seconds || left.pid - right.pid);
  const stale = processes.filter((proc) => proc.age_seconds >= threshold);
  return {
    enabled: true,
    threshold_seconds: threshold,
    process_count: processes.length,
    stale_count: stale.length,
    active_lease_count: activeLeaseCount,
    process_scan_error: PROCESS_TABLE_ERROR,
    sample: processes.slice(0, AGENT_PROCESS_SAMPLE_LIMIT),
    stale: stale.slice(0, AGENT_PROCESS_SAMPLE_LIMIT),
  };
}

function processTable() {
  if (PROCESS_TABLE_CACHE) return PROCESS_TABLE_CACHE;
  try {
    const raw = execFileSync('ps', ['-eo', 'pid=,ppid=,etimes=,args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8000,
      maxBuffer: 16 * 1024 * 1024,
    });
    PROCESS_TABLE_CACHE = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseProcessLine)
      .filter(Boolean)
      .map((proc) => ({ ...proc, cwd: safeProcessCwd(proc.pid) }))
      .filter((proc) => proc.cwd);
    PROCESS_TABLE_ERROR = null;
  } catch (err) {
    PROCESS_TABLE_ERROR = err.message;
    PROCESS_TABLE_CACHE = [];
  }
  return PROCESS_TABLE_CACHE;
}

function parseProcessLine(line) {
  const match = String(line || '').match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
  if (!match) return null;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    age_seconds: Number(match[3]),
    command: match[4] || '',
  };
}

function safeProcessCwd(pid) {
  try {
    return resolve(readlinkSync(`/proc/${pid}/cwd`));
  } catch {
    return null;
  }
}

function currentProcessAncestorPids() {
  if (CURRENT_PROCESS_ANCESTOR_PIDS) return CURRENT_PROCESS_ANCESTOR_PIDS;
  const out = new Set();
  let pid = process.pid;
  for (let depth = 0; pid && depth < 64; depth += 1) {
    out.add(Number(pid));
    const parent = processParentPid(pid);
    if (!parent || parent === pid || out.has(parent)) break;
    pid = parent;
  }
  CURRENT_PROCESS_ANCESTOR_PIDS = out;
  return out;
}

function currentAgentSubtreePids(table = processTable()) {
  if (CURRENT_AGENT_SUBTREE_PIDS) return CURRENT_AGENT_SUBTREE_PIDS;
  CURRENT_AGENT_SUBTREE_PIDS = agentSubtreePids(table, process.pid, currentProcessAncestorPids());
  return CURRENT_AGENT_SUBTREE_PIDS;
}

function agentSubtreePids(table, currentPid, ancestorPids) {
  const tableByPid = new Map(table.map((proc) => [proc.pid, proc]));
  const ancestors = ancestorPids || [currentPid];
  let rootPid = currentPid;
  let seenAgentAncestor = false;
  for (const pid of ancestors) {
    const proc = tableByPid.get(pid);
    if (proc && isAgentCommand(proc.command)) {
      rootPid = pid;
      seenAgentAncestor = true;
      continue;
    }
    if (seenAgentAncestor) break;
  }
  const out = new Set([rootPid, currentPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const proc of table) {
      if (!out.has(proc.ppid) || out.has(proc.pid)) continue;
      out.add(proc.pid);
      changed = true;
    }
  }
  return out;
}

function runSelfTest() {
  const projectRoot = '/tmp/sma-gen3-fixture/project';
  const table = [
    { pid: 1, ppid: 0, age_seconds: 1000, cwd: '/', command: 'systemd' },
    { pid: 10, ppid: 1, age_seconds: 900, cwd: projectRoot, command: 'node /opt/bin/codex --yolo' },
    { pid: 11, ppid: 10, age_seconds: 900, cwd: projectRoot, command: '/opt/codex/vendor/codex --yolo' },
    { pid: 20, ppid: 1, age_seconds: 100, cwd: '/tmp', command: 'bash' },
    { pid: 30, ppid: 20, age_seconds: 80, cwd: projectRoot, command: 'node /opt/bin/codex --yolo' },
    { pid: 31, ppid: 30, age_seconds: 80, cwd: projectRoot, command: '/opt/codex/vendor/codex --yolo' },
    { pid: 32, ppid: 31, age_seconds: 2, cwd: SMA_ROOT, command: 'node tools/sma-controller-snapshot.mjs --selftest' },
    { pid: 33, ppid: 31, age_seconds: 2, cwd: SMA_ROOT, command: 'node tools/sma-controller-snapshot.mjs helper' },
  ];
  const currentSubtree = agentSubtreePids(table, 32, new Set([32, 31, 30, 20, 1]));
  assertSelftest(!currentSubtree.has(1), 'current agent subtree must not include PID 1');
  assertSelftest(currentSubtree.has(30), 'current agent wrapper must be excluded');
  assertSelftest(currentSubtree.has(31), 'current agent child must be excluded');
  assertSelftest(currentSubtree.has(32), 'current process must be excluded');
  assertSelftest(currentSubtree.has(33), 'current agent descendants must be excluded');
  assertSelftest(!currentSubtree.has(10), 'unrelated old agent wrapper must remain visible');
  assertSelftest(!currentSubtree.has(11), 'unrelated old agent child must remain visible');

  const visibleAgentPids = table
    .filter((proc) => proc.cwd && pathInside(proc.cwd, projectRoot))
    .filter((proc) => isAgentCommand(proc.command))
    .filter((proc) => !currentSubtree.has(proc.pid))
    .map((proc) => proc.pid)
    .sort((left, right) => left - right);
  assertSelftest(
    JSON.stringify(visibleAgentPids) === JSON.stringify([10, 11]),
    `expected only unrelated project agents to remain visible, got ${visibleAgentPids.join(',')}`,
  );
  assertSelftest(
    DEFAULT_STALE_AGENT_PROCESS_SECONDS >= 24 * 60 * 60,
    'default stale process threshold must leave long-running Codex sessions alone',
  );
  assertSelftest(
    dirtyGroupKey('src/main/services/coreAgent/coreAgentTraceRecorder.ts') === 'src/main/services/coreAgent',
    'main service dirty group should stay service-specific instead of broad src/main',
  );
  assertSelftest(
    dirtyGroupKey('src/shared/coreAgentTracePolicy.ts') === 'src/shared/coreAgentTracePolicy.ts',
    'single shared file dirty group should stay file-specific for lower collision risk',
  );
  assertSelftest(
    dirtyGroupKey('src/shared/coreAgentModuleSpecificCommandDrafts.parts/agentChatDrafts.ts') === 'src/shared/coreAgentModuleSpecificCommandDrafts.parts',
    'shared nested dirty group should stay package-specific',
  );
  assertSelftest(
    isSmaSelfGeneratedDirtyPath('wiki/projects/acme-desktop/GEN3_DASHBOARD.generated.html'),
    'project-scoped Gen3 dashboards should not become SMA cleanup packets',
  );
  assertSelftest(
    isSmaSelfGeneratedDirtyPath('handoffs/operator-packet.generated.md')
      && isSmaSelfGeneratedDirtyPath('handoffs/operator-packet.acme-desktop.generated.json'),
    'operator packets should be treated as self-generated SMA cache artifacts',
  );
  const modviralLease = {
    resource_kind: 'brick',
    resource_id: 'dirty-src-renderer-modules-modviral-route-batch-5',
    intent: 'route final C0viral credential wizard slideshow audience persona and Studio panels',
    project: 'demo',
  };
  assertSelftest(
    dirtyGroupCoveredByLeases({
      group: 'src/renderer/modules/modviral',
      sample_paths: ['src/renderer/modules/modviral/C0viralStudioPanel.tsx'],
    }, [modviralLease]),
    'module-specific dirty lease should cover its own module group',
  );
  assertSelftest(
    !dirtyGroupCoveredByLeases({
      group: 'src/renderer/modules/modbro',
      sample_paths: ['src/renderer/modules/modbro/ModbroBrowserTabs.tsx'],
    }, [modviralLease]),
    'module-specific dirty lease must not cover sibling modules through generic src/renderer tokens',
  );
  const coreAgentLease = {
    resource_kind: 'brick',
    resource_id: 'coreagent-live-ui-action-bridge',
    intent: 'Make live CoreAgent UI action listing materialize renderer controls',
    project: 'demo',
  };
  assertSelftest(
    dirtyGroupCoveredByLeases({
      group: 'src/main/ipc',
      sample_paths: [
        'src/main/ipc/coreAgentHandlers.ts',
        'src/main/ipc/coreAgentRendererServices.ts',
      ],
    }, [coreAgentLease]),
    'camelCase CoreAgent IPC dirty paths should be covered by a coreagent active lease',
  );
  assertSelftest(
    !dirtyGroupCoveredByLeases({
      group: 'src/main/ipc',
      sample_paths: ['src/main/ipc/systemPreferences.ts'],
    }, [coreAgentLease]),
    'coreagent active lease must not cover unrelated generic src/main IPC paths',
  );
  assertSelftest(
    dirtyGroupCoveredByLeases({
      group: '.smarch/agent-context/modcap-right-rail-restored-controls.ndjson',
      sample_paths: ['.smarch/agent-context/modcap-right-rail-restored-controls.ndjson'],
    }, [{
      resource_kind: 'brick',
      resource_id: 'modcap-right-rail-restored-controls',
      intent: 'Restore missing MODCAP right rail controls',
      project: 'demo',
    }]),
    'active brick lease should cover its exact agent context log',
  );
  assertSelftest(
    !dirtyGroupCoveredByLeases({
      group: '.smarch/agent-context/other-agent.ndjson',
      sample_paths: ['.smarch/agent-context/other-agent.ndjson'],
    }, [{
      resource_kind: 'brick',
      resource_id: 'active-dirty-scope-context-attribution',
      intent: 'Treat active lease context logs as covered dirty scope',
      project: 'demo',
    }]),
    'generic context words must not cover unrelated agent context logs',
  );
  assertSelftest(
    leaseAppliesToProject({
      resource_kind: 'brick',
      resource_id: 'omarchy.droidcam.director',
      project: null,
    }, 'sma', {
      groups: [{
        group: '.smarch/agent-context/omarchy.droidcam.director.ndjson',
        sample_paths: ['.smarch/agent-context/omarchy.droidcam.director.ndjson'],
      }],
    }),
    'unprojected SMA brick lease should apply to its matching SMA agent context log',
  );
  assertSelftest(
    actionRank({ severity: 'blocker', kind: 'stale-context' }) < actionRank({ severity: 'blocker', kind: 'dirty-unleased' }),
    'stale context blockers should rank ahead of generic dirty-unleased cleanup',
  );
  assertSelftest(
    latestRelevantContextEvent([
      { kind: 'edit_planned', timestamp: '2026-01-01T00:00:00.000Z' },
      { kind: 'note', timestamp: '2026-01-01T00:01:00.000Z' },
    ])?.kind === 'edit_planned',
    'notes should not hide pending stale context state',
  );
  assertSelftest(
    !STALE_CONTEXT_PENDING_KINDS.has(latestRelevantContextEvent([
      { kind: 'edit_planned', timestamp: '2026-01-01T00:00:00.000Z' },
      { kind: 'edit_applied', timestamp: '2026-01-01T00:02:00.000Z' },
    ])?.kind),
    'edit_applied should clear stale context state',
  );
  const staleSplitActions = buildActionItems([{
    id: 'demo',
    status: 'stale-context',
    active_leases: [],
    conflicts: { open: [] },
    git: { dirty_count: 7, modified_count: 7, untracked_count: 0, groups: [] },
    stale_context: {
      receipt_count: 2,
      dirty_count: 7,
      receipts: [
        { brick_id: 'modbro-stale', actor_id: 'agent-a', age_seconds: 60, dirty_count: 4, groups: [{ group: 'src/renderer/modules/modbro', count: 4 }] },
        { brick_id: 'modlink-stale', actor_id: 'agent-b', age_seconds: 120, dirty_count: 3, groups: [{ group: 'src/renderer/modules/modlink', count: 3 }] },
      ],
    },
    agent_processes: null,
    graph: null,
    module_graph: null,
  }]).filter((item) => item.kind === 'stale-context');
  assertSelftest(staleSplitActions.length === 2, 'stale context receipts should become independently actionable blockers');
  assertSelftest(staleSplitActions[0].brick !== staleSplitActions[1].brick, 'split stale context blockers should preserve receipt brick identity');

  console.log('OK sma-controller-snapshot selftest');
}

function assertSelftest(condition, message) {
  if (!condition) throw new Error(`selftest failed: ${message}`);
}

function processParentPid(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const end = raw.lastIndexOf(')');
    if (end < 0) return 0;
    const fields = raw.slice(end + 2).trim().split(/\s+/);
    return Number(fields[1] || 0);
  } catch {
    return 0;
  }
}

function isAgentCommand(command) {
  const value = String(command || '').toLowerCase();
  const tokens = value.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  const firstBase = commandTokenBase(tokens[0]);
  if (firstBase === 'codex') return true;
  if (firstBase === 'node' || firstBase === 'bun') {
    return tokens.slice(1, 8).some((token) => token.includes('/') && commandTokenBase(token) === 'codex');
  }
  if (['npx', 'bunx', 'pnpm', 'npm'].includes(firstBase)) {
    return tokens.slice(1, 5).some((token) => commandTokenBase(token) === 'codex');
  }
  return false;
}

function commandTokenBase(token) {
  const normalized = String(token || '').replace(/^["']|["']$/g, '');
  return normalized.split('/').filter(Boolean).pop() || normalized;
}

function pathInside(candidate, root) {
  const resolved = resolve(candidate);
  return resolved === root || resolved.startsWith(`${root}/`);
}

function staleProcessSeconds() {
  const raw = args.staleProcessSeconds;
  if (raw === undefined || raw === null || raw === true) return DEFAULT_STALE_AGENT_PROCESS_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid --stale-process-seconds value: ${raw}`);
  }
  return Math.floor(parsed);
}

function statusPath(line) {
  const raw = line.slice(3).trim();
  return raw.includes(' -> ') ? raw.split(' -> ').pop().trim() : raw;
}

function isSmaSelfGeneratedDirtyPath(path) {
  return SMA_SELF_GENERATED_PATHS.has(path)
    || SMA_SELF_GENERATED_PATTERNS.some((pattern) => pattern.test(path));
}

function dirtyGroups(changes) {
  const groups = new Map();
  for (const line of changes) {
    const path = statusPath(line);
    const key = dirtyGroupKey(path);
    const current = groups.get(key) || { group: key, count: 0, modified_count: 0, untracked_count: 0, sample_paths: [] };
    current.count += 1;
    if (line.startsWith('??')) current.untracked_count += 1;
    else current.modified_count += 1;
    if (current.sample_paths.length < DIRTY_GROUP_SAMPLE_LIMIT && !current.sample_paths.includes(path)) {
      current.sample_paths.push(path);
    }
    groups.set(key, current);
  }
  return [...groups.values()]
    .sort((left, right) => right.count - left.count || left.group.localeCompare(right.group))
    .slice(0, 8);
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

function formatDirtyGroups(groups, limit = 3) {
  const list = Array.isArray(groups) ? groups.filter((group) => group?.count > 0).slice(0, limit) : [];
  if (!list.length) return '';
  const text = list.map((group) => `${group.group} ${group.count}`).join(', ');
  const hidden = groups.length - list.length;
  return hidden > 0 ? `${text}, +${hidden} more` : text;
}

function formatStaleContextReceiptDetail(receipt) {
  if (!receipt) return 'pending Gen3 context receipt without an active lease';
  const actor = receipt.actor_id || 'unknown';
  const age = receipt.age_seconds === null || receipt.age_seconds === undefined
    ? 'unknown age'
    : formatDuration(receipt.age_seconds);
  const groupText = formatDirtyGroups(receipt.groups || [], 4);
  return `${receipt.brick_id} by ${actor}, ${age} old, ${receipt.dirty_count} dirty${groupText ? `; groups: ${groupText}` : ''}`;
}

function dirtyGroupCommands(project, groups = project.git?.groups, includeParallel = false) {
  const group = firstDirtyGroup(groups);
  const primary = dirtyGroupClaim(project, group);
  return {
    brick: primary.brick,
    inspect: `npm run controller:snapshot -- --project ${shellArg(project.id)} --dirty-limit 20`,
    claim: primary.command,
    conflict: primary.conflict,
    parallel_claims: includeParallel ? dirtyGroupClaims(project, groups) : [],
  };
}

function firstDirtyGroup(groups) {
  const list = Array.isArray(groups) ? groups.filter((group) => group?.count > 0) : [];
  return list[0] || { group: 'unclassified-dirty', count: 0 };
}

function sumDirtyGroups(groups) {
  const list = Array.isArray(groups) ? groups : [];
  return list.reduce((sum, group) => sum + Number(group?.count || 0), 0);
}

function dirtyGroupClaims(project, groups) {
  const list = Array.isArray(groups) ? groups.filter((group) => group?.count > 0) : [];
  return list.slice(0, DIRTY_PARALLEL_CLAIM_LIMIT).map((group) => dirtyGroupClaim(project, group));
}

function dirtyGroupClaim(project, group) {
  const groupName = group.group;
  const count = Number(group.count || 0);
  const brick = dirtyGroupBrick(groupName);
  const intent = `claim dirty group ${groupName} (${count} path${count === 1 ? '' : 's'})`;
  return {
    group: groupName,
    count,
    brick,
    sample_paths: normalizeSamplePaths(group.sample_paths),
    command: `npm run start:edit -- --project ${shellArg(project.id)} --brick ${shellArg(brick)} --intent ${shellArg(intent)}`,
    conflict: `npm run conflict -- report --project ${shellArg(project.id)} --brick ${shellArg(brick)} --intent ${shellArg(`dirty group ${groupName} overlaps my work`)} --resolution-plan ${shellArg('claim, split, clean, or hand off before integration')}`,
  };
}

function normalizeSamplePaths(paths, limit = DIRTY_GROUP_SAMPLE_LIMIT) {
  const out = [];
  for (const value of Array.isArray(paths) ? paths : []) {
    const file = String(value || '').trim();
    if (!file || out.includes(file)) continue;
    out.push(file);
    if (out.length >= limit) break;
  }
  return out;
}

function dirtyGroupBrick(groupName) {
  const slug = String(groupName || 'unclassified-dirty')
    .toLowerCase()
    .replace(/^\.+/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  return `dirty-${slug || 'root'}`;
}

function activeDirtyScopeGaps(project) {
  const groups = Array.isArray(project.git?.groups) ? project.git.groups : [];
  const leases = Array.isArray(project.active_leases) ? project.active_leases : [];
  if (!groups.length || !leases.length || project.status !== 'active') return [];
  return groups.filter((group) => !dirtyGroupCoveredByLeases(group, leases));
}

function leaseAppliesToProject(lease, projectId, git) {
  if (lease.project === projectId) return true;
  if (lease.project || projectId !== 'sma') return false;
  const contextBrickIds = dirtyContextBrickIdsFromGit(git);
  return contextBrickIds.has(normalizeScopeId(lease.resource_id));
}

function dirtyGroupCoveredByLeases(dirtyGroup, leases) {
  const group = normalizeDirtyGroup(dirtyGroup);
  if (!group.group) return false;
  for (const lease of leases) {
    if (dirtyGroupCoveredByLease(group, lease)) return true;
  }
  return false;
}

function dirtyGroupCoveredByLease(group, lease) {
  const resourceId = normalizeScopeId(lease.resource_id);
  if (!resourceId) return false;
  if (group.context_brick_ids.has(resourceId)) return true;

  const groupBrick = normalizeScopeId(dirtyGroupBrick(group.group));
  if (resourceId === groupBrick || resourceId.startsWith(`${groupBrick}-`)) return true;

  const leaseTokens = leaseScopeTokens(lease);
  for (const token of group.scope_tokens) {
    if (leaseTokens.has(token)) return true;
  }
  return false;
}

function normalizeDirtyGroup(dirtyGroup) {
  const group = typeof dirtyGroup === 'string' ? dirtyGroup : dirtyGroup?.group;
  const samplePaths = typeof dirtyGroup === 'string' ? [] : normalizeSamplePaths(dirtyGroup?.sample_paths);
  const values = [group, ...samplePaths].map((value) => String(value || ''));
  return {
    group: String(group || '').toLowerCase(),
    sample_paths: samplePaths,
    context_brick_ids: dirtyContextBrickIds(values),
    scope_tokens: new Set(values.flatMap((value) => scopeTokens(value))),
  };
}

function dirtyContextBrickIdsFromGit(git) {
  const groups = Array.isArray(git?.groups) ? git.groups : [];
  return dirtyContextBrickIds(groups.flatMap((group) => [group.group, ...(group.sample_paths || [])]));
}

function dirtyContextBrickIds(values) {
  const out = new Set();
  for (const value of Array.isArray(values) ? values : [values]) {
    const match = String(value || '').replace(/\\/g, '/').match(/(?:^|\/)\.smarch\/agent-context\/([^/]+)\.ndjson$/);
    if (match?.[1]) out.add(normalizeScopeId(match[1]));
  }
  return out;
}

function leaseScopeTokens(lease) {
  return new Set([
    ...scopeTokens(lease.resource_id),
    ...scopeTokens(lease.intent),
  ]);
}

function scopeTokens(value) {
  const out = new Set();
  const rawParts = String(value || '').split(/[^a-zA-Z0-9]+/g).filter(Boolean);
  for (const rawPart of rawParts) {
    const expanded = expandScopePart(rawPart);
    for (const token of expanded) {
      const normalized = token.toLowerCase();
      if (normalized.length < 3 || LEASE_SCOPE_STOP_WORDS.has(normalized)) continue;
      out.add(normalized);
    }
  }
  return [...out];
}

function normalizeScopeId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/\.ndjson$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function expandScopePart(value) {
  const part = String(value || '').trim();
  if (!part) return [];
  const words = part
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/\s+/g)
    .filter(Boolean);
  const tokens = [part, ...words];
  for (let index = 0; index < words.length - 1; index += 1) {
    tokens.push(`${words[index]}${words[index + 1]}`);
  }
  if (words.length > 2) tokens.push(words.join(''));
  return tokens;
}

function readGraphStatus(root) {
  const graphPath = resolve(root, 'graphify-out/graph.json');
  const reportPath = resolve(root, 'graphify-out/GRAPH_REPORT.md');
  if (!existsSync(graphPath)) {
    return { ready: false, graph_path: graphPath, report_path: reportPath, node_count: 0, edge_count: 0, updated_at: null };
  }
  const graphStat = statSync(graphPath);
  const reportExists = existsSync(reportPath);
  const reportCounts = readGraphReportCounts(reportPath);
  return {
    ready: reportExists ? reportCounts.node_count > 0 : graphStat.size > 0,
    graph_path: graphPath,
    report_path: reportPath,
    node_count: reportCounts.node_count,
    edge_count: reportCounts.edge_count,
    updated_at: graphStat.mtime.toISOString(),
    size_bytes: graphStat.size,
  };
}

function readGraphReportCounts(reportPath) {
  if (!existsSync(reportPath)) return { node_count: 0, edge_count: 0 };
  try {
    const raw = readFileSync(reportPath, 'utf8');
    const nodes = Number((raw.match(/^Nodes:\s*(\d+)/m) || [])[1] || 0);
    const edges = Number((raw.match(/^Edges:\s*(\d+)/m) || [])[1] || 0);
    return { node_count: nodes, edge_count: edges };
  } catch {
    return { node_count: 0, edge_count: 0 };
  }
}

function readModuleGraphStatus(projectId, root) {
  const modulesRoot = resolve(root, 'graphify-out/modules');
  if (!existsSync(modulesRoot)) return null;
  try {
    const raw = execFileSync(process.execPath, [
      resolve(SMA_ROOT, 'tools/sma-graphify.mjs'),
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
    const summary = JSON.parse(raw);
    return {
      ready: Boolean(summary.ok),
      project_root: summary.projectRoot ?? root,
      module_count: Number(summary.moduleCount ?? 0),
      satisfied_count: Number(summary.satisfiedCount ?? 0),
      ready_count: Number(summary.readyCount ?? 0),
      known_empty_count: Number(summary.knownEmptyCount ?? 0),
      actionable_gap_count: Number(summary.actionableGapCount ?? 0),
      missing_graph_count: Number(summary.missingGraphCount ?? 0),
      missing_target_count: Number(summary.missingTargetCount ?? 0),
      graphify_unavailable_count: Number(summary.graphifyUnavailableCount ?? 0),
      node_count: Number(summary.nodeCount ?? 0),
      edge_count: Number(summary.edgeCount ?? 0),
      oldest_graph_updated_at: summary.oldestGraphUpdatedAt ?? null,
      newest_graph_updated_at: summary.newestGraphUpdatedAt ?? null,
      actionable_gaps: Array.isArray(summary.actionableGaps)
        ? summary.actionableGaps.slice(0, 8).map((gap) => ({
          module_id: gap.moduleId ?? null,
          source_path: gap.sourcePath ?? null,
          reason: gap.reason ?? null,
          target_candidates: Array.isArray(gap.targetCandidates)
            ? gap.targetCandidates.slice(0, 5).map((candidate) => ({
              path: candidate.path ?? null,
              reason: candidate.reason ?? null,
              score: Number(candidate.score ?? 0),
            }))
            : [],
        }))
        : [],
    };
  } catch (err) {
    return {
      ready: false,
      project_root: root,
      module_count: 0,
      satisfied_count: 0,
      ready_count: 0,
      known_empty_count: 0,
      actionable_gap_count: 1,
      missing_graph_count: 0,
      missing_target_count: 0,
      graphify_unavailable_count: 0,
      node_count: 0,
      edge_count: 0,
      oldest_graph_updated_at: null,
      newest_graph_updated_at: null,
      error: err.message,
      actionable_gaps: [],
    };
  }
}

function moduleGraphGapCount(moduleGraph) {
  return Number(moduleGraph?.actionable_gap_count ?? 0);
}

function moduleGraphGapDetail(moduleGraph) {
  const missingGraphs = Number(moduleGraph?.missing_graph_count ?? 0);
  const missingTargets = Number(moduleGraph?.missing_target_count ?? 0);
  const unavailable = Number(moduleGraph?.graphify_unavailable_count ?? 0);
  const total = Number(moduleGraph?.module_count ?? 0);
  const satisfied = Number(moduleGraph?.satisfied_count ?? 0);
  const gap = moduleGraphGapCount(moduleGraph);
  const drift = missingTargets > 0 ? '; target/source-map drift needs a map fix before refresh' : '';
  const unavailableText = unavailable > 0 ? `, ${unavailable} graphify unavailable` : '';
  const candidateText = moduleGraphCandidateDetail(moduleGraph);
  return `${gap} actionable gap${gap === 1 ? '' : 's'} across ${satisfied}/${total} satisfied modules (${missingGraphs} missing graphs, ${missingTargets} missing targets${unavailableText})${drift}${candidateText}`;
}

function moduleGraphCandidateDetail(moduleGraph) {
  const hints = [];
  for (const gap of moduleGraph?.actionable_gaps || []) {
    const candidate = (gap.target_candidates || []).find((item) => item?.path);
    if (!candidate) continue;
    const source = gap.source_path || gap.module_id || 'missing target';
    hints.push(`${source} -> ${candidate.path}`);
    if (hints.length >= 2) break;
  }
  return hints.length ? `; candidates: ${hints.join('; ')}` : '';
}

function moduleGraphTargetFixes(moduleGraph) {
  return (moduleGraph?.actionable_gaps || [])
    .filter((gap) => gap?.reason === 'target missing')
    .map((gap) => ({
      module_id: gap.module_id ?? null,
      source_path: gap.source_path ?? null,
      candidates: (gap.target_candidates || []).slice(0, 5).map((candidate) => ({
        path: candidate.path ?? null,
        reason: candidate.reason ?? null,
        score: Number(candidate.score ?? 0),
      })),
    }));
}

function moduleGraphGapRepairKind(moduleGraph) {
  const missingGraphs = Number(moduleGraph?.missing_graph_count ?? 0);
  const missingTargets = Number(moduleGraph?.missing_target_count ?? 0);
  if (missingTargets > 0 && missingGraphs === 0) return 'target-drift';
  if (missingTargets > 0 && missingGraphs > 0) return 'mixed';
  return 'missing-graphs';
}

function moduleGraphGapCommand(project) {
  const missingGraphs = Number(project.module_graph?.missing_graph_count ?? 0);
  const missingTargets = Number(project.module_graph?.missing_target_count ?? 0);
  if (missingTargets > 0 && missingGraphs === 0) {
    return `npm run graphify:target-fixes -- --project ${shellArg(project.id)}`;
  }
  return `npm run graphify:refresh:modules -- --project ${shellArg(project.id)} --missing-only --limit 25 --no-cluster --timeout-seconds ${GRAPH_REPAIR_TIMEOUT_SECONDS} && npm run graphify:project-from-modules -- --project ${shellArg(project.id)}`;
}

function graphGapCommand(project) {
  if (project.id === 'sma') return 'npm run graphify:refresh:self';
  if (hasModuleGraphSurface(project)) {
    return `npm run graphify:refresh:modules -- --project ${shellArg(project.id)} --missing-only --limit 25 --no-cluster --timeout-seconds ${GRAPH_REPAIR_TIMEOUT_SECONDS} && npm run graphify:project-from-modules -- --project ${shellArg(project.id)}`;
  }
  if (project.id) {
    return `npm run graphify:refresh -- --project ${shellArg(project.id)} --no-cluster --timeout-seconds ${GRAPH_REPAIR_TIMEOUT_SECONDS}`;
  }
  if (project.root) {
    return `npm run graphify:refresh -- --project-root ${shellArg(project.root)} --as ${shellArg(project.id)} --no-cluster --timeout-seconds ${GRAPH_REPAIR_TIMEOUT_SECONDS}`;
  }
  return `npm run graphify:refresh -- --project ${shellArg(project.id)} --no-cluster --timeout-seconds ${GRAPH_REPAIR_TIMEOUT_SECONDS}`;
}

function hasModuleGraphSurface(project) {
  if (project.module_graph) return true;
  if (!project.root) return false;
  return existsSync(resolve(project.root, 'graphify-out/modules'))
    || existsSync(resolve(project.root, 'sma.gen3.json'));
}

function printText(snapshot) {
  console.log('SMA Gen3 Controller Snapshot');
  console.log(`generated:       ${snapshot.generated_at}`);
  console.log(`projects:        ${snapshot.summary.projects}`);
  console.log(`active leases:   ${snapshot.summary.active_leases}`);
  console.log(`open conflicts:  ${snapshot.summary.open_conflicts}`);
  console.log(`dirty projects:  ${snapshot.summary.dirty_projects}`);
  console.log(`dirty unleased:  ${snapshot.summary.dirty_unleased_projects}`);
  if (snapshot.summary.active_dirty_scope_projects > 0) {
    console.log(`active scope:    ${snapshot.summary.active_dirty_scope_projects} project${snapshot.summary.active_dirty_scope_projects === 1 ? '' : 's'}, ${snapshot.summary.active_dirty_scope_paths} uncovered path${snapshot.summary.active_dirty_scope_paths === 1 ? '' : 's'}`);
  }
  if (snapshot.summary.stale_agent_processes > 0) {
    console.log(`stale agents:    ${snapshot.summary.stale_agent_processes} process${snapshot.summary.stale_agent_processes === 1 ? '' : 'es'} across ${snapshot.summary.stale_agent_process_projects} project${snapshot.summary.stale_agent_process_projects === 1 ? '' : 's'}`);
  }
  console.log(`graph gaps:      ${snapshot.summary.graph_gaps}`);
  if (args.moduleGraphs) console.log(`module gaps:     ${snapshot.summary.module_graph_gaps}`);
  console.log(`actions:         ${snapshot.summary.controller_actions}`);
  console.log('');

  printActions(snapshot);
  if (args.actionsOnly) return;

  if (snapshot.leases.active_count) {
    console.log('Active leases:');
    for (const lease of snapshot.leases.leases) {
      console.log(`  - ${lease.resource_kind}:${lease.resource_id} ${lease.agent_id} ttl=${lease.ttl_remaining_seconds}s project=${lease.project ?? '-'}`);
      console.log(`    ${lease.intent}`);
    }
    console.log('');
  }

  console.log('Projects:');
  for (const project of snapshot.projects) {
    const dirty = project.git ? formatDirty(project.git) : 'dirty skipped';
    const conflicts = `${project.conflicts.open_count} open conflicts`;
    const graph = project.graph ? (project.graph.ready ? `graph ${project.graph.node_count || '?'} nodes` : 'graph missing') : 'graph skipped';
    const moduleGraph = project.module_graph ? `, module graphs ${project.module_graph.satisfied_count}/${project.module_graph.module_count}` : '';
    const processText = project.agent_processes?.stale_count
      ? `, stale agents ${project.agent_processes.stale_count}/${project.agent_processes.process_count}`
      : '';
    console.log(`  - ${project.status.toUpperCase()} ${project.id}: ${dirty}, ${conflicts}, ${graph}${moduleGraph}${processText}`);
    if (project.git?.sample?.length) {
      for (const line of project.git.sample) console.log(`      ${line}`);
    }
    if (project.git?.dirty_hidden_count > 0) {
      console.log(`      ${project.git.dirty_hidden_count} dirty path${project.git.dirty_hidden_count === 1 ? '' : 's'} hidden; use --dirty-limit <n> or --dirty-full for file names`);
    }
    if (project.git?.groups?.length) {
      console.log(`      dirty groups: ${formatDirtyGroups(project.git.groups, 5)}`);
    }
    for (const conflict of project.conflicts.open.slice(0, 3)) {
      console.log(`      conflict ${conflict.brick_id}: ${conflict.intent}`);
    }
    if (project.status === 'dirty-unleased') {
      console.log('      action: claim with start-edit/end-edit, clean the worktree, or report a conflict before integration');
    }
    if (Number(project.stale_context?.receipt_count ?? 0) > 0) {
      console.log('      action: renew or hand off stale Gen3 context before cleanup claims this scope');
    }
    if (project.agent_processes?.stale?.length) {
      for (const proc of project.agent_processes.stale.slice(0, 3)) {
        console.log(`      stale agent pid ${proc.pid}: age=${formatDuration(proc.age_seconds)} cmd=${proc.command}`);
      }
    }
  }
}

function printActions(snapshot) {
  if (!snapshot.action_items.length) {
    console.log('Controller actions: none');
    console.log('');
    return;
  }
  if (snapshot.parallel_wave?.commands?.length) {
    console.log(`Parallel cleanup wave: ${snapshot.parallel_wave.recommended_agent_count} agents, ${snapshot.parallel_wave.total_impact} dirty paths covered`);
    for (const item of snapshot.parallel_wave.commands) {
      console.log(`  - ${item.rank}. ${item.project} ${item.group} (${item.count})`);
      console.log(`      ${item.command}`);
      if (item.conflict) console.log(`      conflict: ${item.conflict}`);
    }
    console.log('');
  }
  const limit = actionPrintLimit();
  const items = snapshot.action_items.slice(0, limit);
  console.log('Controller actions:');
  for (const item of items) {
    const impact = actionImpactLabel(item);
    console.log(`  - ${item.severity.toUpperCase()} ${item.project} ${item.kind}${impact ? ` [${impact}]` : ''}: ${item.title}`);
    if (item.detail) console.log(`      ${item.detail}`);
    if (item.command) console.log(`      ${item.command}`);
    printNextActionCommands(item);
  }
  if (snapshot.action_items.length > items.length) {
    console.log(`  ... ${snapshot.action_items.length - items.length} more action item${snapshot.action_items.length - items.length === 1 ? '' : 's'} hidden; use --action-limit ${snapshot.action_items.length} for the full queue`);
  }
  console.log('');
}

function printNextActionCommands(item) {
  if (!item?.next_commands) return;
  for (const [name, command] of Object.entries(item.next_commands)) {
    if (!command || command === item.command) continue;
    console.log(`      ${name}: ${command}`);
  }
}

function formatDirty(git) {
  if (!git.dirty_count) return '0 dirty';
  return `${git.dirty_count} dirty (${git.modified_count} modified, ${git.untracked_count} untracked)`;
}

function actionImpactLabel(item) {
  if (!item) return '';
  if (item.kind === 'stale-context') return `${Number(item.stale_context_dirty_count ?? item.impact_score ?? 0)} stale-context`;
  if (item.kind === 'dirty-unleased') return `${Number(item.dirty_count ?? item.impact_score ?? 0)} dirty`;
  if (item.kind === 'active-dirty-scope') return `${Number(item.uncovered_dirty_count ?? item.impact_score ?? 0)} uncovered`;
  if (item.kind === 'stale-agent-process') return `${Number(item.stale_process_count ?? item.impact_score ?? 0)} stale`;
  if (item.kind === 'module-graph-gap') return `${Number(item.module_graph_gap_count ?? item.impact_score ?? 0)} module gaps`;
  if (item.kind === 'graph-gap') return 'missing graph';
  return '';
}

function dirtySampleLimit() {
  if (args.dirtyFull) return Number.POSITIVE_INFINITY;
  const raw = args.dirtyLimit ?? args.maxStatus;
  if (raw === undefined || raw === null || raw === true) return DEFAULT_DIRTY_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid --dirty-limit value: ${raw}`);
  }
  return Math.floor(parsed);
}

function actionPrintLimit() {
  const raw = args.actionLimit;
  if (raw === undefined || raw === null || raw === true) return DEFAULT_ACTION_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid --action-limit value: ${raw}`);
  }
  return Math.floor(parsed);
}

function isDirtyStrict() {
  return Boolean(args.dirtyStrict || args.requireCleanOrLeased);
}

function hasStrictDirtyBlockers(snapshot) {
  return Number(snapshot.summary?.dirty_unleased_projects ?? 0) > 0
    || Number(snapshot.summary?.active_dirty_scope_projects ?? 0) > 0
    || Number(snapshot.summary?.stale_agent_processes ?? 0) > 0;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function shellArg(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function parseArgs(list) {
  const out = { project: [] };
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = list[i + 1];
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) {
      out[key] = true;
      continue;
    }
    if (key === 'project') out.project.push(next);
    else out[key] = next;
    i += 1;
  }
  return out;
}
