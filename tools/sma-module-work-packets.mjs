#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { projectRoot, readContextLog } from './lib/context-log.mjs';
import { readActiveLeases } from './lib/gen3-state.mjs';
import { modulePathSamples, modulesOverlap, overlappingModulePathPairs, overlappingSharedHotPaths, pathPatternCovers } from './lib/module-work-paths.mjs';
import { agentPacketDescriptor, agentPacketPayload, writeAgentPackets } from './lib/module-work-agent-packets.mjs';
import { latestObservationForDispatch } from './lib/module-work-observations.mjs';
import { formatExternalActiveLeases, moduleConflictCommand, moduleObservationBigPicture, modulePrompt, moduleWatchBigPicture, renderDispatchMarkdown, renderModuleWatchConsole, renderObservationMarkdown } from './lib/module-work-renderers.mjs';
import { runModuleWorkSelfTest } from './lib/module-work-selftest.mjs';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = resolve(SMA_ROOT, 'tools');
const START_EDIT = resolve(TOOLS_DIR, 'sma-start-edit.mjs');
const LEASE = resolve(TOOLS_DIR, 'sma-lease.mjs');
const DEFAULT_DISPATCH_DIR = resolve(SMA_ROOT, 'handoffs/module-waves');
const DEFAULT_OBSERVATION_DIR = resolve(DEFAULT_DISPATCH_DIR, 'observations');
const PLACEHOLDER_MODULE_TASK = '<describe module task>';
const DEFAULT_STALE_UNCLAIMED_DISPATCH_MS = 8 * 60 * 60 * 1000;
const CLAIM_KINDS = new Set(['lease_acquired', 'lease_force_acquired', 'edit_planned']);
const COMPLETE_KINDS = new Set(['edit_applied']);

const command = argv[2] || 'plan';
const args = parseArgs(argv.slice(3));

try {
  if (args.help || command === 'help' || command === '--help' || command === '-h') {
    usage();
    exit(0);
  }
  if (command === 'plan' || command === 'list') exit(runPlan());
  if (command === 'claim') exit(runClaim());
  if (command === 'observe') exit(runObserve());
  if (command === 'watch') exit(runWatch());
  if (command === 'selftest') exit(runModuleWorkSelfTest({
    DEFAULT_DISPATCH_DIR,
    DEFAULT_STALE_UNCLAIMED_DISPATCH_MS,
    SMA_ROOT,
    START_EDIT,
    blockStaleDispatchAssignments,
    blockedReasonSuffix,
    agentPacketPayload,
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
  }));
  throw new Error(`unknown command: ${command}`);
} catch (err) {
  console.error(`sma-module-work-packets: ${err.message}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-module-work-packets.mjs plan --project <id> [--task "..."] [--max-agents 12]
                                  [--module <id>] [--fill-capacity] [--json]
                                  [--write-dispatch [path]] [--allow-blocked-dispatch]
                                  [--no-graph-check]
  sma-module-work-packets.mjs claim --project <id> --module <id> --task "..."
                                   [--slot <n>] [--ttl 1200] [--json] [--dry-run] [--full-prompt]
                                   [--dispatch-id <id>] [--dispatch-slot <n>]
  sma-module-work-packets.mjs claim --project <id> --next
                                   [--dispatch latest|<id>|<path>] [--ttl 1200]
                                   [--claim-next-wait-ms 15000] [--json] [--dry-run] [--full-prompt]
  sma-module-work-packets.mjs observe [--dispatch latest|<id>|<path>] [--project <id>]
                                    [--json] [--write]
  sma-module-work-packets.mjs watch --project <id> [--task "..."] [--max-agents 12]
                                  [--dispatch latest|<id>|<path>] [--json]
  sma-module-work-packets.mjs selftest

Plans module-local product work slots from sma.gen3.json. Unlike cleanup waves,
these slots are for clean repos: every prompt requires a module graph first,
module-owned paths only, and conflict reporting before shared-hot-path work.
`);
}

function runPlan() {
  const plan = buildPlan();
  const dispatchManifest = args.writeDispatch ? maybeWriteDispatchManifest(plan) : null;
  if (dispatchManifest) plan.dispatch_manifest = dispatchManifest;
  if (args.json) {
    console.log(JSON.stringify(plan, null, 2));
    return 0;
  }

  console.log('SMA Gen3 Module Work Plan');
  console.log(`project:          ${plan.project}`);
  console.log(`status:           ${plan.status}`);
  console.log(`modules:          ${plan.summary.modules_total}, launch-ready ${plan.summary.launch_ready_slots}/${plan.summary.requested_agents}`);
  console.log(`graphs:           ${plan.summary.graph_ready_modules}/${plan.summary.modules_total} ready, ${plan.summary.graph_blocked_modules} blocked`);
  console.log(`leases:           ${plan.summary.held_slots} held slots`);
  console.log(`overlap skipped:  ${plan.summary.path_overlap_blocked_slots}`);
  console.log(`gains:            ${plan.gains.module_graph_first_token_reduction_percent_estimate}% token reduction estimate, ${plan.gains.false_portfolio_blocker_reduction_percent_estimate}% fewer false portfolio blockers`);
  console.log(`preflight:        ${plan.commands.project_preflight}`);
  if (dispatchManifest) {
    console.log(`dispatch:         ${relativeToSma(dispatchManifest.json_path)}`);
    console.log(`handoff:          ${relativeToSma(dispatchManifest.markdown_path)}`);
  }
  if (plan.warnings.length) console.log(`warnings:         ${plan.warnings.join('; ')}`);
  if (plan.blockers.length) console.log(`blockers:         ${plan.blockers.join('; ')}`);
  const blockedSlots = plan.slots.filter((slot) => !slot.launch_ready);
  if (blockedSlots.length) {
    console.log('');
    console.log('Blocked module slots:');
    for (const slot of blockedSlots) {
      console.log(`- ${slot.module_id} slot ${slot.slot}: ${slot.blocked_reason}${slot.path_overlap_warning ? ` (${slot.path_overlap_warning})` : ''}${slot.held_resource ? ` (${slot.held_resource})` : ''}`);
      if (slot.dirty_scope_command) console.log(`   dirty claim: ${slot.dirty_scope_command}`);
      if (slot.dirty_scope_conflict_command) console.log(`   conflict: ${slot.dirty_scope_conflict_command}`);
      for (const pair of slot.overlap_path_pairs.slice(0, 3)) {
        console.log(`   path overlap: ${pair.left} <-> ${pair.right}`);
      }
    }
  }
  console.log('');
  if (!plan.launch_plan.length) {
    console.log('No module work slots are launch-ready for this request.');
    return 0;
  }
  const dispatchAssignments = dispatchManifest ? readJsonFile(dispatchManifest.json_path).assignments || [] : [];
  if (!hasConcreteModuleTask(plan.task)) {
    console.log('Capacity preview only: pass --task "..." --write-dispatch before launching module agents.');
  } else if (!dispatchManifest) {
    console.log(`Dispatch required before launch: npm run module:dispatch -- --project ${shellArg(plan.project)} --task ${shellArg(plan.task)} --max-agents ${plan.summary.requested_agents}`);
  } else {
    console.log('Dispatch-pinned module slots:');
  }
  const printableSlots = dispatchAssignments.length ? dispatchAssignments : plan.launch_plan;
  for (const slot of printableSlots) {
    console.log(`${slot.agent_slot}. ${slot.module_id} slot ${slot.slot}: ${slot.label}`);
    console.log(`   graph: ${slot.graph_query_command}`);
    if (dispatchManifest) console.log(`   claim: ${slot.claim_command}`);
    if ((slot.iteration_gates || []).length) console.log(`   iteration: ${slot.iteration_gates.join(' && ')}`);
    console.log(`   gates: ${(slot.required_gates || []).join(' && ') || 'project default gates'}`);
    if (dispatchManifest) console.log(`   prompt: ${slot.prompt}`);
  }
  return 0;
}

function runClaim() {
  if (args.next) return runNextClaim();
  return runResolvedClaim();
}

function runNextClaim() {
  requireArg('project', '--project');
  const explicitSlotArgs = ['module', 'slot', 'partition', 'dispatchSlot'].filter((key) => args[key] !== undefined);
  if (explicitSlotArgs.length) {
    throw new Error(`--next selects the module slot; remove ${explicitSlotArgs.map((key) => `--${dashCase(key)}`).join(', ')}`);
  }
  const dispatchInput = args.dispatch || args.dispatchId || 'latest';
  if (args.dryRun) {
    hydrateNextDispatchClaim(dispatchInput);
    return runResolvedClaim();
  }
  const dispatch = loadDispatch(dispatchInput);
  const mutex = acquireClaimNextLease(dispatch);
  try {
    hydrateNextDispatchClaim(dispatchInput);
    return runResolvedClaim();
  } finally {
    releaseClaimNextLease(mutex);
  }
}

