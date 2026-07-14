#!/usr/bin/env node
/**
 * WHAT: Pools app-under-test instances (Electron lanes, CDP apps) behind fingerprint-matched, TTL'd checkouts.
 * WHY: Parallel agents otherwise orphan instances, steal each other's lanes, or overrun the machine's cap.
 * HOW: acquire reuses a warm matching instance, launches below the cap, recycles stale or dirty instances,
 * or queues FIFO; every instance is SPL-registered under a pool lease and every checkout is a real sma lease.
 * A per-instance HUD keeper shows the human which agent is testing what inside the app window itself.
 * INPUTS: A project id from registry/sail-projects.json, a build fingerprint, agent identity, and intent.
 * OUTPUTS: JSON checkout receipts (instance, lease, CDP endpoint), pool listings, doctor reports, reap outcomes.
 * CALLERS: SCAT loops, Gen3 steer drivers, SMOA orchestrators, and human controllers.
 * Usage: `node tools/sma-sail.ts acquire --project demo --build auto --intent "smoke the settings modal" --json`
 */

import { argv, env, exit } from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { appendContextEvent, resolveActorId } from './lib/context-log.ts';
import { register as splRegister, unregister as splUnregister } from './lib/spl-registry.ts';
import { resolveSplPlatform, type SplPlatform } from './lib/spl-platform/contract.ts';
import { processResourceEstimate } from './lib/spl-agents.ts';
import {
  clampCap, dropTicket, findByCheckoutLease, getProjectConfig, liveLeaseIds, loadProjects, newInstanceId,
  planAcquire, pruneRegistry, registryPath, stampEvent, ttls, withSailRegistry,
  type SailInstance, type SailPlan, type SailProjectConfig, type SailRegistryData, type SailRegistryOptions,
} from './lib/sail-registry.ts';
import { hudAction, hudScreenshot, installHud, openHudSession, runHudKeeper, updateHud, type SailHudState } from './lib/sail-hud.ts';

const SELF = fileURLToPath(import.meta.url);
const TOOLS_DIR = dirname(SELF);
const LEASE_CLI = resolve(TOOLS_DIR, 'sma-lease.ts');
const READY_TIMEOUT_MS = 45_000;
const EXIT_HELD = 10, EXIT_WAIT_TIMEOUT = 12, EXIT_POOL_FULL = 13;

interface Args {
  command?: string;
  project?: string; agent?: string; intent?: string; build?: string; discriminator?: string;
  lease?: string; instance?: string; note?: string; verdict?: string; phase?: string;
  wait?: number; ttl?: number; port?: number; queue?: number; offsetTop?: number;
  action?: string; out?: string; targetRe?: string;
  fresh: boolean; json: boolean; kill: boolean; dirty: boolean; all: boolean; noHud: boolean; withHud: boolean;
}

type BoolKey = 'fresh' | 'json' | 'kill' | 'dirty' | 'all' | 'noHud' | 'withHud';
type StringKey = 'project' | 'agent' | 'intent' | 'build' | 'discriminator' | 'lease' | 'instance' | 'note' | 'verdict' | 'phase' | 'action' | 'out' | 'targetRe';
type NumberKey = 'wait' | 'ttl' | 'port' | 'queue' | 'offsetTop';

const BOOL_FLAGS = new Map<string, BoolKey>([
  ['--fresh', 'fresh'], ['--json', 'json'], ['--kill', 'kill'], ['--dirty', 'dirty'],
  ['--all', 'all'], ['--no-hud', 'noHud'], ['--with-hud', 'withHud'],
]);
const STRING_FLAGS = new Map<string, StringKey>([
  ['--project', 'project'], ['--agent', 'agent'], ['--intent', 'intent'], ['--build', 'build'],
  ['--discriminator', 'discriminator'], ['--lease', 'lease'], ['--instance', 'instance'],
  ['--note', 'note'], ['--verdict', 'verdict'], ['--phase', 'phase'], ['--action', 'action'],
  ['--out', 'out'], ['--target-re', 'targetRe'],
]);
const NUMBER_FLAGS = new Map<string, NumberKey>([
  ['--wait', 'wait'], ['--ttl', 'ttl'], ['--port', 'port'], ['--queue', 'queue'], ['--offset-top', 'offsetTop'],
]);

function parse(input: string[]): Args {
  const out: Args = { command: input[0], fresh: false, json: false, kill: false, dirty: false, all: false, noHud: false, withHud: false };
  for (let index = 1; index < input.length; index += 1) {
    const flag = input[index];
    const boolKey = BOOL_FLAGS.get(flag);
    if (boolKey) { out[boolKey] = true; continue; }
    const stringKey = STRING_FLAGS.get(flag);
    if (stringKey) { out[stringKey] = input[++index]; continue; }
    const numberKey = NUMBER_FLAGS.get(flag);
    if (numberKey) { out[numberKey] = Number(input[++index]); continue; }
    throw new Error(`SAIL_ARGUMENT_UNKNOWN: ${flag}`);
  }
  return out;
}

