/** Type-only contracts shared by the parallel preflight command and its helpers. */
export type RawRecord = Record<string, unknown>;
export type CliValue = string | boolean | undefined;
export interface PreflightArgs extends Record<string, CliValue> {
  allowStale?: boolean; autoLimit?: boolean; fullPrompts?: boolean; help?: boolean;
  json?: boolean; launchPlan?: boolean; limit?: string | boolean; maxAgents?: string;
  noAutoRefresh?: boolean; processes?: boolean; project?: string; selftest?: boolean;
  staleProcessSeconds?: string; strict?: boolean; task?: string; timeoutMs?: string;
  verboseLaunchPlan?: boolean; writeDispatch?: string | boolean;
}
export interface ToolData extends RawRecord {
  action_items?: RawRecord[];
  assignments?: ModuleAssignment[];
  blockers?: unknown[];
  dispatch?: RawRecord;
  dispatch_manifest?: RawRecord;
  external_active_module_leases?: unknown[];
  freshness?: RawRecord;
  gains?: RawRecord;
  launch_plan?: RawRecord[];
  next?: string;
  parallel_wave?: RawRecord;
  projects?: RawRecord[];
  readiness?: RawRecord;
  status?: string;
  summary?: RawRecord;
  task?: string;
  warnings?: unknown[];
}
export interface ToolResult { label: string; data: ToolData | null; error: string | null }
export interface LimitPlan { mode: string; maxAgents: number; limit: number }
export interface ModuleWorkSummary {
  available: boolean; status: string; project: string | null; task: string; task_is_placeholder: boolean;
  requested_agents: number; launch_ready_slots: number; candidate_slots: number; modules_total: number;
  graph_ready_modules: number; graph_blocked_modules: number; held_slots: number; path_overlap_blocked_slots: number;
  fill_capacity: boolean; modules: string[]; first_claim_command: string; plan_command: string; watch_command: string;
  dispatch_command: string; dashboard_command: string; observe_command: string; warnings: unknown[]; blockers: unknown[];
  gains: Record<string, number>; dispatch_manifest?: RawRecord; dispatch_id?: string; dispatch_assignment_count?: number;
  first_dispatch_claim_command?: string; observe_write_command?: string;
}
export interface ModuleAssignment extends RawRecord {
  agent_slot?: unknown; project?: unknown; module_id?: unknown; dispatch_id?: unknown; slot?: unknown;
  partition_id?: unknown; partition_label?: unknown; brick?: unknown; status?: unknown; graph_ready?: unknown;
  graph_path?: unknown; graph_query_command?: unknown; paths?: unknown; exclude_paths?: unknown;
  iteration_gates?: unknown; required_gates?: unknown; shared_hot_paths?: unknown; claim_command?: unknown;
  conflict_command?: unknown; task?: unknown; agent_packet?: unknown; prompt?: unknown; open_conflicts?: unknown;
  claimed?: unknown; active?: unknown; completed?: unknown; launch_blocked?: unknown;
}
export interface ModuleDispatchSummary {
  available: boolean; status: string; project: string | null; dispatch_id: string; task: string;
  assignment_count: number; claimed: number; active: number; completed: number; unclaimed: number;
  claimable_unclaimed: number; launch_blocked_unclaimed: number; held_blocked_unclaimed: number;
  dirty_scope_blocked_unclaimed: number; other_blocked_unclaimed: number; external_active_slot_count: number;
  external_active_lease_count: number; external_active_module_count: number; dispatch_age_ms: number;
  dispatch_max_age_ms: number; dispatch_stale: boolean; dispatch_stale_unclaimed: boolean; open_conflicts: number;
  graph_ready: number; next_command: string; observe_command: string; observe_write_command: string;
  assignments: ModuleAssignment[]; external_active_module_leases: unknown[]; warnings: unknown[]; blockers: unknown[];
  error: string;
}
export interface ControllerBlockerPacket extends RawRecord {
  rank: number; severity: string; kind: string; project: string; brick: string; title: string; detail: string;
  impact_score: number; dirty_count: number; uncovered_dirty_count: number; stale_context_dirty_count: number;
  stale_context_receipt_count: number; stale_context_total_receipt_count: number; top_dirty_group: string;
  top_dirty_group_count: number; sample_paths: unknown[]; command: string; inspect_command: string;
  conflict_command: string; parallel_claim_count: number; parallel_claims: RawRecord[]; prompt: string;
}
export interface CommandGuidance extends RawRecord {
  active_lane: string; cleanup_actionable: boolean; cleanup_reason: string; module_capacity_agents: number;
  dispatch_launchable_agents: number; stale_context_launchable_agents: number; stale_context_actionable: boolean;
  stale_context_reason: string; launchable_agents: number; concrete_task: boolean; module_dispatch_required: boolean;
  module_dispatch_reason: string; module_observe_actionable: boolean; module_observe_reason: string;
}
export interface CommandGuidanceInput {
  projectScope?: string | null;
  cleanupStatus: string;
  moduleWork: ModuleWorkSummary;
  moduleDispatch: ModuleDispatchSummary;
  activeDirtyScopeProjects?: unknown;
  activeDirtyScopePaths?: unknown;
  staleContextProjects?: unknown;
  staleContextPaths?: unknown;
  staleContextLaunchableAgents?: unknown;
  cleanupLaunchableAgents?: unknown;
  openConflicts?: unknown;
  criticalConflicts?: unknown;
  graphPackets?: unknown;
  projectGraphGaps?: unknown;
  moduleGraphGaps?: unknown;
  staleAgentProcesses?: unknown;
  agentProcessScanErrorProjects?: unknown;
}
export interface LaneStatuses extends RawRecord {
  active_lane: string; active_status: string;
  cleanup: { status: string; actionable: boolean };
  stale_context: { status: string; ready_agents: number; actionable: boolean; projects: number; dirty_paths: number };
  module: RawRecord & { status: string; ready_agents: number };
  integration: RawRecord & { status: string; cleanup_required: boolean; stale_context_projects: number; stale_context_dirty_paths: number };
}
export interface ScoreInput {
  generatedAt: string;
  projectScope: string | null;
  limit: number;
  limitPlan: LimitPlan;
  controller: ToolResult;
  conflicts: ToolResult;
  cleanup: ToolResult;
  graphs: ToolResult;
  moduleWork: ToolResult;
  moduleObserve: ToolResult;
  moduleLimit: number;
  moduleTask: string | null;
}
export interface LaneStatusInput {
  status: string;
  cleanupStatus: string;
  commandGuidance: CommandGuidance;
  moduleWork: ModuleWorkSummary;
  moduleDispatch: ModuleDispatchSummary;
  activeDirtyScopeProjects: unknown;
  activeDirtyScopePaths: unknown;
  staleContextProjects?: unknown;
  staleContextPaths?: unknown;
  staleContextLaunchableAgents?: unknown;
  dirtyUnleasedProjects: unknown;
}
export interface BigPictureInput {
  status: string; readinessScorePercent: number; recommendedAgents: number; requestedAgents: number;
  launchSlots: number; claimablePercent: number; targetedPaths: number; claimablePaths: number;
  dirtyUnleasedProjects: number; activeLeases: number; openConflicts: number; criticalConflicts: number;
  warningConflicts: number; graphPackets: number; projectGraphGaps: number; moduleGraphGaps: number;
  activeDirtyScopeProjects: number; activeDirtyScopePaths: number; staleContextProjects: number;
  staleContextPaths: number; staleAgentProcessProjects: number; staleAgentProcesses: number;
  agentProcessScanErrorProjects: number; topWaveGainPercent: number | null; topProjectGainPercent: number | null;
  overflowGroups: number; blockers: string[]; cleanupStatus: string; projectScope: string | null;
  moduleWork: ModuleWorkSummary; moduleDispatch: ModuleDispatchSummary;
}
export interface PrimaryNextInput {
  status: string; openConflicts: number; criticalConflicts: number; graphPackets: number;
  projectGraphGaps: number; moduleGraphGaps: number; cleanupStatus: string;
  activeDirtyScopeProjects: number; activeDirtyScopePaths: number; staleContextProjects: number;
  staleContextPaths: number; staleAgentProcesses: number; agentProcessScanErrorProjects: number;
  cleanupNext: string; projectScope: string | null; moduleWork: ModuleWorkSummary;
  moduleDispatch: ModuleDispatchSummary; controllerBlockerPackets?: ControllerBlockerPacket[];
  dirtyUnleasedProjects: number;
}