function runResolvedClaim() {
  requireArg('project', '--project');
  requireArg('module', '--module');
  requireArg('task', '--task');
  const config = loadProjectConfig(args.project);
  const module = selectModule(config);
  const slot = positiveInt(args.slot, 1);
  const maxSlots = positiveInt(module.maxParallelAgents, positiveInt(config.config.moduleDefaults?.maxParallelAgents, 1));
  if (slot > maxSlots) {
    throw new Error(`slot ${slot} exceeds ${module.id} maxParallelAgents ${maxSlots}`);
  }
  const partition = modulePartitionForClaim(module, slot);
  const effectiveModule = effectiveModuleForPartition(module, partition);
  const graph = args.noGraphCheck ? { graphReady: false, skipped: true } : checkModuleGraph(config.project, module.id);
  if (!args.noGraphCheck && !graph.graphReady && !graph.graphKnownEmpty) {
    throw new Error(`module graph is not ready for ${module.id}; run npm run graphify:refresh:modules -- --project ${shellArg(config.project)} --missing-only --global`);
  }
  const dispatchAssignment = args.dispatchId ? validateDispatchClaim({ config, module, slot, partition }) : null;
  const active = readActiveLeases({ excludeCurrentWrapperLease: true });
  const brick = moduleWorkBrick(module.id, slot);
  const held = heldModuleSlot(active, config.project, effectiveModule, slot);
  if (held) {
    throw new Error(`module work slot is already held or covered by active module work: ${held.resource_id} by ${held.agent_id} (${held.lease_id})`);
  }
  const dirtyState = readProjectDirtyPaths(config.project);
  if (dirtyState.error) {
    throw new Error(`could not inspect dirty module scope for ${module.id}: ${dirtyState.error}`);
  }
  const dirtyScope = moduleDirtyScope(effectiveModule, dirtyState.paths);
  if (dirtyScope.count) {
    throw new Error([
      `module ${module.id} has ${dirtyScope.count} dirty path(s) already in scope`,
      `claim cleanup first: ${dirtyScopeClaimCommand(config.project, dirtyScope)}`,
      `or document overlap: ${dirtyScopeConflictCommand(config.project, module.id, dirtyScope)}`,
    ].join('; '));
  }

  const partitionLabel = partition ? ` ${partition.id}` : '';
  const intent = `module work ${module.id} slot ${slot}${partitionLabel}: ${args.task}`;
  const rationale = [
    `module=${module.id}`,
    `slot=${slot}`,
    partition ? `partition=${partition.id}` : null,
    args.dispatchId ? `dispatch_id=${args.dispatchId}` : null,
    args.dispatchSlot ? `dispatch_slot=${args.dispatchSlot}` : null,
    dispatchAssignment ? `dispatch_manifest=${dispatchAssignment.dispatch_id}` : null,
    `graph=${graph.graphReady ? 'ready' : graph.graphKnownEmpty ? 'known-empty' : graph.skipped ? 'skipped' : 'not-ready'}`,
    `paths=${(effectiveModule.paths || []).slice(0, 4).join(', ')}`,
    moduleIterationGates(config, effectiveModule).length ? `iteration_gates=${moduleIterationGates(config, effectiveModule).join(' && ')}` : null,
    `gates=${moduleGates(config, effectiveModule).join(' && ')}`,
  ].filter(Boolean).join(' | ');
  const startArgs = [
    START_EDIT,
    '--project', config.project,
    '--brick', brick,
    '--intent', intent,
    '--rationale', rationale,
    '--task', `module-work-${config.project}-${module.id}-${slot}`,
    '--ttl', String(args.ttl ?? 1200),
  ];
  for (const file of modulePathSamples(effectiveModule)) startArgs.push('--file', file);
  if (args.json) startArgs.push('--json');
  const claimReceipt = buildClaimReceipt({
    config,
    module,
    baseModule: module,
    effectiveModule,
    partition,
    slot,
    brick,
    graph,
    dispatchAssignment,
    startArgs,
  });

  if (args.dryRun) {
    console.log(JSON.stringify({
      ok: true,
      dry_run: true,
      ...claimReceipt,
      next: Boolean(args.next),
      claim_next_allocator: args.next && !args.dryRun ? claimNextLeaseResource({ project: config.project, dispatch_id: args.dispatchId }) : null,
    }, null, 2));
    return 0;
  }

  const result = spawnSync(process.execPath, startArgs, args.json
    ? { cwd: SMA_ROOT, encoding: 'utf8' }
    : { cwd: SMA_ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    if (args.json) process.stderr.write(result.stderr ?? '');
    return result.status ?? 1;
  }
  if (args.json) {
    const startEdit = parseJsonOutput(result.stdout, 'start-edit');
    console.log(JSON.stringify({
      ok: true,
      dry_run: false,
      ...claimReceipt,
      lease: startEdit.lease || null,
      context_event: startEdit.context_event || null,
      dirty_baseline: startEdit.dirty_baseline || null,
    }, null, 2));
  } else {
    printClaimReceipt(claimReceipt);
  }
  return 0;
}

function buildClaimReceipt({ config, module, baseModule, effectiveModule, partition, slot, brick, graph, dispatchAssignment, startArgs }) {
  const claim = buildModuleSlot({
    config,
    module: effectiveModule,
    baseModule,
    partition,
    slot,
    agentSlot: number(dispatchAssignment?.agent_slot) || 1,
    graph,
    held: null,
    task: args.task,
  });
  const resolvedClaimCommand = dispatchAssignment?.claim_command
    || (args.next && args.dispatchId
      ? moduleClaimNextCommand({ dispatch_id: args.dispatchId, project: config.project })
      : claim.claim_command);
  const resolvedPrompt = dispatchAssignment?.prompt
    || (resolvedClaimCommand
      ? claim.prompt.replace(
          'Do not claim from this preview; use the dispatch-pinned claim from the module dispatch manifest.',
          `Claim with \`${resolvedClaimCommand}\`.`,
        )
      : claim.prompt);
  const conflictCommand = dispatchAssignment?.conflict_command || moduleConflictCommand({ project: config.project, moduleId: module.id, slot, task: args.task, moduleWorkBrick, shellArg });
  return {
    project: config.project,
    module: module.id,
    module_label: claim.label,
    slot,
    partition: partition?.id || null,
    brick,
    graph,
    graph_query_command: dispatchAssignment?.graph_query_command || claim.graph_query_command,
    graph_path: dispatchAssignment?.graph_path || claim.graph_path || graph.graphPath || null,
    paths: dispatchAssignment?.paths || claim.paths || effectiveModule.paths || [],
    exclude_paths: dispatchAssignment?.exclude_paths || claim.exclude_paths || effectiveModule.excludePaths || [],
    iteration_gates: dispatchAssignment?.iteration_gates || claim.iteration_gates || [],
    required_gates: dispatchAssignment?.required_gates || claim.required_gates || [],
    shared_hot_paths: dispatchAssignment?.shared_hot_paths || claim.shared_hot_paths || [],
    claim_command: resolvedClaimCommand,
    conflict_command: conflictCommand,
    agent_packet: dispatchAssignment?.agent_packet || null,
    agent_packet_markdown_path: dispatchAssignment?.agent_packet?.markdown_path || '',
    start_edit_command: ['node', ...startArgs].map(shellArg).join(' '),
    dispatch_assignment: dispatchAssignment,
    prompt: resolvedPrompt,
  };
}

function printClaimReceipt(receipt) {
  console.log('');
  console.log('SMA Gen3 Module Claim Receipt');
  console.log(`module:           ${receipt.module} slot ${receipt.slot}${receipt.partition ? ` (${receipt.partition})` : ''}`);
  console.log(`brick:            ${receipt.brick}`);
  if (receipt.agent_packet_markdown_path) console.log(`agent packet:     ${receipt.agent_packet_markdown_path}`);
  if (receipt.claim_command) console.log(`claim:            ${receipt.claim_command}`);
  if (receipt.conflict_command) console.log(`conflict:         ${receipt.conflict_command}`);
  if (receipt.graph_query_command) console.log(`graph query:      ${receipt.graph_query_command}`);
  if (receipt.graph_path) console.log(`graph:            ${receipt.graph_path}`);
  if (receipt.paths?.length) console.log(`paths:            ${receipt.paths.join(', ')}`);
  if (receipt.exclude_paths?.length) console.log(`exclude:          ${receipt.exclude_paths.join(', ')}`);
  if (receipt.iteration_gates?.length) console.log(`iteration gates:  ${receipt.iteration_gates.join(' && ')}`);
  if (receipt.required_gates?.length) console.log(`required gates:   ${receipt.required_gates.join(' && ')}`);
  if (receipt.shared_hot_paths?.length) console.log(`shared hot paths: ${receipt.shared_hot_paths.map((item) => item.id || item).join(', ')}`);
  if ((args.fullPrompt || args.fullPrompts) && receipt.prompt) console.log(`prompt:           ${receipt.prompt}`);
}

function parseJsonOutput(raw, label) {
  try {
    const start = String(raw || '').indexOf('{');
    return JSON.parse(start >= 0 ? String(raw).slice(start) : String(raw || ''));
  } catch (err) {
    throw new Error(`invalid ${label} JSON: ${err.message}`);
  }
}

function hydrateNextDispatchClaim(dispatchInput) {
  const dispatch = loadDispatch(dispatchInput);
  args.dispatch = dispatch.path || dispatchInput;
  const observation = observeDispatch(dispatch);
  if (observation.blockers.length) {
    throw new Error(`module dispatch is blocked; run ${observation.next}: ${observation.blockers.join('; ')}`);
  }
  const assignment = nextDispatchClaimAssignment(observation);
  if (!assignment) {
    const unclaimed = observation.assignments.filter((item) => !item.claimed).length;
    const reason = unclaimed
      ? `${unclaimed} slot(s) are unclaimed but none are currently safe to auto-claim`
      : 'no unclaimed module slots remain';
    throw new Error(`${reason}; run npm run module:observe -- --dispatch ${shellArg(dispatch.dispatch_id)} --project ${shellArg(dispatch.project)}`);
  }
  args.module = assignment.module_id;
  args.slot = String(assignment.slot);
  if (assignment.partition_id) args.partition = assignment.partition_id;
  args.task = dispatch.task || assignment.task || PLACEHOLDER_MODULE_TASK;
  args.dispatchId = dispatch.dispatch_id;
  args.dispatchSlot = String(assignment.agent_slot);
}

function acquireClaimNextLease(dispatch) {
  const resource = claimNextLeaseResource(dispatch);
  const waitMs = positiveInt(args.claimNextWaitMs, 15000);
  const retryMs = Math.max(20, positiveInt(args.claimNextRetryMs, 120));
  const startedAt = Date.now();
  const acquireArgs = [
    LEASE, 'acquire',
    '--resource-kind', 'other',
    '--resource', resource,
    '--project', dispatch.project,
    '--intent', `module claim-next allocator ${dispatch.dispatch_id}`,
    '--ttl', String(args.claimNextTtl ?? 60),
    '--json',
  ];
  while (true) {
    const result = spawnSync(process.execPath, acquireArgs, {
      cwd: SMA_ROOT,
      encoding: 'utf8',
    });
    if (result.status === 0) {
      try {
        return JSON.parse(result.stdout);
      } catch (err) {
        throw new Error(`invalid claim-next allocator lease JSON: ${err.message}`);
      }
    }
    if (result.status === 10 && Date.now() - startedAt < waitMs) {
      sleepSync(retryMs);
      continue;
    }
    process.stderr.write(result.stderr ?? '');
    throw new Error(`could not acquire claim-next allocator lease ${resource}`);
  }
}

function releaseClaimNextLease(lease) {
  if (!lease?.lease_id) return;
  const result = spawnSync(process.execPath, [
    LEASE, 'release',
    '--lease', lease.lease_id,
    '--reason', 'module claim-next allocation complete',
    '--json',
  ], {
    cwd: SMA_ROOT,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '');
    console.error(`sma-module-work-packets: warning: failed to release claim-next allocator lease ${lease.lease_id}`);
  }
}

function runObserve() {
  const dispatch = loadDispatch(args.dispatch || 'latest');
  const observation = /** @type {ReturnType<typeof observeDispatch> & {observation_manifest?: any}} */ (observeDispatch(dispatch));
  if (args.write) observation.observation_manifest = writeObservation(observation);
  if (args.json) {
    console.log(JSON.stringify(observation, null, 2));
    return 0;
  }
  console.log('SMA Gen3 Module Dispatch Observation');
  console.log(`tldr:            ${observation.big_picture.tldr}`);
  console.log(`current:         ${observation.big_picture.current_slice}`);
  console.log(`status:           ${observation.status}`);
  console.log(`dispatch:         ${observation.dispatch.dispatch_id} (${observation.dispatch.assignment_count} slots)`);
  console.log(`project:          ${observation.dispatch.project}`);
  console.log(`modules:          ${observation.summary.claimed}/${observation.summary.assignment_count} claimed, ${observation.summary.active} active, ${observation.summary.completed} completed, ${observation.summary.unclaimed} unclaimed`);
  console.log(`claim-ready:      ${observation.summary.claimable_unclaimed}/${observation.summary.unclaimed} unclaimed, ${observation.summary.launch_blocked_unclaimed} blocked${blockedReasonSuffix(observation.summary)}`);
  if (observation.summary.external_active_slot_count) {
    console.log(`external active:  ${observation.summary.external_active_slot_count} slot${observation.summary.external_active_slot_count === 1 ? '' : 's'} occupied by ${observation.summary.external_active_lease_count} non-dispatch lease${observation.summary.external_active_lease_count === 1 ? '' : 's'} (${formatExternalActiveLeases(observation.external_active_module_leases)})`);
  }
  console.log(`conflicts:        ${observation.summary.open_conflicts} open`);
  console.log(`graphs:           ${observation.summary.graph_ready}/${observation.summary.assignment_count} ready`);
  console.log(`next:             ${observation.next}`);
  if (observation.blockers.length) console.log(`blockers:         ${observation.blockers.join('; ')}`);
  if (observation.warnings.length) console.log(`warnings:         ${observation.warnings.join('; ')}`);
  if (observation.observation_manifest) console.log(`written:          ${relativeToSma(observation.observation_manifest.json_path)}`);
  return 0;
}

function runWatch() {
  requireArg('project', '--project');
  const watch = moduleWatch();
  if (args.json) {
    console.log(JSON.stringify(watch, null, 2));
    return 0;
  }

  console.log(renderModuleWatchConsole(watch, { blockedReasonSuffix, formatPercent }));
  return 0;
}

function buildPlan() {
  requireArg('project', '--project');
  const config = loadProjectConfig(args.project);
  const active = readActiveLeases({ excludeCurrentWrapperLease: true });
  const dirtyState = readProjectDirtyPaths(config.project);
  const maxAgents = positiveInt(args.maxAgents, 12);
  const requestedTask = args.task || PLACEHOLDER_MODULE_TASK;
  const modules = config.modules.filter((module) => !args.module || module.id === args.module);
  if (args.module && !modules.length) throw new Error(`module not found in sma.gen3.json: ${args.module}`);

  const moduleInfos = modules.map((module) => ({
    module,
    graph: args.noGraphCheck ? { graphReady: false, skipped: true } : checkModuleGraph(config.project, module.id),
    maxSlots: positiveInt(module.maxParallelAgents, positiveInt(config.config.moduleDefaults?.maxParallelAgents, 1)),
    partitions: moduleWorkPartitions(module),
  }));

  const candidates = [];
  const maxCandidateSlots = moduleInfos.reduce((max, info) => Math.max(max, candidateSlotCount(info)), 0);
  for (let slot = 1; slot <= maxCandidateSlots; slot += 1) {
    for (const info of moduleInfos) {
      if (slot > candidateSlotCount(info)) continue;
      const partition = info.partitions[slot - 1] || null;
      candidates.push({
        ...info,
        module: effectiveModuleForPartition(info.module, partition),
        baseModule: info.module,
        partition,
        slot,
      });
    }
  }

  const selectedModules = [];
  const allSlots = [];
  let agentSlot = 1;
  for (const candidate of candidates) {
    const held = heldModuleSlot(active, config.project, candidate.module, candidate.slot);
    const dirtyScope = moduleDirtyScope(candidate.module, dirtyState.paths);
    const overlap = selectedModules.find((selected) => modulesOverlap(selected.module, candidate.module));
    const slot = buildModuleSlot({
      config,
      module: candidate.module,
      baseModule: candidate.baseModule,
      partition: candidate.partition,
      slot: candidate.slot,
      agentSlot,
      graph: candidate.graph,
      held,
      dirtyScope,
      overlap,
      task: requestedTask,
    });
    if (slot.launch_ready && agentSlot <= maxAgents) {
      selectedModules.push(candidate);
      agentSlot += 1;
    }
    allSlots.push(slot);
  }

  const launchPlan = allSlots.filter((slot) => slot.launch_ready).slice(0, maxAgents);
  const graphReadyModules = moduleInfos.filter((item) => item.graph.graphReady || item.graph.graphKnownEmpty).length;
  const heldSlots = allSlots.filter((slot) => slot.held).length;
  const overlapBlocked = allSlots.filter((slot) => slot.blocked_reason === 'path-overlap').length;
  const graphBlocked = allSlots.filter((slot) => slot.blocked_reason === 'graph-not-ready').length;
  const dirtyScopeBlocked = allSlots.filter((slot) => slot.blocked_reason === 'dirty-scope').length;
  const dirtyScopePaths = allSlots.reduce((sum, slot) => sum + number(slot.dirty_scope_count), 0);
  const blockers = [];
  const warnings = [];
  if (graphBlocked) blockers.push(`${graphBlocked} module slot(s) blocked by missing module graph`);
  if (dirtyState.error) warnings.push(`dirty module scope unavailable: ${dirtyState.error}`);
  if (heldSlots) warnings.push(`${heldSlots} module work slot(s) already held`);
  if (dirtyScopeBlocked) warnings.push(`${dirtyScopeBlocked} slot(s) blocked by dirty module scope; claim cleanup or file a conflict before module launch`);
  if (overlapBlocked) warnings.push(`${overlapBlocked} slot(s) skipped to avoid overlapping module paths`);
  if (args.fillCapacity) {
    warnings.push('fill-capacity enabled; unpartitioned same-module parallel slots require task-path partitioning by the controller');
  }

  return {
    schema_version: '1.0.0',
    generated_at: new Date().toISOString(),
    project: config.project,
    project_root: config.root,
    status: blockers.length ? 'blocked' : 'ready',
    task: requestedTask,
    task_is_placeholder: !hasConcreteModuleTask(requestedTask),
    launch_mode: hasConcreteModuleTask(requestedTask) ? 'dispatch-required' : 'capacity-preview',
    summary: {
      modules_total: modules.length,
      requested_agents: maxAgents,
      candidate_slots: allSlots.length,
      launch_ready_slots: launchPlan.length,
      graph_ready_modules: graphReadyModules,
      graph_blocked_modules: moduleInfos.length - graphReadyModules,
      held_slots: heldSlots,
      path_overlap_blocked_slots: overlapBlocked,
      dirty_scope_blocked_slots: dirtyScopeBlocked,
      dirty_scope_blocked_paths: dirtyScopePaths,
      fill_capacity: Boolean(args.fillCapacity),
      partitioned_slots: allSlots.filter((slot) => slot.partition_id).length,
    },
    gains: {
      module_graph_first_token_reduction_percent_estimate: 90,
      dirty_status_token_reduction_percent_estimate: 90,
      false_portfolio_blocker_reduction_percent_estimate: 100,
      collision_reduction_percent_estimate: dirtyScopeBlocked ? 85 : overlapBlocked ? 70 : 60,
    },
    commands: {
      project_preflight: `npm run parallel:preflight -- --project ${shellArg(config.project)} --max-agents ${maxAgents}`,
      module_plan: `npm run module:plan -- --project ${shellArg(config.project)} --max-agents ${maxAgents}`,
      module_dispatch: hasConcreteModuleTask(requestedTask)
        ? `npm run module:dispatch -- --project ${shellArg(config.project)} --task ${shellArg(requestedTask)} --max-agents ${maxAgents}`
        : '',
      module_observe_write: `npm run module:observe:write -- --dispatch latest --project ${shellArg(config.project)}`,
      conflict_summary: `npm run conflict:summary -- --project ${shellArg(config.project)}`,
    },
    blockers,
    warnings,
    launch_plan: launchPlan,
    slots: allSlots,
  };
}

function maybeWriteDispatchManifest(plan) {
  if (plan.status !== 'ready' && !args.allowBlockedDispatch) {
    throw new Error(`refusing to write module dispatch manifest for ${plan.status} plan; repair blockers or pass --allow-blocked-dispatch for an explicit controller override`);
  }
  if (!hasConcreteModuleTask(plan.task)) {
    throw new Error('refusing to write module dispatch manifest without a concrete --task "..."');
  }
  return writeDispatchManifest(plan);
}

function writeDispatchManifest(plan) {
  const dispatchId = `module-wave-${timestampSlug(new Date())}`;
  const base = dispatchBasePath(args.writeDispatch === true ? dispatchId : String(args.writeDispatch || dispatchId));
  const jsonPath = `${base}.json`;
  const markdownPath = `${base}.md`;
  const packetDir = `${base}.agent-packets`;
  const manifest = {
    schema_version: '1.0.0',
    kind: 'module-work-dispatch',
    dispatch_id: dispatchId,
    created_at: new Date().toISOString(),
    project: plan.project,
    task: plan.task,
    status: plan.status,
    summary: plan.summary,
    gains: plan.gains,
    dispatch_paths: {
      json_path: relativeToSma(jsonPath),
      markdown_path: relativeToSma(markdownPath),
      agent_packets_dir: relativeToSma(packetDir),
    },
    blockers: plan.blockers,
    warnings: plan.warnings,
    controller_commands: {
      observe: `npm run module:observe -- --dispatch ${shellArg(dispatchId)} --project ${shellArg(plan.project)}`,
      observe_write: `npm run module:observe:write -- --dispatch ${shellArg(dispatchId)} --project ${shellArg(plan.project)}`,
      claim_next: moduleClaimNextCommand({ dispatch_id: dispatchId, project: plan.project, path: jsonPath }),
      agent_packets: relativeToSma(packetDir),
      project_preflight: plan.commands.project_preflight,
      project_dashboard: projectDashboardCommand(plan),
      conflict_summary: plan.commands.conflict_summary,
    },
    assignments: plan.launch_plan.map((slot) => dispatchAssignment(slot, dispatchId, base)),
    blocked_slots: plan.slots.filter((slot) => !slot.launch_ready).map((slot) => ({
      module_id: slot.module_id,
      slot: slot.slot,
      partition_id: slot.partition_id,
      partition_label: slot.partition_label,
      brick: slot.brick,
      blocked_reason: slot.blocked_reason,
      held_resource: slot.held_resource,
      dirty_scope_count: slot.dirty_scope_count,
      dirty_scope_paths: slot.dirty_scope_paths,
      dirty_scope_command: slot.dirty_scope_command,
      dirty_scope_conflict_command: slot.dirty_scope_conflict_command,
      overlap_with: slot.overlap_with,
      path_overlap_warning: slot.path_overlap_warning,
      overlap_path_pairs: slot.overlap_path_pairs,
    })),
  };
  mkdirSync(dirname(base), { recursive: true });
  writeAgentPackets(manifest, { smaRoot: SMA_ROOT });
  writeFileSync(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(markdownPath, renderDispatchMarkdown(manifest));
  return {
    dispatch_id: dispatchId,
    json_path: jsonPath,
    markdown_path: markdownPath,
  };
}

function dispatchAssignment(slot, dispatchId, dispatchBase) {
  const claimCommand = [
    'npm run module:claim --',
    '--project', shellArg(slot.project),
    '--module', shellArg(slot.module_id),
    '--slot', shellArg(slot.slot),
    slot.partition_id ? `--partition ${shellArg(slot.partition_id)}` : null,
    '--task', shellArg(slot.task || PLACEHOLDER_MODULE_TASK),
    '--dispatch-id', shellArg(dispatchId),
    '--dispatch-slot', shellArg(slot.agent_slot),
  ].filter(Boolean).join(' ');
  const agentPacket = agentPacketDescriptor({ dispatchBase, slot, smaRoot: SMA_ROOT });
  return {
    agent_slot: slot.agent_slot,
    project: slot.project,
    module_id: slot.module_id,
    task: slot.task || PLACEHOLDER_MODULE_TASK,
    dispatch_id: dispatchId,
    label: slot.label,
    slot: slot.slot,
    partition_id: slot.partition_id,
    partition_label: slot.partition_label,
    partition_description: slot.partition_description,
    brick: slot.brick,
    graph_ready: slot.graph_ready,
    graph_path: slot.graph_path,
    graph_node_count: slot.graph_node_count,
    graph_edge_count: slot.graph_edge_count,
    paths: slot.paths,
    exclude_paths: slot.exclude_paths,
    iteration_gates: slot.iteration_gates,
    required_gates: slot.required_gates,
    shared_hot_paths: slot.shared_hot_paths,
    graph_query_command: slot.graph_query_command,
    claim_command: claimCommand,
    agent_packet: agentPacket,
    prompt: slot.prompt.replace(
      'Do not claim from this preview; use the dispatch-pinned claim from the module dispatch manifest.',
      `Read your agent packet first: \`${agentPacket.markdown_path}\`. Claim with \`${claimCommand}\`.`,
    ),
  };
}

function validateDispatchClaim({ config, module, slot, partition }) {
  const dispatch = loadDispatch(args.dispatch || args.dispatchId);
  if (String(dispatch.dispatch_id) !== String(args.dispatchId)) {
    throw new Error(`dispatch id mismatch: requested ${args.dispatchId}, manifest is ${dispatch.dispatch_id}`);
  }
  if (dispatch.project !== config.project) {
    throw new Error(`dispatch project mismatch: requested ${config.project}, manifest is ${dispatch.project}`);
  }
  if (dispatch.blockers.length && !args.allowBlockedDispatch) {
    throw new Error(`dispatch has blocker(s): ${dispatch.blockers.join('; ')}`);
  }
  const freshness = dispatchFreshness(dispatch);
  if (freshness.stale && !args.allowStaleDispatch) {
    throw new Error(`dispatch ${dispatch.dispatch_id} is stale (${formatDuration(freshness.age_ms)} old, max ${formatDuration(freshness.max_age_ms)}); write a fresh module dispatch or pass --allow-stale-dispatch explicitly`);
  }
  const matches = dispatch.assignments.filter((item) => (
    String(item.project) === String(config.project)
    && String(item.module_id) === String(module.id)
    && String(item.slot) === String(slot)
    && String(item.brick) === moduleWorkBrick(module.id, slot)
    && (!args.partition || String(item.partition_id || '') === String(args.partition))
    && (!args.dispatchSlot || String(item.agent_slot) === String(args.dispatchSlot))
  ));
  if (!matches.length) {
    throw new Error(`dispatch assignment not found: dispatch=${args.dispatchId} project=${config.project} module=${module.id} slot=${slot}${args.dispatchSlot ? ` dispatch_slot=${args.dispatchSlot}` : ''}`);
  }
  if (matches.length > 1) {
    throw new Error(`dispatch assignment is ambiguous: dispatch=${args.dispatchId} project=${config.project} module=${module.id} slot=${slot}`);
  }
  const assignment = matches[0];
  if (!assignment.graph_ready && !args.noGraphCheck) {
    throw new Error(`dispatch assignment graph is not ready: ${module.id} slot ${slot}`);
  }
  return {
    ...assignment,
    dispatch_id: dispatch.dispatch_id,
    agent_slot: assignment.agent_slot,
    module_id: assignment.module_id,
    slot: assignment.slot,
    partition_id: assignment.partition_id || partition?.id || null,
    brick: assignment.brick,
    graph_ready: Boolean(assignment.graph_ready),
    claim_command: assignment.claim_command || null,
  };
}

function dispatchBasePath(input) {
  const raw = String(input || '').trim();
  const base = isPathLike(raw) ? resolve(SMA_ROOT, raw) : resolve(DEFAULT_DISPATCH_DIR, raw);
  return base.replace(/\.(json|md)$/i, '');
}

function loadDispatch(input) {
  const raw = String(input || '').trim();
  const path = raw === 'latest'
    ? latestDispatchPath(args.project || null)
    : `${dispatchBasePath(raw)}.json`;
  if (!path) throw new Error('no module-work dispatch manifest found');
  if (!existsSync(path)) throw new Error(`module-work dispatch manifest not found: ${path}`);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest.kind !== 'module-work-dispatch') {
    throw new Error(`not a module-work-dispatch manifest: ${path}`);
  }
  if (args.project && manifest.project !== args.project) {
    throw new Error(`module-work dispatch project mismatch: expected ${args.project}, got ${manifest.project || 'unknown'}`);
  }
  return {
    path,
    manifest,
    dispatch_id: manifest.dispatch_id || basename(path, '.json'),
    created_at: manifest.created_at || null,
    project: manifest.project || null,
    task: manifest.task || '',
    assignment_count: Array.isArray(manifest.assignments) ? manifest.assignments.length : 0,
    assignments: Array.isArray(manifest.assignments) ? manifest.assignments : [],
    blockers: Array.isArray(manifest.blockers) ? manifest.blockers : [],
    warnings: Array.isArray(manifest.warnings) ? manifest.warnings : [],
    summary: manifest.summary || {},
    gains: manifest.gains || {},
  };
}

function tryLoadDispatch(input, project = null) {
  const previousProject = args.project;
  if (project) args.project = project;
  try {
    return { dispatch: loadDispatch(input), error: null };
  } catch (err) {
    return { dispatch: null, error: err.message || 'failed to load dispatch' };
  } finally {
    args.project = previousProject;
  }
}

function latestDispatchPath(project = null) {
  if (!existsSync(DEFAULT_DISPATCH_DIR)) return null;
  const candidates = readdirSync(DEFAULT_DISPATCH_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^module-wave-.*\.json$/.test(entry.name))
    .map((entry) => resolve(DEFAULT_DISPATCH_DIR, entry.name))
    .sort((left, right) => right.localeCompare(left));
  if (!project) return candidates[0] || null;
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8'));
      if (manifest.kind === 'module-work-dispatch' && manifest.project === project) return candidate;
    } catch {
      // Ignore malformed candidates while looking for the newest valid project dispatch.
    }
  }
  return null;
}