const USAGE = `sma sail — Sweetspot App Instance Lease: pooled, fingerprint-matched app-under-test checkouts.

Usage:
  sma sail acquire   --project <id> --intent "..." [--build auto|<fp>] [--agent <id>]
                     [--wait <s>] [--fresh] [--ttl <s>] [--discriminator <text>] [--no-hud] [--json]
  sma sail release   --lease <checkout_lease_id> [--dirty] [--verdict pass|fail] [--note "..."]
  sma sail renew     --lease <checkout_lease_id> [--ttl <s>]
  sma sail check     --lease <checkout_lease_id>          (exit 0 live, ${String(EXIT_HELD)} stale — fencing helper)
  sma sail list      [--project <id>] [--json]
  sma sail doctor    [--project <id>] [--json]
  sma sail reap      [--project <id>] [--kill] [--all]    (dry-run by default; --all drains idle instances)
  sma sail fingerprint --project <id> [--discriminator <text>]
  sma sail hud       --instance <id> --phase steering|observing|idle [--note "..."]
  sma sail hud-inject --port <cdp-port> --action install|update|hide|show|remove|screenshot
                     [--agent ...] [--intent ...] [--phase ...] [--queue <n>] [--offset-top <px>]
                     [--with-hud] [--out shot.png] [--target-re <regex>]
  sma sail selftest  [--json]

Exit codes: ${String(EXIT_POOL_FULL)} pool full (re-run with --wait), ${String(EXIT_WAIT_TIMEOUT)} wait timeout, ${String(EXIT_HELD)} stale/unknown lease.`;

const COMMAND_HANDLERS = new Map<string, (args: Args, options: SailRegistryOptions) => Promise<void> | void>([
  ['acquire', acquireCommand],
  ['release', releaseCommand],
  ['renew', renewCommand],
  ['check', checkCommand],
  ['list', listCommand],
  ['doctor', doctorCommand],
  ['reap', reapCommand],
  ['fingerprint', fingerprintCommand],
  ['hud', hudCommand],
  ['hud-keeper', hudKeeperCommand],
  ['hud-inject', (args) => hudInjectCommand(args)],
  ['selftest', (args) => selftestCommand(args)],
]);

async function main(): Promise<void> {
  const args = parse(argv.slice(2));
  if (!args.command || ['help', '--help', '-h'].includes(args.command)) {
    console.log(USAGE);
    exit(args.command ? 0 : 2);
  }
  const handler = COMMAND_HANDLERS.get(args.command);
  if (!handler) {
    console.error(`sail: unknown subcommand "${args.command}"`);
    console.error(USAGE);
    exit(2);
  }
  await handler(args, {});
}

// ── shared helpers ───────────────────────────────────────────────────────────

function fail(code: number, message: string): Error {
  const error = new Error(message) as Error & { code: number };
  error.code = code;
  return error;
}

function requireProject(args: Args, options: SailRegistryOptions): { project: string; config: SailProjectConfig } {
  if (!args.project) throw fail(2, '--project is required');
  const config = getProjectConfig(options, args.project);
  if (!config) throw fail(2, `SAIL_PROJECT_UNKNOWN: "${args.project}" has no entry in registry/sail-projects.json`);
  return { project: args.project, config };
}

function leaseCli(cliArgs: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [LEASE_CLI, ...cliArgs], { encoding: 'utf8', env: process.env });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function acquireLease(kind: string, resource: string, agent: string, intent: string, ttlSeconds: number): { lease_id: string; expires_at: string } {
  const result = leaseCli(['acquire', '--resource-kind', kind, '--resource', resource, '--agent', agent, '--intent', intent, '--ttl', String(ttlSeconds), '--json']);
  if (result.status !== 0) throw fail(EXIT_HELD, `SAIL_LEASE_ACQUIRE_FAILED (${kind}/${resource}): ${result.stderr.trim() || result.stdout.trim()}`);
  return JSON.parse(result.stdout) as { lease_id: string; expires_at: string };
}

function renewLease(leaseId: string, agent: string, ttlSeconds: number): boolean {
  return leaseCli(['renew', '--lease', leaseId, '--agent', agent, '--ttl', String(ttlSeconds), '--json']).status === 0;
}

function releaseLease(leaseId: string, agent: string, reason: string): void {
  // Best-effort: a rejected release leaves the lease to expire by TTL, which
  // prune already treats as an abandoned checkout.
  leaseCli(['release', '--lease', leaseId, '--agent', agent, '--reason', reason]);
}

function stampSail(action: string, instance: Pick<SailInstance, 'instance_id' | 'project'>, intent: string, detail: Record<string, unknown> = {}): void {
  try {
    appendContextEvent({
      project: 'sma', brick: 'sail-instance-lifecycle', kind: 'sail_instance_event', intent,
      actorKind: 'agent', actorId: resolveActorId(),
      sail: { action, instance_id: instance.instance_id, project: instance.project, ...detail },
    });
  } catch { /* context log unavailable (hermetic selftest roots); pool events still record it */ }
}

function sleep(ms: number): Promise<void> { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }

// ── fingerprint ──────────────────────────────────────────────────────────────

function sha1(text: string): string { return createHash('sha1').update(text).digest('hex'); }

function walkManifest(root: string, relative: string, lines: string[]): void {
  const absolute = join(root, relative);
  let stats;
  try { stats = statSync(absolute); } catch { return; }
  if (stats.isFile()) { lines.push(`${relative}:${String(stats.size)}:${String(Math.trunc(stats.mtimeMs))}`); return; }
  if (!stats.isDirectory()) return;
  for (const entry of readdirSync(absolute)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    walkManifest(root, join(relative, entry), lines);
  }
}

