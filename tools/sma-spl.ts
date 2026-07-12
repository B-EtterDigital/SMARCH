#!/usr/bin/env node
/** Public CLI for Sweetspot Process Lease (SPL). Dry-run is the default. */
import { argv, exit } from 'node:process';
import { readFileSync } from 'node:fs';
import { appendContextEvent, resolveActorId } from './lib/context-log.ts';
import { findAgentOrphans, processResourceEstimate, type SplOrphan } from './lib/spl-agents.ts';
import { list, register, unregister, type SplProcess } from './lib/spl-registry.ts';
import { resolveSplPlatform } from './lib/spl-platform/contract.ts';

interface Args { command?: string; json: boolean; kill: boolean; adoptOrphans: boolean; pid?: number; lease?: string; label?: string; grace: number; minAge: number }

function parse(input: string[]): Args {
  const out: Args = { command: input[0], json: false, kill: false, adoptOrphans: false, grace: 8, minAge: 600 };
  for (let i = 1; i < input.length; i += 1) {
    const flag = input[i];
    if (flag === '--json') out.json = true;
    else if (flag === '--kill') out.kill = true;
    else if (flag === '--adopt-orphans') out.adoptOrphans = true;
    else if (flag === '--pid') out.pid = Number(input[++i]);
    else if (flag === '--lease') out.lease = input[++i];
    else if (flag === '--label') out.label = input[++i];
    else if (flag === '--grace') out.grace = Number(input[++i]);
    else if (flag === '--min-age') out.minAge = Number(input[++i]);
    else throw new Error(`SPL_ARGUMENT_UNKNOWN: ${flag}`);
  }
  if (!Number.isFinite(out.grace) || out.grace < 0 || !Number.isFinite(out.minAge) || out.minAge < 0) throw new Error('SPL_ARGUMENT_INVALID');
  return out;
}

