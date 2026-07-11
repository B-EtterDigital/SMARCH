export interface ModulePacketArgs {
  allowBlockedDispatch: boolean; allowStaleDispatch: boolean; dryRun: boolean; fillCapacity: boolean;
  fullPrompt: boolean; fullPrompts: boolean; help: boolean; json: boolean; next: boolean; noGraphCheck: boolean;
  write: boolean; writeDispatch: string | boolean; claimNextRetryMs: string; claimNextTtl: string;
  claimNextWaitMs: string; dispatch: string; dispatchId: string; dispatchMaxAgeMs: string; dispatchSlot: string;
  graphTimeoutMs: string; maxAgents: string; module: string; partition: string; project: string;
  slot: string; task: string; ttl: string;
}

interface GuardedAssignment {
  agent_slot?: unknown;
  brick?: unknown;
  claimed?: boolean;
  held_by?: unknown;
  held_lease_id?: unknown;
  held_match?: unknown;
  held_resource?: unknown;
  launch_blocked?: boolean;
  launch_blocked_reason?: string;
  module_id?: unknown;
}

interface BlockedSummary {
  dirty_scope_blocked_unclaimed?: unknown;
  held_blocked_unclaimed?: unknown;
  other_blocked_unclaimed?: unknown;
}

interface DashboardPlan {
  launch_plan?: unknown[];
  project?: unknown;
  summary?: { requested_agents?: unknown };
  task?: unknown;
}

export const PLACEHOLDER_MODULE_TASK = '<describe module task>';

export function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

export function safeId(value: unknown): string {
  return String(value || 'module').replace(/[^a-z0-9._-]/gi, '-').replace(/-+/g, '-');
}

export function isPathLike(value: unknown): boolean {
  const raw = String(value || '');
  return raw.includes('/') || raw.startsWith('.');
}

export function timestampSlug(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function blockedReasonCounts(assignments: GuardedAssignment[] | null | undefined) {
  const counts = { held: 0, dirtyScope: 0, other: 0 };
  for (const item of assignments || []) {
    if (!item?.launch_blocked || item.claimed) continue;
    if (item.launch_blocked_reason === 'held') counts.held += 1;
    else if (item.launch_blocked_reason === 'dirty-scope') counts.dirtyScope += 1;
    else counts.other += 1;
  }
  return counts;
}

export function externalActiveModuleLeaseGroups(assignments: GuardedAssignment[] | null | undefined) {
  const groups = new Map<string, {
    module_id: unknown; held_resource: unknown; held_lease_id: unknown; held_by: unknown;
    held_match: unknown; slot_count: number; agent_slots: unknown[]; dispatch_bricks: unknown[];
  }>();
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
    const group = groups.get(key)!;
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

export function blockedReasonSuffix(summary: unknown): string {
  const value = summary as BlockedSummary | null | undefined;
  const parts = [];
  const held = number(value?.held_blocked_unclaimed);
  const dirtyScope = number(value?.dirty_scope_blocked_unclaimed);
  const other = number(value?.other_blocked_unclaimed);
  if (held) parts.push(blockedCountLabel(held, 'active lease'));
  if (dirtyScope) parts.push(`${dirtyScope} dirty scope`);
  if (other) parts.push(blockedCountLabel(other, 'other guard'));
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function blockedCountLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

export function hasConcreteModuleTask(task: unknown): boolean {
  const value = String(task || '').trim();
  return Boolean(value && value !== PLACEHOLDER_MODULE_TASK && !/^<[^>]+>$/.test(value));
}

export function projectDashboardCommand(plan: DashboardPlan): string {
  const maxAgents = number(plan.summary?.requested_agents) || plan.launch_plan?.length || 12;
  return `npm run gen3:dashboard -- --project ${shellArg(plan.project)} --task ${shellArg(plan.task)} --max-agents ${maxAgents}`;
}

export function percent(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

export function formatPercent(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'n/a';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 'n/a';
  return `${parsed}%`;
}

export function formatDuration(ms: unknown): string {
  const seconds = Math.max(0, Math.floor(number(ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function shellArg(value: unknown): string {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

export function dashCase(value: unknown): string {
  return String(value).replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

export function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
  }
}

export function parseArgs(list: string[]): ModulePacketArgs {
  const out: ModulePacketArgs = {
    allowBlockedDispatch: false, allowStaleDispatch: false, dryRun: false, fillCapacity: false,
    fullPrompt: false, fullPrompts: false, help: false, json: false, next: false, noGraphCheck: false,
    write: false, writeDispatch: false, claimNextRetryMs: '', claimNextTtl: '', claimNextWaitMs: '',
    dispatch: '', dispatchId: '', dispatchMaxAgeMs: '', dispatchSlot: '', graphTimeoutMs: '', maxAgents: '',
    module: '', partition: '', project: '', slot: '', task: '', ttl: '',
  };
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_match: string, character: string) => character.toUpperCase());
    const next = list[i + 1];
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) {
      Object.assign(out, { [key]: true });
      continue;
    }
    Object.assign(out, { [key]: next });
    i += 1;
  }
  return out;
}
