/**
 * WHAT: Owns the SAIL app-instance pool registry — instances, checkout state, and the FIFO wait queue.
 * WHY: Parallel agents need one authoritative record of which app instance is leased, warm, dirty, or waiting.
 * HOW: Callers mutate the registry under a lock; hygiene reconciles records against live processes and live leases.
 * Pool decisions (reuse, launch, recycle, queue) are computed here as pure planning so the CLI stays thin.
 * Registry lives at registry/sail-instances.generated.json below SMA_ROOT; schema schemas/sail-instances.schema.json.
 * Format and command terms are defined in docs/GLOSSARY.md.
 * @example node --input-type=module -e "import { registryPath } from './tools/lib/sail-registry.ts'; console.log(registryPath({}))"
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SMA_ROOT } from './sma-paths.ts';
import type { SplPlatform } from './spl-platform/contract.ts';

export type SailState = 'LAUNCHING' | 'IDLE' | 'LEASED' | 'RETIRING';

export interface SailCheckout {
  lease_id: string;
  agent: string;
  intent: string;
  acquired_at: string;
  ttl_s: number;
  generation: number;
}

export interface SailInstance {
  instance_id: string;
  project: string;
  pid: number | null;
  start_token: string | null;
  port: number | null;
  cdp: string | null;
  fingerprint: string;
  state: SailState;
  dirty: boolean;
  generation: number;
  leases_served: number;
  pool_lease_id: string | null;
  hud_pid: number | null;
  hud: { phase: string; note: string | null };
  launched_by: string;
  launched_at: string;
  last_activity: string;
  checkout: SailCheckout | null;
}

export interface SailTicket {
  ticket_id: string;
  project: string;
  agent: string;
  intent: string;
  fingerprint: string;
  enqueued_at: string;
  expires_at: string;
}

export interface SailEvent { at: string; type: string; [key: string]: unknown }

export interface SailRegistryData {
  version: 1;
  instances: SailInstance[];
  queue: SailTicket[];
  events: SailEvent[];
}

export interface SailProjectConfig {
  cap?: number;
  budget_clamp?: boolean;
  lease_ttl_s?: number;
  idle_ttl_s?: number;
  wait_ttl_s?: number;
  max_leases?: number;
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
  ready_path?: string;
  post_launch?: string[];
  hud?: boolean;
  hud_offset_top?: number;
  fingerprint_paths?: string[];
}

export interface SailRegistryOptions {
  root?: string;
  registryPath?: string;
  projectsPath?: string;
  leaseRegistryPath?: string;
}

const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 30_000;
const EVENT_CAP = 400;
export const SAIL_CAP_MAX = 4;

export function registryPath(options: SailRegistryOptions): string {
  const root = options.root ?? SMA_ROOT;
  return options.registryPath ?? process.env.SMA_SAIL_REGISTRY_PATH ?? resolve(root, 'registry/sail-instances.generated.json');
}

export function projectsPath(options: SailRegistryOptions): string {
  const root = options.root ?? SMA_ROOT;
  return options.projectsPath ?? process.env.SMA_SAIL_PROJECTS_PATH ?? resolve(root, 'registry/sail-projects.json');
}

function leaseRegistryPath(options: SailRegistryOptions): string {
  const root = options.root ?? SMA_ROOT;
  return options.leaseRegistryPath ?? process.env.SMA_LEASE_REGISTRY_PATH ?? resolve(root, 'registry/active-leases.generated.json');
}

export function loadProjects(options: SailRegistryOptions): Record<string, SailProjectConfig> {
  const path = projectsPath(options);
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { projects?: Record<string, SailProjectConfig> };
  return parsed.projects ?? {};
}

/** Config for one project, or undefined when the registry has no entry. */
export function getProjectConfig(options: SailRegistryOptions, project: string): SailProjectConfig | undefined {
  const projects = loadProjects(options);
  return Object.hasOwn(projects, project) ? projects[project] : undefined;
}