export function computeFingerprint(config: SailProjectConfig, discriminator?: string): string {
  const parts: string[] = [];
  const git = (gitArgs: string[]): string => {
    const result = spawnSync('git', ['-C', config.cwd, ...gitArgs], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : '';
  };
  parts.push(`head:${git(['rev-parse', 'HEAD']) || 'no-git'}`);
  parts.push(`dirty:${sha1(git(['status', '--porcelain']))}`);
  for (const manifestPath of config.fingerprint_paths ?? []) {
    const lines: string[] = [];
    walkManifest(config.cwd, manifestPath, lines);
    parts.push(`${manifestPath}:${sha1(lines.sort().join('\n'))}`);
  }
  if (discriminator) parts.push(`disc:${discriminator}`);
  return `fp-${sha1(parts.join('|')).slice(0, 16)}`;
}

function resolveFingerprint(args: Args, config: SailProjectConfig): string {
  const requested = args.build ?? 'auto';
  return requested === 'auto' ? computeFingerprint(config, args.discriminator) : requested;
}

function fingerprintCommand(args: Args, options: SailRegistryOptions): void {
  const { config } = requireProject(args, options);
  console.log(computeFingerprint(config, args.discriminator));
}

// ── launch / retire ──────────────────────────────────────────────────────────

async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') { rejectPort(new Error('SAIL_PORT_ALLOCATION_FAILED')); return; }
      server.close(() => { resolvePort(address.port); });
    });
    server.on('error', rejectPort);
  });
}

async function readyPing(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.status === 200;
  } catch { return false; }
}

function substitute(template: string, port: number, pid?: number): string {
  return template.replaceAll('{PORT}', String(port)).replaceAll('{PID}', pid === undefined ? '{PID}' : String(pid));
}

function sailLogFd(options: SailRegistryOptions, project: string, port: number): number {
  const directory = resolve(dirname(registryPath(options)), '..', 'logs', 'sail');
  mkdirSync(directory, { recursive: true });
  return openSync(join(directory, `${project}-${String(port)}.log`), 'a');
}

interface LaunchResult { pid: number; startToken: string; port: number; cdp: string }

async function performLaunch(config: SailProjectConfig, project: string, platform: SplPlatform, options: SailRegistryOptions): Promise<LaunchResult> {
  if (!existsSync(config.cwd)) throw fail(2, `SAIL_LAUNCH_UNSATISFIABLE: cwd ${config.cwd} does not exist`);
  const port = await freePort();
  const commandArgv = config.argv.map((part) => substitute(part, port));
  const childEnv = { ...process.env, ...Object.fromEntries(Object.entries(config.env ?? {}).map(([key, value]) => [key, substitute(value, port)])) };
  const logFd = sailLogFd(options, project, port);
  const child = spawn(commandArgv[0], commandArgv.slice(1), { cwd: config.cwd, env: childEnv, detached: true, stdio: ['ignore', logFd, logFd] });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('spawn', () => { resolveSpawn(); });
    child.once('error', rejectSpawn);
  });
  child.unref();
  if (!child.pid) throw fail(1, `SAIL_LAUNCH_FAILED: spawn returned no pid for ${commandArgv[0]}`);
  const startToken = platform.startToken(child.pid);
  if (!startToken) throw fail(1, 'SAIL_LAUNCH_FAILED: instance died before identity capture');
  const readyUrl = `http://127.0.0.1:${String(port)}${config.ready_path ?? '/json/version'}`;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (await readyPing(readyUrl)) break;
    if (!platform.isAlive(child.pid, startToken)) throw fail(1, `SAIL_LAUNCH_FAILED: instance exited before readiness (${readyUrl})`);
    if (Date.now() > deadline) {
      await platform.terminate(child.pid, startToken, { graceMs: 2000 });
      throw fail(1, `SAIL_LAUNCH_TIMEOUT: ${readyUrl} never returned 200`);
    }
    await sleep(250);
  }
  for (const step of config.post_launch ?? []) {
    const stepArgv = step.split(' ').map((part) => substitute(part, port, child.pid));
    spawnSync(stepArgv[0], stepArgv.slice(1), { stdio: 'ignore' });
  }
  return { pid: child.pid, startToken, port, cdp: `http://127.0.0.1:${String(port)}` };
}

async function retireInstance(instance: SailInstance, platform: SplPlatform, reason: string): Promise<void> {
  if (instance.hud_pid !== null) {
    const hudToken = platform.startToken(instance.hud_pid);
    if (hudToken) {
      await platform.terminate(instance.hud_pid, hudToken, { graceMs: 1000 });
      await splUnregister(instance.hud_pid, hudToken, {}, `sail retire: ${reason}`);
    }
  }
  if (instance.pid !== null && instance.start_token !== null) {
    await platform.terminate(instance.pid, instance.start_token, { graceMs: 5000 });
    await splUnregister(instance.pid, instance.start_token, {}, `sail retire: ${reason}`);
  }
  if (instance.pool_lease_id !== null) releaseLease(instance.pool_lease_id, instance.launched_by, `sail retire: ${reason}`);
  stampSail('instance-retired', instance, `retired app instance (${reason})`, { reason, pid: instance.pid });
}

function poolLeaseTtl(config: SailProjectConfig): number {
  const limits = ttls(config);
  return limits.lease + limits.idle;
}

// ── acquire ──────────────────────────────────────────────────────────────────

