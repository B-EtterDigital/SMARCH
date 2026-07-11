/**
 * WHAT: Renders module dispatch, observation, watch, conflict, and agent-prompt views.
 * WHY: Operators and agents need the same state expressed as concise, actionable text.
 * HOW: Transforms already-computed manifests and status objects into Markdown, console lines, and commands.
 * INPUTS: Dispatch manifests, observation or watch summaries, and formatting callbacks.
 * OUTPUTS: Display strings and big-picture objects; this module does not read or write state.
 * CALLERS: Module-work planning, dispatch, observe, watch, and agent-packet writers share these renderers.
 * @example node --input-type=module -e "import { formatExternalActiveLeases } from './tools/lib/module-work-renderers.ts'; console.log(formatExternalActiveLeases([{ module_id: 'reg', held_resource: 'brick:demo', slot_count: 1 }]));"
 */
/** Markdown and prompt renderers for sma-module-work-packets.mjs. */

export type BigPicture = { tldr: string; current_slice: string; outlook: string[]; eta: string; horizon: string };
type PathPair = { left: string; right: string };
type DispatchAssignment = {
  agent_slot: number; module_id: string; slot: number; partition_id?: string | null; partition_label?: string | null;
  brick: string; graph_query_command: string; claim_command: string; iteration_gates?: string[]; required_gates: string[]; prompt: string;
  agent_packet?: { markdown_path?: string | null };
};
type BlockedSlot = {
  module_id: string; slot: number; blocked_reason: string; held_resource?: string | null; path_overlap_warning?: string | null;
  dirty_scope_command?: string | null; dirty_scope_conflict_command?: string | null; overlap_path_pairs?: PathPair[];
};
type DispatchManifest = {
  dispatch_id: string; project: string; task: string; created_at: string; assignments: DispatchAssignment[]; blocked_slots: BlockedSlot[];
  controller_commands: Record<'observe' | 'observe_write' | 'claim_next' | 'project_preflight' | 'project_dashboard' | 'conflict_summary', string>;
};
type SharedScopeItem = string | { id?: string; path?: string };
type AgentPacket = {
  dispatch_id: string; agent_slot: number; project: string; module_id: string; slot: number; partition_id?: string | null; task: string; brick: string;
  gains: { graph_first_token_reduction_percent_estimate: number; collision_reduction_percent_estimate: number };
  commands: { graph_query: string; claim: string; observe: string };
  scope: { paths?: string[]; exclude_paths?: string[]; shared_hot_paths?: SharedScopeItem[] };
  gates: { iteration?: string[]; required?: string[] }; rules?: string[]; prompt?: string;
  links: { dispatch_markdown?: string | null; dispatch_json?: string | null; agent_packet_json?: string | null };
};
type ProgressSummary = {
  assignment_count: number; claimed: number; active: number; completed: number; unclaimed: number; claimable_unclaimed: number;
  launch_blocked_unclaimed: number; external_active_slot_count: number; external_active_lease_count: number;
  external_active_module_count: number; open_conflicts: number; graph_ready: number;
  [key: string]: unknown;
};
type ObservationAssignment = {
  agent_slot: number; module_id: string; slot: number; status: string; claim_event_count: number; completion_event_count: number;
  active_lease_count?: number; open_conflicts?: number; context_error?: string | null; dirty_scope_count?: number; held_resource?: string | null;
  agent_packet_markdown_path?: string | null; conflict_command?: string | null; dirty_scope_command?: string | null; dirty_scope_conflict_command?: string | null;
};
type ExternalLeaseGroup = { module_id?: string; held_resource?: string; held_by?: string | null; slot_count: number; agent_slots: number[] };
export type ModuleObservation = {
  schema_version?: string; kind?: string; big_picture?: BigPicture; status: string; generated_at: string; dispatch: { dispatch_id: string; project?: string; task?: string; assignment_count?: number; predicted_launch_ready_slots?: number; predicted_requested_agents?: number };
  summary: ProgressSummary; gains: Record<'predicted_graph_first_token_reduction_percent' | 'observed_claimed_percent' | 'observed_completed_percent', number>;
  comparison: Record<'predicted_requested_agents' | 'predicted_launch_ready_slots' | 'dispatched_slots' | 'observed_claimed_slots' | 'observed_active_slots' | 'observed_completed_slots' | 'observed_claimable_unclaimed_slots' | 'observed_launch_blocked_unclaimed_slots' | 'observed_external_active_slots' | 'observed_external_active_leases' | 'observed_open_conflicts', number>;
  next: string; blockers: string[]; warnings: string[]; external_active_module_leases?: ExternalLeaseGroup[]; assignments: ObservationAssignment[];
};
type LatestObservation = { json_path?: string | null; markdown_path?: string | null };
type HeldModule = { module_id?: string; slot?: number | string; held_resource?: string; held_by?: string | null };
type ModuleWatch = {
  big_picture?: BigPicture; status: string; project: string; task: string; active_lane: string; launchable_agents: number; blockers?: string[]; warnings?: string[]; next: string;
  capacity: { launch_ready_slots: number; requested_agents: number; graph_ready_modules: number; modules_total: number; held_slots?: number; graph_blocked_modules?: number; path_overlap_blocked_slots?: number; held_modules?: HeldModule[] };
  dispatch: { available: boolean; dispatch_id?: string; assignment_count?: number; latest_observation?: LatestObservation };
  progress: ProgressSummary & { dispatch_age_ms?: number; dispatch_stale?: boolean; dispatch_max_age_ms?: number };
  gains: Record<'predicted_graph_first_token_reduction_percent' | 'predicted_dirty_status_token_reduction_percent' | 'predicted_collision_reduction_percent' | 'observed_claimed_percent' | 'observed_completed_percent', number>;
};
type RendererDeps = { blockedReasonSuffix: (summary: ProgressSummary) => string; formatPercent: (value: number) => string };