function observeDispatch(dispatch) {
  const activeState = safeReadActiveLeases();
  const guardState = dispatchAssignmentGuards(dispatch, activeState.leases);
  let assignments = dispatch.assignments.map((assignment) => observeAssignment(
    assignment,
    dispatch.created_at,
    activeState.leases,
    guardState.guards.get(moduleSlotKey(assignment)),
  ));
  const freshness = dispatchFreshness(dispatch);
  const initialClaimed = assignments.filter((item) => item.claimed).length;
  const initialActive = assignments.filter((item) => item.active).length;
  const initialCompleted = assignments.filter((item) => item.completed).length;
  const staleUnclaimed = freshness.stale
    && !args.allowStaleDispatch
    && assignments.length > 0
    && initialClaimed === 0
    && initialActive === 0
    && initialCompleted === 0;
  if (staleUnclaimed) assignments = blockStaleDispatchAssignments(assignments, freshness);
  const claimed = assignments.filter((item) => item.claimed).length;
  const active = assignments.filter((item) => item.active).length;
  const completed = assignments.filter((item) => item.completed).length;
  const unclaimed = assignments.filter((item) => !item.claimed).length;
  const claimableUnclaimed = assignments.filter((item) => isClaimableDispatchAssignment(item)).length;
  const launchBlockedUnclaimed = assignments.filter((item) => item.launch_blocked && !item.claimed).length;
  const blockedCounts = blockedReasonCounts(assignments);
  const externalActiveModuleLeases = externalActiveModuleLeaseGroups(assignments);
  const openConflicts = assignments.reduce((sum, item) => sum + item.open_conflicts, 0);
  const contextErrors = assignments.filter((item) => item.context_error).length;
  const blockers = [
    ...dispatch.blockers.map((item) => `dispatch: ${item}`),
    staleUnclaimed ? staleDispatchBlocker(dispatch, freshness) : null,
    openConflicts ? `${openConflicts} open module conflict(s)` : null,
  ].filter(Boolean);
  const warnings = [
    ...dispatch.warnings.map((item) => `dispatch: ${item}`),
    ...guardState.warnings,
    activeState.error ? `active lease registry: ${activeState.error}` : null,
    contextErrors ? `${contextErrors} module context log(s) could not be read` : null,
    externalActiveModuleLeases.length
      ? `${externalActiveModuleLeases.reduce((sum, item) => sum + item.slot_count, 0)} dispatch slot(s) occupied by ${externalActiveModuleLeases.length} external active module lease(s): ${formatExternalActiveLeases(externalActiveModuleLeases)}`
      : null,
    blockedCounts.held ? `${blockedCounts.held} unclaimed dispatch slot(s) reserved by active module lease(s)` : null,
    blockedCounts.dirtyScope ? `${blockedCounts.dirtyScope} unclaimed dispatch slot(s) blocked by dirty module scope` : null,
    blockedCounts.other ? `${blockedCounts.other} unclaimed dispatch slot(s) blocked by other launch guard(s)` : null,
    unclaimed ? `${unclaimed} dispatched module slot(s) are still unclaimed` : null,
  ].filter(Boolean);

  let status = blockers.length ? 'blocked' : 'dispatch-only';
  if (!blockers.length && assignments.length && completed === assignments.length) status = 'complete';
  else if (!blockers.length && active > 0) status = 'in-progress';
  else if (!blockers.length && claimed > 0) status = 'partial';
  else if (!assignments.length) status = 'empty';

  const observation = {
    schema_version: '1.0.0',
    kind: 'module-work-observation',
    generated_at: new Date().toISOString(),
    status,
    dispatch: {
      dispatch_id: dispatch.dispatch_id,
      path: relativeToSma(dispatch.path),
      created_at: dispatch.created_at,
      project: dispatch.project,
      task: dispatch.task,
      assignment_count: dispatch.assignment_count,
      predicted_launch_ready_slots: number(dispatch.summary.launch_ready_slots),
      predicted_requested_agents: number(dispatch.summary.requested_agents),
    },
    summary: {
      assignment_count: assignments.length,
      claimed,
      active,
      completed,
      unclaimed,
      claimable_unclaimed: claimableUnclaimed,
      launch_blocked_unclaimed: launchBlockedUnclaimed,
      held_blocked_unclaimed: blockedCounts.held,
      dirty_scope_blocked_unclaimed: blockedCounts.dirtyScope,
      other_blocked_unclaimed: blockedCounts.other,
      external_active_slot_count: externalActiveModuleLeases.reduce((sum, item) => sum + item.slot_count, 0),
      external_active_lease_count: externalActiveModuleLeases.length,
      external_active_module_count: new Set(externalActiveModuleLeases.map((item) => item.module_id).filter(Boolean)).size,
      open_conflicts: openConflicts,
      graph_ready: assignments.filter((item) => item.graph_ready).length,
      context_errors: contextErrors,
      active_lease_registry_generated_at: activeState.generated_at,
      dispatch_age_ms: freshness.age_ms,
      dispatch_max_age_ms: freshness.max_age_ms,
      dispatch_stale: freshness.stale,
      dispatch_stale_unclaimed: staleUnclaimed,
    },
    gains: {
      predicted_graph_first_token_reduction_percent: number(dispatch.gains.module_graph_first_token_reduction_percent_estimate),
      predicted_dirty_status_token_reduction_percent: number(dispatch.gains.dirty_status_token_reduction_percent_estimate),
      predicted_false_portfolio_blocker_reduction_percent: number(dispatch.gains.false_portfolio_blocker_reduction_percent_estimate),
      predicted_collision_reduction_percent: number(dispatch.gains.collision_reduction_percent_estimate),
      observed_claimed_percent: percent(claimed, assignments.length),
      observed_completed_percent: percent(completed, assignments.length),
    },
    comparison: {
      predicted_requested_agents: number(dispatch.summary.requested_agents),
      predicted_launch_ready_slots: number(dispatch.summary.launch_ready_slots),
      dispatched_slots: assignments.length,
      observed_claimed_slots: claimed,
      observed_active_slots: active,
      observed_completed_slots: completed,
      observed_unclaimed_slots: unclaimed,
      observed_claimable_unclaimed_slots: claimableUnclaimed,
      observed_launch_blocked_unclaimed_slots: launchBlockedUnclaimed,
      observed_held_blocked_unclaimed_slots: blockedCounts.held,
      observed_dirty_scope_blocked_unclaimed_slots: blockedCounts.dirtyScope,
      observed_other_blocked_unclaimed_slots: blockedCounts.other,
      observed_external_active_slots: externalActiveModuleLeases.reduce((sum, item) => sum + item.slot_count, 0),
      observed_external_active_leases: externalActiveModuleLeases.length,
      observed_open_conflicts: openConflicts,
      launch_ready_to_dispatched_delta: number(dispatch.summary.launch_ready_slots) - assignments.length,
      dispatched_to_claimed_delta: assignments.length - claimed,
      dispatched_to_completed_delta: assignments.length - completed,
    },
    blockers,
    warnings,
    next: chooseObservationNext({ dispatch, assignments, status, openConflicts, unclaimed, staleUnclaimed }),
    external_active_module_leases: externalActiveModuleLeases,
    assignments,
  };
  return {
    ...observation,
    big_picture: moduleObservationBigPicture(observation),
  };
}