async function acquireCommand(args: Args, options: SailRegistryOptions): Promise<void> {
  const { project, config } = requireProject(args, options);
  if (!args.intent) throw fail(2, '--intent is required');
  const platform = await resolveSplPlatform();
  const agent = args.agent ?? resolveActorId();
  const intent = args.intent;
  const fingerprint = resolveFingerprint(args, config);
  const limits = ttls(config);
  const checkoutTtl = args.ttl ?? limits.lease;
  const cap = clampCap(config, platform.budgetSnapshot().recommended_agents);
  const waitSeconds = args.wait ?? 0;
  const deadline = Date.now() + waitSeconds * 1000;
  let ticketId: string | null = null;

  for (;;) {
    const plan = withSailRegistry(options, (data) => {
      pruneRegistry(data, platform, liveLeaseIds(options));
      const decided = planAcquire(data, { project, agent, intent, fingerprint, fresh: args.fresh, cap, ticketId, waiting: waitSeconds > 0 }, limits.wait);
      return commitAcquirePlan(data, decided, { project, agent, intent, fingerprint, checkoutTtl, config, ticketId });
    });
    if (plan.kind === 'queued') ticketId = plan.ticketId;
    if (plan.kind === 'ticket-lost') ticketId = null;

    if (plan.kind === 'leased') { emitReceipt(plan.receipt, args.json); return; }

    if (plan.kind === 'recycle') {
      await retireInstance(plan.instance, platform, plan.instance.dirty ? 'dirty' : 'stale-build');
      withSailRegistry(options, (data) => {
        data.instances = data.instances.filter((instance) => instance.instance_id !== plan.instance.instance_id);
      });
      continue;
    }

    if (plan.kind === 'launch') {
      const receipt = await finalizeLaunch(plan.instanceId, project, config, platform, options, agent, intent, checkoutTtl, args);
      emitReceipt(receipt, args.json);
      return;
    }

    if (waitSeconds === 0 || Date.now() > deadline) failAcquire(options, ticketId, project, cap, waitSeconds);
    await sleep(1000);
  }
}

function failAcquire(options: SailRegistryOptions, ticketId: string | null, project: string, cap: number, waitSeconds: number): never {
  if (ticketId) withSailRegistry(options, (data) => { dropTicket(data, ticketId); });
  if (waitSeconds > 0) throw fail(EXIT_WAIT_TIMEOUT, `SAIL_WAIT_TIMEOUT: pool "${project}" still full after ${String(waitSeconds)}s (cap ${String(cap)})`);
  throw fail(EXIT_POOL_FULL, `SAIL_POOL_FULL: "${project}" at cap ${String(cap)}; re-run with --wait <seconds> to queue`);
}

interface CheckoutReceipt { instance_id: string; lease_id: string; generation: number; port: number | null; cdp: string | null; fingerprint: string; expires_at: string; how: string }

interface AcquireContext { project: string; agent: string; intent: string; fingerprint: string; checkoutTtl: number; config: SailProjectConfig; ticketId: string | null }

type AcquireOutcome =
  | { kind: 'leased'; receipt: CheckoutReceipt }
  | { kind: 'launch'; instanceId: string }
  | { kind: 'recycle'; instance: SailInstance }
  | { kind: 'queued'; position: number; ticketId: string }
  | { kind: 'ticket-lost' };

/** Commit one planned pool action inside the registry critical section. */
function commitAcquirePlan(data: SailRegistryData, decided: SailPlan, context: AcquireContext): AcquireOutcome {
  if (decided.kind === 'reuse') {
    const receipt = checkoutInstance(data, decided.instance, context.agent, context.intent, context.checkoutTtl, context.config, 'reused');
    dropTicket(data, context.ticketId);
    return { kind: 'leased', receipt };
  }
  if (decided.kind === 'launch') {
    const instance: SailInstance = {
      instance_id: newInstanceId(), project: context.project, pid: null, start_token: null, port: null, cdp: null,
      fingerprint: context.fingerprint, state: 'LAUNCHING', dirty: false, generation: 0, leases_served: 0,
      pool_lease_id: null, hud_pid: null, hud: { phase: 'idle', note: null },
      launched_by: context.agent, launched_at: new Date().toISOString(), last_activity: new Date().toISOString(), checkout: null,
    };
    data.instances.push(instance);
    dropTicket(data, context.ticketId);
    stampEvent(data, 'instance-launching', { instance: instance.instance_id, project: context.project, fingerprint: context.fingerprint, agent: context.agent });
    return { kind: 'launch', instanceId: instance.instance_id };
  }
  if (decided.kind === 'recycle') {
    decided.instance.state = 'RETIRING';
    stampEvent(data, 'instance-retiring', { instance: decided.instance.instance_id, reason: decided.instance.dirty ? 'dirty' : 'stale-build' });
    return { kind: 'recycle', instance: decided.instance };
  }
  if (decided.kind === 'ticket-lost') return { kind: 'ticket-lost' };
  return { kind: 'queued', position: decided.position, ticketId: decided.ticketId };
}

function checkoutInstance(data: SailRegistryData, instance: SailInstance, agent: string, intent: string, checkoutTtl: number, config: SailProjectConfig, how: string): CheckoutReceipt {
  const receipt = acquireLease('app-instance', instance.instance_id, agent, intent, checkoutTtl);
  instance.generation += 1;
  instance.leases_served += 1;
  instance.state = 'LEASED';
  instance.dirty = false;
  instance.last_activity = new Date().toISOString();
  instance.checkout = { lease_id: receipt.lease_id, agent, intent, acquired_at: new Date().toISOString(), ttl_s: checkoutTtl, generation: instance.generation };
  instance.hud = { phase: 'steering', note: null };
  if (instance.pool_lease_id !== null) renewLease(instance.pool_lease_id, instance.launched_by, poolLeaseTtl(config));
  stampEvent(data, 'leased', { instance: instance.instance_id, lease: receipt.lease_id, agent, intent, how });
  stampSail('leased', instance, `leased app instance to ${agent}: ${intent}`, { lease_id: receipt.lease_id, agent, how, fingerprint: instance.fingerprint });
  return { instance_id: instance.instance_id, lease_id: receipt.lease_id, generation: instance.generation, port: instance.port, cdp: instance.cdp, fingerprint: instance.fingerprint, expires_at: receipt.expires_at, how };
}