export function renderDispatchMarkdown(manifest: DispatchManifest): string {
  const lines = [
    `# ${manifest.dispatch_id}`,
    '',
    `Project: \`${manifest.project}\``,
    `Task: ${manifest.task}`,
    `Created: ${manifest.created_at}`,
    `Assignments: ${manifest.assignments.length}`,
    '',
    '## Controller',
    '',
    `- Observe: \`${manifest.controller_commands.observe}\``,
    `- Observe/write: \`${manifest.controller_commands.observe_write}\``,
    `- Claim next: \`${manifest.controller_commands.claim_next}\``,
    `- Preflight: \`${manifest.controller_commands.project_preflight}\``,
    `- Project dashboard: \`${manifest.controller_commands.project_dashboard}\``,
    `- Conflicts: \`${manifest.controller_commands.conflict_summary}\``,
    '',
    '## Assignments',
    '',
  ];
  for (const item of manifest.assignments) {
    lines.push(`### ${item.agent_slot}. ${item.module_id} slot ${item.slot}${item.partition_id ? ` (${item.partition_id})` : ''}`);
    lines.push('');
    lines.push(`- Brick: \`${item.brick}\``);
    if (item.partition_id) lines.push(`- Partition: \`${item.partition_id}\` — ${item.partition_label || item.partition_id}`);
    lines.push(`- Graph: \`${item.graph_query_command}\``);
    lines.push(`- Claim: \`${item.claim_command}\``);
    if (item.agent_packet?.markdown_path) lines.push(`- Agent packet: \`${item.agent_packet.markdown_path}\``);
    if ((item.iteration_gates || []).length) lines.push(`- Iteration gates: ${(item.iteration_gates || []).map((gate) => `\`${gate}\``).join(', ')}`);
    lines.push(`- Gates: ${item.required_gates.map((gate) => `\`${gate}\``).join(', ') || 'project defaults'}`);
    lines.push(`- Prompt: ${item.prompt}`);
    lines.push('');
  }
  if (manifest.blocked_slots.length) {
    lines.push('## Blocked Slots', '');
    for (const item of manifest.blocked_slots) {
      lines.push(`- ${item.module_id} slot ${item.slot}: ${item.blocked_reason}${item.held_resource ? ` (${item.held_resource})` : ''}${item.path_overlap_warning ? ` (${item.path_overlap_warning})` : ''}`);
      if (item.dirty_scope_command) lines.push(`  - dirty claim: \`${item.dirty_scope_command}\``);
      if (item.dirty_scope_conflict_command) lines.push(`  - conflict: \`${item.dirty_scope_conflict_command}\``);
      for (const pair of (item.overlap_path_pairs || []).slice(0, 3)) {
        lines.push(`  - path overlap: \`${pair.left}\` overlaps \`${pair.right}\``);
      }
    }
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}