function moduleWatch() {
  const plan = buildPlan();
  const requestedDispatch = args.dispatch || 'latest';
  const { dispatch, error } = tryLoadDispatch(requestedDispatch, plan.project);
  const observation = dispatch ? observeDispatch(dispatch) : null;
  const concreteTask = hasConcreteModuleTask(plan.task);
  const capacity = {
    requested_agents: number(plan.summary.requested_agents),
    launch_ready_slots: number(plan.summary.launch_ready_slots),
    modules_total: number(plan.summary.modules_total),
    graph_ready_modules: number(plan.summary.graph_ready_modules),
    graph_blocked_modules: number(plan.summary.graph_blocked_modules),
    held_slots: number(plan.summary.held_slots),
    held_modules: plan.slots.filter((slot) => slot.held).map(({ module_id, slot, held_resource, held_by, held_match }) => ({ module_id, slot, held_resource, held_by, held_match })).slice(0, 8),
    path_overlap_blocked_slots: number(plan.summary.path_overlap_blocked_slots),
  };
  const dispatchMissing = !dispatch;
  const activeLane = observation
    ? observation.status === 'complete' ? 'module-complete' : 'module-observe'
    : concreteTask ? 'module-dispatch' : 'module-capacity-preview';
  const next = observation
    ? observation.next
    : concreteTask
      ? `npm run module:dispatch -- --project ${shellArg(plan.project)} --task ${shellArg(plan.task)} --max-agents ${capacity.requested_agents}`
      : `npm run module:plan -- --project ${shellArg(plan.project)} --max-agents ${capacity.requested_agents}`;
  const watch = {
    schema_version: '1.0.0',
    kind: 'module-wave-watch',
    generated_at: new Date().toISOString(),
    status: observation?.status || (dispatchMissing ? 'dispatch-missing' : 'unknown'),
    active_lane: activeLane,
    project: plan.project,
    task: plan.task,
    task_is_placeholder: !concreteTask,
    launchable_agents: observation ? number(observation.summary.claimable_unclaimed) : 0,
    capacity,
    dispatch: dispatch
      ? {
          available: true,
          dispatch_id: dispatch.dispatch_id,
          path: relativeToSma(dispatch.path),
          created_at: dispatch.created_at,
          assignment_count: dispatch.assignment_count,
          latest_observation: latestObservationForDispatch({ dispatchId: dispatch.dispatch_id, observationDir: DEFAULT_OBSERVATION_DIR, rootDir: SMA_ROOT }),
        }
      : {
          available: false,
          error,
        },
    progress: observation
      ? observation.summary
      : {
          assignment_count: 0,
          claimed: 0,
          active: 0,
          completed: 0,
          unclaimed: 0,
          claimable_unclaimed: 0,
          launch_blocked_unclaimed: 0,
          held_blocked_unclaimed: 0,
          dirty_scope_blocked_unclaimed: 0,
          other_blocked_unclaimed: 0,
          external_active_slot_count: 0,
          external_active_lease_count: 0,
          external_active_module_count: 0,
          open_conflicts: 0,
          graph_ready: 0,
        },
    gains: observation
      ? observation.gains
      : {
          predicted_graph_first_token_reduction_percent: number(plan.gains.module_graph_first_token_reduction_percent_estimate),
          predicted_dirty_status_token_reduction_percent: number(plan.gains.dirty_status_token_reduction_percent_estimate),
          predicted_false_portfolio_blocker_reduction_percent: number(plan.gains.false_portfolio_blocker_reduction_percent_estimate),
          predicted_collision_reduction_percent: number(plan.gains.collision_reduction_percent_estimate),
          observed_claimed_percent: 0,
          observed_completed_percent: 0,
        },
    blockers: observation?.blockers || plan.blockers || [],
    warnings: observation
      ? observation.warnings
      : [
          dispatchMissing ? 'module dispatch manifest is missing; write dispatch before launching agents' : null,
          ...plan.warnings,
        ].filter(Boolean),
    next,
  };
  return {
    ...watch,
    big_picture: moduleWatchBigPicture(watch),
  };
}
function observeAssignment(assignment, createdAt, activeLeases, guard = null) {
  const activeMatches = (Array.isArray(activeLeases) ? activeLeases : [])
    .filter((lease) => leaseMatchesAssignment(lease, assignment));
  const context = contextEventsSince(assignment.project, assignment.brick, createdAt);
  const claimLeaseIds = new Set(activeMatches.map((lease) => lease.lease_id).filter(Boolean));
  const claimEvents = context.events.filter((event) => (
    CLAIM_KINDS.has(event.kind)
    && eventMatchesAssignment(event, assignment)
  ));
  for (const event of claimEvents) {
    if (event.lease_id) claimLeaseIds.add(event.lease_id);
  }
  const completionEvents = context.events.filter((event) => (
    COMPLETE_KINDS.has(event.kind)
    && (eventMatchesAssignment(event, assignment) || claimLeaseIds.has(event.lease_id))
  ));
  const openConflicts = openConflictCount(context.events);
  const active = activeMatches.length > 0;
  const completed = completionEvents.length > 0;
  const claimed = completed || active || claimEvents.length > 0;
  const launchBlocked = !claimed && Boolean(guard?.launch_blocked);
  const status = openConflicts > 0
    ? 'conflict'
    : completed
      ? 'completed'
      : active
        ? 'active'
        : claimEvents.length
          ? 'claimed'
          : launchBlocked
            ? 'launch-blocked'
            : context.error
              ? 'context-error'
              : 'unclaimed';

  return {
    key: assignmentKey(assignment),
    agent_slot: assignment.agent_slot ?? null,
    project: assignment.project ?? null,
    module_id: assignment.module_id ?? null,
    task: assignment.task ?? null,
    dispatch_id: assignment.dispatch_id ?? null,
    slot: assignment.slot ?? null,
    partition_id: assignment.partition_id ?? null,
    partition_label: assignment.partition_label ?? null,
    brick: assignment.brick ?? null,
    status,
    claimed,
    active,
    completed,
    graph_ready: Boolean(assignment.graph_ready),
    graph_path: assignment.graph_path ?? null,
    agent_packet_markdown_path: assignment.agent_packet?.markdown_path || '',
    claim_command: assignment.claim_command ?? null,
    conflict_command: assignment.conflict_command || moduleConflictCommand({ project: assignment.project, moduleId: assignment.module_id, slot: assignment.slot, task: assignment.task, moduleWorkBrick, shellArg }),
    open_conflicts: openConflicts,
    context_error: context.error,
    context_events_checked: context.events.length,
    claim_event_count: claimEvents.length,
    completion_event_count: completionEvents.length,
    active_lease_count: activeMatches.length,
    latest_claim_event: summarizeContextEvent(latestEvent(claimEvents)),
    latest_completion_event: summarizeContextEvent(latestEvent(completionEvents)),
    active_leases: activeMatches.map(summarizeLease),
    launch_blocked: launchBlocked,
    launch_blocked_reason: guard?.launch_blocked_reason || null,
    held_resource: guard?.held_resource || null,
    held_lease_id: guard?.held_lease_id || null,
    held_by: guard?.held_by || null,
    held_match: guard?.held_match || null,
    dirty_scope_count: number(guard?.dirty_scope_count),
    dirty_scope_paths: guard?.dirty_scope_paths || [],
    dirty_scope_command: guard?.dirty_scope_command || null,
    dirty_scope_conflict_command: guard?.dirty_scope_conflict_command || null,
  };
}