async function finalizeLaunch(instanceId: string, project: string, config: SailProjectConfig, platform: SplPlatform, options: SailRegistryOptions, agent: string, intent: string, checkoutTtl: number, args: Args): Promise<CheckoutReceipt> {
  let poolLeaseId: string | null = null;
  try {
    poolLeaseId = acquireLease('app-instance-pool', instanceId, agent, `sail pool ownership of ${instanceId}`, poolLeaseTtl(config)).lease_id;
    const launched = await performLaunch(config, project, platform, options);
    await splRegister(poolLeaseId, launched.pid, `sail:${project}:${instanceId}`);
    const hudPid = (config.hud === false || args.noHud) ? null : spawnHudKeeper(instanceId, options, poolLeaseId, project, launched.port);
    return withSailRegistry(options, (data) => {
      const instance = data.instances.find((candidate) => candidate.instance_id === instanceId);
      if (!instance) throw fail(1, 'SAIL_REGISTRY_INVARIANT: launch reservation vanished');
      instance.pid = launched.pid;
      instance.start_token = launched.startToken;
      instance.port = launched.port;
      instance.cdp = launched.cdp;
      instance.pool_lease_id = poolLeaseId;
      instance.hud_pid = hudPid;
      instance.state = 'IDLE';
      stampEvent(data, 'instance-launched', { instance: instanceId, pid: launched.pid, port: launched.port });
      stampSail('instance-launched', instance, `launched app instance for ${project}`, { pid: launched.pid, port: launched.port, fingerprint: instance.fingerprint });
      return checkoutInstance(data, instance, agent, intent, checkoutTtl, config, 'fresh-launch');
    });
  } catch (error) {
    withSailRegistry(options, (data) => {
      data.instances = data.instances.filter((instance) => instance.instance_id !== instanceId);
      stampEvent(data, 'launch-failed', { instance: instanceId, error: (error as Error).message });
    });
    if (poolLeaseId !== null) releaseLease(poolLeaseId, agent, 'sail launch failed');
    throw error;
  }
}

function spawnHudKeeper(instanceId: string, options: SailRegistryOptions, poolLeaseId: string, project: string, port: number): number | null {
  const keeperEnv = { ...process.env };
  const logFd = sailLogFd(options, `${project}-hud`, port);
  const keeper = spawn(process.execPath, [SELF, 'hud-keeper', '--instance', instanceId], { detached: true, stdio: ['ignore', logFd, logFd], env: keeperEnv });
  keeper.unref();
  if (!keeper.pid) return null;
  splRegister(poolLeaseId, keeper.pid, `sail-hud:${instanceId}`).catch(() => { /* keeper still reaped via pool lease expiry */ });
  return keeper.pid;
}

function emitReceipt(receipt: CheckoutReceipt, json: boolean): void {
  if (json) { console.log(JSON.stringify(receipt)); return; }
  console.log(JSON.stringify(receipt, null, 2));
}

// ── release / renew / check ──────────────────────────────────────────────────

async function releaseCommand(args: Args, options: SailRegistryOptions): Promise<void> {
  if (!args.lease) throw fail(2, '--lease is required');
  const platform = await resolveSplPlatform();
  const released = withSailRegistry(options, (data) => {
    pruneRegistry(data, platform, liveLeaseIds(options));
    const instance = findByCheckoutLease(data, args.lease ?? '');
    if (!instance?.checkout) throw fail(EXIT_HELD, `SAIL_LEASE_UNKNOWN: no live checkout ${args.lease ?? ''}`);
    const checkout = instance.checkout;
    instance.checkout = null;
    instance.state = 'IDLE';
    instance.dirty = args.dirty;
    instance.last_activity = new Date().toISOString();
    instance.hud = { phase: 'idle', note: args.dirty ? 'released dirty — will restart before next checkout' : 'warm — same build reusable' };
    stampEvent(data, 'released', { instance: instance.instance_id, lease: checkout.lease_id, agent: checkout.agent, dirty: args.dirty, verdict: args.verdict ?? null, note: args.note ?? null });
    stampSail('released', instance, `released app instance (${args.verdict ?? 'no verdict'})`, { lease_id: checkout.lease_id, agent: checkout.agent, dirty: args.dirty, verdict: args.verdict ?? null });
    return { instance, checkout };
  });
  releaseLease(released.checkout.lease_id, released.checkout.agent, `sail release${args.dirty ? ' (dirty)' : ''}`);
  const config = getProjectConfig(options, released.instance.project);
  if (released.instance.pool_lease_id !== null && config) renewLease(released.instance.pool_lease_id, released.instance.launched_by, poolLeaseTtl(config));
  console.log(`released ${released.checkout.lease_id} (${released.instance.instance_id}${args.dirty ? ', dirty' : ''})`);
}

