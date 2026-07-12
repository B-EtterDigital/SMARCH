/** Append-only SPL registry. All liveness and signalling goes through SplPlatform. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { resolveActorId } from './context-log.ts';
import { SMA_ROOT } from './sma-paths.ts';
import type { SplPlatform } from './spl-platform/contract.ts';
import { resolveSplPlatform } from './spl-platform/contract.ts';

type SplState = 'ACTIVE' | 'EXPIRED' | 'DEAD';
export interface SplProcessRecord { pid: number; start_token: string; lease_id: string; agent: string; label: string; registered_at: string }
interface SplRegistryEvent extends SplProcessRecord { event: 'registered' | 'unregistered'; timestamp: string; reason?: string }
export interface SplProcess extends SplProcessRecord { state: SplState }

export interface SplRegistryOptions { root?: string; registryPath?: string; leaseRegistryPath?: string; platform?: SplPlatform }

function paths(options: SplRegistryOptions) {
  const root = options.root ?? SMA_ROOT;
  return {
    registry: options.registryPath ?? resolve(root, 'registry/spl-registry.ndjson'),
    leases: options.leaseRegistryPath ?? resolve(root, 'registry/active-leases.generated.json'),
  };
}

function readEvents(path: string): SplRegistryEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as SplRegistryEvent]; } catch { return []; }
  });
}

function append(path: string, event: SplRegistryEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`);
}

function identity(pid: number, token: string): string { return `${String(pid)}:${token}`; }

function currentRecords(path: string): Map<string, SplProcessRecord> {
  const records = new Map<string, SplProcessRecord>();
  for (const event of readEvents(path)) {
    const key = identity(event.pid, event.start_token);
    if (event.event === 'registered') records.set(key, { pid: event.pid, start_token: event.start_token, lease_id: event.lease_id, agent: event.agent, label: event.label, registered_at: event.registered_at });
    else records.delete(key);
  }
  return records;
}

function liveLeaseIds(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { leases?: { lease_id?: string; expires_at?: string }[] };
    const now = Date.now();
    return new Set((parsed.leases ?? []).filter((lease) => Boolean(lease.lease_id) && Date.parse(lease.expires_at ?? '') > now).map((lease) => String(lease.lease_id)));
  } catch { return new Set(); }
}

export async function register(leaseId: string, pid: number, label: string, options: SplRegistryOptions = {}): Promise<SplProcessRecord> {
  if (!leaseId || !label || !Number.isSafeInteger(pid) || pid <= 1) throw new Error('SPL_REGISTER_INVALID');
  const platform = options.platform ?? await resolveSplPlatform();
  const startToken = platform.startToken(pid);
  if (!startToken) throw new Error(`SPL_PROCESS_NOT_FOUND: ${String(pid)}`);
  const record: SplProcessRecord = { pid, start_token: startToken, lease_id: leaseId, agent: resolveActorId(), label, registered_at: new Date().toISOString() };
  append(paths(options).registry, { event: 'registered', ...record, timestamp: record.registered_at });
  return record;
}

export function unregister(pid: number, expectedStartToken: string, options: SplRegistryOptions = {}, reason = 'explicit unregister'): Promise<boolean> {
  const location = paths(options).registry;
  const record = currentRecords(location).get(identity(pid, expectedStartToken));
  if (!record) return Promise.resolve(false);
  append(location, { event: 'unregistered', ...record, timestamp: new Date().toISOString(), reason });
  return Promise.resolve(true);
}

export async function unregisterLease(leaseId: string, options: SplRegistryOptions = {}, reason = 'lease ended'): Promise<number> {
  const location = paths(options).registry;
  const records = [...currentRecords(location).values()].filter((record) => record.lease_id === leaseId);
  const platform = options.platform ?? await resolveSplPlatform();
  const dead = records.filter((record) => !platform.isAlive(record.pid, record.start_token));
  for (const record of dead) append(location, { event: 'unregistered', ...record, timestamp: new Date().toISOString(), reason });
  return dead.length;
}

export async function list(options: SplRegistryOptions = {}): Promise<SplProcess[]> {
  const platform = options.platform ?? await resolveSplPlatform();
  const location = paths(options);
  const leases = liveLeaseIds(location.leases);
  return [...currentRecords(location.registry).values()].map((record) => ({
    ...record,
    state: !platform.isAlive(record.pid, record.start_token) ? 'DEAD' : leases.has(record.lease_id) ? 'ACTIVE' : 'EXPIRED',
  }));
}