export function renderAgentPacketMarkdown(packet: AgentPacket): string {
  const lines = [
    `# SMA Gen3 Agent Packet ${packet.dispatch_id} / ${packet.agent_slot}`,
    '',
    `- Project: \`${packet.project}\``,
    `- Module: \`${packet.module_id}\` slot ${packet.slot}${packet.partition_id ? ` (${packet.partition_id})` : ''}`,
    `- Task: ${packet.task}`,
    `- Brick: \`${packet.brick}\``,
    `- Gains: ${packet.gains.graph_first_token_reduction_percent_estimate}% graph-first token reduction, ${packet.gains.collision_reduction_percent_estimate}% collision-reduction estimate`,
    '',
    '## First Commands',
    '',
    `1. Graph: \`${packet.commands.graph_query}\``,
    `2. Claim: \`${packet.commands.claim}\``,
    `3. Observe: \`${packet.commands.observe}\``,
    '',
    '## Scope',
    '',
    `- Paths: ${(packet.scope.paths || []).map((item) => `\`${item}\``).join(', ') || 'configured module paths'}`,
    `- Exclude: ${(packet.scope.exclude_paths || []).map((item) => `\`${item}\``).join(', ') || 'none'}`,
    `- Shared hot paths: ${(packet.scope.shared_hot_paths || []).map((item) => `\`${typeof item === 'string' ? item : item.id || item.path || 'unknown'}\``).join(', ') || 'none listed'}`,
    '',
    '## Gates',
    '',
    `- Iteration: ${(packet.gates.iteration || []).map((item) => `\`${item}\``).join(', ') || 'module defaults'}`,
    `- Required: ${(packet.gates.required || []).map((item) => `\`${item}\``).join(', ') || 'project defaults'}`,
    '',
    '## Rules',
    '',
    ...(packet.rules || []).map((item) => `- ${item}`),
    '',
    '## Prompt',
    '',
    packet.prompt || 'n/a',
    '',
    '## Links',
    '',
    `- Full dispatch: \`${packet.links.dispatch_markdown || packet.links.dispatch_json || 'n/a'}\``,
    `- This packet JSON: \`${packet.links.agent_packet_json || 'n/a'}\``,
  ];
  return `${lines.join('\n').trim()}\n`;
}