async function renewCommand(args: Args, options: SailRegistryOptions): Promise<void> {
  if (!args.lease) throw fail(2, '--lease is required');
  const platform = await resolveSplPlatform();
  const renewed = withSailRegistry(options, (data) => {
    pruneRegistry(data, platform, liveLeaseIds(options));
    const instance = findByCheckoutLease(data, args.lease ?? '');
    if (!instance?.checkout) throw fail(EXIT_HELD, `SAIL_LEASE_UNKNOWN: no live checkout ${args.lease ?? ''} (expired checkouts mark the instance dirty)`);
    instance.last_activity = new Date().toISOString();
    return { agent: instance.checkout.agent, ttl: args.ttl ?? instance.checkout.ttl_s, poolLease: instance.pool_lease_id, launchedBy: instance.launched_by, project: instance.project };
  });
  if (!renewLease(args.lease, renewed.agent, renewed.ttl)) throw fail(EXIT_HELD, `SAIL_RENEW_FAILED: ${args.lease}`);
  const config = getProjectConfig(options, renewed.project);
  if (renewed.poolLease !== null && config) renewLease(renewed.poolLease, renewed.launchedBy, poolLeaseTtl(config));
  console.log(JSON.stringify({ lease_id: args.lease, ttl_s: renewed.ttl }));
}

async function checkCommand(args: Args, options: SailRegistryOptions): Promise<void> {
  if (!args.lease) throw fail(2, '--lease is required');
  const platform = await resolveSplPlatform();
  const live = withSailRegistry(options, (data) => {
    pruneRegistry(data, platform, liveLeaseIds(options));
    return Boolean(findByCheckoutLease(data, args.lease ?? ''));
  });
  if (!live) throw fail(EXIT_HELD, `SAIL_FENCE_STALE: checkout ${args.lease} is no longer live — stop steering`);
  console.log('live');
}

// ── list / doctor / reap ─────────────────────────────────────────────────────

async function snapshot(options: SailRegistryOptions): Promise<SailRegistryData> {
  const platform = await resolveSplPlatform();
  return withSailRegistry(options, (data) => {
    pruneRegistry(data, platform, liveLeaseIds(options));
    return structuredClone(data);
  });
}

function projectFilter<T extends { project: string }>(rows: T[], project?: string): T[] {
  return project ? rows.filter((row) => row.project === project) : rows;
}

async function listCommand(args: Args, options: SailRegistryOptions): Promise<void> {
  const data = await snapshot(options);
  const instances = projectFilter(data.instances, args.project);
  const queue = projectFilter(data.queue, args.project);
  if (args.json) { console.log(JSON.stringify({ instances, queue }, null, 2)); return; }
  for (const instance of instances) {
    const holder = instance.checkout ? `${instance.checkout.agent} — "${instance.checkout.intent}"` : '';
    console.log(`${instance.instance_id}  ${instance.project}  pid=${String(instance.pid)}  :${String(instance.port)}  ${instance.state}${instance.dirty ? '+DIRTY' : ''}  ${instance.fingerprint}  ${holder}`);
  }
  queue.forEach((ticket, position) => { console.log(`  queue[${String(position)}] ${ticket.project} ${ticket.agent} — "${ticket.intent}" ${ticket.fingerprint}`); });
  if (!instances.length && !queue.length) console.log('(pool empty)');
}

async function doctorCommand(args: Args, options: SailRegistryOptions): Promise<void> {
  const platform = await resolveSplPlatform();
  const data = await snapshot(options);
  const projects = loadProjects(options);
  const instances = projectFilter(data.instances, args.project).map((instance) => ({
    instance: instance.instance_id,
    project: instance.project,
    state: instance.state + (instance.dirty ? '+DIRTY' : ''),
    pid: instance.pid,
    port: instance.port,
    fingerprint: instance.fingerprint,
    rss_mb: instance.pid === null ? null : processResourceEstimate(instance.pid).rss_mb,
    holder: instance.checkout?.agent ?? null,
    intent: instance.checkout?.intent ?? null,
    generation: instance.generation,
    leases_served: instance.leases_served,
    idle_for_s: instance.state === 'IDLE' ? Math.round((Date.now() - Date.parse(instance.last_activity)) / 1000) : null,
  }));
  const report = {
    budget: platform.budgetSnapshot(),
    caps: Object.fromEntries(Object.entries(projects).map(([id, config]) => [id, clampCap(config, platform.budgetSnapshot().recommended_agents)])),
    live: instances.length,
    queued: projectFilter(data.queue, args.project).length,
    instances,
    queue: projectFilter(data.queue, args.project),
  };
  console.log(JSON.stringify(report, null, 2));
}

async function reapCommand(args: Args, options: SailRegistryOptions): Promise<void> {
  const platform = await resolveSplPlatform();
  const victims = withSailRegistry(options, (data) => {
    pruneRegistry(data, platform, liveLeaseIds(options));
    const now = Date.now();
    const eligible = projectFilter(data.instances, args.project).filter((instance) => {
      if (instance.state !== 'IDLE') return false;
      if (args.all) return true;
      const config = getProjectConfig(options, instance.project);
      const idleTtl = config ? ttls(config).idle : 900;
      const idleFor = (now - Date.parse(instance.last_activity)) / 1000;
      const wanted = data.queue.some((ticket) => ticket.project === instance.project && ticket.fingerprint === instance.fingerprint);
      return idleFor > idleTtl && !wanted;
    });
    if (args.kill) {
      const ids = new Set(eligible.map((instance) => instance.instance_id));
      for (const instance of eligible) stampEvent(data, 'instance-reaped', { instance: instance.instance_id, reason: args.all ? 'drain' : 'idle-ttl' });
      data.instances = data.instances.filter((instance) => !ids.has(instance.instance_id));
    }
    return structuredClone(eligible);
  });
  for (const victim of victims) {
    console.log(`${args.kill ? 'reaping' : 'would reap'} ${victim.instance_id} (${victim.project}) pid=${String(victim.pid)}`);
    if (args.kill) await retireInstance(victim, platform, args.all ? 'drain' : 'idle-ttl');
  }
  if (!victims.length) console.log('nothing to reap');
}