function procParent(pid: number, procRoot = process.env.SMA_SPL_PROC_ROOT ?? '/proc'): number | null {
  try {
    const raw = readFileSync(`${procRoot}/${String(pid)}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
    return Number(fields[1]);
  } catch { return null; }
}

function ancestry(): Set<number> {
  const set = new Set<number>([1]);
  let pid = process.pid;
  while (pid > 1 && !set.has(pid)) { set.add(pid); pid = procParent(pid) ?? 1; }
  return set;
}

function audit(kind: 'spl_signal_sent' | 'spl_reap_outcome', item: SplProcess | SplOrphan, tier: string, reason: string, extra: { signal?: string; outcome?: string } = {}): void {
  appendContextEvent({
    project: 'sma', brick: 'spl-process-lifecycle', kind,
    intent: `${reason}: pid ${String(item.pid)} (${tier})`, actorKind: 'agent', actorId: resolveActorId(),
    ...('lease_id' in item ? { leaseId: item.lease_id } : {}),
    spl: { pid: item.pid, start_token: item.start_token, tier, reason, ...extra },
  });
}

async function snapshot(args: Args) {
  const registered = await list();
  const orphans = findAgentOrphans(registered, { minAgeSeconds: args.minAge });
  return { registered, orphans };
}

interface ReapResult { pid: number; tier: string; action?: string; reason?: string; outcome?: string; signals?: ('SIGTERM' | 'SIGKILL')[] }

function isProtectedProcess(pid: number, itemSession: number | null, protectedPids: Set<number>, protectedSession: number | null): boolean {
  return pid <= 1 || protectedPids.has(pid) || (protectedSession !== null && itemSession === protectedSession);
}

async function reapTarget(item: SplProcess | SplOrphan, args: Args, protectedPids: Set<number>): Promise<ReapResult> {
  const platform = await resolveSplPlatform();
  const tier = 'tier' in item ? item.tier : item.state;
  const reason = tier === 'ORPHAN?' ? 'explicit orphan adoption' : 'registered process lease expired';
  if (!args.kill) return { pid: item.pid, tier, action: 'would-reap', reason };
  const itemSession = platform.sessionId(item.pid);
  const protectedSession = platform.sessionId(process.pid);
  if (isProtectedProcess(item.pid, itemSession, protectedPids, protectedSession)) {
    audit('spl_reap_outcome', item, tier, reason, { outcome: 'refused-protected' });
    return { pid: item.pid, tier, outcome: 'refused-protected' };
  }
  if (tier === 'ORPHAN?' && procParent(item.pid) !== 1 && itemSession !== item.pid) {
    audit('spl_reap_outcome', item, tier, reason, { outcome: 'refused-non-orphan-shape' });
    return { pid: item.pid, tier, outcome: 'refused-non-orphan-shape' };
  }
  if (platform.startToken(item.pid) !== item.start_token) {
    audit('spl_reap_outcome', item, tier, reason, { outcome: 'identity-mismatch' });
    return { pid: item.pid, tier, outcome: 'identity-mismatch' };
  }
  const result = await platform.terminate(item.pid, item.start_token, { graceMs: args.grace * 1000 });
  for (const signal of result.signals ?? []) audit('spl_signal_sent', item, tier, reason, { signal });
  audit('spl_reap_outcome', item, tier, reason, { outcome: result.outcome });
  if ('state' in item && ['terminated', 'killed', 'already-dead'].includes(result.outcome)) await unregister(item.pid, item.start_token, {}, `reap ${result.outcome}`);
  return { pid: item.pid, tier, ...result };
}

function printTable(registered: SplProcess[], orphans: SplOrphan[]): void {
  console.log('PID      STARTED                  LEASE                       AGENT              STATE     LABEL');
  for (const row of registered) console.log(`${String(row.pid).padEnd(8)} ${row.start_token.slice(0, 24).padEnd(24)} ${row.lease_id.slice(0, 27).padEnd(27)} ${row.agent.slice(0, 18).padEnd(18)} ${row.state.padEnd(9)} ${row.label}`);
  console.log('\nORPHAN? (unregistered agent candidates; informational unless --adopt-orphans)');
  if (!orphans.length) console.log('(none)');
  for (const row of orphans) console.log(`${String(row.pid).padEnd(8)} ${row.start_token.slice(0, 24).padEnd(24)} ${'-'.padEnd(27)} ${row.agent.slice(0, 18).padEnd(18)} ${row.tier.padEnd(9)} ${row.label}`);
}

async function reap(args: Args): Promise<void> {
  const { registered, orphans } = await snapshot(args);
  const expired = registered.filter((item) => item.state === 'EXPIRED');
  const targets: (SplProcess | SplOrphan)[] = [...expired, ...(args.adoptOrphans ? orphans : [])];
  const protectedPids = ancestry();
  const results: ReapResult[] = [];
  for (const item of targets) results.push(await reapTarget(item, args, protectedPids));
  if (args.json) console.log(JSON.stringify({ dry_run: !args.kill, results }, null, 2));
  else {
    console.log(args.kill ? 'SPL reap outcomes' : 'SPL reap dry-run (pass --kill to signal)');
    for (const result of results) console.log(JSON.stringify(result));
    if (!results.length) console.log('(no eligible processes)');
  }
}

async function registerCommand(args: Args): Promise<void> {
  if (!args.lease || !args.pid || !args.label) throw new Error('usage: sma spl register --lease <id> --pid <n> --label <text>');
  console.log(JSON.stringify(await register(args.lease, args.pid, args.label), null, args.json ? 2 : 0));
}

async function unregisterCommand(args: Args): Promise<void> {
  if (!args.pid) throw new Error('usage: sma spl unregister --pid <n>');
  const token = (await resolveSplPlatform()).startToken(args.pid);
  const removed = token ? await unregister(args.pid, token) : false;
  console.log(args.json ? JSON.stringify({ removed }) : removed ? 'unregistered' : 'not registered');
}

async function listCommand(args: Args): Promise<void> {
  const data = await snapshot(args);
  if (args.json) console.log(JSON.stringify(data, null, 2));
  else printTable(data.registered, data.orphans);
}

async function budgetCommand(args: Args): Promise<void> {
  const budget = (await resolveSplPlatform()).budgetSnapshot();
  if (args.json) console.log(JSON.stringify(budget, null, 2));
  else Object.entries(budget).forEach(([key, value]) => { console.log(`${key}: ${String(value)}`); });
}

async function doctorCommand(args: Args): Promise<void> {
  const { registered, orphans } = await snapshot(args);
  const budget = (await resolveSplPlatform()).budgetSnapshot();
  const counts = { ACTIVE: registered.filter((x) => x.state === 'ACTIVE').length, EXPIRED: registered.filter((x) => x.state === 'EXPIRED').length, DEAD: registered.filter((x) => x.state === 'DEAD').length, 'ORPHAN?': orphans.length };
  const expiredUsage = registered.filter((entry) => entry.state === 'EXPIRED').map((entry) => processResourceEstimate(entry.pid));
  const reclaimable = [...orphans, ...expiredUsage];
  const health = { budget, counts, estimated_reclaimable_ram_mb: Number(reclaimable.reduce((n, x) => n + x.rss_mb, 0).toFixed(1)), estimated_reclaimable_cpu_seconds: Number(reclaimable.reduce((n, x) => n + x.cpu_seconds, 0).toFixed(1)) };
  if (args.json) {
    console.log(JSON.stringify(health, null, 2));
    return;
  }
  console.log('SPL machine health');
  Object.entries(budget).forEach(([key, value]) => { console.log(`${key}: ${String(value)}`); });
  console.log(`counts: ${JSON.stringify(counts)}`);
  console.log(`estimated reclaimable: ${String(health.estimated_reclaimable_ram_mb)} MB RAM, ${String(health.estimated_reclaimable_cpu_seconds)} CPU-seconds`);
}

async function main(): Promise<void> {
  const args = parse(argv.slice(2));
  if (args.command === 'register') await registerCommand(args);
  else if (args.command === 'unregister') await unregisterCommand(args);
  else if (args.command === 'list') await listCommand(args);
  else if (args.command === 'reap') await reap(args);
  else if (args.command === 'budget') await budgetCommand(args);
  else if (args.command === 'doctor') await doctorCommand(args);
  else printUsage(args.command);
}

function printUsage(command?: string): void {
  console.log('Usage: sma spl <register|unregister|list|reap|budget|doctor> [--json] [--min-age 600] [--kill] [--grace 8] [--adopt-orphans]');
  exit(command ? 2 : 0);
}

main().catch((error: unknown) => { const value = error as { code?: string; message?: string }; console.error(value.message ?? String(error)); exit(value.code === 'SPL_PLATFORM_UNSUPPORTED' ? 3 : 1); });