function contextEventsSince(project, brick, createdAt) {
  try {
    const since = Date.parse(createdAt || 0);
    const events = readContextLog(project, brick)
      .filter((event) => !event._malformed)
      .filter((event) => {
        if (!Number.isFinite(since) || since <= 0) return true;
        const timestamp = Date.parse(event.timestamp || 0);
        return Number.isFinite(timestamp) && timestamp >= since;
      });
    return { events, error: null };
  } catch (err) {
    return { events: [], error: err.message || 'failed to read context log' };
  }
}

function openConflictCount(events) {
  let open = 0;
  for (const event of events) {
    if (event.kind === 'conflict_detected') open += 1;
    if (event.kind === 'conflict_resolved' && open > 0) open -= 1;
  }
  return open;
}

function chooseObservationNext({ dispatch, assignments, status, openConflicts, unclaimed, staleUnclaimed = false }) {
  if (openConflicts > 0) return `npm run conflict:summary -- --project ${shellArg(dispatch.project)}`;
  if (staleUnclaimed) return freshDispatchCommand(dispatch);
  const firstSafeUnclaimed = nextDispatchClaimAssignment({ assignments });
  if (unclaimed > 0 && firstSafeUnclaimed) return moduleClaimNextCommand(dispatch);
  if (status === 'complete') {
    return `npm run parallel:preflight -- --project ${shellArg(dispatch.project)} --max-agents ${assignments.length || 12}`;
  }
  return `npm run module:observe:write -- --dispatch ${shellArg(dispatch.dispatch_id)} --project ${shellArg(dispatch.project)}`;
}

