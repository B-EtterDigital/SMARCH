/**
 * WHAT: Runs the regression suite for module-work planning, claiming, observation, and rendering helpers.
 * WHY: Dispatch safety depends on many joined decisions that can regress without an integrated harness.
 * HOW: Receives the command's private helper seams, feeds them fixed scenarios, and asserts each outcome.
 * INPUTS: A harness object supplied by the module-work command.
 * OUTPUTS: A success message and zero result, or a thrown assertion naming the failed contract.
 * CALLERS: The module-work command invokes this harness through its selftest subcommand.
 * @example node tools/sma-module-work-packets.mjs selftest
 */
/** Selftest harness for sma-module-work-packets.mjs. */

type SelfTestHarness = Record<string, any>;

export function runModuleWorkSelfTest(harness: SelfTestHarness): number {
  const {
    DEFAULT_DISPATCH_DIR,
    DEFAULT_STALE_UNCLAIMED_DISPATCH_MS,
    SMA_ROOT,
    START_EDIT,
    agentPacketPayload,
    blockStaleDispatchAssignments,
    blockedReasonSuffix,
    buildClaimReceipt,
    chooseObservationNext,
    claimNextLeaseResource,
    dirtyScopeClaimCommand,
    dirtyScopeConflictCommand,
    externalActiveModuleLeaseGroups,
    formatExternalActiveLeases,
    moduleConflictCommand,
    moduleObservationBigPicture,
    moduleClaimNextCommand,
    moduleDirtyScope,
    nextDispatchClaimAssignment,
    parseGitShortDirtyPaths,
    renderObservationMarkdown,
    resolve,
  } = harness;
  const dispatch = { dispatch_id: 'module-wave-test', project: 'demo-project' };
  const claimNext = moduleClaimNextCommand(dispatch);
  assertSelfTest(
    claimNext === "npm run module:claim -- --project 'demo-project' --next --dispatch 'module-wave-test'",
    'module claim-next command shape is stable',
  );
  assertSelfTest(
    moduleClaimNextCommand({
      ...dispatch,
      path: resolve(DEFAULT_DISPATCH_DIR, 'module-wave-test.json'),
    }) === claimNext,
    'module claim-next keeps default dispatch refs short',
  );
  assertSelfTest(
    moduleClaimNextCommand({
      ...dispatch,
      path: resolve(SMA_ROOT, 'handoffs/custom/custom-wave.json'),
    }) === "npm run module:claim -- --project 'demo-project' --next --dispatch 'handoffs/custom/custom-wave'",
    'module claim-next preserves custom dispatch refs',
  );
  assertSelfTest(
    claimNextLeaseResource(dispatch) === 'module-claim-next:demo-project:module-wave-test',
    'module claim-next allocator resource is deterministic',
  );
  const observation = {
    assignments: [
      { agent_slot: 1, claimed: true, status: 'claimed', open_conflicts: 0, graph_ready: true },
      { agent_slot: 2, claimed: false, status: 'conflict', open_conflicts: 1, graph_ready: true },
      { agent_slot: 3, claimed: false, status: 'unclaimed', open_conflicts: 0, graph_ready: false },
      { agent_slot: 4, claimed: false, status: 'context-error', open_conflicts: 0, graph_ready: true, context_error: 'unreadable' },
      { agent_slot: 5, claimed: false, status: 'launch-blocked', open_conflicts: 0, graph_ready: true, launch_blocked: true },
      { agent_slot: 6, claimed: false, status: 'unclaimed', open_conflicts: 0, graph_ready: true },
    ],
  };
  assertSelfTest(nextDispatchClaimAssignment(observation)?.agent_slot === 6, 'next claim skips unsafe and launch-blocked dispatch slots');
  assertSelfTest(
    blockedReasonSuffix({
      held_blocked_unclaimed: 2,
      dirty_scope_blocked_unclaimed: 1,
      other_blocked_unclaimed: 0,
    }) === ' (2 active leases, 1 dirty scope)',
    'blocked reason suffix splits held and dirty scope blockers',
  );
  const staleFreshness = {
    age_ms: DEFAULT_STALE_UNCLAIMED_DISPATCH_MS + 1,
    max_age_ms: DEFAULT_STALE_UNCLAIMED_DISPATCH_MS,
  };
  const staleAssignments = blockStaleDispatchAssignments([
    { agent_slot: 1, status: 'unclaimed', claimed: false, open_conflicts: 0, graph_ready: true, context_error: null, launch_blocked: false },
    { agent_slot: 2, status: 'claimed', claimed: true, open_conflicts: 0, graph_ready: true, context_error: null, launch_blocked: false },
  ], staleFreshness);
  assertSelfTest(
    staleAssignments[0].status === 'launch-blocked' && staleAssignments[0].launch_blocked_reason === 'dispatch-stale',
    'stale unclaimed dispatch assignments should become launch-blocked',
  );
  assertSelfTest(
    staleAssignments[1].status === 'claimed',
    'stale dispatch guard should not rewrite already claimed assignments',
  );
  assertSelfTest(
    chooseObservationNext({
      dispatch: { ...dispatch, task: 'fresh task', assignment_count: 12 },
      assignments: staleAssignments,
      status: 'blocked',
      openConflicts: 0,
      unclaimed: 1,
      staleUnclaimed: true,
    }) === "npm run module:dispatch -- --project 'demo-project' --task 'fresh task' --max-agents 12",
    'stale unclaimed dispatch should route next command to a fresh module dispatch',
  );
  const externalActive = externalActiveModuleLeaseGroups([
    {
      agent_slot: 1,
      module_id: 'modlink',
      brick: 'module-work-modlink-slot-1',
      launch_blocked: true,
      claimed: false,
      held_match: 'module-related-active-lease',
      held_resource: 'modlink-proof',
      held_lease_id: 'lease-a',
      held_by: 'agent-a',
    },
    {
      agent_slot: 2,
      module_id: 'modlink',
      brick: 'module-work-modlink-slot-2',
      launch_blocked: true,
      claimed: false,
      held_match: 'module-related-active-lease',
      held_resource: 'modlink-proof',
      held_lease_id: 'lease-a',
      held_by: 'agent-a',
    },
    {
      agent_slot: 3,
      module_id: 'modcap',
      launch_blocked: true,
      claimed: false,
      held_match: 'exact-slot-lease',
      held_resource: 'module-work-modcap-slot-1',
      held_lease_id: 'lease-b',
      held_by: 'agent-b',
    },
  ]);
  assertSelfTest(externalActive.length === 1, 'external active grouping excludes exact dispatch-slot leases');
  assertSelfTest(externalActive[0].slot_count === 2, 'external active grouping counts multiple blocked slots for one lease');
  assertSelfTest(formatExternalActiveLeases(externalActive) === 'modlink:modlink-proof (2 slots)', 'external active formatter summarizes grouped leases');
  assertSelfTest(
    moduleConflictCommand({
      project: 'demo-project',
      moduleId: 'demo',
      slot: 1,
      task: 'demo task',
      moduleWorkBrick: (moduleId, slotId) => `module-work-${moduleId}-slot-${slotId}`,
      shellArg: (value) => `'${value}'`,
    }).includes("conflict -- report --project 'demo-project'"),
    'module conflict command is standalone and actionable',
  );
  const dirtyScope = moduleDirtyScope({
    id: 'modbro',
    paths: ['src/renderer/modules/modbro/**'],
    excludePaths: ['src/renderer/modules/modbro/generated/**'],
  }, parseGitShortDirtyPaths([
    ' M src/renderer/modules/modbro/useModbroBrowserSessions.ts',
    '?? src/renderer/modules/modbro/generated/ignored.ts',
    ' M src/renderer/modules/modcap/SelectionBar.tsx',
  ].join('\n')));
  assertSelfTest(dirtyScope.count === 1, 'dirty module scope includes owned paths and excludes delegated paths');
  assertSelfTest(dirtyScope.brick === 'dirty-src-renderer-modules-modbro', 'dirty module scope brick is deterministic');
  assertSelfTest(
    dirtyScopeClaimCommand('demo-project', dirtyScope).includes("start:edit -- --project 'demo-project' --brick 'dirty-src-renderer-modules-modbro'"),
    'dirty module scope claim command is actionable',
  );
  assertSelfTest(
    dirtyScopeConflictCommand('demo-project', 'modbro', dirtyScope).includes('conflict -- report'),
    'dirty module scope conflict command is actionable',
  );
  assertSelfTest(
    chooseObservationNext({
      dispatch,
      assignments: observation.assignments,
      status: 'dispatch-only',
      openConflicts: 0,
      unclaimed: 4,
    }) === claimNext,
    'dispatch observation advertises generic claim-next',
  );
  const observationArtifact: Record<string, any> = {
    schema_version: '1.0.0',
    kind: 'module-work-observation',
    generated_at: '2026-01-01T00:00:00.000Z',
    status: 'dispatch-only',
    dispatch: {
      dispatch_id: 'module-wave-test',
      project: 'demo-project',
      task: 'demo task',
      assignment_count: 6,
      predicted_launch_ready_slots: 6,
      predicted_requested_agents: 12,
    },
    summary: {
      assignment_count: 6,
      claimed: 1,
      active: 0,
      completed: 0,
      unclaimed: 5,
      claimable_unclaimed: 1,
      launch_blocked_unclaimed: 0,
      held_blocked_unclaimed: 0,
      dirty_scope_blocked_unclaimed: 0,
      other_blocked_unclaimed: 0,
      external_active_slot_count: 0,
      external_active_lease_count: 0,
      external_active_module_count: 0,
      open_conflicts: 0,
      graph_ready: 5,
    },
    gains: {
      predicted_graph_first_token_reduction_percent: 90,
      observed_claimed_percent: 17,
      observed_completed_percent: 0,
    },
    comparison: {
      predicted_requested_agents: 12,
      predicted_launch_ready_slots: 6,
      dispatched_slots: 6,
      observed_claimed_slots: 1,
      observed_active_slots: 0,
      observed_completed_slots: 0,
      observed_claimable_unclaimed_slots: 1,
      observed_launch_blocked_unclaimed_slots: 0,
      observed_external_active_slots: 0,
      observed_external_active_leases: 0,
      observed_open_conflicts: 0,
    },
    blockers: [],
    warnings: [],
    next: claimNext,
    external_active_module_leases: [],
    assignments: [{
      agent_slot: 1,
      module_id: 'demo',
      slot: 1,
      status: 'unclaimed',
      claim_event_count: 0,
      completion_event_count: 0,
      active_lease_count: 0,
      open_conflicts: 0,
      agent_packet_markdown_path: 'handoffs/module-waves/module-wave-test.agent-packets/01-demo.md',
      conflict_command: "npm run conflict -- report --project 'demo-project' --brick 'module-work-demo-slot-1'",
    }],
  };
  observationArtifact.big_picture = moduleObservationBigPicture(observationArtifact);
  const observationMarkdown = renderObservationMarkdown(observationArtifact, {
    blockedReasonSuffix,
    formatPercent: (value) => `${value}%`,
  });
  assertSelfTest(observationArtifact.big_picture.tldr.includes('launch-ready'), 'observation artifact has big-picture launch TLDR');
  assertSelfTest(observationMarkdown.includes('## Big Picture'), 'observation markdown renders big-picture section');
  assertSelfTest(observationMarkdown.includes('Current:'), 'observation markdown renders current slice');
  assertSelfTest(observationMarkdown.includes('Agent packet:'), 'observation markdown renders first-read packet path');
  assertSelfTest(observationMarkdown.includes('Module conflict:'), 'observation markdown renders standalone conflict command');
  const receipt = buildClaimReceipt({
    config: {
      project: 'demo-project',
      config: {
        moduleDefaults: { requiredLocalGates: ['pnpm test:default'] },
        sharedHotPaths: [],
      },
    },
    module: {
      id: 'demo',
      label: 'Demo',
      paths: ['src/demo/**'],
      requiredLocalGates: ['pnpm test:demo'],
    },
    baseModule: {
      id: 'demo',
      label: 'Demo',
      paths: ['src/demo/**'],
    },
    effectiveModule: {
      id: 'demo',
      label: 'Demo',
      paths: ['src/demo/**'],
      requiredLocalGates: ['pnpm test:demo'],
    },
    partition: null,
    slot: 1,
    brick: 'module-work-demo-slot-1',
    graph: { graphReady: true, graphPath: '/tmp/demo/graph.json' },
    dispatchAssignment: {
      agent_slot: 1,
      dispatch_id: 'module-wave-test',
      module_id: 'demo',
      slot: 1,
      graph_query_command: "npm run graphify:query -- --project 'demo-project' --module 'demo' -- 'Map module.'",
      graph_path: '/tmp/demo/graph.json',
      paths: ['src/demo/**'],
      exclude_paths: ['src/demo/generated/**'],
      required_gates: ['pnpm test:demo'],
      claim_command: "npm run module:claim -- --project 'demo-project' --module 'demo' --dispatch-id 'module-wave-test' --dispatch-slot '1'",
      agent_packet: { markdown_path: 'handoffs/module-waves/module-wave-test.agent-packets/01-demo.md' },
      prompt: 'Use $sma-gen3. Stay inside module paths: src/demo/**. Run module gates before completion: pnpm test:demo.',
    },
    startArgs: [START_EDIT, '--project', 'demo-project', '--brick', 'module-work-demo-slot-1'],
  });
  assertSelfTest(receipt.graph_query_command.includes('graphify:query'), 'claim receipt carries graph query command');
  assertSelfTest(receipt.paths.includes('src/demo/**'), 'claim receipt carries owned module paths');
  assertSelfTest(receipt.exclude_paths.includes('src/demo/generated/**'), 'claim receipt carries excluded paths');
  assertSelfTest(receipt.required_gates.includes('pnpm test:demo'), 'claim receipt carries required gates');
  assertSelfTest(receipt.conflict_command.includes('conflict -- report'), 'claim receipt carries standalone conflict command');
  assertSelfTest(receipt.agent_packet_markdown_path.endsWith('01-demo.md'), 'claim receipt carries first-read agent packet path');
  assertSelfTest(receipt.prompt.includes('Stay inside module paths'), 'claim receipt carries dispatch prompt');
  const agentPacket = agentPacketPayload({
    created_at: '2026-01-01T00:00:00.000Z',
    dispatch_id: 'module-wave-test',
    gains: {
      module_graph_first_token_reduction_percent_estimate: 90,
      dirty_status_token_reduction_percent_estimate: 90,
      collision_reduction_percent_estimate: 60,
    },
    controller_commands: {
      observe: "npm run module:observe -- --dispatch 'module-wave-test'",
      observe_write: "npm run module:observe:write -- --dispatch 'module-wave-test'",
      conflict_summary: "npm run conflict:summary -- --project 'demo-project'",
    },
    dispatch_paths: {
      json_path: 'handoffs/module-waves/module-wave-test.json',
      markdown_path: 'handoffs/module-waves/module-wave-test.md',
    },
  }, {
    ...receipt,
    agent_slot: 1,
    task: 'demo task',
    agent_packet: {
      json_path: 'handoffs/module-waves/module-wave-test.agent-packets/01-demo.json',
      markdown_path: 'handoffs/module-waves/module-wave-test.agent-packets/01-demo.md',
    },
  });
  assertSelfTest(agentPacket.first_read === true, 'agent packet is marked first-read');
  assertSelfTest(agentPacket.commands.claim.includes('module:claim'), 'agent packet carries the exact claim command');
  assertSelfTest(agentPacket.commands.graph_query.includes('graphify:query'), 'agent packet carries the module graph command');
  assertSelfTest(agentPacket.links.dispatch_markdown.endsWith('.md'), 'agent packet links back to the full dispatch markdown');
  assertSelfTest(
    chooseObservationNext({
      dispatch,
      assignments: observation.assignments,
      status: 'blocked',
      openConflicts: 1,
      unclaimed: 4,
    }) === "npm run conflict:summary -- --project 'demo-project'",
    'dispatch observation routes conflicts to conflict summary',
  );
  console.log('sma-module-work-packets selftest: ok');
  return 0;
}



function assertSelfTest(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`selftest failed: ${message}`);
}