// ── HUD ──────────────────────────────────────────────────────────────────────

async function hudCommand(args: Args, options: SailRegistryOptions): Promise<void> {
  if (!args.instance || !args.phase) throw fail(2, '--instance and --phase are required');
  const platform = await resolveSplPlatform();
  withSailRegistry(options, (data) => {
    pruneRegistry(data, platform, liveLeaseIds(options));
    const instance = data.instances.find((candidate) => candidate.instance_id === args.instance);
    if (!instance) throw fail(2, `SAIL_INSTANCE_UNKNOWN: ${args.instance ?? ''}`);
    instance.hud = { phase: args.phase ?? 'idle', note: args.note ?? null };
    instance.last_activity = new Date().toISOString();
  });
  console.log('hud state recorded (keeper renders it)');
}

function hudStateFromRegistry(options: SailRegistryOptions, instanceId: string): SailHudState | null {
  try {
    const raw = JSON.parse(readFileSync(registryPath(options), 'utf8')) as SailRegistryData;
    const instance = raw.instances.find((candidate) => candidate.instance_id === instanceId);
    if (!instance || instance.state === 'RETIRING') return null;
    const config = loadProjects(options)[instance.project] ?? { cwd: '.', argv: [] };
    const queueDepth = raw.queue.filter((ticket) => ticket.project === instance.project).length;
    if (!instance.checkout) return { agent: '—', intent: 'idle — warm instance', phase: 'idle', queue: queueDepth, offsetTop: config.hud_offset_top ?? 44 };
    return {
      agent: instance.checkout.agent,
      intent: instance.hud.note ?? instance.checkout.intent,
      phase: instance.hud.phase,
      queue: queueDepth,
      since: Date.parse(instance.checkout.acquired_at),
      offsetTop: config.hud_offset_top ?? 44,
    };
  } catch { return null; }
}

async function hudKeeperCommand(args: Args, options: SailRegistryOptions): Promise<void> {
  if (!args.instance) throw fail(2, '--instance is required');
  const instanceId = args.instance;
  const port = (() => {
    const raw = JSON.parse(readFileSync(registryPath(options), 'utf8')) as SailRegistryData;
    return raw.instances.find((candidate) => candidate.instance_id === instanceId)?.port ?? null;
  })();
  if (port === null) throw fail(2, `SAIL_INSTANCE_UNKNOWN: ${instanceId}`);
  await runHudKeeper({ port, readState: () => hudStateFromRegistry(options, instanceId) });
}

async function hudInjectCommand(args: Args): Promise<void> {
  if (!args.port) throw fail(2, '--port is required');
  const client = await openHudSession(args.port, args.targetRe);
  try {
    const state: SailHudState = {};
    if (args.agent !== undefined) state.agent = args.agent;
    if (args.intent !== undefined) state.intent = args.intent;
    if (args.phase !== undefined) state.phase = args.phase;
    if (args.queue !== undefined) state.queue = args.queue;
    if (args.offsetTop !== undefined) state.offsetTop = args.offsetTop;
    const action = args.action ?? 'install';
    if (action === 'install') { await installHud(client, state); console.log('HUD installed'); }
    else if (action === 'update') { await updateHud(client, state); console.log('HUD updated'); }
    else if (action === 'hide' || action === 'show' || action === 'remove') { await hudAction(client, action); console.log(`HUD ${action}`); }
    else if (action === 'screenshot') {
      const image = await hudScreenshot(client, args.withHud);
      const outPath = args.out ?? 'sail-shot.png';
      writeFileSync(outPath, image);
      console.log(`screenshot → ${outPath}`);
    } else throw fail(2, `SAIL_HUD_ACTION_UNKNOWN: ${action}`);
  } finally {
    client.close();
  }
}

// ── selftest ─────────────────────────────────────────────────────────────────

const FAKE_APP_SOURCE = `
import http from 'node:http';
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
const server = http.createServer((request, response) => {
  if (request.url === '/json/version') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"Browser":"FakeElectron/1.0"}'); return; }
  response.writeHead(404); response.end();
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => { server.close(); process.exit(0); });
`;

interface SelftestCase { name: string; passed: boolean; detail: string }
interface SelftestRun { status: number | null; stdout: string; stderr: string }
interface SelftestHarness { run: (cliArgs: string[]) => SelftestRun; runAsync: (cliArgs: string[]) => Promise<SelftestRun> }