export function renderObservationMarkdown(observation: ModuleObservation, { blockedReasonSuffix, formatPercent }: RendererDeps): string {
  const bigPicture = observation.big_picture || moduleObservationBigPicture(observation);
  const lines = [
    '# SMA Gen3 Module Work Observation',
    '',
    '## Big Picture',
    '',
    `- TLDR: ${bigPicture.tldr}`,
    `- Current: ${bigPicture.current_slice}`,
    `- ETA: ${bigPicture.eta}`,
    `- Horizon: ${bigPicture.horizon}`,
    '',
    '## Metrics',
    '',
    `- Status: ${observation.status}`,
    `- Generated: ${observation.generated_at}`,
    `- Dispatch: ${observation.dispatch.dispatch_id}`,
    `- Project: ${observation.dispatch.project}`,
    `- Task: ${observation.dispatch.task}`,
    `- Slots: ${observation.summary.claimed}/${observation.summary.assignment_count} claimed, ${observation.summary.active} active, ${observation.summary.completed} completed, ${observation.summary.unclaimed} unclaimed`,
    `- Claim-ready: ${observation.summary.claimable_unclaimed}/${observation.summary.unclaimed} unclaimed, ${observation.summary.launch_blocked_unclaimed} blocked${blockedReasonSuffix(observation.summary)}`,
    `- External active: ${observation.summary.external_active_slot_count} slot(s), ${observation.summary.external_active_lease_count} non-dispatch lease(s), ${observation.summary.external_active_module_count} module(s)`,
    `- Conflicts: ${observation.summary.open_conflicts} open`,
    `- Graphs: ${observation.summary.graph_ready}/${observation.summary.assignment_count} ready`,
    `- Gains: ${formatPercent(observation.gains.predicted_graph_first_token_reduction_percent)} predicted graph-first token reduction, ${formatPercent(observation.gains.observed_claimed_percent)} claimed, ${formatPercent(observation.gains.observed_completed_percent)} completed`,
    `- Next: \`${observation.next}\``,
    '',
    '## Comparison',
    '',
    `- Requested agents: ${observation.comparison.predicted_requested_agents}`,
    `- Predicted launch-ready slots: ${observation.comparison.predicted_launch_ready_slots}`,
    `- Dispatched slots: ${observation.comparison.dispatched_slots}`,
    `- Claimed/active/completed: ${observation.comparison.observed_claimed_slots}/${observation.comparison.observed_active_slots}/${observation.comparison.observed_completed_slots}`,
    `- Claim-ready/blocked unclaimed: ${observation.comparison.observed_claimable_unclaimed_slots}/${observation.comparison.observed_launch_blocked_unclaimed_slots}${blockedReasonSuffix(observation.summary)}`,
    `- External active slots/leases: ${observation.comparison.observed_external_active_slots}/${observation.comparison.observed_external_active_leases}`,
    `- Open conflicts: ${observation.comparison.observed_open_conflicts}`,
    '',
  ];
  if (observation.blockers.length) {
    lines.push('## Blockers', '');
    for (const blocker of observation.blockers) lines.push(`- ${blocker}`);
    lines.push('');
  }
  if (observation.warnings.length) {
    lines.push('## Warnings', '');
    for (const warning of observation.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }
  if (observation.external_active_module_leases?.length) {
    lines.push('## External Active Module Leases', '');
    for (const item of observation.external_active_module_leases) {
      lines.push(`- ${item.module_id}: ${item.held_resource} by ${item.held_by || 'unknown'} (${item.slot_count} slot${item.slot_count === 1 ? '' : 's'}: ${item.agent_slots.join(', ')})`);
    }
    lines.push('');
  }
  lines.push('## Assignments', '');
  for (const item of observation.assignments) {
    const activeLabel = item.active_lease_count ? `, active leases ${item.active_lease_count}` : '';
    const conflictLabel = item.open_conflicts ? `, open conflicts ${item.open_conflicts}` : '';
    const contextLabel = item.context_error ? `, context error: ${item.context_error}` : '';
    const dirtyLabel = item.dirty_scope_count ? `, dirty scope ${item.dirty_scope_count}` : '';
    const heldLabel = item.held_resource ? `, held ${item.held_resource}` : '';
    lines.push(`- #${item.agent_slot} ${item.module_id} slot ${item.slot}: ${item.status}, ${item.claim_event_count} claim events, ${item.completion_event_count} completion events${activeLabel}${conflictLabel}${contextLabel}${dirtyLabel}${heldLabel}`);
    if (item.agent_packet_markdown_path) lines.push(`  - Agent packet: \`${item.agent_packet_markdown_path}\``);
    if (item.conflict_command) lines.push(`  - Module conflict: \`${item.conflict_command}\``);
    if (item.dirty_scope_command) lines.push(`  - Dirty-scope claim: \`${item.dirty_scope_command}\``);
    if (item.dirty_scope_conflict_command) lines.push(`  - Conflict: \`${item.dirty_scope_conflict_command}\``);
  }
  return `${lines.join('\n').trim()}\n`;
}


export function moduleObservationBigPicture(observation: ModuleObservation): BigPicture {
  const summary = observation?.summary || {};
  const dispatch = observation?.dispatch || {};
  const assignmentCount = numeric(summary.assignment_count || dispatch.assignment_count);
  const claimReady = numeric(summary.claimable_unclaimed);
  const unclaimed = numeric(summary.unclaimed);
  const completed = numeric(summary.completed);
  const conflicts = numeric(summary.open_conflicts);
  const graphReady = numeric(summary.graph_ready);
  const dispatchId = dispatch.dispatch_id || 'module dispatch';
  const graphText = `${graphReady}/${assignmentCount} dispatch graphs`;

  if (completed >= assignmentCount && assignmentCount > 0) {
    return {
      tldr: `Dispatch ${dispatchId} is complete: ${completed}/${assignmentCount} slots done, ${conflicts} conflicts, ${graphText}.`,
      current_slice: 'Current slice: preserve this observation as proof, refresh the dashboard, then decide the next module wave.',
      outlook: [
        'Keep the observation artifact with the release handoff.',
        'Run project preflight and clear dirty integration blockers.',
        'Dispatch the next non-overlapping module wave only after this wave is accepted.',
      ],
      eta: '5-10 minutes for controller closeout once agent leases are ended.',
      horizon: 'Completed module-local proof raises the safe concurrency ceiling only when integration stays serialized.',
    };
  }

  if (claimReady > 0) {
    return {
      tldr: `Dispatch ${dispatchId} is launch-ready: ${claimReady}/${unclaimed} open packet-first slots, ${conflicts} conflicts, ${graphText}.`,
      current_slice: `Current slice: claim ${claimReady} open dispatch-pinned slot(s), keep agents inside packet scope, then write the next observation.`,
      outlook: [
        'Claim open slots with module:claim --next.',
        'Use module:watch for low-token progress between observations.',
        'Before the next wave, write observation proof and resolve dirty integration blockers.',
      ],
      eta: `5-10 minutes to respawn ${claimReady} packet-first agents; observe progress within 15 minutes.`,
      horizon: 'Module-local work can proceed now; integration waits for cleanup, conflicts, and release gates.',
    };
  }

  return {
    tldr: `Dispatch ${dispatchId} is not claim-ready: ${unclaimed} unclaimed slots, ${conflicts} conflicts, ${graphText}.`,
    current_slice: 'Current slice: clear blockers, conflicts, stale dispatch state, or active leases before assigning more agents.',
    outlook: [
      'Resolve the listed blockers.',
      'Write another observation after claims, completions, or conflict resolutions.',
      'Rerun project preflight before a new wave.',
    ],
    eta: 'Blocked until the listed module observation blockers clear.',
    horizon: 'Do not integrate or release while module-wave blockers remain open.',
  };
}


export function moduleWatchBigPicture(watch: ModuleWatch): BigPicture {
  const capacity = watch?.capacity || {};
  const progress = watch?.progress || {};
  const dispatch = watch?.dispatch || {};
  const dispatchReady = Boolean(dispatch.available);
  const assignmentCount = numeric(progress.assignment_count);
  const claimReady = dispatchReady ? numeric(progress.claimable_unclaimed) : 0;
  const unclaimed = dispatchReady ? numeric(progress.unclaimed) : 0;
  const completed = dispatchReady ? numeric(progress.completed) : 0;
  const conflicts = dispatchReady ? numeric(progress.open_conflicts) : 0;
  const capReady = numeric(capacity.launch_ready_slots);
  const capRequested = numeric(capacity.requested_agents);
  const capGraphReady = numeric(capacity.graph_ready_modules);
  const capModules = numeric(capacity.modules_total);
  const dispatchGraphReady = numeric(progress.graph_ready);
  const graphText = dispatchReady
    ? `${dispatchGraphReady}/${assignmentCount} dispatch graphs, ${capGraphReady}/${capModules} module graphs`
    : `${capGraphReady}/${capModules} module graphs`;

  if (!dispatchReady) {
    return {
      tldr: `Dispatch missing: ${capReady}/${capRequested} module slots are capacity-ready, but agents need a written dispatch before launch.`,
      current_slice: 'Current slice: write a concrete module dispatch, then launch agents from dispatch-pinned packets only.',
      outlook: [
        'Write the dispatch manifest for the concrete task.',
        'Claim module packets one by one with module:claim --next.',
        'Observe/write the dispatch before assigning the next wave.',
      ],
      eta: '5 minutes after the task is concrete; release remains blocked until dirty/shared-path blockers clear.',
      horizon: 'Module packets keep local work moving now; integration waits for cleanup, conflicts, and release gates.',
    };
  }

  if (completed >= assignmentCount && assignmentCount > 0) {
    return {
      tldr: `Dispatch ${dispatch.dispatch_id} is complete: ${completed}/${assignmentCount} slots done, ${conflicts} conflicts, ${graphText}.`,
      current_slice: 'Current slice: observe/write completion proof, refresh the project dashboard, then decide the next module wave.',
      outlook: [
        'Persist module observation so predicted gain becomes proof.',
        'Run project preflight and resolve any dirty integration blockers.',
        'Dispatch the next non-overlapping module wave only after the controller accepts the previous one.',
      ],
      eta: '5-10 minutes for controller closeout once all agents have ended their leases.',
      horizon: 'The ceiling moves from 8-12 toward 15-25 agents only when completed work stays module-local and integration is serialized.',
    };
  }

  if (claimReady > 0) {
    return {
      tldr: `Dispatch ${dispatch.dispatch_id} is launch-ready: ${claimReady}/${unclaimed} open packet-first slots, ${conflicts} conflicts, ${graphText}.`,
      current_slice: `Current slice: claim up to ${claimReady} dispatch-pinned module agents, keep each inside its packet scope, then observe/write progress.`,
      outlook: [
        'Launch claim-ready slots with module:claim --next from the dispatch.',
        'Watch claimed/active/completed counts instead of rereading the full dashboard.',
        'Before the next wave, write an observation receipt and resolve dirty integration blockers.',
      ],
      eta: `5-10 minutes to respawn ${claimReady} packet-first agents; observe progress within 15 minutes of launch.`,
      horizon: 'Now: module-local work can proceed; next: integration cleanup; later: 15-25 agents after hot shared paths shrink.',
    };
  }

  return {
    tldr: `Dispatch ${dispatch.dispatch_id} is not claim-ready: ${unclaimed} unclaimed slots, ${conflicts} conflicts, ${graphText}.`,
    current_slice: 'Current slice: clear blockers or observe active work before assigning more agents.',
    outlook: [
      'Resolve held, stale, dirty-scope, or conflict blockers.',
      'Observe/write dispatch receipts once agents claim or complete work.',
      'Rerun project preflight before launching a new wave.',
    ],
    eta: 'Blocked until the listed module-wave blockers clear.',
    horizon: 'Do not push integration while dispatch or dirty-scope blockers remain open.',
  };
}


export function renderModuleWatchConsole(watch: ModuleWatch, { blockedReasonSuffix, formatPercent }: RendererDeps): string {
  const bigPicture = watch.big_picture || moduleWatchBigPicture(watch);
  const capacityBlocked = [];
  if (watch.capacity.held_slots) capacityBlocked.push(`${watch.capacity.held_slots} held`);
  if (watch.capacity.graph_blocked_modules) capacityBlocked.push(`${watch.capacity.graph_blocked_modules} graph`);
  if (watch.capacity.path_overlap_blocked_slots) capacityBlocked.push(`${watch.capacity.path_overlap_blocked_slots} overlap`);
  const lines = [
    'SMA Gen3 Module Wave Watch',
    `tldr:            ${bigPicture.tldr}`,
    `current:         ${bigPicture.current_slice}`,
    `status:          ${watch.status}`,
    `project:         ${watch.project}`,
    `task:            ${watch.task}`,
    `lane:            ${watch.active_lane}`,
    `capacity:        ${watch.capacity.launch_ready_slots}/${watch.capacity.requested_agents} slots, ${watch.capacity.graph_ready_modules}/${watch.capacity.modules_total} graphs ready`,
  ];
  if (capacityBlocked.length) lines.push(`capacity-blocked: ${capacityBlocked.join(', ')} currently blocked outside this dispatch`);
  if ((watch.capacity.held_modules || []).length) lines.push(`held-modules:     ${formatHeldModuleSummary(watch.capacity.held_modules || [])}`);

  if (watch.dispatch.available) {
    lines.push(`dispatch:        ${watch.dispatch.dispatch_id} (${watch.dispatch.assignment_count} slots)`);
    if (watch.progress.dispatch_age_ms) lines.push(`dispatch-age:    ${formatWatchDuration(watch.progress.dispatch_age_ms)}${watch.progress.dispatch_stale ? ' stale' : ''} (max ${formatWatchDuration(watch.progress.dispatch_max_age_ms)})`);
    if (watch.dispatch.latest_observation?.json_path) lines.push(`observation:     ${watch.dispatch.latest_observation.json_path}${observationAgeSuffix(watch.dispatch.latest_observation)}${watch.dispatch.latest_observation.markdown_path ? ` · ${watch.dispatch.latest_observation.markdown_path}` : ''}`);
    lines.push(`progress:        ${watch.progress.claimed}/${watch.progress.assignment_count} claimed, ${watch.progress.active} active, ${watch.progress.completed} completed, ${watch.progress.unclaimed} unclaimed`);
    lines.push(`claim-ready:     ${watch.progress.claimable_unclaimed}/${watch.progress.unclaimed} unclaimed, ${watch.progress.launch_blocked_unclaimed} blocked${blockedReasonSuffix(watch.progress)}`);
    if (watch.progress.external_active_slot_count) {
      lines.push(`external active: ${watch.progress.external_active_slot_count} slot${watch.progress.external_active_slot_count === 1 ? '' : 's'} occupied by ${watch.progress.external_active_lease_count} non-dispatch lease${watch.progress.external_active_lease_count === 1 ? '' : 's'}`);
    }
    lines.push(`conflicts:       ${watch.progress.open_conflicts} open`);
    lines.push(`gains:           ${watchPercent(formatPercent, watch.gains.predicted_graph_first_token_reduction_percent)} graph-first, ${watchPercent(formatPercent, watch.gains.predicted_dirty_status_token_reduction_percent)} dirty-status, ${watchPercent(formatPercent, watch.gains.predicted_collision_reduction_percent)} collision estimate, ${watchPercent(formatPercent, watch.gains.observed_claimed_percent)} claimed, ${watchPercent(formatPercent, watch.gains.observed_completed_percent)} completed`);
  } else {
    lines.push('dispatch:        missing');
    lines.push(`launchable:      ${watch.launchable_agents}/${watch.capacity.requested_agents} until dispatch is written`);
  }

  (bigPicture.outlook || []).slice(0, 3).forEach((item, index) => {
    lines.push(`outlook ${index + 1}:       ${item}`);
  });
  lines.push(`eta:             ${bigPicture.eta}`);
  lines.push(`horizon:         ${bigPicture.horizon}`);
  if ((watch.blockers || []).length) lines.push(`blockers:        ${(watch.blockers || []).join('; ')}`);
  if ((watch.warnings || []).length) lines.push(`warnings:        ${(watch.warnings || []).join('; ')}`);
  lines.push(`next:            ${watch.next}`);
  return lines.join('\n');
}



export function formatExternalActiveLeases(groups: ExternalLeaseGroup[], limit = 4): string {
  const items = Array.isArray(groups) ? groups : [];
  if (!items.length) return 'none';
  const rendered = items.slice(0, limit).map((item) => (
    `${item.module_id || 'module'}:${item.held_resource || 'active-lease'}${item.slot_count > 1 ? ` (${item.slot_count} slots)` : ''}`
  ));
  const remaining = items.length - rendered.length;
  if (remaining > 0) rendered.push(`+${remaining} more`);
  return rendered.join(', ');
}

function numeric(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function watchPercent(formatPercent: ((value: number) => string) | undefined, value: number): string {
  return typeof formatPercent === 'function' ? formatPercent(value) : `${numeric(value)}%`;
}

function formatHeldModuleSummary(items: HeldModule[]): string {
  const rendered = (Array.isArray(items) ? items : []).slice(0, 5).map((item) => `${item.module_id || 'module'}#${item.slot || '?'}:${item.held_resource || 'held'}${item.held_by ? ` by ${item.held_by}` : ''}`);
  const remaining = (Array.isArray(items) ? items.length : 0) - rendered.length;
  if (remaining > 0) rendered.push(`+${remaining} more`);
  return rendered.join(', ');
}

function observationAgeSuffix(observation: LatestObservation): string {
  const match = String(observation?.json_path || '').match(/observed-(\d{8}T\d{6}Z)\.json$/);
  if (!match) return '';
  const stamp = match[1].replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z');
  const age = Date.now() - Date.parse(stamp);
  return Number.isFinite(age) && age >= 0 ? ` · observed ${formatWatchDuration(age)} ago` : '';
}

function formatWatchDuration(ms: unknown): string {
  const totalMinutes = Math.max(0, Math.round(numeric(ms) / 60000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h${minutes}m` : `${hours}h`;
}

export function moduleConflictCommand({ project, moduleId, slot, task, moduleWorkBrick, shellArg }: { project: string; moduleId: string; slot: number; task: string; moduleWorkBrick: (moduleId: string, slot: number) => string; shellArg: (value: string) => string }): string {
  const brick = moduleWorkBrick(moduleId, slot);
  return [
    'npm run conflict -- report --project',
    shellArg(project),
    '--brick',
    shellArg(brick),
    '--intent',
    shellArg(`module ${moduleId} overlap or shared hot path for ${task}`),
    '--resolution-plan',
    shellArg('document overlap, back off, split paths, or wait for controller decision'),
  ].join(' ');
}

export function modulePrompt({
  config,
  module,
  partition,
  slot,
  task,
  graphCommand,
  iterationGates,
  gates,
  sharedWarnings,
  claimCommand = '',
  moduleWorkBrick,
  shellArg,
}: {
  config: { project: string };
  module: { id: string; paths: string[]; excludePaths?: string[] };
  partition?: { id: string; description?: string; label?: string } | null;
  slot: number;
  task: string;
  graphCommand: string;
  iterationGates: string[];
  gates: string[];
  sharedWarnings: Array<{ id: string }>;
  claimCommand?: string;
  moduleWorkBrick: (moduleId: string, slot: number) => string;
  shellArg: (value: string) => string;
}): string {
  const conflict = moduleConflictCommand({ project: config.project, moduleId: module.id, slot, task, moduleWorkBrick, shellArg });
  const pathLimit = partition ? module.paths : (module.paths || []).slice(0, 4);
  return [
    'Use $sma-gen3.',
    `From ~/DEV/SMARCH run \`${graphCommand}\` before broad file reads.`,
    claimCommand
      ? `Claim with \`${claimCommand}\`.`
      : 'Do not claim from this preview; use the dispatch-pinned claim from the module dispatch manifest.',
    partition
      ? `This is explicit partition \`${partition.id}\`: ${partition.description || partition.label || 'use only the listed partition paths'}.`
      : null,
    `Stay inside ${partition ? 'partition' : 'module'} paths: ${pathLimit.join(', ') || 'configured module paths'}.`,
    (module.excludePaths || []).length
      ? `Do not edit excluded delegated paths: ${(module.excludePaths || []).slice(0, 4).join(', ')}.`
      : null,
    Number(slot) > 1 && !partition
      ? 'This is an extra same-module slot; proceed only with an explicit subpath/task partition from the controller.'
      : partition
        ? 'This same-module slot is safe only for the named partition; conflict-report before crossing into another partition.'
        : 'This is the primary module slot; do not assume another same-module agent is safe without explicit partitioning.',
    sharedWarnings.length
      ? `Shared hot-path warning: ${sharedWarnings.map((item) => item.id).join(', ')}. Do not edit those paths without controller approval.`
      : 'Do not edit shared hot paths unless the controller explicitly reclassifies the work.',
    `If overlap or uncertainty appears, conflict reporting is mandatory: run \`${conflict}\` and back off.`,
    iterationGates.length
      ? `For fast iteration, run iteration gates on your changed files before the final gate: ${iterationGates.join(' && ')}.`
      : null,
    gates.length ? `Run module gates before completion: ${gates.join(' && ')}.` : 'Run project-local Gen3 gates before completion.',
    'Finish with end-edit, dirty delta cleanup, and a concise proof summary.',
  ].filter(Boolean).join(' ');
}
