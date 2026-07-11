/**
 * WHAT: Runs fixed scenarios against the parallel-preflight decision engine.
 * WHY: A misleading launch recommendation can assign agents into blockers, stale work, or conflicting scopes.
 * HOW: Accepts the command's private decision helpers and asserts clean, blocked, stale, and fallback outcomes.
 * INPUTS: A harness object supplied by the parallel-preflight command.
 * OUTPUTS: A success message and zero result, or an assertion failure naming the broken decision.
 * CALLERS: The parallel-preflight command invokes this harness through its selftest mode.
 * @example node tools/sma-parallel-preflight.mjs selftest
 */
/** Selftest harness for sma-parallel-preflight.mjs. */

type SelftestHarness = Record<string, any>;

export function runParallelPreflightSelftest(harness: SelftestHarness): void {
  const {
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
  } = harness;
  const moduleDispatch = {
    available: true,
    status: 'dispatch-only',
    project: 'demo',
    dispatch_id: 'module-wave-demo',
    unclaimed: 12,
    claimable_unclaimed: 11,
    launch_blocked_unclaimed: 1,
    held_blocked_unclaimed: 1,
    dirty_scope_blocked_unclaimed: 0,
    other_blocked_unclaimed: 0,
    next_command: "npm run module:claim -- --project 'demo' --next --dispatch 'module-wave-demo'",
    assignments: Array.from({ length: 12 }, (_, index) => ({
      agent_slot: index + 1,
      project: 'demo',
      module_id: `module-${index + 1}`,
      dispatch_id: 'module-wave-demo',
      slot: 1,
      brick: `module-work-${index + 1}`,
      status: index === 3 ? 'launch-blocked' : 'unclaimed',
      claimed: false,
      active: false,
      completed: false,
      graph_ready: true,
      launch_blocked: index === 3,
      launch_blocked_reason: index === 3 ? 'held' : null,
      graph_path: `/tmp/module-${index + 1}/graph.json`,
      graph_query_command: `npm run graphify:query -- --project 'demo' --module 'module-${index + 1}' -- 'Map module.'`,
      paths: [`src/module-${index + 1}/**`],
      exclude_paths: [],
      iteration_gates: [`pnpm typecheck:module-${index + 1}:affected`],
      required_gates: [`pnpm typecheck:module-${index + 1}`, 'pnpm sma:claims:strict:json'],
      shared_hot_paths: [],
      claim_command: `npm run module:claim -- --project 'demo' --module 'module-${index + 1}' --dispatch-id 'module-wave-demo' --dispatch-slot '${index + 1}'`,
      agent_packet: {
        markdown_path: `handoffs/module-waves/module-wave-demo.agent-packets/${String(index + 1).padStart(2, '0')}-module-${index + 1}.md`,
        json_path: `handoffs/module-waves/module-wave-demo.agent-packets/${String(index + 1).padStart(2, '0')}-module-${index + 1}.json`,
        first_read: true,
      },
      prompt: `Use $sma-gen3. Query graph first, stay inside src/module-${index + 1}/**, and run pnpm typecheck:module-${index + 1}.`,
      open_conflicts: 0,
    })),
  };
  const moduleWork = {
    available: true,
    task: 'demo task',
    launch_ready_slots: 12,
    requested_agents: 12,
    graph_ready_modules: 12,
    modules_total: 12,
    dispatch_command: "npm run module:dispatch -- --project 'demo' --task 'demo task' --max-agents 12",
    plan_command: "npm run module:plan -- --project 'demo' --max-agents 12",
  };
  assertSelftest(formatDispatchBlocked(moduleDispatch) === ' (1 active lease)', 'module dispatch blocked formatter should split active-lease blockers');
  const moduleGuidance = summarizeCommandGuidance({
    projectScope: 'demo',
    cleanupStatus: 'empty',
    moduleWork,
    moduleDispatch,
  });
  assertSelftest(moduleGuidance.active_lane === 'module-observe', 'open dispatch should select module-observe active lane');
  assertSelftest(moduleGuidance.launchable_agents === 11, 'open dispatch should expose only claim-ready module agents');
  const moduleLaunchPlan = buildModuleLaunchPlan(moduleDispatch, moduleGuidance.launchable_agents);
  assertSelftest(moduleLaunchPlan.length === 11, 'module launch plan should exclude launch-blocked dispatch slots');
  assertSelftest(!moduleLaunchPlan.some((item) => item.module_id === 'module-4'), 'module launch plan should skip held/stale module slots');
  assertSelftest(moduleLaunchPlan[0].claim_command.includes('module:claim'), 'module launch plan should carry dispatch-pinned claim command');
  assertSelftest(moduleLaunchPlan[0].agent_packet_markdown_path.endsWith('01-module-1.md'), 'module launch plan should carry first-read packet path');
  assertSelftest(moduleLaunchPlan[0].graph_query_command.includes('graphify:query'), 'module launch plan should carry module graph query command');
  assertSelftest(moduleLaunchPlan[0].conflict_command.includes('conflict -- report'), 'module launch plan should carry standalone conflict command');
  assertSelftest(moduleLaunchPlan[0].paths.includes('src/module-1/**'), 'module launch plan should carry module paths');
  assertSelftest(moduleLaunchPlan[0].required_gates.includes('pnpm typecheck:module-1'), 'module launch plan should carry required gates');
  assertSelftest(moduleLaunchPlan[0].prompt.includes('stay inside src/module-1/**'), 'module launch plan should carry rich dispatch prompt');
  const staleModuleDispatch = {
    ...moduleDispatch,
    status: 'blocked',
    claimable_unclaimed: 0,
    launch_blocked_unclaimed: 12,
    other_blocked_unclaimed: 12,
    dispatch_stale_unclaimed: true,
    assignments: moduleDispatch.assignments.map((assignment) => ({
      ...assignment,
      status: 'launch-blocked',
      launch_blocked: true,
      launch_blocked_reason: 'dispatch-stale',
    })),
    next_command: moduleWork.dispatch_command,
  };
  const staleDispatchGuidance = summarizeCommandGuidance({
    projectScope: 'demo',
    cleanupStatus: 'empty',
    moduleWork,
    moduleDispatch: staleModuleDispatch,
  });
  assertSelftest(staleDispatchGuidance.active_lane === 'module-dispatch', 'stale unclaimed dispatch should route to fresh module dispatch');
  assertSelftest(staleDispatchGuidance.module_dispatch_required, 'stale unclaimed dispatch should require a fresh dispatch manifest');
  assertSelftest(
    moduleProgressCommand({ projectScope: 'demo', moduleWork, moduleDispatch: staleModuleDispatch }) === moduleWork.dispatch_command,
    'stale unclaimed dispatch progress command should write a fresh dispatch',
  );
  assertSelftest(buildModuleLaunchPlan(staleModuleDispatch, 12).length === 0, 'stale unclaimed dispatch should not expose launch slots');
  const staleCleanupGuidance = summarizeCommandGuidance({
    projectScope: 'demo',
    cleanupStatus: 'stale',
    cleanupLaunchableAgents: 0,
    moduleWork,
    moduleDispatch,
  });
  assertSelftest(staleCleanupGuidance.active_lane === 'module-observe', 'stale cleanup with no launchable cleanup agents should route to safe module dispatch');
  assertSelftest(staleCleanupGuidance.launchable_agents === 11, 'stale cleanup module lane should expose claim-ready module agents');
  const staleCleanupLaneStatuses = buildLaneStatuses({
    status: 'blocked',
    cleanupStatus: 'stale',
    commandGuidance: staleCleanupGuidance,
    moduleWork,
    moduleDispatch,
    activeDirtyScopeProjects: 0,
    activeDirtyScopePaths: 0,
    staleContextProjects: 0,
    staleContextPaths: 0,
    staleContextLaunchableAgents: 0,
    dirtyUnleasedProjects: 0,
  });
  const staleCleanupLaunchDecision = buildLaunchDecision({
    status: 'blocked',
    laneStatuses: staleCleanupLaneStatuses,
    commandGuidance: staleCleanupGuidance,
    recommendedAgents: 0,
    primaryNextCommand: moduleDispatch.next_command,
  });
  const staleCleanupPrimaryNext = primaryNext({
    status: 'blocked',
    openConflicts: 0,
    criticalConflicts: 0,
    graphPackets: 0,
    projectGraphGaps: 0,
    moduleGraphGaps: 0,
    cleanupStatus: 'stale',
    activeDirtyScopeProjects: 0,
    activeDirtyScopePaths: 0,
    staleContextProjects: 0,
    staleContextPaths: 0,
    staleAgentProcesses: 0,
    agentProcessScanErrorProjects: 0,
    cleanupNext: 'npm run controller:sweep:write',
    projectScope: 'demo',
    moduleWork,
    moduleDispatch,
    controllerBlockerPackets: [],
    dirtyUnleasedProjects: 0,
  });
  assertSelftest(staleCleanupLaneStatuses.active_status === 'ready', 'stale cleanup module lane should be ready when dispatch slots are claimable');
  assertSelftest(staleCleanupLaunchDecision.allowed, 'safe module dispatch should launch while cleanup remains stale');
  assertSelftest(!staleCleanupLaunchDecision.release_allowed, 'safe module dispatch should not allow release while cleanup remains stale');
  assertSelftest(staleCleanupPrimaryNext === moduleDispatch.next_command, 'stale cleanup module lane should route primary next to module claim command');

  const observed = [{
    dispatch_id: 'module-wave-demo',
    agent_slot: 1,
    brick: 'module-work-1',
    status: 'active',
    active: true,
    claim_command: moduleDispatch.assignments[0].claim_command,
  }];
  const merged = mergeDispatchAssignments(observed, moduleDispatch.assignments);
  assertSelftest(merged[0].active === true, 'observed active status should stay authoritative');
  assertSelftest(merged[0].paths.includes('src/module-1/**'), 'manifest paths should merge into observed assignment');

  const cleanupGuidance = summarizeCommandGuidance({
    projectScope: 'demo',
    cleanupStatus: 'ready',
    cleanupLaunchableAgents: 3,
    moduleWork,
    moduleDispatch,
  });
  assertSelftest(cleanupGuidance.active_lane === 'cleanup', 'cleanup pressure should keep cleanup active lane');
  assertSelftest(buildModuleLaunchPlan(moduleDispatch, cleanupGuidance.launchable_agents).length === 0, 'cleanup lane should suppress module launch slots');
  const cleanupLaneStatuses = buildLaneStatuses({
    status: 'ready',
    cleanupStatus: 'ready',
    commandGuidance: cleanupGuidance,
    moduleWork,
    moduleDispatch,
    activeDirtyScopeProjects: 0,
    activeDirtyScopePaths: 0,
    dirtyUnleasedProjects: 1,
  });
  assertSelftest(
    cleanupLaneStatuses.integration.status === 'blocked' && cleanupLaneStatuses.integration.cleanup_required,
    'integration lane should stay blocked while dirty cleanup remains launch-ready',
  );
  const dirtyScopeModuleGuidance = summarizeCommandGuidance({
    projectScope: 'demo',
    cleanupStatus: 'blocked',
    moduleWork,
    moduleDispatch,
    activeDirtyScopeProjects: 1,
    activeDirtyScopePaths: 4,
  });
  assertSelftest(
    dirtyScopeModuleGuidance.active_lane === 'module-observe',
    'active dirty-scope with claim-ready module dispatch should keep module-observe active',
  );
  assertSelftest(
    dirtyScopeModuleGuidance.launchable_agents === 11,
    'active dirty-scope module lane should expose claim-ready module agents',
  );
  const dirtyScopeLaneStatuses = buildLaneStatuses({
    status: 'blocked',
    cleanupStatus: 'blocked',
    commandGuidance: dirtyScopeModuleGuidance,
    moduleWork,
    moduleDispatch,
    activeDirtyScopeProjects: 1,
    activeDirtyScopePaths: 4,
    dirtyUnleasedProjects: 0,
  });
  assertSelftest(
    dirtyScopeLaneStatuses.active_status === 'ready' && dirtyScopeLaneStatuses.integration.status === 'blocked',
    'lane statuses should separate ready module lane from blocked integration lane',
  );
  const dirtyScopeLaunchDecision = buildLaunchDecision({
    status: 'blocked',
    laneStatuses: dirtyScopeLaneStatuses,
    commandGuidance: dirtyScopeModuleGuidance,
    recommendedAgents: 0,
    primaryNextCommand: moduleDispatch.next_command,
  });
  assertSelftest(
    dirtyScopeLaunchDecision.allowed
      && dirtyScopeLaunchDecision.agents === 11
      && dirtyScopeLaunchDecision.integration_blocked
      && !dirtyScopeLaunchDecision.release_allowed,
    'launch decision should allow module launch while keeping release blocked',
  );
  const hardBlockedModuleGuidance = summarizeCommandGuidance({
    projectScope: 'demo',
    cleanupStatus: 'blocked',
    moduleWork,
    moduleDispatch,
    activeDirtyScopeProjects: 1,
    activeDirtyScopePaths: 4,
    graphPackets: 1,
  });
  assertSelftest(
    hardBlockedModuleGuidance.active_lane === 'cleanup',
    'hard graph blockers should prevent active dirty-scope from selecting module lane',
  );
  const cleanupFallback = { assignment_count: 2 };
  assertSelftest(
    shouldUseControllerCleanupFallback({
      data: {
        freshness: { stale: true },
        readiness: {
          status: 'stale',
          assignment_count: 2,
          targeted_dirty_paths: 10,
          stale_assignment_count: 2,
        },
      },
    }, cleanupFallback) === true,
    'stale cleanup packets should use live controller cleanup fallback',
  );
  assertSelftest(
    shouldUseControllerCleanupFallback({
      data: {
        freshness: { stale: false },
        readiness: {
          status: 'ready',
          assignment_count: 2,
          targeted_dirty_paths: 10,
          stale_assignment_count: 0,
        },
      },
    }, cleanupFallback) === false,
    'fresh cleanup packets should stay authoritative',
  );
  assertSelftest(
    shouldUseControllerCleanupFallback({
      data: {
        freshness: { stale: false },
        readiness: {
          status: 'empty',
          assignment_count: 0,
          targeted_dirty_paths: 0,
        },
      },
    }, cleanupFallback) === true,
    'empty packet wave should use non-empty live controller fallback',
  );
  const blockerPackets = buildControllerBlockerPackets({
    action_items: [
      {
        severity: 'watch',
        kind: 'active-lease',
        project: 'demo',
        brick: 'module-owner',
        command: 'watch',
      },
      {
        severity: 'blocker',
        kind: 'active-dirty-scope',
        project: 'demo',
        brick: 'dirty-src-renderer-modules-modlink',
        impact_score: 4,
        dirty_count: 9,
        uncovered_dirty_count: 4,
        top_dirty_group: 'src/renderer/modules/modlink',
        top_dirty_group_count: 4,
        top_dirty_group_sample_paths: ['src/renderer/modules/modlink/ModLinkTextSafety.ts'],
        command: "npm run start:edit -- --project 'demo' --brick 'dirty-src-renderer-modules-modlink'",
        next_commands: {
          inspect: "npm run controller:snapshot -- --project 'demo' --dirty-limit 20",
          conflict: "npm run conflict -- report --project 'demo' --brick 'dirty-src-renderer-modules-modlink'",
        },
        parallel_claims: [
          {
            group: 'src/renderer/modules/modlink',
            count: 4,
            brick: 'dirty-src-renderer-modules-modlink',
            command: "npm run start:edit -- --project 'demo' --brick 'dirty-src-renderer-modules-modlink'",
            conflict: "npm run conflict -- report --project 'demo' --brick 'dirty-src-renderer-modules-modlink'",
            sample_paths: ['src/renderer/modules/modlink/ModLinkTextSafety.ts'],
          },
        ],
      },
    ],
  });
  assertSelftest(blockerPackets.length === 1, 'blocker packets should ignore watch-only actions');
  assertSelftest(blockerPackets[0].kind === 'active-dirty-scope', 'blocker packet should preserve kind');
  assertSelftest(blockerPackets[0].uncovered_dirty_count === 4, 'blocker packet should preserve uncovered dirty count');
  assertSelftest(blockerPackets[0].conflict_command.includes('conflict -- report'), 'blocker packet should carry conflict command');
  assertSelftest(blockerPackets[0].parallel_claim_count === 1, 'blocker packet should expose parallel claim count');
  assertSelftest(blockerPackets[0].prompt.includes('Reconcile uncovered active dirty scope'), 'active dirty-scope packet should carry mandatory reconciliation prompt');
  const staleContextPackets = buildControllerBlockerPackets({
    action_items: [{
      severity: 'blocker',
      kind: 'stale-context',
      project: 'demo',
      brick: 'modbro-direct-tab-lookup-indexing',
      impact_score: 6,
      dirty_count: 14,
      stale_context_dirty_count: 6,
      stale_context_receipt_count: 1,
      command: "npm run start:edit -- --project 'demo' --brick 'modbro-direct-tab-lookup-indexing'",
      next_commands: {
        conflict: "npm run conflict -- report --project 'demo' --brick 'modbro-direct-tab-lookup-indexing'",
      },
    }],
  });
  assertSelftest(!scopedControllerIsClean({ stale_context_projects: 1 }), 'stale context should block scoped clean shortcut');
  assertSelftest(staleContextPackets[0].kind === 'stale-context', 'stale-context blocker packet should preserve kind');
  assertSelftest(staleContextPackets[0].prompt.includes('Renew or hand off'), 'stale-context prompt should require renewal or handoff');
  const staleContextLaunchPlan = buildStaleContextLaunchPlan(staleContextPackets, 12, 'demo');
  assertSelftest(staleContextLaunchPlan.length === 1, 'stale-context launch plan should expose renewal packets');
  assertSelftest(staleContextLaunchPlan[0].command.includes('start:edit'), 'stale-context launch plan should carry renewal command');
  assertSelftest(staleContextLaunchPlan[0].conflict_command.includes('conflict -- report'), 'stale-context launch plan should carry conflict command');
  const staleContextGuidance = summarizeCommandGuidance({
    projectScope: 'demo',
    cleanupStatus: 'empty',
    moduleWork,
    moduleDispatch,
    staleContextProjects: 1,
    staleContextPaths: 6,
    staleContextLaunchableAgents: staleContextLaunchPlan.length,
  });
  assertSelftest(staleContextGuidance.active_lane === 'module-observe', 'stale context should not suppress safe dispatch-pinned module work');
  assertSelftest(staleContextGuidance.launchable_agents === 11, 'stale-context with dispatch should expose claim-ready module agents');
  assertSelftest(staleContextGuidance.stale_context_actionable, 'stale-context lane should be actionable when packets are claimable');
  const staleContextRenewGuidance = summarizeCommandGuidance({
    projectScope: 'demo',
    cleanupStatus: 'empty',
    moduleWork,
    moduleDispatch: { available: false, status: 'missing' },
    staleContextProjects: 1,
    staleContextPaths: 6,
    staleContextLaunchableAgents: staleContextLaunchPlan.length,
  });
  assertSelftest(staleContextRenewGuidance.active_lane === 'stale-context', 'stale context should still expose renewal lane when no dispatch-pinned module work exists');
  assertSelftest(staleContextRenewGuidance.launchable_agents === 1, 'stale-context renewal lane should expose renewal agents without dispatch work');
  const immediateModulePlan = buildModuleLaunchPlan(
    moduleDispatch,
    staleContextGuidance.active_lane.startsWith('module') ? staleContextGuidance.launchable_agents : 0,
  );
  const queuedModulePlan = buildModuleLaunchPlan(
    moduleDispatch,
    staleContextGuidance.active_lane.startsWith('module') ? 0 : 12,
  );
  assertSelftest(immediateModulePlan.length === 11, 'stale-context with dispatch should expose immediate module launch commands');
  assertSelftest(queuedModulePlan.length === 0, 'stale-context with dispatch should not duplicate immediate module capacity as queued');
  const staleContextLaneStatuses = buildLaneStatuses({
    status: 'blocked',
    cleanupStatus: 'empty',
    commandGuidance: staleContextGuidance,
    moduleWork,
    moduleDispatch,
    activeDirtyScopeProjects: 0,
    activeDirtyScopePaths: 0,
    staleContextProjects: 1,
    staleContextPaths: 6,
    staleContextLaunchableAgents: staleContextLaunchPlan.length,
    dirtyUnleasedProjects: 0,
  });
  assertSelftest(staleContextLaneStatuses.active_status === 'ready', 'stale-context active lane should be ready when renewal packets are launchable');
  const staleContextLaunchDecision = buildLaunchDecision({
    status: 'blocked',
    laneStatuses: staleContextLaneStatuses,
    commandGuidance: staleContextGuidance,
    recommendedAgents: 0,
    primaryNextCommand: moduleDispatch.next_command,
  });
  assertSelftest(staleContextLaunchDecision.allowed, 'safe module dispatch should launch while stale context remains blocked');
  assertSelftest(!staleContextLaunchDecision.release_allowed, 'safe module dispatch should not allow release while stale context remains blocked');
  const moduleReadyBigPicture = buildBigPicture({
    status: 'blocked',
    readinessScorePercent: 0,
    recommendedAgents: 0,
    requestedAgents: 12,
    launchSlots: 0,
    claimablePercent: 0,
    targetedPaths: 0,
    claimablePaths: 0,
    dirtyUnleasedProjects: 0,
    activeLeases: 1,
    openConflicts: 0,
    criticalConflicts: 0,
    warningConflicts: 0,
    graphPackets: 0,
    projectGraphGaps: 0,
    moduleGraphGaps: 0,
    activeDirtyScopeProjects: 0,
    activeDirtyScopePaths: 0,
    staleContextProjects: 1,
    staleContextPaths: 6,
    staleAgentProcessProjects: 0,
    staleAgentProcesses: 0,
    agentProcessScanErrorProjects: 0,
    topWaveGainPercent: 0,
    topProjectGainPercent: null,
    overflowGroups: 0,
    blockers: ['1 stale Gen3 context project(s), 6 dirty path(s) require lease renewal or handoff'],
    cleanupStatus: 'empty',
    projectScope: 'demo',
    moduleWork,
    moduleDispatch,
  });
  assertSelftest(
    moduleReadyBigPicture.tldr.startsWith('Module-launch-ready, release blocked:'),
    'big picture should not say no progress when module dispatch slots are safely claim-ready',
  );
  const blockerNext = primaryNext({
    status: 'blocked',
    openConflicts: 0,
    criticalConflicts: 0,
    graphPackets: 0,
    projectGraphGaps: 0,
    moduleGraphGaps: 0,
    cleanupStatus: 'empty',
    activeDirtyScopeProjects: 1,
    activeDirtyScopePaths: 4,
    staleAgentProcesses: 0,
    agentProcessScanErrorProjects: 0,
    cleanupNext: '',
    projectScope: 'demo',
    moduleWork,
    moduleDispatch,
    controllerBlockerPackets: blockerPackets,
    dirtyUnleasedProjects: 0,
  });
  assertSelftest(
    blockerNext === moduleDispatch.next_command,
    'blocked active dirty-scope preflight should route primary next to safe module dispatch before integration cleanup',
  );
  const staleContextNext = primaryNext({
    status: 'blocked',
    openConflicts: 0,
    criticalConflicts: 0,
    graphPackets: 0,
    projectGraphGaps: 0,
    moduleGraphGaps: 0,
    cleanupStatus: 'empty',
    activeDirtyScopeProjects: 0,
    activeDirtyScopePaths: 0,
    staleContextProjects: 1,
    staleContextPaths: 6,
    staleAgentProcesses: 0,
    agentProcessScanErrorProjects: 0,
    cleanupNext: '',
    projectScope: 'demo',
    moduleWork,
    moduleDispatch,
    controllerBlockerPackets: staleContextPackets,
    dirtyUnleasedProjects: 0,
  });
  assertSelftest(
    staleContextNext === moduleDispatch.next_command,
    'stale context preflight should route primary next to safe module dispatch when dispatch slots are claim-ready',
  );
  const dirtyUnleasedNext = primaryNext({
    status: 'blocked',
    openConflicts: 0,
    criticalConflicts: 0,
    graphPackets: 0,
    projectGraphGaps: 0,
    moduleGraphGaps: 0,
    cleanupStatus: 'blocked',
    activeDirtyScopeProjects: 1,
    activeDirtyScopePaths: 4,
    staleAgentProcesses: 0,
    agentProcessScanErrorProjects: 0,
    cleanupNext: "npm run cleanup:claim -- --project 'demo' --next",
    projectScope: 'demo',
    moduleWork,
    moduleDispatch,
    controllerBlockerPackets: blockerPackets,
    dirtyUnleasedProjects: 1,
  });
  assertSelftest(
    dirtyUnleasedNext === "npm run cleanup:claim -- --project 'demo' --next",
    'dirty-unleased cleanup should still win over module dispatch',
  );
  console.log('OK sma-parallel-preflight selftest');
}

function assertSelftest(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`selftest failed: ${message}`);
}
