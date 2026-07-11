#!/usr/bin/env node
/**
 * What: Produces one readiness report before parallel work is launched or resumed.
 * Why: A launch can otherwise collide with leases, stale handoffs, or unclaimed dirty work.
 * How: Combines controller, conflict, graph, and work-packet inputs into text or structured output.
 * Callers: Controllers run it before assigning a cleanup or module wave.
 * Example: `node tools/sma-parallel-preflight.mjs --help`
 */
/**
 * sma-parallel-preflight.mjs - one-command Gen3 readiness check before
 * launching or respawning parallel SMA agents.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { runParallelPreflightSelftest } from './lib/parallel-preflight-selftest.ts';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = resolve(SMA_ROOT, 'tools');
const PLACEHOLDER_MODULE_TASK = '<describe module task>';
const rawArgs = argv.slice(2);
const command = rawArgs.find((arg) => !arg.startsWith('--')) || '';
const args = parseArgs(rawArgs);

try {
  if (args.help) {
    usage();
    exit(0);
  }
  if (args.selftest || command === 'selftest') {
    runParallelPreflightSelftest({
      buildBigPicture,
      buildControllerBlockerPackets,
      buildLaunchDecision,
      buildLaneStatuses,
      buildModuleLaunchPlan,
      buildStaleContextLaunchPlan,
      formatDispatchBlocked,
      mergeDispatchAssignments,
      moduleProgressCommand,
      primaryNext,
      scopedControllerIsClean,
      shouldUseControllerCleanupFallback,
      summarizeCommandGuidance,
    });
    exit(0);
  }
  const result = runPreflight();
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printText(result);
  }
  if (args.strict && result.status === 'blocked') exit(4);
} catch (err) {
  console.error(`sma-parallel-preflight: ${err.message}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
	  sma-parallel-preflight.mjs [--limit 3|auto] [--auto-limit] [--max-agents 12]
		                             [--project <id>]
		                             [--task "..."]
                             [--write-dispatch [path]]
		                             [--launch-plan] [--full-prompts] [--json] [--strict]
                             [--no-auto-refresh] [--allow-stale]
                             [--processes] [--stale-process-seconds <n>]
                             [--selftest|selftest]

Runs the low-token Gen3 controller preflight for parallel agent launches.
By default stale cleanup/graph packets are auto-refreshed once by the packet
tools. Use --auto-limit for the largest currently safe local cleanup wave,
capped by --max-agents. Use --no-auto-refresh for read-only dashboard checks.
Use --launch-plan to print compact cleanup slots and current module-dispatch
claim slots in text mode. Use --full-prompts only when you need the legacy
long prompt text; module agents should read their packet first.
`);
}

function runPreflight() {
  const projectScope = args.project ? String(args.project) : null;
  const moduleTask = args.task ? String(args.task) : null;
  const controllerArgs = [
    resolve(TOOLS_DIR, 'sma-controller-snapshot.mjs'),
    '--dirty-limit', '0',
    '--action-limit', '25',
    '--actions-only',
    '--json',
    '--module-graphs',
    '--exclude-volatile-sma-regen',
  ];
  if (projectScope) controllerArgs.push('--project', projectScope);
  else controllerArgs.push('--all');
  if (args.processes) controllerArgs.push('--processes');
  if (args.staleProcessSeconds !== undefined) {
    controllerArgs.push('--stale-process-seconds', String(args.staleProcessSeconds));
  }
  const controller = runJsonTool('controller', controllerArgs);
  const projectScopeIsClean = Boolean(projectScope) && scopedControllerIsClean(controller.data?.summary || {});
  const limitPlan = resolveLimitPlan(controller.data?.summary || {});
  const limit = limitPlan.limit;
  const conflictArgs = [
    resolve(TOOLS_DIR, 'sma-conflict.mjs'),
    'summary',
    '--json',
  ];
  if (projectScope) conflictArgs.push('--project', projectScope);
  else conflictArgs.push('--all');
  const conflicts = runJsonTool('conflicts', conflictArgs);
  const cleanupArgs = [
    resolve(TOOLS_DIR, 'sma-cleanup-packets.mjs'),
    'wave',
    '--limit', String(limit),
    '--json',
  ];
  const graphArgs = [
    resolve(TOOLS_DIR, 'sma-graph-packets.mjs'),
    'list',
    '--json',
  ];
  if (projectScope) {
    cleanupArgs.push('--project', projectScope);
    graphArgs.push('--project', projectScope);
  }
  if (args.noAutoRefresh || projectScopeIsClean) {
    cleanupArgs.push('--no-auto-refresh');
    graphArgs.push('--no-auto-refresh');
  }
  if (args.allowStale) {
    cleanupArgs.push('--allow-stale');
    graphArgs.push('--allow-stale');
  }
  const cleanup = runJsonTool('cleanup', cleanupArgs);
  const graphs = runJsonTool('graphs', graphArgs);
  const moduleLimit = limitPlan.maxAgents || limit;
  const moduleWorkArgs = [
    resolve(TOOLS_DIR, 'sma-module-work-packets.mjs'),
    'plan',
    '--project', projectScope,
    '--max-agents', String(moduleLimit),
    '--json',
  ];
  if (moduleTask) moduleWorkArgs.push('--task', moduleTask);
  const moduleWork = projectScope
    ? runJsonTool('module-work', moduleWorkArgs)
    : { label: 'module-work', data: null, error: null };
  const moduleObserve = projectScope
    ? runJsonTool('module-observe', [
        resolve(TOOLS_DIR, 'sma-module-work-packets.mjs'),
        'observe',
        '--dispatch', 'latest',
        '--project', projectScope,
        '--json',
      ])
    : { label: 'module-observe', data: null, error: null };

  const result = scorePreflight({
    generatedAt: new Date().toISOString(),
    projectScope,
    limit,
    limitPlan,
    controller,
    conflicts,
    cleanup,
    graphs,
    moduleWork,
    moduleObserve,
    moduleLimit,
    moduleTask,
  });
  if (args.writeDispatch !== undefined) {
    attachModuleDispatch(result, { projectScope, moduleTask, moduleLimit });
  }
  return result;
}

function scopedControllerIsClean(summary) {
  return number(summary.dirty_unleased_projects) === 0
    && number(summary.stale_context_projects) === 0
    && number(summary.stale_context_dirty_paths) === 0
    && number(summary.active_dirty_scope_projects) === 0
    && number(summary.active_dirty_scope_paths) === 0
    && number(summary.graph_gaps) === 0
    && number(summary.module_graph_gaps) === 0;
}

function scorePreflight({ generatedAt, projectScope, limit, limitPlan, controller, conflicts, cleanup, graphs, moduleWork, moduleObserve, moduleLimit, moduleTask }) {
  const controllerSummary = controller.data?.summary || {};
  const scopedController = scopedControllerSummary(controller.data, controllerSummary, projectScope);
  const conflictSummary = conflicts.data?.summary || {};
  const cleanupFallback = controllerCleanupFallback(controller.data?.parallel_wave);
  const useControllerCleanupFallback = shouldUseControllerCleanupFallback(cleanup, cleanupFallback);
  const cleanupSummary = useControllerCleanupFallback ? cleanupFallback.summary : (cleanup.data?.summary || {});
  const readiness = useControllerCleanupFallback ? cleanupFallback.readiness : (cleanup.data?.readiness || {});
  const cleanupAssignments = useControllerCleanupFallback ? cleanupFallback.assignments : (cleanup.data?.assignments || []);
  const graphSummary = graphs.data?.summary || {};
  const moduleWorkSummary = summarizeModuleWork(moduleWork, projectScope, moduleLimit || limit, moduleTask);
  const moduleDispatchSummary = summarizeModuleDispatch(moduleObserve, projectScope);
  const controllerBlockerPackets = buildControllerBlockerPackets(controller.data);
  const staleContextLaunchPlan = buildStaleContextLaunchPlan(controllerBlockerPackets, limit, projectScope);
  const blockers = [];
  const warnings = [];

  for (const probe of [controller, conflicts, cleanup, graphs]) {
    if (probe.error) blockers.push(`${probe.label}: ${probe.error}`);
  }
  if (moduleWork?.error && projectScope) warnings.push(`module-work: ${moduleWork.error}`);
  if (moduleDispatchSummary.error && moduleDispatchSummary.status !== 'missing') {
    warnings.push(`module-dispatch: ${moduleDispatchSummary.error}`);
  }
  if (moduleDispatchSummary.dispatch_stale_unclaimed) {
    warnings.push(`module-dispatch: latest dispatch is stale and unclaimed; write a fresh dispatch before launching module agents`);
  }

  const openConflicts = number(conflictSummary.open_conflicts ?? controllerSummary.open_conflicts);
  const criticalConflicts = number(conflictSummary.critical_conflicts);
  const warningConflicts = number(conflictSummary.warning_conflicts);
  if (openConflicts > 0) blockers.push(`${openConflicts} open conflict report(s)`);
  if (criticalConflicts > 0) blockers.push(`${criticalConflicts} critical conflict SLA item(s)`);
  if (warningConflicts > 0) warnings.push(`${warningConflicts} warning conflict SLA item(s)`);
  if (number(conflictSummary.projects_skipped) > 0) {
    warnings.push(`${number(conflictSummary.projects_skipped)} project(s) skipped by conflict summary`);
  }

  const graphPackets = number(graphSummary.packet_count);
  const projectGraphGaps = number(graphSummary.project_graph_gaps);
  const moduleGraphGaps = number(graphSummary.module_graph_gap_count);
  if (graphPackets > 0 || projectGraphGaps > 0 || moduleGraphGaps > 0) {
    blockers.push(`${graphPackets} graph repair packet(s): ${projectGraphGaps} project gap(s), ${moduleGraphGaps} module gap(s)`);
  }

  const cleanupStatus = String(readiness.status || 'unknown');
  const cleanupClaimablePercent = number(readiness.claimable_percent);
  const targetedPaths = number(readiness.targeted_dirty_paths ?? cleanupSummary.targeted_dirty_paths);
  const claimablePaths = number(readiness.claimable_dirty_paths ?? cleanupSummary.claimable_dirty_paths);
  const dirtyUnleasedProjects = number(scopedController.dirty_unleased_projects);
  if (cleanupStatus === 'blocked' || cleanupStatus === 'stale') {
    blockers.push(`cleanup wave is ${cleanupStatus}`);
  } else if (cleanupStatus === 'partial' || cleanupStatus === 'partial-stale') {
    warnings.push(`cleanup wave is ${cleanupStatus}`);
  } else if (cleanupStatus === 'empty' && dirtyUnleasedProjects > 0) {
    blockers.push(`${dirtyUnleasedProjects} dirty-unleased project(s) have no cleanup packet coverage`);
  } else if (!cleanupStatus || cleanupStatus === 'unknown') {
    warnings.push('cleanup wave readiness is unknown');
  }
  if (targetedPaths > 0 && cleanupClaimablePercent < 100) {
    warnings.push(`${cleanupClaimablePercent}% of selected cleanup paths claimable`);
  }

  const activeDirtyScopeProjects = number(scopedController.active_dirty_scope_projects);
  const activeDirtyScopePaths = number(scopedController.active_dirty_scope_paths);
  if (activeDirtyScopeProjects > 0 || activeDirtyScopePaths > 0) {
    blockers.push(`${activeDirtyScopeProjects} active dirty-scope project(s), ${activeDirtyScopePaths} uncovered path(s)`);
  }

  const staleContextProjects = number(scopedController.stale_context_projects);
  const staleContextPaths = number(scopedController.stale_context_dirty_paths);
  if (staleContextProjects > 0 || staleContextPaths > 0) {
    blockers.push(`${staleContextProjects} stale Gen3 context project(s), ${staleContextPaths} dirty path(s) require lease renewal or handoff`);
  }

  const staleAgentProcessProjects = number(scopedController.stale_agent_process_projects);
  const staleAgentProcesses = number(scopedController.stale_agent_processes);
  const agentProcessScanErrorProjects = number(scopedController.agent_process_scan_error_projects);
  if (staleAgentProcesses > 0) {
    blockers.push(`${staleAgentProcesses} stale project-rooted agent process(es) across ${staleAgentProcessProjects} project(s)`);
  }
  if (agentProcessScanErrorProjects > 0) {
    blockers.push(`agent process scan failed for ${agentProcessScanErrorProjects} project(s)`);
  }

  const activeLeases = number(scopedController.active_leases);
  if (activeLeases > 0) warnings.push(`${activeLeases} active lease(s) currently visible`);
  if (moduleDispatchSummary.open_conflicts > 0) {
    blockers.push(`${moduleDispatchSummary.open_conflicts} open module-dispatch conflict(s)`);
  }

  const penalties = [
    openConflicts > 0 ? 40 : 0,
    criticalConflicts > 0 ? 20 : 0,
    warningConflicts > 0 ? Math.min(12, warningConflicts * 4) : 0,
    graphPackets > 0 || moduleGraphGaps > 0 || projectGraphGaps > 0
      ? Math.min(30, graphPackets * 10 + moduleGraphGaps * 2 + projectGraphGaps * 8)
      : 0,
    cleanupPenalty(cleanupStatus),
    cleanupStatus === 'empty' && dirtyUnleasedProjects > 0 ? 25 : 0,
    targetedPaths > 0 ? Math.max(0, (100 - cleanupClaimablePercent) * 0.35) : 0,
    activeDirtyScopeProjects > 0 || activeDirtyScopePaths > 0 ? 20 : 0,
    staleContextProjects > 0 || staleContextPaths > 0 ? 25 : 0,
    staleAgentProcesses > 0 ? Math.min(25, staleAgentProcesses * 10) : 0,
    agentProcessScanErrorProjects > 0 ? 15 : 0,
    Math.min(8, activeLeases * 2),
    Math.min(20, number(conflictSummary.projects_skipped) * 5),
    [controller, conflicts, cleanup, graphs].filter((probe) => probe.error).length * 25,
  ];
  const readinessScorePercent = clamp(Math.round(100 - penalties.reduce((sum, item) => sum + item, 0)), 0, 100);
  const status = blockers.length
    ? 'blocked'
    : readinessScorePercent >= 90 && (cleanupStatus === 'ready' || cleanupStatus === 'empty')
      ? 'ready'
      : 'watch';

  const requestedAssignments = number(readiness.assignment_count ?? cleanupSummary.assignment_count);
  const claimableAssignments = number(readiness.claimable_assignment_count ?? cleanupSummary.claimable_assignment_count);
  const recommendedAgents = status === 'blocked' ? 0 : Math.min(limit, claimableAssignments || requestedAssignments);
  const launchPlan = buildLaunchPlan(cleanupAssignments, recommendedAgents);
  const bigPicture = buildBigPicture({
    status,
    readinessScorePercent,
    recommendedAgents,
    requestedAgents: limit,
    launchSlots: launchPlan.length,
    claimablePercent: cleanupClaimablePercent,
    targetedPaths,
    claimablePaths,
    dirtyUnleasedProjects,
    activeLeases,
    openConflicts,
    criticalConflicts,
    warningConflicts,
    graphPackets,
    projectGraphGaps,
    moduleGraphGaps,
    activeDirtyScopeProjects,
    activeDirtyScopePaths,
    staleContextProjects,
    staleContextPaths,
    staleAgentProcessProjects,
    staleAgentProcesses,
    agentProcessScanErrorProjects,
    topWaveGainPercent: number(readiness.top_wave_gain_percent),
    topProjectGainPercent: nullableNumber(readiness.top_project_gain_percent),
    overflowGroups: number(readiness.overflow_count ?? cleanupSummary.overflow_count),
    blockers,
    cleanupStatus,
    projectScope,
    moduleWork: moduleWorkSummary,
    moduleDispatch: moduleDispatchSummary,
  });
  const primaryNextCommand = primaryNext({
    status,
    openConflicts,
    criticalConflicts,
    graphPackets,
    projectGraphGaps,
    moduleGraphGaps,
    cleanupStatus,
    activeDirtyScopeProjects,
    activeDirtyScopePaths,
    staleContextProjects,
    staleContextPaths,
    staleAgentProcesses,
    agentProcessScanErrorProjects,
    cleanupNext: useControllerCleanupFallback
      ? cleanupFallback.first_claim_command
      : scopedCleanupCommand(readiness.recommended_next_command || 'npm run controller:sweep:write', projectScope),
    projectScope,
    moduleWork: moduleWorkSummary,
    moduleDispatch: moduleDispatchSummary,
    controllerBlockerPackets,
    dirtyUnleasedProjects,
  });
  const commandGuidance = summarizeCommandGuidance({
    projectScope,
    cleanupStatus,
    moduleWork: moduleWorkSummary,
    moduleDispatch: moduleDispatchSummary,
    activeDirtyScopeProjects,
    activeDirtyScopePaths,
    staleContextProjects,
    staleContextPaths,
    staleContextLaunchableAgents: staleContextLaunchPlan.length,
    cleanupLaunchableAgents: recommendedAgents,
    openConflicts,
    criticalConflicts,
    graphPackets,
    projectGraphGaps,
    moduleGraphGaps,
    staleAgentProcesses,
    agentProcessScanErrorProjects,
  });
  const moduleLaunchPlan = buildModuleLaunchPlan(
    moduleDispatchSummary,
    commandGuidance.active_lane.startsWith('module') ? commandGuidance.launchable_agents : 0,
  );
  const queuedModuleLaunchPlan = buildModuleLaunchPlan(
    moduleDispatchSummary,
    commandGuidance.active_lane.startsWith('module') ? 0 : Math.min(limit, number(moduleDispatchSummary.claimable_unclaimed ?? moduleDispatchSummary.unclaimed)),
  );
  const laneStatuses = buildLaneStatuses({
    status,
    cleanupStatus,
    commandGuidance,
    moduleWork: moduleWorkSummary,
    moduleDispatch: moduleDispatchSummary,
    activeDirtyScopeProjects,
    activeDirtyScopePaths,
    staleContextProjects,
    staleContextPaths,
    staleContextLaunchableAgents: staleContextLaunchPlan.length,
    dirtyUnleasedProjects,
  });
  const launchDecision = buildLaunchDecision({
    status,
    laneStatuses,
    commandGuidance,
    recommendedAgents,
    primaryNextCommand,
  });
  const activeRecommendedAgents = commandGuidance.active_lane === 'cleanup'
    ? recommendedAgents
    : commandGuidance.launchable_agents;
  const activeLaneCapacityPercent = capacityPercent(activeRecommendedAgents, limit);

  return {
    schema_version: '1.0.0',
    generated_at: generatedAt,
    scope: {
      project: projectScope,
      mode: projectScope ? 'project' : 'portfolio',
    },
    status,
    readiness_score_percent: readinessScorePercent,
    integration_readiness_score_percent: readinessScorePercent,
    active_lane_capacity_percent: activeLaneCapacityPercent,
    requested_agents: limit,
    recommended_agents: recommendedAgents,
    active_lane: commandGuidance.active_lane,
    active_lane_status: laneStatuses.active_status,
    launch_allowed: launchDecision.allowed,
    active_recommended_agents: activeRecommendedAgents,
    stale_context_capacity_agents: staleContextLaunchPlan.length,
    module_capacity_agents: moduleWorkSummary.launch_ready_slots,
    dispatch_launchable_agents: commandGuidance.dispatch_launchable_agents,
    limit_mode: limitPlan.mode,
    max_agents: limitPlan.maxAgents,
    primary_next_command: primaryNextCommand,
    big_picture: bigPicture,
    blockers,
    warnings,
    launch_plan: launchPlan,
    stale_context_launch_plan: staleContextLaunchPlan,
    module_launch_plan: moduleLaunchPlan,
    queued_module_launch_plan: queuedModuleLaunchPlan,
    gains: {
      coordination_roundtrip_reduction_percent_estimate: 75,
      dirty_status_token_reduction_percent_estimate: 90,
      manual_wave_sizing_reduction_percent_estimate: limitPlan.mode === 'auto' ? 100 : 0,
      cleanup_wave_command_reduction_percent_estimate: launchPlan.length ? 100 : 0,
      stale_context_renewal_command_reduction_percent_estimate: staleContextLaunchPlan.length ? 100 : 0,
      module_wave_command_reduction_percent_estimate: moduleLaunchPlan.length ? 100 : 0,
      queued_module_wave_command_reduction_percent_estimate: queuedModuleLaunchPlan.length ? 100 : 0,
      active_lane_capacity_percent: activeLaneCapacityPercent,
      selected_wave_claimable_percent: cleanupClaimablePercent,
      selected_wave_top_gain_percent: number(readiness.top_wave_gain_percent),
      selected_project_top_gain_percent: nullableNumber(readiness.top_project_gain_percent),
      module_work_graph_first_token_reduction_percent_estimate: moduleWorkSummary.gains.module_graph_first_token_reduction_percent_estimate,
      module_work_collision_reduction_percent_estimate: moduleWorkSummary.gains.collision_reduction_percent_estimate,
      targeted_dirty_paths: targetedPaths,
      claimable_dirty_paths: claimablePaths,
      blocked_dirty_paths: number(readiness.blocked_dirty_paths),
      candidate_groups: number(readiness.total_candidate_count ?? cleanupSummary.total_candidate_count),
      overflow_groups: number(readiness.overflow_count ?? cleanupSummary.overflow_count),
    },
    controller: {
      projects: number(scopedController.projects),
      active_leases: activeLeases,
      open_conflicts: number(scopedController.open_conflicts),
      dirty_projects: number(scopedController.dirty_projects),
      dirty_unleased_projects: dirtyUnleasedProjects,
      stale_context_projects: staleContextProjects,
      stale_context_dirty_paths: staleContextPaths,
      active_dirty_scope_projects: activeDirtyScopeProjects,
      active_dirty_scope_paths: activeDirtyScopePaths,
      stale_agent_process_projects: staleAgentProcessProjects,
      stale_agent_processes: staleAgentProcesses,
      agent_process_scan_error_projects: agentProcessScanErrorProjects,
      graph_gaps: number(scopedController.graph_gaps),
      module_graph_gaps: number(scopedController.module_graph_gaps),
      controller_actions: number(scopedController.controller_actions),
      blocker_packet_count: controllerBlockerPackets.length,
      parallel_wave_agents: number(scopedController.parallel_wave_agents),
      parallel_wave_impact: number(scopedController.parallel_wave_impact),
    },
    conflict_sla: {
      status: conflictSummary.status || 'unknown',
      projects_scanned: number(conflictSummary.projects_scanned),
      projects_skipped: number(conflictSummary.projects_skipped),
      open_conflicts: openConflicts,
      warning_conflicts: warningConflicts,
      critical_conflicts: criticalConflicts,
      oldest_age_bucket: conflictSummary.oldest_age_bucket || 'none',
    },
    cleanup_wave: {
      status: cleanupStatus,
      auto_refreshed: Boolean(cleanup.data?.auto_refreshed),
      source: useControllerCleanupFallback ? 'controller-parallel-wave' : 'cleanup-packets',
      controller_fallback_applied: useControllerCleanupFallback,
      packet_file_stale: cleanupStatus !== 'empty' && Boolean(cleanup.data?.freshness?.stale),
      packet_stale_relevant: !useControllerCleanupFallback && cleanupStatus !== 'empty' && Boolean(cleanup.data?.freshness?.stale),
      assignment_count: requestedAssignments,
      claimable_assignment_count: claimableAssignments,
      held_assignment_count: number(readiness.held_assignment_count),
      stale_assignment_count: number(readiness.stale_assignment_count),
      targeted_dirty_paths: targetedPaths,
      claimable_dirty_paths: claimablePaths,
      claimable_percent: cleanupClaimablePercent,
      top_wave_gain_percent: number(readiness.top_wave_gain_percent),
      top_project_gain_percent: nullableNumber(readiness.top_project_gain_percent),
      launch_plan_slots: launchPlan.length,
      recommended_next_command: readiness.recommended_next_command || 'npm run controller:sweep:write',
    },
    graph_packets: {
      auto_refreshed: Boolean(graphs.data?.auto_refreshed),
      packet_file_stale: graphPackets > 0 && Boolean(graphs.data?.freshness?.stale || graphSummary.packet_stale),
      packet_stale_relevant: graphPackets > 0 && Boolean(graphs.data?.freshness?.stale || graphSummary.packet_stale),
      packet_count: graphPackets,
      project_graph_gaps: projectGraphGaps,
      module_graph_gap_count: moduleGraphGaps,
      stale_packet_count: number(graphSummary.stale_packet_count),
      held_packet_count: number(graphSummary.held_packet_count),
      available_packet_count: number(graphSummary.available_packet_count),
    },
    module_work: moduleWorkSummary,
    module_dispatch: moduleDispatchSummary,
    lane_statuses: laneStatuses,
    launch_decision: launchDecision,
    controller_blocker_packets: controllerBlockerPackets,
    command_guidance: commandGuidance,
    next_commands: {
      first_controller_blocker: controllerBlockerPackets[0]?.command || '',
      stale_context_renewal: commandGuidance.stale_context_actionable ? staleContextLaunchPlan[0]?.command || '' : '',
      claim_next_cleanup_agent: commandGuidance.cleanup_actionable ? scopedCommand('npm run cleanup:claim -- --next', projectScope) : '',
      cleanup_wave: commandGuidance.cleanup_actionable ? scopedCommand(`npm run cleanup:wave -- --limit ${limit}`, projectScope) : '',
      auto_preflight: scopedCommand(`npm run parallel:preflight -- --auto-limit --max-agents ${limitPlan.maxAgents}`, projectScope),
      conflict_summary: scopedCommand('npm run conflict:summary', projectScope),
      graph_packets: scopedCommand('npm run graph:packets', projectScope),
      controller_sweep: 'npm run controller:sweep',
      refresh_packets: 'npm run controller:sweep:write',
      dashboard: projectScope ? projectDashboardCommand(projectScope, limit, moduleWorkSummary.task) : 'npm run gen3:dashboard',
      project_dashboard: projectScope ? projectDashboardCommand(projectScope, limit, moduleWorkSummary.task) : '',
      global_dashboard: 'npm run gen3:dashboard',
      module_plan: projectScope ? `npm run module:plan -- --project ${shellArg(projectScope)} --max-agents ${limit}` : '',
      module_watch: projectScope ? moduleWatchCommand(projectScope, limit, moduleWorkSummary.task) : '',
      module_dispatch: projectScope ? moduleDispatchCommand(projectScope, limit, moduleWorkSummary.task) : '',
      module_observe: commandGuidance.module_observe_actionable ? moduleDispatchSummary.observe_command : '',
      module_observe_write: commandGuidance.module_observe_actionable ? moduleDispatchSummary.observe_write_command : '',
      queued_module_first_claim: queuedModuleLaunchPlan[0]?.claim_command || '',
    },
  };
}

function summarizeModuleWork(moduleWork, projectScope, limit, moduleTask = null) {
  const plan = moduleWork?.data || null;
  const summary = plan?.summary || {};
  const launchPlan = Array.isArray(plan?.launch_plan) ? plan.launch_plan : [];
  const gains = plan?.gains || {};
  const task = String(plan?.task || moduleTask || PLACEHOLDER_MODULE_TASK);
  const observeCommand = projectScope
    ? `npm run module:observe -- --dispatch latest --project ${shellArg(projectScope)}`
    : 'npm run module:observe -- --dispatch latest';
  return {
    available: Boolean(plan && !moduleWork?.error),
    status: plan?.status || (moduleWork?.error ? 'unavailable' : 'not-requested'),
    project: projectScope || null,
    task,
    task_is_placeholder: !hasConcreteModuleTask(task),
    requested_agents: number(summary.requested_agents || limit),
    launch_ready_slots: number(summary.launch_ready_slots),
    candidate_slots: number(summary.candidate_slots),
    modules_total: number(summary.modules_total),
    graph_ready_modules: number(summary.graph_ready_modules),
    graph_blocked_modules: number(summary.graph_blocked_modules),
    held_slots: number(summary.held_slots),
    path_overlap_blocked_slots: number(summary.path_overlap_blocked_slots),
    fill_capacity: Boolean(summary.fill_capacity),
    modules: uniqueStrings(launchPlan.map((slot) => slot.module_id)),
    first_claim_command: '',
    plan_command: projectScope ? `npm run module:plan -- --project ${shellArg(projectScope)} --max-agents ${limit}` : '',
    watch_command: projectScope ? moduleWatchCommand(projectScope, limit, task) : '',
    dispatch_command: projectScope ? moduleDispatchCommand(projectScope, limit, task) : '',
    dashboard_command: projectScope ? projectDashboardCommand(projectScope, limit, task) : '',
    observe_command: observeCommand,
    warnings: Array.isArray(plan?.warnings) ? plan.warnings : [],
    blockers: Array.isArray(plan?.blockers) ? plan.blockers : [],
    gains: {
      module_graph_first_token_reduction_percent_estimate: number(gains.module_graph_first_token_reduction_percent_estimate),
      dirty_status_token_reduction_percent_estimate: number(gains.dirty_status_token_reduction_percent_estimate),
      false_portfolio_blocker_reduction_percent_estimate: number(gains.false_portfolio_blocker_reduction_percent_estimate),
      collision_reduction_percent_estimate: number(gains.collision_reduction_percent_estimate),
    },
  };
}

function summarizeModuleDispatch(moduleObserve, projectScope) {
  const error = moduleObserve?.error || '';
  const missing = Boolean(error) && /no module-work dispatch manifest found/.test(error);
  const observation = moduleObserve?.data || null;
  const summary = observation?.summary || {};
  const dispatch = observation?.dispatch || {};
  const manifestAssignments = readDispatchManifestAssignments(dispatch.path);
  const assignments = mergeDispatchAssignments(
    Array.isArray(observation?.assignments) ? observation.assignments : [],
    manifestAssignments,
  );
  const dispatchId = dispatch.dispatch_id || '';
  const latestObserveCommand = projectScope
    ? `npm run module:observe -- --dispatch latest --project ${shellArg(projectScope)}`
    : 'npm run module:observe -- --dispatch latest';
  const latestObserveWriteCommand = projectScope
    ? `npm run module:observe:write -- --dispatch latest --project ${shellArg(projectScope)}`
    : 'npm run module:observe:write -- --dispatch latest';
  const observeCommand = dispatchId
    ? `npm run module:observe -- --dispatch ${shellArg(dispatchId)}${projectScope ? ` --project ${shellArg(projectScope)}` : ''}`
    : latestObserveCommand;
  const observeWriteCommand = dispatchId
    ? `npm run module:observe:write -- --dispatch ${shellArg(dispatchId)}${projectScope ? ` --project ${shellArg(projectScope)}` : ''}`
    : latestObserveWriteCommand;
  const status = observation?.status || (missing ? 'missing' : error ? 'unavailable' : 'not-requested');

  return {
    available: Boolean(observation && !error),
    status,
    project: projectScope || dispatch.project || null,
    dispatch_id: dispatchId,
    task: dispatch.task || '',
    assignment_count: number(summary.assignment_count ?? dispatch.assignment_count),
    claimed: number(summary.claimed),
    active: number(summary.active),
    completed: number(summary.completed),
    unclaimed: number(summary.unclaimed),
    claimable_unclaimed: number(summary.claimable_unclaimed ?? summary.unclaimed),
    launch_blocked_unclaimed: number(summary.launch_blocked_unclaimed),
    held_blocked_unclaimed: number(summary.held_blocked_unclaimed),
    dirty_scope_blocked_unclaimed: number(summary.dirty_scope_blocked_unclaimed),
    other_blocked_unclaimed: number(summary.other_blocked_unclaimed),
    external_active_slot_count: number(summary.external_active_slot_count),
    external_active_lease_count: number(summary.external_active_lease_count),
    external_active_module_count: number(summary.external_active_module_count),
    dispatch_age_ms: number(summary.dispatch_age_ms),
    dispatch_max_age_ms: number(summary.dispatch_max_age_ms),
    dispatch_stale: Boolean(summary.dispatch_stale),
    dispatch_stale_unclaimed: Boolean(summary.dispatch_stale_unclaimed),
    open_conflicts: number(summary.open_conflicts),
    graph_ready: number(summary.graph_ready),
    next_command: observation?.next || '',
    observe_command: observeCommand,
    observe_write_command: observeWriteCommand,
    assignments,
    external_active_module_leases: Array.isArray(observation?.external_active_module_leases)
      ? observation.external_active_module_leases
      : [],
    warnings: Array.isArray(observation?.warnings) ? observation.warnings : [],
    blockers: Array.isArray(observation?.blockers) ? observation.blockers : [],
    error,
  };
}

function buildModuleLaunchPlan(moduleDispatch, limit) {
  if (!moduleDispatch?.available || moduleDispatch.status === 'complete') return [];
  const max = Math.floor(number(limit));
  if (max <= 0) return [];
  const assignments = Array.isArray(moduleDispatch.assignments) ? moduleDispatch.assignments : [];
  return assignments
    .filter((assignment) => {
      if (!assignment || assignment.status !== 'unclaimed') return false;
      if (assignment.claimed || assignment.active || assignment.completed) return false;
      if (assignment.launch_blocked) return false;
      if (assignment.graph_ready === false) return false;
      if (number(assignment.open_conflicts) > 0) return false;
      return Boolean(assignment.claim_command);
    })
    .slice(0, max)
    .map((assignment, index) => ({
      agent_slot: number(assignment.agent_slot || index + 1),
      project: assignment.project || moduleDispatch.project || '',
      module_id: assignment.module_id || '',
      dispatch_id: assignment.dispatch_id || moduleDispatch.dispatch_id || '',
      slot: number(assignment.slot || 1),
      partition_id: assignment.partition_id || null,
      partition_label: assignment.partition_label || null,
      brick: assignment.brick || '',
      status: assignment.status || 'unclaimed',
      graph_ready: assignment.graph_ready !== false,
      graph_path: assignment.graph_path || '',
      graph_query_command: assignment.graph_query_command || '',
      paths: Array.isArray(assignment.paths) ? assignment.paths : [],
      exclude_paths: Array.isArray(assignment.exclude_paths) ? assignment.exclude_paths : [],
      iteration_gates: Array.isArray(assignment.iteration_gates) ? assignment.iteration_gates : [],
      required_gates: Array.isArray(assignment.required_gates) ? assignment.required_gates : [],
      shared_hot_paths: Array.isArray(assignment.shared_hot_paths) ? assignment.shared_hot_paths : [],
      claim_command: assignment.claim_command || '',
      conflict_command: assignment.conflict_command || moduleLaunchConflictCommand({
        project: assignment.project || moduleDispatch.project || '',
        brick: assignment.brick || '',
        moduleId: assignment.module_id || '',
        task: assignment.task || moduleDispatch.task || '',
      }),
      agent_packet: assignment.agent_packet || null,
      agent_packet_markdown_path: assignment.agent_packet?.markdown_path || '',
      agent_packet_json_path: assignment.agent_packet?.json_path || '',
      prompt: assignment.prompt || `Use $sma-gen3. Claim this dispatch-pinned module slot with \`${assignment.claim_command}\`, query the module graph first, stay inside the assigned module paths, and conflict-report before touching shared hot paths or overlap.`,
    }));
}

function moduleLaunchConflictCommand({ project, brick, moduleId, task }) {
  if (!project || !brick) return '';
  const intent = `module ${moduleId || brick} overlap or shared hot path${task ? ` for ${task}` : ''}`;
  return [
    'npm run conflict -- report --project',
    shellArg(project),
    '--brick',
    shellArg(brick),
    '--intent',
    shellArg(intent),
    '--resolution-plan',
    shellArg('document overlap, back off, split paths, or wait for controller decision'),
  ].join(' ');
}

function buildStaleContextLaunchPlan(controllerBlockerPackets, limit = 6, projectScope = null) {
  const max = Math.floor(number(limit));
  if (max <= 0) return [];
  const packets = Array.isArray(controllerBlockerPackets) ? controllerBlockerPackets : [];
  return packets
    .filter((packet) => {
      if (!packet || packet.kind !== 'stale-context') return false;
      if (!packet.command) return false;
      if (projectScope && packet.project && packet.project !== projectScope) return false;
      return true;
    })
    .slice(0, max)
    .map((packet, index) => ({
      agent_slot: index + 1,
      packet_rank: number(packet.rank || index + 1),
      project: packet.project || projectScope || '',
      brick: packet.brick || '',
      dirty_path_count: number(packet.stale_context_dirty_count || packet.dirty_count || packet.impact_score),
      receipt_count: number(packet.stale_context_receipt_count),
      total_receipt_count: number(packet.stale_context_total_receipt_count || packet.stale_context_receipt_count),
      command: packet.command || '',
      inspect_command: packet.inspect_command || '',
      conflict_command: packet.conflict_command || '',
      sample_paths: Array.isArray(packet.sample_paths) ? packet.sample_paths.slice(0, 5) : [],
      prompt: packet.prompt || `Use $sma-gen3. Renew or hand off this stale Gen3 context with \`${packet.command}\`; conflict-report ownership uncertainty before cleanup or module reassignment.`,
    }));
}

function buildControllerBlockerPackets(controllerData, limit = 6) {
  const actions = Array.isArray(controllerData?.action_items) ? controllerData.action_items : [];
  return actions
    .filter((item) => item?.severity === 'blocker')
    .slice(0, limit)
    .map((item, index) => {
      const next = item.next_commands || {};
      const parallelClaims = Array.isArray(item.parallel_claims) ? item.parallel_claims : [];
      return {
        rank: index + 1,
        severity: item.severity || 'blocker',
        kind: item.kind || 'unknown',
        project: item.project || '',
        brick: item.brick || '',
        title: item.title || '',
        detail: item.detail || '',
        impact_score: number(item.impact_score),
        dirty_count: number(item.dirty_count),
        uncovered_dirty_count: number(item.uncovered_dirty_count),
        stale_context_dirty_count: number(item.stale_context_dirty_count),
        stale_context_receipt_count: number(item.stale_context_receipt_count),
        stale_context_total_receipt_count: number(item.stale_context_total_receipt_count),
        top_dirty_group: item.top_dirty_group || '',
        top_dirty_group_count: number(item.top_dirty_group_count),
        sample_paths: Array.isArray(item.top_dirty_group_sample_paths)
          ? item.top_dirty_group_sample_paths.slice(0, 5)
          : [],
        command: item.command || '',
        inspect_command: next.inspect || '',
        conflict_command: next.conflict || '',
        parallel_claim_count: parallelClaims.length,
        parallel_claims: parallelClaims.slice(0, 6).map((claim) => ({
          group: claim.group || '',
          count: number(claim.count),
          brick: claim.brick || '',
          command: claim.command || '',
          conflict_command: claim.conflict || '',
          sample_paths: Array.isArray(claim.sample_paths) ? claim.sample_paths.slice(0, 5) : [],
        })),
        prompt: buildControllerBlockerPrompt(item),
      };
    });
}

function buildControllerBlockerPrompt(item) {
  const kind = item?.kind || 'controller-blocker';
  const command = item?.command || 'rerun controller snapshot';
  const conflict = item?.next_commands?.conflict || '';
  if (kind === 'active-dirty-scope') {
    return `Use $sma-gen3. Reconcile uncovered active dirty scope with \`${command}\`; if this overlaps another agent or you are uncertain, run \`${conflict}\` before continuing.`;
  }
  if (kind === 'dirty-unleased') {
    return `Use $sma-gen3. Claim this dirty group with \`${command}\`, clean or commit only that group, and conflict-report overlap before touching other paths.`;
  }
  if (kind === 'stale-context') {
    return `Use $sma-gen3. Renew or hand off the stale context with \`${command}\`; if ownership is unclear, run \`${conflict}\` before cleanup or module reassignment.`;
  }
  if (kind === 'open-conflict') {
    return `Use $sma-gen3. Resolve the documented conflict with \`${command}\` before assigning more agents.`;
  }
  if (kind === 'stale-agent-process') {
    return `Use $sma-gen3. Inspect the stale process owner before termination; document uncertainty with \`${conflict}\`.`;
  }
  return `Use $sma-gen3. Handle this controller blocker with \`${command}\` and document any collision before reassignment.`;
}

function readDispatchManifestAssignments(dispatchPath) {
  if (!dispatchPath) return [];
  try {
    const manifest = readJsonFile(resolve(SMA_ROOT, dispatchPath));
    return Array.isArray(manifest.assignments) ? manifest.assignments : [];
  } catch {
    return [];
  }
}

function mergeDispatchAssignments(observedAssignments, manifestAssignments) {
  if (!manifestAssignments.length) return observedAssignments;
  const byKey = new Map();
  const byClaim = new Map();
  for (const assignment of manifestAssignments) {
    const key = dispatchAssignmentKey(assignment);
    if (key) byKey.set(key, assignment);
    if (assignment?.claim_command) byClaim.set(String(assignment.claim_command), assignment);
  }
  return observedAssignments.map((assignment) => {
    const manifestAssignment = byKey.get(dispatchAssignmentKey(assignment))
      || byClaim.get(String(assignment?.claim_command || ''))
      || null;
    return manifestAssignment ? { ...manifestAssignment, ...assignment } : assignment;
  });
}

function dispatchAssignmentKey(assignment) {
  if (!assignment) return '';
  const dispatchId = String(assignment.dispatch_id || '');
  const slot = String(assignment.agent_slot || '');
  const brick = String(assignment.brick || '');
  if (!dispatchId || !slot || !brick) return '';
  return `${dispatchId}:${slot}:${brick}`;
}

function shouldUseControllerCleanupFallback(cleanup, fallback) {
  if (!fallback.assignment_count) return false;
  const assignmentCount = number(cleanup?.data?.readiness?.assignment_count ?? cleanup?.data?.summary?.assignment_count);
  const targetedPaths = number(cleanup?.data?.readiness?.targeted_dirty_paths ?? cleanup?.data?.summary?.targeted_dirty_paths);
  const cleanupStatus = String(cleanup?.data?.readiness?.status || '');
  const packetStale = Boolean(cleanup?.data?.freshness?.stale);
  const staleAssignments = number(cleanup?.data?.readiness?.stale_assignment_count);
  if (assignmentCount === 0 && targetedPaths === 0) return true;
  return packetStale || cleanupStatus === 'stale' || cleanupStatus === 'partial-stale' || staleAssignments > 0;
}

function controllerCleanupFallback(parallelWave) {
  const commands = Array.isArray(parallelWave?.commands) ? parallelWave.commands : [];
  const assignments = commands.map((item, index) => ({
    rank: number(item.rank || index + 1),
    project: item.project || '',
    group: item.group || '',
    brick: item.brick || '',
    packet_type: 'controller-dirty-unleased',
    dirty_path_count: number(item.count),
    wave_gain_percent: number(item.wave_gain_percent),
    project_gain_percent: nullableNumber(item.project_gain_percent),
    claim_command: item.command || '',
    inspect_command: item.inspect || '',
    conflict_command: item.conflict || '',
    finish_rule: 'Use end-edit with verification evidence, then refresh project preflight.',
    prompt: item.command
      ? `Use $sma-gen3. Claim this cleanup group with \`${item.command}\`. Clean or commit only this ownership group; conflict-report any overlap before continuing.`
      : '',
    sample_paths: Array.isArray(item.sample_paths) ? item.sample_paths.slice(0, 5) : [],
    held: false,
    packet_stale: false,
  }));
  const targetedPaths = assignments.reduce((sum, item) => sum + number(item.dirty_path_count), 0);
  const top = assignments[0] || {};
  return {
    assignments,
    assignment_count: assignments.length,
    first_claim_command: assignments[0]?.claim_command || '',
    summary: {
      packet_count: assignments.length,
      assignment_count: assignments.length,
      claimable_assignment_count: assignments.length,
      targeted_dirty_paths: targetedPaths,
      claimable_dirty_paths: targetedPaths,
      total_candidate_count: number(parallelWave?.total_candidate_count || assignments.length),
      overflow_count: number(parallelWave?.overflow_count),
    },
    readiness: {
      status: assignments.length ? 'ready' : 'empty',
      assignment_count: assignments.length,
      claimable_assignment_count: assignments.length,
      held_assignment_count: 0,
      stale_assignment_count: 0,
      blocked_assignment_count: 0,
      targeted_dirty_paths: targetedPaths,
      claimable_dirty_paths: targetedPaths,
      blocked_dirty_paths: 0,
      claimable_percent: targetedPaths > 0 ? 100 : 0,
      top_wave_gain_percent: number(top.wave_gain_percent),
      top_project_gain_percent: nullableNumber(top.project_gain_percent),
      total_candidate_count: number(parallelWave?.total_candidate_count || assignments.length),
      overflow_count: number(parallelWave?.overflow_count),
      recommended_next_command: assignments[0]?.claim_command || 'npm run controller:sweep:write',
    },
  };
}

function scopedControllerSummary(data, summary, projectScope) {
  if (!projectScope) return summary;
  const projects = Array.isArray(data?.projects)
    ? data.projects.filter((project) => String(project.id || '') === String(projectScope))
    : [];
  const scopedActiveLeases = projects.reduce((sum, project) => (
    sum + (Array.isArray(project.active_leases) ? project.active_leases.length : 0)
  ), 0);
  const staleAgentProcesses = projects.reduce((sum, project) => (
    sum + number(project.agent_processes?.stale_count)
  ), 0);
  const agentProcessScanErrorProjects = projects.filter((project) => project.agent_processes?.process_scan_error).length;
  const staleContextProjects = projects.filter((project) => number(project.stale_context?.receipt_count) > 0).length;
  const staleContextPaths = projects.reduce((sum, project) => (
    sum + number(project.stale_context?.dirty_count)
  ), 0);
  return {
    ...summary,
    scope_project: String(projectScope),
    active_leases: scopedActiveLeases,
    stale_context_projects: staleContextProjects,
    stale_context_dirty_paths: staleContextPaths,
    stale_agent_process_projects: projects.filter((project) => number(project.agent_processes?.stale_count) > 0).length,
    stale_agent_processes: staleAgentProcesses,
    agent_process_scan_error_projects: agentProcessScanErrorProjects,
  };
}

function scopedCommand(command, projectScope) {
  if (!projectScope) return command;
  const flag = ` --project ${shellArg(projectScope)}`;
  return command.includes(' -- ') ? `${command}${flag}` : `${command} --${flag}`;
}

function moduleDispatchCommand(projectScope, limit, task) {
  if (!hasConcreteModuleTask(task)) return '';
  return `npm run module:dispatch -- --project ${shellArg(projectScope)} --task ${shellArg(task)} --max-agents ${limit}`;
}

function moduleWatchCommand(projectScope, limit, task) {
  const safeTask = hasConcreteModuleTask(task) ? ` --task ${shellArg(task)}` : '';
  return `npm run module:watch -- --project ${shellArg(projectScope)} --max-agents ${limit}${safeTask}`;
}

function summarizeCommandGuidance({
  projectScope,
  cleanupStatus,
  moduleWork,
  moduleDispatch,
  activeDirtyScopeProjects = 0,
  activeDirtyScopePaths = 0,
  staleContextProjects = 0,
  staleContextPaths = 0,
  staleContextLaunchableAgents = 0,
  cleanupLaunchableAgents = 0,
  openConflicts = 0,
  criticalConflicts = 0,
  graphPackets = 0,
  projectGraphGaps = 0,
  moduleGraphGaps = 0,
  staleAgentProcesses = 0,
  agentProcessScanErrorProjects = 0,
}) {
  const cleanupActionable = cleanupStatus !== 'empty';
  const moduleDispatchNeedsRefresh = Boolean(moduleDispatch?.dispatch_stale_unclaimed);
  const moduleDispatchOpen = Boolean(moduleDispatch?.available && moduleDispatch.status !== 'complete' && !moduleDispatchNeedsRefresh);
  const concreteTask = hasConcreteModuleTask(moduleWork?.task);
  const moduleDispatchMissing = Boolean(projectScope && moduleWork?.available && (!moduleDispatch?.available || moduleDispatchNeedsRefresh));
  const dispatchLaunchableAgents = moduleDispatchOpen ? number(moduleDispatch.claimable_unclaimed ?? moduleDispatch.unclaimed) : 0;
  const moduleCapacityAvailable = Boolean(moduleWork?.available && moduleWork.launch_ready_slots > 0);
  const activeDirtyScopePresent = number(activeDirtyScopeProjects) > 0 || number(activeDirtyScopePaths) > 0;
  const staleContextPresent = number(staleContextProjects) > 0 || number(staleContextPaths) > 0;
  const nonStaleHardLaneBlocker = number(openConflicts) > 0
    || number(criticalConflicts) > 0
    || number(graphPackets) > 0
    || number(projectGraphGaps) > 0
    || number(moduleGraphGaps) > 0
    || number(staleAgentProcesses) > 0
    || number(agentProcessScanErrorProjects) > 0
    || number(moduleDispatch?.open_conflicts) > 0;
  const staleContextCanRenew = staleContextPresent
    && number(staleContextLaunchableAgents) > 0
    && !nonStaleHardLaneBlocker;
  const staleContextDispatchCanProceed = staleContextPresent
    && !nonStaleHardLaneBlocker
    && moduleDispatchOpen
    && dispatchLaunchableAgents > 0;
  const moduleCanProceedThroughDirtyScope = cleanupActionable
    && activeDirtyScopePresent
    && !nonStaleHardLaneBlocker
    && (dispatchLaunchableAgents > 0 || moduleCapacityAvailable);
  const moduleCanProceedWhileCleanupBlocked = cleanupActionable
    && !activeDirtyScopePresent
    && !nonStaleHardLaneBlocker
    && number(cleanupLaunchableAgents) === 0
    && (dispatchLaunchableAgents > 0 || moduleCapacityAvailable);
  const activeLane = staleContextDispatchCanProceed
    ? 'module-observe'
    : staleContextCanRenew
    ? 'stale-context'
    : staleContextPresent
      ? 'snapshot'
    : moduleCanProceedThroughDirtyScope || moduleCanProceedWhileCleanupBlocked
    ? moduleDispatchOpen
      ? 'module-observe'
      : moduleCapacityAvailable
        ? concreteTask ? 'module-dispatch' : 'module-capacity-preview'
        : 'cleanup'
    : cleanupActionable
    ? 'cleanup'
    : moduleDispatchOpen
      ? 'module-observe'
      : moduleWork?.available && moduleWork.launch_ready_slots > 0
        ? concreteTask ? 'module-dispatch' : 'module-capacity-preview'
        : 'snapshot';
  const launchableAgents = activeLane === 'cleanup'
    ? 0
    : activeLane === 'stale-context'
      ? number(staleContextLaunchableAgents)
    : activeLane === 'module-observe'
      ? dispatchLaunchableAgents
      : 0;
  return {
    active_lane: activeLane,
    cleanup_actionable: cleanupActionable,
    cleanup_reason: cleanupActionable
      ? staleContextDispatchCanProceed || moduleCanProceedThroughDirtyScope || moduleCanProceedWhileCleanupBlocked
        ? staleContextDispatchCanProceed
          ? 'cleanup and release are blocked by stale Gen3 context; safe dispatch-pinned module work may continue'
          : moduleCanProceedThroughDirtyScope
          ? 'cleanup integration is blocked by active dirty scope; safe module dispatch may continue'
          : 'cleanup integration is blocked, but no cleanup agents are launchable; safe module dispatch may continue'
        : staleContextPresent
          ? 'cleanup is blocked by stale Gen3 context; renew or hand off before cleanup claims'
        : 'cleanup pressure exists; claim cleanup work before module dispatch'
      : staleContextPresent
        ? 'cleanup is blocked by stale Gen3 context; renew or hand off before cleanup claims'
        : 'cleanup pressure is clear for this scope; skip cleanup claims',
    module_capacity_agents: number(moduleWork?.launch_ready_slots),
    dispatch_launchable_agents: dispatchLaunchableAgents,
    stale_context_launchable_agents: number(staleContextLaunchableAgents),
    stale_context_actionable: staleContextCanRenew,
    stale_context_reason: staleContextCanRenew
      ? staleContextDispatchCanProceed
        ? 'stale Gen3 context can be renewed or handed off while safe dispatch-pinned module work continues'
        : 'stale Gen3 context can be renewed or handed off by packet-specific agents'
      : staleContextPresent
        ? 'stale Gen3 context blocks cleanup and module reassignment until renewal or handoff packets are claimable'
        : 'no stale Gen3 context in this scope',
    launchable_agents: launchableAgents,
    concrete_task: concreteTask,
    module_dispatch_required: moduleDispatchMissing && concreteTask,
    module_dispatch_reason: moduleDispatchNeedsRefresh
      ? 'latest module dispatch is stale and unclaimed; write a fresh dispatch before launching agents'
      : moduleDispatchMissing
        ? concreteTask
        ? 'write a module dispatch manifest before launching or observing module agents'
        : 'provide a concrete --task, then write a module dispatch manifest before launching agents'
      : moduleDispatchOpen
        ? 'module dispatch exists; observe it before assigning another wave'
        : 'module dispatch is not needed for the current lane',
    module_observe_actionable: moduleDispatchOpen,
    module_observe_reason: moduleDispatchOpen
      ? 'observe the current module dispatch'
      : 'module observation starts after a dispatch manifest exists',
  };
}

function buildLaneStatuses({
  status,
  cleanupStatus,
  commandGuidance,
  moduleWork,
  moduleDispatch,
  activeDirtyScopeProjects,
  activeDirtyScopePaths,
  staleContextProjects,
  staleContextPaths,
  staleContextLaunchableAgents = 0,
  dirtyUnleasedProjects,
}) {
  const moduleReadyAgents = commandGuidance.active_lane === 'module-observe'
    ? number(commandGuidance.dispatch_launchable_agents)
    : commandGuidance.active_lane === 'module-dispatch'
      ? number(moduleWork?.launch_ready_slots)
      : 0;
  const moduleStatus = moduleReadyAgents > 0
    ? 'ready'
    : moduleDispatch?.available && moduleDispatch.status !== 'complete'
      ? 'waiting'
      : moduleWork?.available && moduleWork.launch_ready_slots > 0
        ? 'preview'
        : 'idle';
  const cleanupLaneStatus = cleanupStatus === 'empty' ? 'clear' : cleanupStatus || 'unknown';
  const staleContextPresent = number(staleContextProjects) > 0 || number(staleContextPaths) > 0;
  const staleContextReadyAgents = number(staleContextLaunchableAgents);
  const staleContextStatus = staleContextReadyAgents > 0
    ? 'ready'
    : staleContextPresent
      ? 'blocked'
      : 'clear';
  const integrationDirty = number(dirtyUnleasedProjects) > 0
    || number(activeDirtyScopeProjects) > 0
    || number(activeDirtyScopePaths) > 0
    || staleContextPresent
    || cleanupLaneStatus !== 'clear';
  const integrationStatus = integrationDirty
    ? 'blocked'
    : status === 'ready'
      ? 'ready'
      : status === 'blocked'
        ? 'blocked'
        : 'watch';
  const activeStatus = commandGuidance.active_lane === 'cleanup'
    ? cleanupLaneStatus
    : commandGuidance.active_lane === 'stale-context'
      ? staleContextStatus
    : commandGuidance.active_lane.startsWith('module')
      ? moduleStatus
      : integrationStatus;
  return {
    active_lane: commandGuidance.active_lane,
    active_status: activeStatus,
    cleanup: {
      status: cleanupLaneStatus,
      actionable: Boolean(commandGuidance.cleanup_actionable),
    },
    stale_context: {
      status: staleContextStatus,
      ready_agents: staleContextReadyAgents,
      actionable: Boolean(commandGuidance.stale_context_actionable),
      projects: number(staleContextProjects),
      dirty_paths: number(staleContextPaths),
    },
    module: {
      status: moduleStatus,
      ready_agents: moduleReadyAgents,
      capacity_agents: number(moduleWork?.launch_ready_slots),
      dispatch_claimable_agents: number(moduleDispatch?.claimable_unclaimed ?? moduleDispatch?.unclaimed),
      dispatch_held_or_stale_agents: number(moduleDispatch?.launch_blocked_unclaimed),
      dispatch_held_blocked_agents: number(moduleDispatch?.held_blocked_unclaimed),
      dispatch_dirty_scope_blocked_agents: number(moduleDispatch?.dirty_scope_blocked_unclaimed),
      dispatch_other_blocked_agents: number(moduleDispatch?.other_blocked_unclaimed),
      dispatch_status: moduleDispatch?.status || 'not-requested',
    },
    integration: {
      status: integrationStatus,
      cleanup_required: integrationDirty,
      dirty_unleased_projects: number(dirtyUnleasedProjects),
      stale_context_projects: number(staleContextProjects),
      stale_context_dirty_paths: number(staleContextPaths),
      active_dirty_scope_projects: number(activeDirtyScopeProjects),
      active_dirty_scope_paths: number(activeDirtyScopePaths),
    },
  };
}

function buildLaunchDecision({
  status,
  laneStatuses,
  commandGuidance,
  recommendedAgents,
  primaryNextCommand,
}) {
  const lane = commandGuidance?.active_lane || laneStatuses?.active_lane || 'snapshot';
  const laneStatus = laneStatuses?.active_status || 'unknown';
  const activeAgents = lane === 'cleanup'
    ? number(recommendedAgents)
    : number(commandGuidance?.launchable_agents);
  const integration = laneStatuses?.integration || {};
  const allowed = laneStatus === 'ready' && activeAgents > 0 && Boolean(primaryNextCommand);
  const releaseAllowed = allowed
    && status === 'ready'
    && integration.status === 'ready'
    && !integration.cleanup_required;
  const reason = allowed
    ? integration.status === 'blocked'
      ? `${lane} launch allowed; integration remains blocked until ${integration.stale_context_projects || integration.stale_context_dirty_paths || lane === 'stale-context' ? 'stale context is renewed or handed off' : 'cleanup is reconciled'}`
      : `${lane} launch allowed`
    : laneStatus === 'ready'
      ? `${lane} is ready but no launch command or agent capacity is available`
      : `${lane} is ${laneStatus}`;
  return {
    allowed,
    lane,
    lane_status: laneStatus,
    agents: activeAgents,
    command: allowed ? primaryNextCommand : '',
    integration_status: integration.status || 'unknown',
    integration_blocked: integration.status === 'blocked',
    release_allowed: releaseAllowed,
    reason,
  };
}

function projectDashboardCommand(projectScope, limit, task) {
  const safeTask = hasConcreteModuleTask(task) ? ` --task ${shellArg(task)}` : '';
  return `npm run gen3:dashboard -- --project ${shellArg(projectScope)} --max-agents ${limit}${safeTask}`;
}

function hasConcreteModuleTask(task) {
  const value = String(task || '').trim();
  return Boolean(value && value !== PLACEHOLDER_MODULE_TASK && !/^<[^>]+>$/.test(value));
}

function uniqueStrings(values) {
  const seen = new Set();
  const unique = [];
  for (const value of values) {
    const item = String(value || '').trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    unique.push(item);
  }
  return unique;
}

function attachModuleDispatch(result, { projectScope, moduleTask, moduleLimit }) {
  if (!projectScope) {
    throw new Error('--write-dispatch requires --project <id>');
  }
  if (!moduleTask) {
    throw new Error('--write-dispatch requires --task "..." to avoid placeholder module-wave manifests');
  }
  if (result.status !== 'ready') {
    throw new Error(`refusing to write module dispatch while preflight is ${result.status}: ${result.blockers.join('; ') || 'not ready'}`);
  }
  if (!result.module_work?.available || result.module_work.launch_ready_slots <= 0) {
    throw new Error('refusing to write module dispatch with no launch-ready module slots');
  }
  const dispatchArgs = [
    resolve(TOOLS_DIR, 'sma-module-work-packets.mjs'),
    'plan',
    '--project', projectScope,
    '--task', moduleTask,
    '--max-agents', String(moduleLimit),
    '--json',
    '--write-dispatch',
  ];
  if (args.writeDispatch !== true) dispatchArgs.push(String(args.writeDispatch));
  const dispatch = runJsonTool('module-dispatch', dispatchArgs);
  if (dispatch.error) {
    throw new Error(`module dispatch write failed: ${dispatch.error}`);
  }
  const manifestInfo = dispatch.data?.dispatch_manifest;
  if (!manifestInfo?.json_path) {
    throw new Error('module dispatch write did not return a manifest path');
  }
  const manifest = readJsonFile(manifestInfo.json_path);
  const firstClaim = manifest.assignments?.[0]?.claim_command || '';
  result.module_work.dispatch_manifest = manifestInfo;
  result.module_work.dispatch_id = manifest.dispatch_id || manifestInfo.dispatch_id || '';
  result.module_work.dispatch_assignment_count = Array.isArray(manifest.assignments) ? manifest.assignments.length : 0;
  result.module_work.first_dispatch_claim_command = firstClaim;
  result.module_work.observe_command = manifest.controller_commands?.observe || result.module_work.observe_command;
  result.module_work.observe_write_command = manifest.controller_commands?.observe_write || '';
  result.primary_next_command = firstClaim || result.module_work.observe_command || result.primary_next_command;
  result.next_commands.module_observe = result.module_work.observe_command;
  result.next_commands.module_observe_write = result.module_work.observe_write_command;
  result.next_commands.module_first_claim = firstClaim;
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(resolve(filePath), 'utf8'));
}

function scopedCleanupCommand(command, projectScope) {
  if (!projectScope) return command;
  if (/controller:sweep:write/.test(String(command))) {
    return [
      'npm run controller:snapshot --',
      '--project', shellArg(projectScope),
      '--module-graphs',
      '--exclude-volatile-sma-regen',
      '--dirty-limit', '0',
      '--action-limit', '25',
      '--actions-only',
      '--write-actions', 'handoffs/controller-actions.generated.json',
    ].join(' ');
  }
  return scopedCommand(command, projectScope);
}

function buildLaunchPlan(assignments, recommendedAgents) {
  const limit = Math.max(0, number(recommendedAgents));
  return assignments
    .filter((item) => !item.held && !item.packet_stale)
    .slice(0, limit)
    .map((item, index) => ({
      agent_slot: index + 1,
      packet_rank: number(item.rank),
      project: item.project || '',
      group: item.group || '',
      brick: item.brick || '',
      packet_type: item.packet_type || 'dirty-unleased',
      dirty_path_count: number(item.dirty_path_count),
      wave_gain_percent: number(item.wave_gain_percent),
      project_gain_percent: nullableNumber(item.project_gain_percent),
      claim_command: item.claim_command || `npm run cleanup:claim -- --rank ${number(item.rank)}`,
      inspect_command: item.inspect_command || '',
      conflict_command: item.conflict_command || '',
      finish_rule: item.finish_rule || '',
      prompt: item.prompt || '',
      sample_paths: Array.isArray(item.sample_paths) ? item.sample_paths.slice(0, 5) : [],
    }));
}

function buildBigPicture({
  status,
  readinessScorePercent,
  recommendedAgents,
  requestedAgents,
  launchSlots,
  claimablePercent,
  targetedPaths,
  claimablePaths,
  dirtyUnleasedProjects,
  activeLeases,
  openConflicts,
  criticalConflicts,
  warningConflicts,
  graphPackets,
  projectGraphGaps,
  moduleGraphGaps,
  activeDirtyScopeProjects,
  activeDirtyScopePaths,
  staleContextProjects,
  staleContextPaths,
  staleAgentProcessProjects,
  staleAgentProcesses,
  agentProcessScanErrorProjects,
  topWaveGainPercent,
  topProjectGainPercent,
  overflowGroups,
  blockers,
  cleanupStatus,
  projectScope,
  moduleWork,
  moduleDispatch,
}) {
  const conflictText = `${openConflicts} open conflicts (${warningConflicts}/${criticalConflicts} warning/critical)`;
  const graphText = `${graphPackets} graph packets (${projectGraphGaps} project, ${moduleGraphGaps} module gaps)`;
  const processText = `${staleAgentProcesses} stale agent process${staleAgentProcesses === 1 ? '' : 'es'} across ${staleAgentProcessProjects} project${staleAgentProcessProjects === 1 ? '' : 's'}`;
  const cleanScope = status === 'ready' && cleanupStatus === 'empty';
  const moduleText = moduleWork?.available
    ? ` Module lane: ${moduleWork.launch_ready_slots}/${moduleWork.requested_agents} slots safe, ${moduleWork.graph_ready_modules}/${moduleWork.modules_total} module graphs ready.`
    : '';
  const dispatchOpen = moduleDispatch?.available && moduleDispatch.status !== 'complete';
  const dispatchId = moduleDispatch?.dispatch_id || 'latest';
  const dispatchClaimReady = moduleDispatch?.claimable_unclaimed ?? moduleDispatch?.unclaimed ?? 0;
  const dispatchBlocked = moduleDispatch?.launch_blocked_unclaimed ?? 0;
  const dispatchBlockedText = formatDispatchBlocked(moduleDispatch);
  const dispatchText = moduleDispatch?.available
    ? ` Dispatch ${dispatchId}: ${moduleDispatch.claimed}/${moduleDispatch.assignment_count} claimed, ${moduleDispatch.active} active, ${moduleDispatch.completed} done, ${dispatchClaimReady}/${moduleDispatch.unclaimed} open claim-ready, ${dispatchBlocked} blocked${dispatchBlockedText}.`
    : '';
  const safeModuleLaunchOpen = dispatchOpen
    && dispatchClaimReady > 0
    && openConflicts === 0
    && criticalConflicts === 0
    && graphPackets === 0
    && projectGraphGaps === 0
    && moduleGraphGaps === 0
    && staleAgentProcesses === 0
    && agentProcessScanErrorProjects === 0
    && number(moduleDispatch?.open_conflicts) === 0;
  const releaseBlockerText = blockers.length ? blockers.join('; ') : `${status} at ${readinessScorePercent}%`;
  const readyText = cleanScope
    ? `${projectScope || 'Selected scope'} is clean for cleanup agents: ${conflictText}, ${graphText}, ${activeLeases} active lease(s), ${processText}.${moduleText}${dispatchText}`
    : safeModuleLaunchOpen
    ? `Module-launch-ready, release blocked: ${dispatchClaimReady}/${moduleDispatch.unclaimed} dispatch slot(s) claim-ready while cleanup/release blockers remain: ${releaseBlockerText}.${moduleText}${dispatchText}`
    : status === 'ready'
    ? `Ready for ${launchSlots || recommendedAgents}/${requestedAgents} local cleanup agents: ${claimablePaths}/${targetedPaths} paths claimable (${claimablePercent}%), ${conflictText}, ${graphText}, ${processText}.${moduleText}${dispatchText}`
    : `Not cleanup-launch-ready: ${releaseBlockerText}.${moduleText}${dispatchText}`;
  const currentSlice = cleanScope
    ? dispatchOpen
      ? `Current slice: continue existing module dispatch ${dispatchId}; claim ${dispatchClaimReady} safe open slot(s), skip ${dispatchBlocked} blocked slot(s)${dispatchBlockedText}, then observe/write progress.`
      : `Current slice: cleanup pressure is clear for this scope; assign only real module work, with module graphs and leases.${moduleText}`
    : status === 'ready'
    ? `Current slice: launch up to ${launchSlots || recommendedAgents}/${requestedAgents} cleanup agents, keep conflict SLA and graph packets at zero, monitor cleanup progress, and reserve module dispatch for non-overlapping product work.`
    : staleAgentProcesses > 0
      ? `Current slice: inspect, terminate, or reattach stale project-rooted agent processes before assigning more ${projectScope || 'project'} agents.`
    : (staleContextProjects > 0 || staleContextPaths > 0) && dispatchOpen && dispatchClaimReady > 0
      ? `Current slice: stale Gen3 context blocks cleanup/release, but existing dispatch ${dispatchId} still has ${dispatchClaimReady} safe claim-ready module slot(s); launch only those dispatch-pinned modules and leave stale/dirty scope alone.`
    : staleContextProjects > 0 || staleContextPaths > 0
      ? `Current slice: renew or hand off stale Gen3 context for ${staleContextPaths} dirty path(s) before cleanup or module reassignment.`
    : moduleWork?.available && moduleWork.launch_ready_slots > 0
      ? `Current slice: cleanup integration is blocked, but ${moduleWork.launch_ready_slots} module-work slot(s) can proceed if they stay out of dirty/shared paths and use module dispatch.`
      : 'Current slice: clear the launch blocker before assigning more agents.';
  const nextSlices = cleanScope
    ? dispatchOpen
      ? [
          `Continue dispatch ${dispatchId}: claim ${dispatchClaimReady} safe open slot(s), leave ${dispatchBlocked} blocked slot(s)${dispatchBlockedText} alone, then observe/write progress.`,
          'Only write a new module dispatch after the current dispatch is complete or intentionally abandoned by the controller.',
          'Each claimed agent must query its module graph first, keep shared hot paths serialized, and report receipts through Gen3 context.',
        ]
      : [
          `Respawn ${projectScope || 'the selected project'} module agents only for explicit product/module tasks, not cleanup.`,
          'Each agent should claim its module lease, query the module graph first, and keep shared hot paths serialized.',
          'Rerun project-scoped preflight before each new wave so unrelated portfolio work does not distort Acme Desktop readiness.',
        ]
    : status === 'ready'
    ? [
        'Launch the preflight launch-plan cleanup wave and monitor cleanup:progress for cleared, held, and stale packets.',
        'Keep conflict SLA and graph packets at zero while agents work; any collision must be documented before reassignment.',
        'After dirty pressure drops, raise project/module-local concurrency toward 15-25 while shared hot paths stay serialized.',
      ]
    : staleAgentProcesses > 0
      ? [
          'Inspect the stale process action item and verify whether the owner is still active.',
          'Terminate stale unowned processes or reattach them with a lease before respawning module agents.',
          'Rerun project-scoped preflight; only launch module dispatch after stale process count returns to zero.',
        ]
    : (staleContextProjects > 0 || staleContextPaths > 0) && dispatchOpen && dispatchClaimReady > 0
      ? [
          `Claim ${dispatchClaimReady} safe dispatch-pinned module slot(s) now; leave ${dispatchBlocked} blocked slot(s)${dispatchBlockedText} and all stale dirty scope untouched.`,
          'Renew or hand off the stale Gen3 context before cleanup, integration, merge, release, or shared hot-path work.',
          'Observe/write module dispatch receipts before assigning the next module wave so predicted capacity becomes durable proof.',
        ]
    : staleContextProjects > 0 || staleContextPaths > 0
      ? [
          'Renew the stale Gen3 context lease or record a handoff/conflict before any cleanup agent claims the dirty scope.',
          'Rerun project-scoped preflight after renewal; cleanup should remain blocked until ownership is explicit.',
          'Once stale context is reconciled, resume cleanup or module dispatch based on the updated active lane.',
        ]
    : moduleWork?.available && moduleWork.launch_ready_slots > 0
      ? [
          `Use module dispatch for up to ${moduleWork.launch_ready_slots} non-overlapping module agents; do not launch cleanup agents until dirty cleanup blockers clear.`,
          'Resolve or reconcile dirty cleanup blockers before integration, merge, release, or shared hot-path work.',
          'Observe module dispatch receipts before assigning the next module wave so predicted capacity becomes durable proof.',
        ]
      : [
          'Resolve the listed blocker first, usually by refreshing packets, ending the active lease, or claiming the uncovered dirty scope.',
          'Rerun parallel:preflight after the blocker clears; do not launch agents from stale or blocked packet state.',
          'Once preflight returns ready, launch the auto-sized wave and monitor cleanup:progress.',
        ];

  return {
    tldr: readyText,
    current_slice: currentSlice,
    current_state: {
      status,
      readiness_score_percent: readinessScorePercent,
      recommended_agents: recommendedAgents,
      launch_slots: launchSlots,
      claimable_percent: claimablePercent,
      dirty_unleased_projects: dirtyUnleasedProjects,
      stale_context_projects: staleContextProjects,
      stale_context_dirty_paths: staleContextPaths,
      active_leases: activeLeases,
      open_conflicts: openConflicts,
      graph_packets: graphPackets,
      stale_agent_processes: staleAgentProcesses,
      stale_agent_process_projects: staleAgentProcessProjects,
      agent_process_scan_error_projects: agentProcessScanErrorProjects,
      top_wave_gain_percent: topWaveGainPercent,
      top_project_gain_percent: topProjectGainPercent,
      overflow_groups: overflowGroups,
      module_work_slots: moduleWork?.launch_ready_slots ?? 0,
      module_work_graphs_ready: moduleWork?.graph_ready_modules ?? 0,
      module_work_graphs_total: moduleWork?.modules_total ?? 0,
      module_dispatch_status: moduleDispatch?.status || 'not-requested',
      module_dispatch_claimed: moduleDispatch?.claimed ?? 0,
      module_dispatch_active: moduleDispatch?.active ?? 0,
      module_dispatch_completed: moduleDispatch?.completed ?? 0,
      module_dispatch_unclaimed: moduleDispatch?.unclaimed ?? 0,
      module_dispatch_claimable_unclaimed: moduleDispatch?.claimable_unclaimed ?? 0,
      module_dispatch_launch_blocked_unclaimed: moduleDispatch?.launch_blocked_unclaimed ?? 0,
      module_dispatch_held_blocked_unclaimed: moduleDispatch?.held_blocked_unclaimed ?? 0,
      module_dispatch_dirty_scope_blocked_unclaimed: moduleDispatch?.dirty_scope_blocked_unclaimed ?? 0,
      module_dispatch_other_blocked_unclaimed: moduleDispatch?.other_blocked_unclaimed ?? 0,
      module_dispatch_open_conflicts: moduleDispatch?.open_conflicts ?? 0,
    },
    eta: {
      strong_daily_standard: '2-3 focused SMA slices',
      absolute_max_hardening: '1-2 days of real parallel-wave hardening',
    },
    next_slices: nextSlices,
    horizon: [
      'Now: 12 local cleanup agents is the safe practical wave for the current portfolio state.',
      'Next ceiling: 15-25 agents after more work is module-local and hot shared files are reduced.',
      '30+ agents requires hot shared files, review, and product-decision bottlenecks to be structurally reduced.',
    ],
    watchouts: [
      `${activeDirtyScopeProjects} active dirty-scope project(s), ${activeDirtyScopePaths} uncovered path(s).`,
      `${staleContextProjects} stale Gen3 context project(s), ${staleContextPaths} dirty path(s).`,
      `${staleAgentProcesses} stale project-rooted agent process(es).`,
      `${overflowGroups} cleanup groups remain outside the current launch wave.`,
    ],
  };
}

function cleanupPenalty(status) {
  if (status === 'ready') return 0;
  if (status === 'partial') return 12;
  if (status === 'partial-stale') return 24;
  if (status === 'stale' || status === 'blocked') return 35;
  if (status === 'empty') return 0;
  return 15;
}

function resolveLimitPlan(controllerSummary) {
  const maxAgents = positiveInt(args.maxAgents, 12);
  const rawLimit = args.limit === true ? undefined : args.limit;
  const autoRequested = Boolean(args.autoLimit)
    || rawLimit === undefined
    || String(rawLimit).toLowerCase() === 'auto';
  if (!autoRequested) {
    return {
      mode: 'fixed',
      maxAgents,
      limit: positiveInt(rawLimit, 3),
    };
  }
  const controllerRecommended = number(controllerSummary.parallel_wave_agents);
  const dirtyProjects = number(controllerSummary.dirty_unleased_projects);
  const candidate = controllerRecommended || dirtyProjects || maxAgents;
  return {
    mode: 'auto',
    maxAgents,
    limit: clamp(Math.max(1, candidate), 1, maxAgents),
  };
}

function primaryNext({
  status,
  openConflicts,
  criticalConflicts,
  graphPackets,
  projectGraphGaps,
  moduleGraphGaps,
  cleanupStatus,
  activeDirtyScopeProjects,
  activeDirtyScopePaths,
  staleContextProjects,
  staleContextPaths,
  staleAgentProcesses,
  agentProcessScanErrorProjects,
  cleanupNext,
  projectScope,
  moduleWork,
  moduleDispatch,
  controllerBlockerPackets = [],
  dirtyUnleasedProjects,
}) {
  const hasOpenModuleDispatch = moduleDispatch?.available && moduleDispatch.status !== 'complete';
  const moduleProgressNext = moduleProgressCommand({ projectScope, moduleWork, moduleDispatch });
  const firstControllerBlocker = Array.isArray(controllerBlockerPackets)
    ? controllerBlockerPackets.find((packet) => packet?.command)
    : null;
  const firstStaleContextBlocker = Array.isArray(controllerBlockerPackets)
    ? controllerBlockerPackets.find((packet) => packet?.kind === 'stale-context' && packet?.command)
    : null;
  if (status !== 'blocked') {
    if (cleanupStatus === 'empty') {
      if (hasOpenModuleDispatch) {
        return moduleProgressNext || scopedCommand('npm run module:observe:write -- --dispatch latest', projectScope);
      }
      if (moduleWork?.available && moduleWork.launch_ready_slots > 0) {
        return moduleWork.dispatch_command || moduleWork.plan_command || scopedCommand('npm run module:plan', projectScope);
      }
      return scopedCommand('npm run controller:snapshot:quiet', projectScope);
    }
    return cleanupNext || scopedCommand('npm run cleanup:claim -- --next', projectScope);
  }
  if (moduleDispatch?.open_conflicts > 0) return scopedCommand('npm run conflict:summary', projectScope);
  if (openConflicts > 0 || criticalConflicts > 0) return 'npm run conflict:summary';
  if (staleAgentProcesses > 0 || agentProcessScanErrorProjects > 0) return scopedCommand('npm run controller:snapshot:quiet', projectScope);
  if (graphPackets > 0 || projectGraphGaps > 0 || moduleGraphGaps > 0) return 'npm run graph:claim -- --next';
  if (
    dirtyUnleasedProjects === 0
    && (staleContextProjects > 0 || staleContextPaths > 0)
    && moduleProgressNext
  ) {
    return moduleProgressNext;
  }
  if ((staleContextProjects > 0 || staleContextPaths > 0) && firstStaleContextBlocker) return firstStaleContextBlocker.command;
  if (
    dirtyUnleasedProjects === 0
    && (activeDirtyScopeProjects > 0 || activeDirtyScopePaths > 0)
    && moduleProgressNext
  ) {
    return moduleProgressNext;
  }
  if (
    dirtyUnleasedProjects === 0
    && activeDirtyScopeProjects === 0
    && activeDirtyScopePaths === 0
    && (cleanupStatus === 'stale' || cleanupStatus === 'blocked')
    && moduleProgressNext
  ) {
    return moduleProgressNext;
  }
  if (cleanupStatus === 'stale') return cleanupNext || 'npm run controller:sweep:write';
  if (cleanupStatus === 'blocked') return cleanupNext || 'npm run cleanup:progress -- --limit 12';
  if ((dirtyUnleasedProjects > 0 || activeDirtyScopeProjects > 0 || activeDirtyScopePaths > 0) && firstControllerBlocker) {
    return firstControllerBlocker.command;
  }
  if ((dirtyUnleasedProjects > 0 || activeDirtyScopeProjects > 0 || activeDirtyScopePaths > 0) && moduleWork?.available && moduleWork.launch_ready_slots > 0) {
    if (hasOpenModuleDispatch) return moduleProgressNext || moduleDispatch.observe_command || moduleWork.observe_command;
    return moduleWork.dispatch_command || moduleWork.plan_command || 'npm run module:plan';
  }
  if (activeDirtyScopeProjects > 0 || activeDirtyScopePaths > 0) return 'npm run controller:sweep';
  return cleanupNext || 'npm run controller:sweep';
}

function moduleProgressCommand({ projectScope, moduleWork, moduleDispatch }) {
  const hasOpenModuleDispatch = moduleDispatch?.available && moduleDispatch.status !== 'complete';
  if (moduleDispatch?.dispatch_stale_unclaimed) {
    return moduleWork?.dispatch_command || moduleDispatch.next_command || moduleWork?.plan_command || scopedCommand('npm run module:plan', projectScope);
  }
  const dispatchClaimableAgents = hasOpenModuleDispatch
    ? number(moduleDispatch.claimable_unclaimed ?? moduleDispatch.unclaimed)
    : 0;
  if (hasOpenModuleDispatch) {
    if (dispatchClaimableAgents > 0 && moduleDispatch.next_command) return moduleDispatch.next_command;
    return moduleDispatch.observe_write_command
      || moduleDispatch.observe_command
      || scopedCommand('npm run module:observe:write -- --dispatch latest', projectScope);
  }
  if (moduleWork?.available && moduleWork.launch_ready_slots > 0) {
    return moduleWork.dispatch_command || moduleWork.plan_command || scopedCommand('npm run module:plan', projectScope);
  }
  return '';
}

function runJsonTool(label, toolArgs) {
  try {
    const raw = execFileSync(process.execPath, toolArgs, {
      cwd: SMA_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: positiveInt(args.timeoutMs, 180000),
      maxBuffer: 96 * 1024 * 1024,
    });
    return { label, data: JSON.parse(raw) };
  } catch (err) {
    return {
      label,
      data: null,
      error: err.stderr?.toString()?.trim() || err.message,
    };
  }
}

function printText(result) {
  const printFullPrompts = Boolean(args.fullPrompts || args.verboseLaunchPlan);
  console.log('SMA Gen3 Parallel Preflight');
  if (result.scope?.project) console.log(`scope:            project ${result.scope.project}`);
  console.log(`big picture:      ${result.big_picture.tldr}`);
  console.log(`current slice:    ${result.big_picture.current_slice}`);
  console.log(`score:            launch ${result.active_lane_capacity_percent}%, integration ${result.readiness_score_percent}%`);
  console.log(`status:           ${result.status}${formatStatusSuffix(result)}`);
  console.log(`agents:           ${result.active_recommended_agents}/${result.requested_agents} active-lane recommended (${result.active_lane || 'cleanup'}); cleanup ${result.recommended_agents}/${result.requested_agents} (${result.limit_mode}, max ${result.max_agents})`);
  if (result.command_guidance?.active_lane) {
    console.log(`active lane:      ${result.command_guidance.active_lane} (${result.command_guidance.cleanup_reason}; ${result.command_guidance.module_observe_reason})`);
  }
  if (result.lane_statuses) {
    console.log(`lane status:      ${result.lane_statuses.active_lane} ${result.lane_statuses.active_status}; stale ${result.lane_statuses.stale_context.status} (${result.lane_statuses.stale_context.ready_agents} ready); module ${result.lane_statuses.module.status} (${result.lane_statuses.module.ready_agents} ready); integration ${result.lane_statuses.integration.status} (${result.lane_statuses.integration.active_dirty_scope_paths} dirty-scope paths)`);
  }
  if (result.launch_decision) {
    console.log(`launch decision:  ${result.launch_decision.allowed ? 'allowed' : 'blocked'} ${result.launch_decision.lane} (${result.launch_decision.agents} agent${result.launch_decision.agents === 1 ? '' : 's'}); release ${result.launch_decision.release_allowed ? 'allowed' : 'blocked'}`);
  }
  console.log(`cleanup:          ${result.cleanup_wave.claimable_assignment_count}/${result.cleanup_wave.assignment_count} assignments claimable, ${result.cleanup_wave.claimable_percent}% paths claimable`);
  if (result.cleanup_wave.source && result.cleanup_wave.source !== 'cleanup-packets') {
    console.log(`cleanup source:   ${result.cleanup_wave.source}`);
  }
  if (result.module_work?.available) {
    console.log(`module work:      ${result.module_work.launch_ready_slots}/${result.module_work.requested_agents} slots safe, ${result.module_work.graph_ready_modules}/${result.module_work.modules_total} graphs ready, held ${result.module_work.held_slots}, overlap ${result.module_work.path_overlap_blocked_slots}`);
  }
  if (result.module_dispatch?.available) {
    console.log(`module dispatch:  ${result.module_dispatch.status} ${result.module_dispatch.claimed}/${result.module_dispatch.assignment_count} claimed, ${result.module_dispatch.active} active, ${result.module_dispatch.completed} done, ${result.module_dispatch.claimable_unclaimed}/${result.module_dispatch.unclaimed} open claim-ready, ${result.module_dispatch.launch_blocked_unclaimed} blocked${formatDispatchBlocked(result.module_dispatch)}`);
    if (result.module_dispatch.external_active_slot_count) {
      console.log(`module external:  ${result.module_dispatch.external_active_slot_count} slot${result.module_dispatch.external_active_slot_count === 1 ? '' : 's'} occupied by ${result.module_dispatch.external_active_lease_count} non-dispatch lease${result.module_dispatch.external_active_lease_count === 1 ? '' : 's'} across ${result.module_dispatch.external_active_module_count} module${result.module_dispatch.external_active_module_count === 1 ? '' : 's'}`);
    }
    if (result.module_dispatch.next_command && result.active_lane?.startsWith('module')) {
      console.log(`module next:      ${result.module_dispatch.next_command}`);
    } else if (result.module_dispatch.next_command) {
      console.log(`module queued:    ${result.module_dispatch.next_command}`);
    }
  }
  if (result.module_work?.dispatch_manifest) {
    console.log(`module dispatch written: ${result.module_work.dispatch_manifest.json_path}`);
    console.log(`first claim:      ${result.module_work.first_dispatch_claim_command}`);
    console.log(`observe:          ${result.module_work.observe_command}`);
  }
  console.log(`cleanup launch:   ${result.launch_plan.length} cleanup spawn-ready slots${result.launch_plan.length ? ' (rerun with --launch-plan for commands)' : ''}`);
  if (result.controller?.stale_context_projects || result.stale_context_launch_plan?.length) {
    console.log(`stale renew:      ${(result.stale_context_launch_plan || []).length}/${result.controller_blocker_packets.filter((packet) => packet.kind === 'stale-context').length} stale-context packets launch-ready${(result.stale_context_launch_plan || []).length ? ' (rerun with --launch-plan for commands)' : ''}`);
  }
  if (result.module_dispatch?.available) {
    console.log(`module launch:    ${(result.module_launch_plan || []).length}/${result.module_dispatch.claimable_unclaimed} dispatch slots claim-ready, ${result.module_dispatch.launch_blocked_unclaimed} blocked${formatDispatchBlocked(result.module_dispatch)}${(result.module_launch_plan || []).length ? ' (rerun with --launch-plan for commands)' : ''}`);
  }
  if (result.queued_module_launch_plan?.length) {
    console.log(`queued module:    ${result.queued_module_launch_plan.length}/${result.module_dispatch.claimable_unclaimed} dispatch slots ready after ${result.active_lane} clears`);
  }
  console.log(`gains:            top wave ${formatPercent(result.gains.selected_wave_top_gain_percent)}, top project ${formatPercent(result.gains.selected_project_top_gain_percent)}, ${result.gains.coordination_roundtrip_reduction_percent_estimate}% fewer controller command round trips`);
  if (result.module_work?.available) {
    console.log(`module gains:     ${result.module_work.gains.module_graph_first_token_reduction_percent_estimate}% graph-first token reduction, ${result.module_work.gains.collision_reduction_percent_estimate}% collision reduction estimate`);
  }
  console.log(`dirty targets:    ${result.gains.claimable_dirty_paths}/${result.gains.targeted_dirty_paths} claimable paths, ${result.gains.overflow_groups} overflow groups`);
  console.log(`conflicts:        ${result.conflict_sla.open_conflicts} open, ${result.conflict_sla.warning_conflicts}/${result.conflict_sla.critical_conflicts} warning/critical, ${result.conflict_sla.projects_scanned} projects scanned`);
  console.log(`graphs:           ${result.graph_packets.packet_count} packets, ${result.graph_packets.project_graph_gaps} project gaps, ${result.graph_packets.module_graph_gap_count} module gaps`);
  console.log(`processes:        ${result.controller.stale_agent_processes} stale agent process${result.controller.stale_agent_processes === 1 ? '' : 'es'} across ${result.controller.stale_agent_process_projects} project${result.controller.stale_agent_process_projects === 1 ? '' : 's'}, ${result.controller.agent_process_scan_error_projects} scan error project${result.controller.agent_process_scan_error_projects === 1 ? '' : 's'}`);
  console.log(`controller:       ${result.controller.active_leases} active leases, ${result.controller.dirty_unleased_projects} dirty-unleased projects, ${result.controller.stale_context_projects} stale-context projects, ${result.controller.active_dirty_scope_projects} dirty-scope blockers`);
  if (result.controller_blocker_packets?.length) {
    const first = result.controller_blocker_packets[0];
    console.log(`blocker packets:  ${result.controller_blocker_packets.length} actionable; first ${first.kind} ${first.project}${first.brick ? `/${first.brick}` : ''}`);
    if (first.command) console.log(`blocker command:  ${first.command}`);
    if (first.conflict_command) console.log(`blocker conflict: ${first.conflict_command}`);
  }
  for (const [index, item] of (result.big_picture.next_slices || []).slice(0, 3).entries()) {
    console.log(`outlook ${index + 1}:        ${item}`);
  }
  if (result.big_picture.horizon?.length) {
    console.log(`horizon:          ${result.big_picture.horizon.slice(0, 3).join(' | ')}`);
  }
  console.log(`eta:              ${result.big_picture.eta.strong_daily_standard} for strong daily standard; ${result.big_picture.eta.absolute_max_hardening} for absolute-max hardening`);
  if (result.blockers.length) {
    console.log(`blockers:         ${result.blockers.join('; ')}`);
  }
  if (result.warnings.length) {
    console.log(`warnings:         ${result.warnings.join('; ')}`);
  }
  if (args.launchPlan && result.launch_plan.length) {
    console.log('');
    console.log('Spawn-ready cleanup launch plan:');
    for (const item of result.launch_plan) {
      console.log(`${item.agent_slot}. ${item.project} ${item.group} (${item.dirty_path_count} paths, wave ${formatPercent(item.wave_gain_percent)}, project ${formatPercent(item.project_gain_percent)})`);
      console.log(`   claim: ${item.claim_command}`);
      if (item.conflict_command) console.log(`   conflict: ${item.conflict_command}`);
      if (printFullPrompts && item.prompt) console.log(`   prompt: ${item.prompt}`);
    }
  }
  if (args.launchPlan && result.stale_context_launch_plan?.length) {
    console.log('');
    console.log('Spawn-ready stale-context renewal plan:');
    for (const item of result.stale_context_launch_plan) {
      console.log(`${item.agent_slot}. ${item.project} ${item.brick} (${item.dirty_path_count} dirty paths, ${item.receipt_count} receipt${item.receipt_count === 1 ? '' : 's'})`);
      console.log(`   renew: ${item.command}`);
      if (item.inspect_command) console.log(`   inspect: ${item.inspect_command}`);
      if (item.conflict_command) console.log(`   conflict: ${item.conflict_command}`);
      if (printFullPrompts && item.prompt) console.log(`   prompt: ${item.prompt}`);
    }
  }
  if (args.launchPlan && result.module_launch_plan?.length) {
    console.log('');
    console.log('Spawn-ready module dispatch plan:');
    for (const item of result.module_launch_plan) {
      console.log(`${item.agent_slot}. ${item.project} ${item.module_id} slot ${item.slot} (${item.brick}, dispatch ${item.dispatch_id})`);
      if (item.agent_packet_markdown_path) console.log(`   agent packet: ${item.agent_packet_markdown_path}`);
      console.log(`   claim: ${item.claim_command}`);
      if (item.graph_query_command) console.log(`   graph query: ${item.graph_query_command}`);
      if (item.graph_path) console.log(`   graph: ${item.graph_path}`);
      if (item.paths?.length) console.log(`   paths: ${item.paths.join(', ')}`);
      if (item.exclude_paths?.length) console.log(`   exclude: ${item.exclude_paths.join(', ')}`);
      if (item.required_gates?.length) console.log(`   gates: ${item.required_gates.join(' && ')}`);
      if (item.shared_hot_paths?.length) console.log(`   shared hot: ${item.shared_hot_paths.join(', ')}`);
      if (item.conflict_command) console.log(`   conflict: ${item.conflict_command}`);
      if (printFullPrompts && item.prompt) console.log(`   prompt: ${item.prompt}`);
    }
  }
  console.log(`next:             ${result.primary_next_command}`);
}

function parseArgs(list) {
  const out = {};
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

function positiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function capacityPercent(activeAgents, requestedAgents) {
  const requested = number(requestedAgents);
  if (requested <= 0) return 0;
  return clamp(Math.round((number(activeAgents) / requested) * 100), 0, 100);
}

function shellArg(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function formatStatusSuffix(result) {
  const decision = result?.launch_decision || {};
  if (decision.allowed && decision.release_allowed) return ` (${decision.lane} ready; release allowed)`;
  if (decision.allowed) return ` (${decision.lane} ready; release blocked)`;
  if (result?.lane_statuses?.active_status === 'ready' && number(result?.active_recommended_agents) > 0) {
    return ` (${result.active_lane} ready; launch blocked)`;
  }
  return '';
}

function formatPercent(value) {
  if (value === null || value === undefined || value === '') return 'n/a';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 'n/a';
  return `${parsed}%`;
}

function formatDispatchBlocked(moduleDispatch) {
  const parts = [];
  const held = number(moduleDispatch?.held_blocked_unclaimed);
  const dirtyScope = number(moduleDispatch?.dirty_scope_blocked_unclaimed);
  const other = number(moduleDispatch?.other_blocked_unclaimed);
  if (held) parts.push(blockedCountLabel(held, 'active lease'));
  if (dirtyScope) parts.push(`${dirtyScope} dirty scope`);
  if (other) parts.push(blockedCountLabel(other, 'other guard'));
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function blockedCountLabel(count, singular) {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}