function dispatchFreshness(dispatch) {
  const maxAgeMs = positiveInt(args.dispatchMaxAgeMs ?? process.env.SMA_MODULE_DISPATCH_STALE_MS, DEFAULT_STALE_UNCLAIMED_DISPATCH_MS);
  const createdMs = Date.parse(dispatch?.created_at || 0);
  const nowMs = Date.now();
  const ageMs = Number.isFinite(createdMs) && createdMs > 0 ? Math.max(0, nowMs - createdMs) : 0;
  return {
    created_ms: Number.isFinite(createdMs) && createdMs > 0 ? createdMs : null,
    age_ms: ageMs,
    max_age_ms: maxAgeMs,
    stale: Boolean(Number.isFinite(createdMs) && createdMs > 0 && ageMs > maxAgeMs),
  };
}

function blockStaleDispatchAssignments(assignments, freshness) {
  return assignments.map((item) => {
    if (!isClaimableDispatchAssignment(item)) return item;
    return {
      ...item,
      status: 'launch-blocked',
      launch_blocked: true,
      launch_blocked_reason: 'dispatch-stale',
      stale_dispatch_age_ms: freshness.age_ms,
      stale_dispatch_max_age_ms: freshness.max_age_ms,
    };
  });
}

function staleDispatchBlocker(dispatch, freshness) {
  return `dispatch ${dispatch.dispatch_id} is stale and unclaimed (${formatDuration(freshness.age_ms)} old, max ${formatDuration(freshness.max_age_ms)}); write a fresh module dispatch before launching agents`;
}

function freshDispatchCommand(dispatch) {
  const task = hasConcreteModuleTask(dispatch.task) ? dispatch.task : PLACEHOLDER_MODULE_TASK;
  return `npm run module:dispatch -- --project ${shellArg(dispatch.project)} --task ${shellArg(task)} --max-agents ${positiveInt(dispatch.assignment_count, 12)}`;
}

function nextDispatchClaimAssignment(observation) {
  return (observation.assignments || []).find((item) => isClaimableDispatchAssignment(item)) || null;
}

function isClaimableDispatchAssignment(item) {
  return Boolean(
    item
    && !item.claimed
    && item.status === 'unclaimed'
    && item.open_conflicts === 0
    && item.graph_ready
    && !item.context_error
    && !item.launch_blocked,
  );
}

function dispatchAssignmentGuards(dispatch, activeLeases) {
  const guards = new Map();
  const warnings = [];
  let config = null;
  try {
    config = loadProjectConfig(dispatch.project);
  } catch (err) {
    warnings.push(`current module-plan guard unavailable: ${err.message || 'project config failed to load'}`);
    return { guards, warnings };
  }
  const active = { leases: Array.isArray(activeLeases) ? activeLeases : [] };
  const dirtyState = readProjectDirtyPaths(dispatch.project);
  if (dirtyState.error) warnings.push(`dirty module scope unavailable: ${dirtyState.error}`);
  for (const assignment of dispatch.assignments || []) {
    const module = config.modules.find((item) => item.id === assignment.module_id);
    if (!module) {
      guards.set(moduleSlotKey(assignment), {
        launch_blocked: true,
        launch_blocked_reason: 'module-not-found',
      });
      continue;
    }
    const partition = modulePartitionForAssignment(module, assignment);
    const effectiveModule = effectiveModuleForPartition(module, partition);
    const held = heldModuleSlot(active, config.project, effectiveModule, positiveInt(assignment.slot, 1));
    if (held) {
      guards.set(moduleSlotKey(assignment), {
        launch_blocked: true,
        launch_blocked_reason: 'held',
        held_resource: held.resource_id || null,
        held_lease_id: held.lease_id || null,
        held_by: held.agent_id || null,
        held_match: held._module_related ? 'module-related-active-lease' : 'exact-slot-lease',
      });
      continue;
    }
    const dirtyScope = moduleDirtyScope(effectiveModule, dirtyState.paths);
    if (!dirtyScope.count) continue;
    guards.set(moduleSlotKey(assignment), {
      launch_blocked: true,
      launch_blocked_reason: 'dirty-scope',
      dirty_scope_count: dirtyScope.count,
      dirty_scope_paths: dirtyScope.paths,
      dirty_scope_command: dirtyScopeClaimCommand(config.project, dirtyScope),
      dirty_scope_conflict_command: dirtyScopeConflictCommand(config.project, module.id, dirtyScope),
    });
  }
  return { guards, warnings };
}

function modulePartitionForAssignment(module, assignment) {
  const partitions = moduleWorkPartitions(module);
  if (!partitions.length) return null;
  if (assignment.partition_id) {
    return partitions.find((partition) => String(partition.id) === String(assignment.partition_id)) || null;
  }
  return partitions[positiveInt(assignment.slot, 1) - 1] || null;
}

function moduleClaimNextCommand(dispatch) {
  return `npm run module:claim -- --project ${shellArg(dispatch.project)} --next --dispatch ${shellArg(dispatchCommandRef(dispatch))}`;
}

function dispatchCommandRef(dispatch) {
  const rawPath = dispatch.path || dispatch.dispatch_path || '';
  if (!rawPath) return dispatch.dispatch_id;
  const relativePath = relativeToSma(rawPath).replace(/\.json$/i, '');
  const defaultPath = relativeToSma(resolve(DEFAULT_DISPATCH_DIR, String(dispatch.dispatch_id || ''))).replace(/\.json$/i, '');
  if (relativePath && relativePath !== defaultPath) return relativePath;
  return dispatch.dispatch_id;
}