export function clampCap(config: SailProjectConfig, recommendedAgents: number): number {
  const declared = Math.max(1, Math.min(SAIL_CAP_MAX, config.cap ?? 3));
  // Machine pressure shrinks the pool (SPL budget) unless the project opts out
  // (hermetic selftests need a deterministic cap regardless of host load).
  if (config.budget_clamp === false) return declared;
  return Math.max(1, Math.min(declared, recommendedAgents));
}

export function ttls(config: SailProjectConfig): { lease: number; idle: number; wait: number } {
  return {
    lease: Math.max(30, config.lease_ttl_s ?? 900),
    idle: Math.max(30, config.idle_ttl_s ?? 900),
    wait: Math.max(30, config.wait_ttl_s ?? 1200),
  };
}

function loadRegistry(path: string): SailRegistryData {
  if (!existsSync(path)) return { version: 1, instances: [], queue: [], events: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SailRegistryData>;
  return { version: 1, instances: parsed.instances ?? [], queue: parsed.queue ?? [], events: parsed.events ?? [] };
}

function saveRegistry(path: string, data: SailRegistryData): void {
  data.events = data.events.slice(-EVENT_CAP);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${String(process.pid)}`;
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(temp, path);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Mutate the registry under the cross-process lock; the mutator's return value is passed through. */
export function withSailRegistry<T>(options: SailRegistryOptions, mutator: (data: SailRegistryData) => T): T {
  const path = registryPath(options);
  const lockDir = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { mkdirSync(lockDir, { recursive: false }); break; } catch {
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) { rmdirSync(lockDir); continue; }
      } catch { continue; }
      if (Date.now() > deadline) throw new Error(`SAIL_REGISTRY_LOCK_TIMEOUT: ${lockDir}`);
      sleepSync(50);
    }
  }
  try {
    const data = loadRegistry(path);
    const result = mutator(data);
    saveRegistry(path, data);
    return result;
  } finally {
    try { rmdirSync(lockDir); } catch { /* released by stale takeover */ }
  }
}

export function stampEvent(data: SailRegistryData, type: string, detail: Record<string, unknown>): void {
  data.events.push({ at: new Date().toISOString(), type, ...detail });
}

/** Lease ids that are currently live in the shared active-leases registry. */
export function liveLeaseIds(options: SailRegistryOptions): Set<string> {
  const path = leaseRegistryPath(options);
  if (!existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { leases?: { lease_id?: string; expires_at?: string }[] };
    const now = Date.now();
    return new Set((parsed.leases ?? [])
      .filter((lease) => Boolean(lease.lease_id) && Date.parse(lease.expires_at ?? '') > now)
      .map((lease) => String(lease.lease_id)));
  } catch { return new Set(); }
}

export interface SailPruneResult { removedDead: SailInstance[]; expiredCheckouts: SailInstance[]; expiredTickets: SailTicket[] }

/**
 * Reconcile records with reality: drop instances whose process identity is gone,
 * mark instances with a dead checkout lease dirty (the agent vanished mid-test),
 * and drop expired queue tickets. Never signals anything.
 */
export function pruneRegistry(data: SailRegistryData, platform: SplPlatform, liveLeases: Set<string>): SailPruneResult {
  const now = Date.now();
  const removedDead: SailInstance[] = [];
  data.instances = data.instances.filter((instance) => {
    if (instance.state === 'LAUNCHING') return true;
    if (instance.pid !== null && instance.start_token !== null && platform.isAlive(instance.pid, instance.start_token)) return true;
    removedDead.push(instance);
    stampEvent(data, 'instance-dead', { instance: instance.instance_id, project: instance.project, pid: instance.pid });
    return false;
  });
  const expiredCheckouts: SailInstance[] = [];
  for (const instance of data.instances) {
    if (instance.checkout && !liveLeases.has(instance.checkout.lease_id)) {
      expiredCheckouts.push(instance);
      stampEvent(data, 'checkout-expired', { instance: instance.instance_id, lease: instance.checkout.lease_id, agent: instance.checkout.agent });
      instance.checkout = null;
      instance.state = 'IDLE';
      instance.dirty = true;
      instance.hud = { phase: 'idle', note: 'previous agent vanished; state unknown' };
    }
  }
  const expiredTickets = data.queue.filter((ticket) => Date.parse(ticket.expires_at) <= now);
  for (const ticket of expiredTickets) stampEvent(data, 'ticket-expired', { ticket: ticket.ticket_id, agent: ticket.agent });
  data.queue = data.queue.filter((ticket) => Date.parse(ticket.expires_at) > now);
  return { removedDead, expiredCheckouts, expiredTickets };
}

export interface SailAcquireRequest {
  project: string;
  agent: string;
  intent: string;
  fingerprint: string;
  fresh: boolean;
  cap: number;
  ticketId: string | null;
  waiting: boolean;
}

export type SailPlan =
  | { kind: 'reuse'; instance: SailInstance }
  | { kind: 'launch' }
  | { kind: 'recycle'; instance: SailInstance }
  | { kind: 'queue'; position: number; ticketId: string }
  | { kind: 'ticket-lost' };

/**
 * Decide the next pool action for one acquire attempt. Strict FIFO: a newcomer
 * never barges past queued tickets, and a queued agent only acts at the head.
 */
export function planAcquire(data: SailRegistryData, request: SailAcquireRequest, waitTtlSeconds: number): SailPlan {
  const projectQueue = data.queue.filter((ticket) => ticket.project === request.project);
  if (request.ticketId) {
    const position = projectQueue.findIndex((ticket) => ticket.ticket_id === request.ticketId);
    if (position > 0) return { kind: 'queue', position, ticketId: request.ticketId };
    if (position === -1 && request.waiting) return { kind: 'ticket-lost' };
  } else if (projectQueue.length > 0) {
    return { kind: 'queue', position: enqueueTicket(data, request, waitTtlSeconds), ticketId: mustTail(data, request.project) };
  }

  const instances = data.instances.filter((instance) => instance.project === request.project);
  if (!request.fresh) {
    const match = instances.find((instance) => instance.state === 'IDLE' && !instance.dirty && instance.fingerprint === request.fingerprint);
    if (match) return { kind: 'reuse', instance: match };
  }
  if (instances.length < request.cap) return { kind: 'launch' };
  const recyclable = instances.find((instance) => instance.state === 'IDLE' && (instance.dirty || instance.fingerprint !== request.fingerprint || request.fresh));
  if (recyclable) return { kind: 'recycle', instance: recyclable };

  if (request.ticketId) return { kind: 'queue', position: 0, ticketId: request.ticketId };
  return { kind: 'queue', position: enqueueTicket(data, request, waitTtlSeconds), ticketId: mustTail(data, request.project) };
}

function enqueueTicket(data: SailRegistryData, request: SailAcquireRequest, waitTtlSeconds: number): number {
  const ticket: SailTicket = {
    ticket_id: `sail-tkt-${randomBytes(4).toString('hex')}`,
    project: request.project,
    agent: request.agent,
    intent: request.intent,
    fingerprint: request.fingerprint,
    enqueued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + waitTtlSeconds * 1000).toISOString(),
  };
  data.queue.push(ticket);
  stampEvent(data, 'ticket-enqueued', { ticket: ticket.ticket_id, project: ticket.project, agent: ticket.agent, intent: ticket.intent });
  return data.queue.filter((entry) => entry.project === request.project).length - 1;
}

function mustTail(data: SailRegistryData, project: string): string {
  const projectQueue = data.queue.filter((ticket) => ticket.project === project);
  const tail = projectQueue.at(-1);
  if (!tail) throw new Error('SAIL_QUEUE_INVARIANT: enqueue produced no tail ticket');
  return tail.ticket_id;
}

export function dropTicket(data: SailRegistryData, ticketId: string | null): void {
  if (ticketId) data.queue = data.queue.filter((ticket) => ticket.ticket_id !== ticketId);
}

export function newInstanceId(): string { return `sail-inst-${randomBytes(4).toString('hex')}`; }

export function findByCheckoutLease(data: SailRegistryData, leaseId: string): SailInstance | undefined {
  return data.instances.find((instance) => instance.checkout?.lease_id === leaseId);
}