function makeSelftestHarness(): SelftestHarness {
  const root = mkdtempSync(join(tmpdir(), 'sail-selftest-'));
  const fakeApp = join(root, 'fake-app.mjs');
  writeFileSync(fakeApp, FAKE_APP_SOURCE);
  writeFileSync(join(root, 'sail-projects.json'), JSON.stringify({
    projects: { selftest: { cap: 2, budget_clamp: false, lease_ttl_s: 120, idle_ttl_s: 300, wait_ttl_s: 60, cwd: root, hud: false, argv: ['node', fakeApp, '--port', '{PORT}'] } },
  }, null, 2));
  const testEnv = {
    ...process.env,
    SMA_SAIL_REGISTRY_PATH: join(root, 'sail-instances.generated.json'),
    SMA_SAIL_PROJECTS_PATH: join(root, 'sail-projects.json'),
    SMA_LEASE_REGISTRY_PATH: join(root, 'active-leases.generated.json'),
    SMA_SPL_REGISTRY_PATH: join(root, 'spl-registry.ndjson'),
  };
  const run = (cliArgs: string[]): SelftestRun => {
    const result = spawnSync(process.execPath, [SELF, ...cliArgs], { encoding: 'utf8', env: testEnv });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const runAsync = (cliArgs: string[]): Promise<SelftestRun> => new Promise((resolveRun) => {
    const child = spawn(process.execPath, [SELF, ...cliArgs], { env: testEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('exit', (code) => { resolveRun({ status: code, stdout, stderr }); });
  });
  return { run, runAsync };
}

function receiptOf(result: SelftestRun): CheckoutReceipt {
  if (result.status !== 0 || !result.stdout.trim()) throw fail(1, `SAIL_SELFTEST_STEP_FAILED (exit ${String(result.status)}): ${result.stderr.trim() || 'no output'}`);
  return JSON.parse(result.stdout) as CheckoutReceipt;
}

async function selftestCommand(args: Args): Promise<void> {
  const { run, runAsync } = makeSelftestHarness();
  const cases: SelftestCase[] = [];
  const record = (name: string, passed: boolean, detail: string): void => { cases.push({ name, passed, detail }); };

  try {
    const first = run(['acquire', '--project', 'selftest', '--agent', 'agent-A', '--intent', 'selftest first checkout', '--build', 'fp-AAA', '--json']);
    record('fresh launch below cap', first.status === 0, first.stderr.trim() || 'launched');
    const firstReceipt = receiptOf(first);
    const second = run(['acquire', '--project', 'selftest', '--agent', 'agent-B', '--intent', 'selftest second checkout', '--build', 'fp-AAA', '--json']);
    record('second launch reaches cap', second.status === 0, second.stderr.trim() || 'launched');
    const secondReceipt = receiptOf(second);

    const refused = run(['acquire', '--project', 'selftest', '--agent', 'agent-C', '--intent', 'selftest refused checkout', '--build', 'fp-AAA', '--json']);
    record('pool-full refusal without --wait', refused.status === EXIT_POOL_FULL, `exit ${String(refused.status)}`);

    const waiterC = runAsync(['acquire', '--project', 'selftest', '--agent', 'agent-C', '--intent', 'selftest queued reuse', '--build', 'fp-AAA', '--wait', '30', '--json']);
    await sleep(1500);
    run(['release', '--lease', firstReceipt.lease_id, '--verdict', 'pass']);
    const reuse = await waiterC;
    const reuseReceipt = receiptOf(reuse);
    record('queued agent reuses the released same-build instance', reuse.status === 0 && reuseReceipt.instance_id === firstReceipt.instance_id, `${firstReceipt.instance_id} → ${reuseReceipt.instance_id}`);

    const waiterD = runAsync(['acquire', '--project', 'selftest', '--agent', 'agent-D', '--intent', 'selftest stale-build recycle', '--build', 'fp-BBB', '--wait', '30', '--json']);
    await sleep(1500);
    run(['release', '--lease', secondReceipt.lease_id, '--verdict', 'pass']);
    const recycled = await waiterD;
    const recycledReceipt = receiptOf(recycled);
    record('stale-build instance recycled for a new fingerprint', recycled.status === 0 && recycledReceipt.instance_id !== secondReceipt.instance_id && recycledReceipt.fingerprint === 'fp-BBB', `${secondReceipt.instance_id} → ${recycledReceipt.instance_id}`);

    run(['release', '--lease', reuseReceipt.lease_id, '--dirty', '--note', 'selftest dirty release']);
    const afterDirty = run(['acquire', '--project', 'selftest', '--agent', 'agent-E', '--intent', 'selftest dirty recycle', '--build', 'fp-AAA', '--json']);
    const afterDirtyReceipt = receiptOf(afterDirty);
    record('dirty instance recycled instead of reused', afterDirty.status === 0 && afterDirtyReceipt.instance_id !== reuseReceipt.instance_id, `${reuseReceipt.instance_id} → ${afterDirtyReceipt.instance_id}`);

    const fence = run(['check', '--lease', firstReceipt.lease_id]);
    record('fencing check rejects a released lease', fence.status === EXIT_HELD, `exit ${String(fence.status)}`);

    run(['release', '--lease', recycledReceipt.lease_id]);
    run(['release', '--lease', afterDirtyReceipt.lease_id]);
    const dryRun = run(['reap', '--project', 'selftest']);
    record('reap dry-run keeps warm instances inside idle TTL', dryRun.status === 0 && dryRun.stdout.includes('nothing to reap'), dryRun.stdout.trim());
  } finally {
    run(['reap', '--project', 'selftest', '--all', '--kill']);
  }

  const drained = run(['list', '--project', 'selftest', '--json']);
  const remaining = (JSON.parse(drained.stdout) as { instances: SailInstance[] }).instances.length;
  cases.push({ name: 'drain reap leaves no instances behind', passed: remaining === 0, detail: `${String(remaining)} remaining` });

  const failures = cases.filter((entry) => !entry.passed);
  const report = { selftest: true, status: failures.length ? 'failed' : 'passed', cases_total: cases.length, cases_passed: cases.length - failures.length, cases };
  console.log(args.json ? JSON.stringify(report) : JSON.stringify(report, null, 2));
  if (failures.length) exit(1);
}

main().catch((error: unknown) => {
  const failure = error as { message?: string; code?: unknown; stack?: string };
  console.error(`sail: ${failure.message ?? String(error)}`);
  if (env.SMA_SAIL_DEBUG) console.error(failure.stack);
  exit(typeof failure.code === 'number' ? failure.code : 1);
});