function claimNextLeaseResource(dispatch) {
  return `module-claim-next:${safeId(dispatch.project)}:${safeId(dispatch.dispatch_id)}`;
}

function writeObservation(observation) {
  const base = observationBasePath(observation);
  const jsonPath = `${base}.json`;
  const markdownPath = `${base}.md`;
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(observation, null, 2)}\n`);
  writeFileSync(markdownPath, renderObservationMarkdown(observation, { blockedReasonSuffix, formatPercent }));
  return {
    json_path: relativeToSma(jsonPath),
    markdown_path: relativeToSma(markdownPath),
  };
}

function observationBasePath(observation) {
  if (args.write !== true) {
    return resolve(SMA_ROOT, String(args.write || '').trim()).replace(/\.(json|md)$/i, '');
  }
  return resolve(DEFAULT_OBSERVATION_DIR, `${observation.dispatch.dispatch_id}-observed-${timestampSlug(new Date())}`);
}

function safeReadActiveLeases() {
  try {
    const state = readActiveLeases({ excludeVolatileSmaRegenLeases: true });
    return {
      generated_at: state.generated_at || null,
      leases: Array.isArray(state.leases) ? state.leases : [],
      error: state._error || null,
    };
  } catch (err) {
    return {
      generated_at: null,
      leases: [],
      error: err.message || 'failed to read active leases',
    };
  }
}

function leaseMatchesAssignment(lease, assignment) {
  return lease
    && lease.project === assignment.project
    && lease.resource_kind === 'brick'
    && lease.resource_id === assignment.brick;
}

function eventMatchesAssignment(event, assignment) {
  if (!event || event._malformed) return false;
  const taskId = moduleTaskId(assignment);
  if (event.task_id && event.task_id === taskId) return true;
  if (event.brick_id && event.brick_id === assignment.brick) return true;
  const text = eventSearchText(event);
  if (text.includes(taskId)) return true;
  if (text.includes(`module=${assignment.module_id}`) && text.includes(`slot=${assignment.slot}`)) return true;
  if (assignment.dispatch_id && text.includes(`dispatch_id=${assignment.dispatch_id}`)) return true;
  return false;
}

function eventSearchText(event) {
  return [
    event.task_id,
    event.decision_rationale,
    event.intent,
    event.lease_id,
    ...(Array.isArray(event.files_touched) ? event.files_touched : []),
  ].filter(Boolean).join(' ');
}

function moduleTaskId(assignment) {
  return `module-work-${assignment.project}-${assignment.module_id}-${assignment.slot}`;
}

function assignmentKey(assignment) {
  return [
    assignment.project ?? '',
    assignment.brick ?? '',
    assignment.agent_slot ?? '',
  ].join(':');
}

function moduleSlotKey(assignment) {
  return [
    assignment.project ?? '',
    assignment.module_id ?? '',
    positiveInt(assignment.slot, 1),
  ].join(':');
}

function latestEvent(events) {
  if (!Array.isArray(events) || !events.length) return null;
  return events
    .slice()
    .sort((left, right) => Date.parse(right.timestamp || 0) - Date.parse(left.timestamp || 0))[0] || null;
}

function summarizeContextEvent(event) {
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

function summarizeLease(lease) {
  return {
    lease_id: lease.lease_id || null,
    agent_id: lease.agent_id || null,
    acquired_at: lease.acquired_at || null,
    expires_at: lease.expires_at || null,
    intent: lease.intent || null,
  };
}

function buildModuleSlot({ config, module, baseModule = module, partition = null, slot, agentSlot, graph, held, dirtyScope = null, overlap = null, task }) {
  const graphReady = Boolean(graph.graphReady || graph.graphKnownEmpty);
  const graphQuestion = partition
    ? `Map the files, entry points, dependencies, tests, and risks for this ${module.id} partition task. Partition: ${partition.id}. Paths: ${(module.paths || []).join(', ')}.`
    : 'Map the files, entry points, dependencies, tests, and risks for this module task.';
  const graphCommand = `npm run graphify:query -- --project ${shellArg(config.project)} --module ${shellArg(module.id)} -- ${shellArg(graphQuestion)}`;
  const claimCommand = '';
  let blockedReason = null;
  if (!graphReady) blockedReason = 'graph-not-ready';
  else if (held) blockedReason = 'held';
  else if (dirtyScope?.count) blockedReason = 'dirty-scope';
  else if (overlap && !args.fillCapacity) blockedReason = 'path-overlap';
  const gates = moduleGates(config, module);
  const iterationGates = moduleIterationGates(config, module);
  const sharedWarnings = overlappingSharedHotPaths(config.config.sharedHotPaths || [], module);
  const overlapPathPairs = overlap ? overlappingModulePathPairs(module, overlap.module) : [];
  return {
    agent_slot: agentSlot,
    project: config.project,
    module_id: module.id,
    label: partition?.label || module.label || module.id,
    task,
    slot,
    partition_id: partition?.id || null,
    partition_label: partition?.label || null,
    partition_description: partition?.description || null,
    brick: moduleWorkBrick(module.id, slot),
    launch_ready: !blockedReason,
    blocked_reason: blockedReason,
    held: Boolean(held),
    held_by: held?.agent_id || null,
    held_lease_id: held?.lease_id || null,
    held_resource: held?.resource_id || null,
    held_match: held?._module_related ? 'module-related-active-lease' : held ? 'exact-slot-lease' : null,
    dirty_scope_count: number(dirtyScope?.count),
    dirty_scope_paths: dirtyScope?.paths || [],
    dirty_scope_command: dirtyScope?.count ? dirtyScopeClaimCommand(config.project, dirtyScope) : null,
    dirty_scope_conflict_command: dirtyScope?.count ? dirtyScopeConflictCommand(config.project, module.id, dirtyScope) : null,
    overlap_with: overlap?.module?.id || null,
    path_overlap_warning: overlap ? `${module.id} overlaps ${overlap.module.id}` : null,
    overlap_path_pairs: overlapPathPairs,
    shared_hot_paths: sharedWarnings,
    max_parallel_agents: positiveInt(module.maxParallelAgents, positiveInt(config.config.moduleDefaults?.maxParallelAgents, 1)),
    paths: module.paths || [],
    module_paths: baseModule.paths || module.paths || [],
    iteration_gates: iterationGates,
    required_gates: gates,
    graph_ready: graphReady,
    graph_known_empty: Boolean(graph.graphKnownEmpty),
    graph_node_count: graph.nodeCount ?? null,
    graph_edge_count: graph.edgeCount ?? null,
    graph_path: graph.graphPath || null,
    graph_query_command: graphCommand,
    exclude_paths: module.excludePaths || [],
    claim_command: claimCommand,
    prompt: modulePrompt({ config, module, partition, slot, task, graphCommand, iterationGates, gates, sharedWarnings, claimCommand, moduleWorkBrick, shellArg }),
  };
}

function loadProjectConfig(project) {
  const root = projectRoot(project);
  const file = resolve(root, 'sma.gen3.json');
  if (!existsSync(file)) throw new Error(`sma.gen3.json not found for ${project}: ${file}`);
  const config = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(config.modules) || !config.modules.length) {
    throw new Error(`sma.gen3.json has no modules: ${file}`);
  }
  return {
    project,
    root,
    config,
    modules: config.modules.map((module) => ({
      ...module,
      id: String(module.id || '').trim(),
      paths: Array.isArray(module.paths) ? module.paths : [],
      excludePaths: Array.isArray(module.excludePaths) ? module.excludePaths : [],
      iterationLocalGates: Array.isArray(module.iterationLocalGates) ? module.iterationLocalGates : [],
      workPartitions: normalizeWorkPartitions(module),
    })).filter((module) => module.id),
  };
}

function selectModule(config) {
  const module = config.modules.find((item) => item.id === args.module);
  if (!module) throw new Error(`module not found in ${config.project}: ${args.module}`);
  return module;
}

function normalizeWorkPartitions(module) {
  if (!Array.isArray(module.workPartitions)) return [];
  return module.workPartitions
    .map((partition, index) => ({
      ...partition,
      id: safeId(partition.id || `partition-${index + 1}`),
      label: partition.label || partition.id || `Partition ${index + 1}`,
      description: partition.description || '',
      paths: Array.isArray(partition.paths) ? partition.paths : [],
      excludePaths: Array.isArray(partition.excludePaths) ? partition.excludePaths : [],
      iterationLocalGates: Array.isArray(partition.iterationLocalGates) ? partition.iterationLocalGates : [],
      requiredLocalGates: Array.isArray(partition.requiredLocalGates) ? partition.requiredLocalGates : [],
    }))
    .filter((partition) => partition.paths.length);
}

function moduleWorkPartitions(module) {
  return Array.isArray(module.workPartitions) ? module.workPartitions : [];
}

function candidateSlotCount(info) {
  if (info.partitions.length) return Math.min(info.maxSlots, info.partitions.length);
  return args.fillCapacity ? info.maxSlots : 1;
}

function modulePartitionForClaim(module, slot) {
  const partitions = moduleWorkPartitions(module);
  if (!partitions.length) return null;
  const explicit = args.partition
    ? partitions.find((partition) => String(partition.id) === String(args.partition))
    : null;
  if (args.partition && !explicit) {
    throw new Error(`partition not found for ${module.id}: ${args.partition}`);
  }
  const partition = explicit || partitions[slot - 1] || null;
  if (partition && args.partition && partitions[slot - 1] && partitions[slot - 1].id !== partition.id) {
    throw new Error(`partition ${args.partition} does not match ${module.id} slot ${slot}; expected ${partitions[slot - 1].id}`);
  }
  return partition;
}

function effectiveModuleForPartition(module, partition) {
  if (!partition) return module;
  return {
    ...module,
    label: partition.label || module.label,
    paths: partition.paths,
    excludePaths: partition.excludePaths || [],
    partitionIterationLocalGates: partition.iterationLocalGates || [],
    partitionRequiredLocalGates: partition.requiredLocalGates || [],
  };
}

function checkModuleGraph(project, moduleId) {
  try {
    const raw = execFileSync(process.execPath, [
      resolve(TOOLS_DIR, 'sma-graphify.mjs'),
      'check',
      '--project', project,
      '--module', moduleId,
      '--json',
    ], {
      cwd: SMA_ROOT,
      encoding: 'utf8',
      timeout: positiveInt(args.graphTimeoutMs, 15000),
      maxBuffer: 4 * 1024 * 1024,
    });
    const start = raw.indexOf('{');
    const data = JSON.parse(start >= 0 ? raw.slice(start) : raw);
    return data;
  } catch (err) {
    return {
      ok: false,
      graphReady: false,
      error: err.stderr?.toString()?.trim() || err.message,
    };
  }
}

function heldModuleSlot(active, project, module, slot) {
  const brick = moduleWorkBrick(module.id, slot);
  const exact = (active.leases || []).find((lease) => (
    lease.project === project
    && lease.resource_kind === 'brick'
    && lease.resource_id === brick
  ));
  if (exact) return exact;
  const moduleKeys = moduleLeaseKeys(module);
  const partitionedModuleWorkPrefix = module.workPartitions?.length
    ? `module-work-${safeId(module.id).toLowerCase()}-slot-`
    : null;
  const related = (active.leases || []).find((lease) => (
    lease.project === project
    && lease.resource_kind === 'brick'
    && !(partitionedModuleWorkPrefix && safeId(lease.resource_id).toLowerCase().startsWith(partitionedModuleWorkPrefix))
    && moduleKeys.some((key) => leaseResourceMatchesKey(lease.resource_id, key))
  ));
  return related ? { ...related, _module_related: true } : null;
}

function readProjectDirtyPaths(project) {
  try {
    const root = projectRoot(project);
    const raw = execFileSync('git', ['-C', root, 'status', '--short', '--untracked-files=all'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      paths: parseGitShortDirtyPaths(raw),
      error: null,
    };
  } catch (err) {
    return {
      paths: [],
      error: err.stderr?.toString()?.trim() || err.message || 'git status failed',
    };
  }
}

function parseGitShortDirtyPaths(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const value = line.length > 3 ? line.slice(3).trim() : line.trim();
      return value.includes(' -> ') ? value.split(' -> ').pop().trim() : value;
    })
    .filter(Boolean)
    .map((value) => value.replace(/^"|"$/g, '').replace(/\\/g, '/'));
}

function moduleDirtyScope(module, dirtyPaths) {
  const paths = [];
  for (const dirtyPath of dirtyPaths || []) {
    if (!modulePathOwnsDirtyPath(module, dirtyPath)) continue;
    paths.push(dirtyPath);
  }
  const unique = [...new Set(paths)].sort();
  const group = dirtyGroupForPath(unique[0] || module.paths?.[0] || module.id);
  return {
    count: unique.length,
    paths: unique.slice(0, 12),
    group,
    brick: `dirty-${safeId(group)}`,
  };
}

function modulePathOwnsDirtyPath(module, dirtyPath) {
  const normalized = String(dirtyPath || '').replace(/\\/g, '/');
  if (!normalized) return false;
  if ((module.excludePaths || []).some((pattern) => pathPatternCovers(pattern, normalized))) return false;
  return (module.paths || []).some((pattern) => pathPatternCovers(pattern, normalized));
}

function dirtyGroupForPath(pathValue) {
  const parts = String(pathValue || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts[0] === 'src' && parts[1] === 'renderer' && parts[2] === 'modules' && parts[3]) {
    return parts.slice(0, 4).join('/');
  }
  if (parts[0] === 'src' && parts[1] === 'main' && parts[2] === 'services' && parts[3]) {
    return parts.slice(0, 4).join('/');
  }
  if (parts[0] === 'src' && parts[1] === 'shared' && parts[2]) {
    return parts.slice(0, 3).join('/');
  }
  if (parts[0] === 'supabase' && parts[1] === 'functions' && parts[2]) {
    return parts.slice(0, 3).join('/');
  }
  if (parts[0] === 'web' || parts[0] === 'website' || parts[0] === 'mobile') return parts[0];
  return parts.slice(0, Math.min(parts.length, 2)).join('/') || 'module';
}

function dirtyScopeClaimCommand(project, dirtyScope) {
  return `npm run start:edit -- --project ${shellArg(project)} --brick ${shellArg(dirtyScope.brick)} --intent ${shellArg(`claim dirty module scope ${dirtyScope.group} (${dirtyScope.count} path${dirtyScope.count === 1 ? '' : 's'})`)}`;
}

function dirtyScopeConflictCommand(project, moduleId, dirtyScope) {
  return `npm run conflict -- report --project ${shellArg(project)} --brick ${shellArg(dirtyScope.brick)} --intent ${shellArg(`dirty module scope ${dirtyScope.group} overlaps module ${moduleId}`)} --resolution-plan ${shellArg('claim cleanup, split paths, wait for owner, or hand off before module launch')}`;
}

function moduleLeaseKeys(module) {
  const keys = new Set([safeId(module.id).toLowerCase()]);
  for (const path of module.paths || []) {
    const first = String(path || '').split('/').find(Boolean);
    if (first) keys.add(safeId(first).toLowerCase());
    const parts = String(path || '').split('/').filter(Boolean);
    if (parts[0] === 'src' && parts[1] === 'renderer' && parts[2] === 'modules' && parts[3]) {
      keys.add(safeId(parts[3]).toLowerCase());
    }
    if (parts[0] === 'web') keys.add('web');
    if (parts[0] === 'website') keys.add('website');
    if (parts[0] === 'supabase') keys.add('supabase');
    if (parts[0] === 'mobile') keys.add('mobile');
  }
  return [...keys].filter((key) => key.length >= 2);
}

function leaseResourceMatchesKey(resource, key) {
  const value = safeId(resource).toLowerCase();
  return value === key
    || value.startsWith(`${key}-`)
    || value.startsWith(`${key}.`)
    || value.includes(`-${key}-`)
    || value.includes(`.${key}.`);
}

function moduleWorkBrick(moduleId, slot) {
  return `module-work-${safeId(moduleId)}-slot-${positiveInt(slot, 1)}`;
}

function moduleGates(config, module) {
  const baseGates = Array.isArray(module.requiredLocalGates) && module.requiredLocalGates.length
    ? module.requiredLocalGates
    : config.config.moduleDefaults?.requiredLocalGates;
  const gates = Array.isArray(baseGates) ? [...baseGates] : [];
  if (Array.isArray(module.partitionRequiredLocalGates)) gates.push(...module.partitionRequiredLocalGates);
  return [...new Set(gates)];
}

function moduleIterationGates(config, module) {
  const gates = [];
  if (Array.isArray(config.config.moduleDefaults?.iterationLocalGates)) {
    gates.push(...config.config.moduleDefaults.iterationLocalGates);
  }
  if (Array.isArray(module.iterationLocalGates)) {
    gates.push(...module.iterationLocalGates);
  }
  if (Array.isArray(module.partitionIterationLocalGates)) {
    gates.push(...module.partitionIterationLocalGates);
  }
  return [...new Set(gates)];
}

function requireArg(name, label) {
  if (!args[name]) throw new Error(`missing ${label}`);
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function safeId(value) {
  return String(value || 'module').replace(/[^a-z0-9._-]/gi, '-').replace(/-+/g, '-');
}

function isPathLike(value) {
  const raw = String(value || '');
  return raw.includes('/') || raw.startsWith('.');
}

function timestampSlug(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function relativeToSma(filePath) {
  return filePath.startsWith(`${SMA_ROOT}/`) ? filePath.slice(SMA_ROOT.length + 1) : filePath;
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function blockedReasonCounts(assignments) {
  const counts = { held: 0, dirtyScope: 0, other: 0 };
  for (const item of assignments || []) {
    if (!item?.launch_blocked || item.claimed) continue;
    if (item.launch_blocked_reason === 'held') counts.held += 1;
    else if (item.launch_blocked_reason === 'dirty-scope') counts.dirtyScope += 1;
    else counts.other += 1;
  }
  return counts;
}

function externalActiveModuleLeaseGroups(assignments) {
  const groups = new Map();
  for (const item of assignments || []) {
    if (!item?.launch_blocked || item.claimed) continue;
    if (item.held_match !== 'module-related-active-lease') continue;
    const key = [
      item.module_id || '',
      item.held_lease_id || '',
      item.held_resource || '',
      item.held_by || '',
    ].join('\u0000');
    if (!groups.has(key)) {
      groups.set(key, {
        module_id: item.module_id || null,
        held_resource: item.held_resource || null,
        held_lease_id: item.held_lease_id || null,
        held_by: item.held_by || null,
        held_match: item.held_match || null,
        slot_count: 0,
        agent_slots: [],
        dispatch_bricks: [],
      });
    }
    const group = groups.get(key);
    group.slot_count += 1;
    if (item.agent_slot !== null && item.agent_slot !== undefined) group.agent_slots.push(item.agent_slot);
    if (item.brick) group.dispatch_bricks.push(item.brick);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    agent_slots: [...new Set(group.agent_slots)].sort((left, right) => number(left) - number(right)),
    dispatch_bricks: [...new Set(group.dispatch_bricks)],
  }));
}

function blockedReasonSuffix(summary) {
  const parts = [];
  const held = number(summary?.held_blocked_unclaimed);
  const dirtyScope = number(summary?.dirty_scope_blocked_unclaimed);
  const other = number(summary?.other_blocked_unclaimed);
  if (held) parts.push(blockedCountLabel(held, 'active lease'));
  if (dirtyScope) parts.push(`${dirtyScope} dirty scope`);
  if (other) parts.push(blockedCountLabel(other, 'other guard'));
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function blockedCountLabel(count, singular) {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function hasConcreteModuleTask(task) {
  const value = String(task || '').trim();
  return Boolean(value && value !== PLACEHOLDER_MODULE_TASK && !/^<[^>]+>$/.test(value));
}

function projectDashboardCommand(plan) {
  const maxAgents = number(plan.summary?.requested_agents) || plan.launch_plan?.length || 12;
  return `npm run gen3:dashboard -- --project ${shellArg(plan.project)} --task ${shellArg(plan.task)} --max-agents ${maxAgents}`;
}

function percent(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function formatPercent(value) {
  if (value === null || value === undefined || value === '') return 'n/a';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 'n/a';
  return `${parsed}%`;
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(number(ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function shellArg(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function dashCase(value) {
  return String(value).replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
  }
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
