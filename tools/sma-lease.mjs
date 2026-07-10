#!/usr/bin/env node
/**
 * sma-lease.mjs — soft-lock registry for SMARCH agent collision avoidance.
 *
 * Runtime cache: ~/DEV/SMARCH/registry/active-leases.generated.json
 * The file is intentionally ignored by git because it changes whenever leases
 * are acquired/released.
 * Schema:   schemas/active-leases.schema.json
 *
 * The point: stop two agents from editing the same brick or stomping on the same
 * `.generated.json` regen target. Lease has a TTL. A crashed agent does not block
 * forever. A live agent can renew.
 *
 * Subcommands:
 *   acquire        --resource-kind <kind> --resource <id> [--agent <id>] --intent "..."
 *                  [--ttl <seconds>] [--project <id>] [--brick <id>] [--session <id>]
 *                  [--task <id>] [--model <name>] [--actor-kind <kind>]
 *                  [--rationale "..."] [--linked-backlog <id>]... [--auto-context]
 *
 *   force-acquire  --resource-kind <kind> --resource <id> --intent "..." --reason "..."
 *                  [acquire flags]
 *
 *   renew          --lease <lease_id> [--ttl <seconds>] [--auto-context]
 *
 *   release        --lease <lease_id> [--reason "..."] [--auto-context]
 *
 *   list           [--resource-kind <kind>] [--resource <id>] [--agent <id>]
 *                  [--include-expired] [--json]
 *
 *   status         --resource-kind <kind> --resource <id> [--json]
 *                  → exits 0 if free, 10 if held by another, 11 if held by self
 *
 *   expire                                    → drop all expired leases
 *
 *   run            --resource-kind <kind> --resource <id> [--agent <id>] --intent "..."
 *                  [--ttl <seconds>] [--auto-context] [--project <id>] [--brick <id>]
 *                  [--renew-every <seconds>] -- <command...>
 *                  → acquires lease, spawns command, releases on exit (success or fail).
 *                    SIGINT/SIGTERM are caught so the lease is released before re-raise.
 *                    With --renew-every, a heartbeat thread keeps the lease alive.
 *
 * Agent fallback: --agent defaults to env.SMA_AGENT or env.USER if not provided.
 *
 * Auto-context: --auto-context (or env SMA_AUTO_CONTEXT=1) appends matching events
 * to the per-brick agent-context log when --project and --brick are supplied.
 *
 * Atomic write: file → tmp → rename. Sentinel sidecar is the single-machine guard.
 */

import { SMA_ROOT } from "./lib/sma-paths.mjs";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { argv, exit, env, hrtime } from 'node:process';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendContextEvent,
  resolveActorId,
  resolveSessionId,
} from './lib/context-log.mjs';


const REGISTRY_PATH = resolve(SMA_ROOT, 'registry/active-leases.generated.json');
const LOCK_SENTINEL = REGISTRY_PATH + '.lock';
const SCHEMA_VERSION = '1.0.0';

const RESOURCE_KINDS = new Set([
  'brick',
  'build',
  'release',
  'registry-regen',
  'wiki-regen',
  'state-regen',
  'import-lock',
  'backlog',
  'other',
]);

const ACTOR_KINDS = new Set(['human', 'ai_model', 'agent', 'automation', 'tool']);

const DEFAULT_TTL_SECONDS = 600;

const cmd = argv[2];
const rawArgs = argv.slice(3);

// `run` uses `--` as the separator between lease flags and the child command.
let runChildArgs = null;
let leaseFlagArgs = rawArgs;
if (cmd === 'run') {
  const dashDashIdx = rawArgs.indexOf('--');
  if (dashDashIdx === -1) {
    console.error('sma-lease run: missing `--` separator before child command');
    exit(2);
  }
  leaseFlagArgs = rawArgs.slice(0, dashDashIdx);
  runChildArgs = rawArgs.slice(dashDashIdx + 1);
}

const args = parseArgs(leaseFlagArgs);

try {
  switch (cmd) {
    case 'acquire':
      runAcquire(false);
      break;
    case 'force-acquire':
      runAcquire(true);
      break;
    case 'renew':
      runRenew();
      break;
    case 'release':
      runRelease();
      break;
    case 'list':
      runList();
      break;
    case 'status':
      runStatus();
      break;
    case 'expire':
      runExpire();
      break;
    case 'run':
      await runWrapped();
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      usage();
      exit(cmd ? 0 : 2);
      break;
    default:
      console.error(`unknown subcommand: ${cmd}`);
      usage();
      exit(2);
  }
} catch (err) {
  console.error(`sma-lease: ${err.message}`);
  exit(typeof err.code === 'number' ? err.code : 1);
}

function usage() {
  console.log(`Usage:
  sma-lease.mjs acquire        --resource-kind <kind> --resource <id> [--agent <id>] --intent "..."
                               [--ttl <seconds>] [--project <id>] [--brick <id>] [--session <id>]
                               [--task <id>] [--model <name>] [--actor-kind <kind>]
                               [--rationale "..."] [--linked-backlog <id>]... [--auto-context]
  sma-lease.mjs force-acquire  --resource-kind <kind> --resource <id> --intent "..." --reason "..."
                               [acquire flags]
  sma-lease.mjs renew          --lease <lease_id> [--ttl <seconds>] [--auto-context]
  sma-lease.mjs release        --lease <lease_id> [--reason "..."] [--auto-context]
  sma-lease.mjs list           [--resource-kind <kind>] [--resource <id>] [--agent <id>]
                               [--include-expired] [--json]
  sma-lease.mjs status         --resource-kind <kind> --resource <id> [--json]
  sma-lease.mjs expire
  sma-lease.mjs run            --resource-kind <kind> --resource <id> [--agent <id>] --intent "..."
                               [--ttl <seconds>] [--auto-context] [--project <id>] [--brick <id>]
                               [--renew-every <seconds>] -- <command...>

Resource kinds: ${[...RESOURCE_KINDS].join(', ')}
Agent default: $SMA_AGENT or $USER
`);
}

// ── load / save ─────────────────────────────────────────────────────────────

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) {
    return { schema_version: SCHEMA_VERSION, generated_at: nowIso(), leases: [] };
  }
  let raw;
  try {
    raw = readFileSync(REGISTRY_PATH, 'utf8');
  } catch (e) {
    throw new Error(`could not read ${REGISTRY_PATH}: ${e.message}`);
  }
  if (!raw.trim()) {
    return { schema_version: SCHEMA_VERSION, generated_at: nowIso(), leases: [] };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.leases)) parsed.leases = [];
    return parsed;
  } catch (e) {
    throw new Error(`registry is corrupt JSON: ${e.message}`);
  }
}

function saveRegistry(reg) {
  reg.schema_version = SCHEMA_VERSION;
  reg.generated_at = nowIso();
  const dir = dirname(REGISTRY_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = REGISTRY_PATH + '.tmp.' + process.pid + '.' + Date.now();
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
  renameSync(tmp, REGISTRY_PATH);
}

function withLock(fn) {
  const startNs = hrtime.bigint();
  const maxWaitMs = 5000;
  while (existsSync(LOCK_SENTINEL)) {
    const elapsedMs = Number(hrtime.bigint() - startNs) / 1e6;
    if (elapsedMs > maxWaitMs) {
      try { unlinkSync(LOCK_SENTINEL); } catch { /* ignore */ }
      break;
    }
    sleepSync(20);
  }
  const dir = dirname(LOCK_SENTINEL);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(LOCK_SENTINEL, String(process.pid));
  try {
    return fn();
  } finally {
    try { unlinkSync(LOCK_SENTINEL); } catch { /* ignore */ }
  }
}

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

// ── core ops ────────────────────────────────────────────────────────────────

function runAcquire(force) {
  requireArg('resourceKind', '--resource-kind');
  requireArg('resource', '--resource');
  requireArg('intent', '--intent');
  if (force) requireArg('reason', '--reason');
  const lease = doAcquire({ force });
  if (args.json) {
    console.log(JSON.stringify(lease, null, 2));
  } else {
    console.log(`acquired ${lease.resource_kind}:${lease.resource_id} → lease ${lease.lease_id}`);
    console.log(`expires ${lease.expires_at}`);
    console.log(`agent   ${lease.agent_id}`);
    console.log(`intent  ${lease.intent}`);
  }
  maybeStampContext('lease_acquired', lease, lease.intent);
}

/**
 * Acquire returns the lease object on success. Throws on conflict (with err.code = 10).
 * Does not write to stdout.
 */
function doAcquire({ force }) {
  if (!RESOURCE_KINDS.has(args.resourceKind)) {
    throw new Error(`bad --resource-kind: ${args.resourceKind} (allowed: ${[...RESOURCE_KINDS].join(',')})`);
  }
  if (args.actorKind && !ACTOR_KINDS.has(args.actorKind)) {
    throw new Error(`bad --actor-kind: ${args.actorKind} (allowed: ${[...ACTOR_KINDS].join(',')})`);
  }
  const ttl = parseTtl(args.ttl);
  const sessionId = resolveSessionId(args.session);
  const agent = resolveAgent(sessionId);

  return withLock(() => {
    const reg = loadRegistry();
    pruneExpired(reg);
    const existing = reg.leases.find(
      (l) => l.resource_kind === args.resourceKind && l.resource_id === args.resource,
    );
    if (existing && !force) {
      const err = /** @type {Error & {code?: number}} */ (new Error(
        `resource is leased: ${args.resourceKind}:${args.resource} → held by ${existing.agent_id} ` +
        `(lease ${existing.lease_id}, expires ${existing.expires_at}, intent: ${existing.intent})`,
      ));
      err.code = 10;
      throw err;
    }
    const lease = buildLease(force ? existing : null, agent, ttl, sessionId);
    if (force && existing) {
      reg.leases = reg.leases.filter((l) => l.lease_id !== existing.lease_id);
    }
    reg.leases.push(lease);
    saveRegistry(reg);
    return lease;
  });
}

function buildLease(displaced, agent, ttl, sessionId) {
  const acquiredAt = nowIso();
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const lease = {
    lease_id: newLeaseId(),
    resource_kind: args.resourceKind,
    resource_id: args.resource,
    agent_id: agent,
    acquired_at: acquiredAt,
    expires_at: expiresAt,
    renewals: 0,
    intent: args.intent,
  };
  if (args.project) lease.project = args.project;
  if (args.actorKind) lease.actor_kind = args.actorKind;
  if (sessionId) lease.session_id = sessionId;
  if (args.task) lease.task_id = args.task;
  if (args.model) lease.model = args.model;
  if (args.rationale) lease.rationale = args.rationale;
  if (args.linkedBacklog && args.linkedBacklog.length) lease.linked_backlog = args.linkedBacklog;
  if (displaced) {
    lease.force_acquired_from = displaced.lease_id;
    lease.force_acquired_reason = args.reason;
  }
  return lease;
}

function runRenew() {
  requireArg('lease', '--lease');
  const ttl = parseTtl(args.ttl);
  const result = doRenew(args.lease, ttl);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`renewed ${result.lease_id} → expires ${result.expires_at}`);
  maybeStampContext('lease_renewed', result, `renewed lease ${result.lease_id}`);
}

function doRenew(leaseId, ttl) {
  return withLock(() => {
    const reg = loadRegistry();
    pruneExpired(reg);
    const lease = reg.leases.find((l) => l.lease_id === leaseId);
    if (!lease) {
      const err = /** @type {Error & {code?: number}} */ (new Error(`lease not found (or already expired): ${leaseId}`));
      err.code = 12;
      throw err;
    }
    lease.expires_at = new Date(Date.now() + ttl * 1000).toISOString();
    lease.renewed_at = nowIso();
    lease.renewals = (lease.renewals ?? 0) + 1;
    saveRegistry(reg);
    return lease;
  });
}

function runRelease() {
  requireArg('lease', '--lease');
  const released = doRelease(args.lease);
  if (args.json) console.log(JSON.stringify(released, null, 2));
  else console.log(`released ${released.lease_id} (${released.resource_kind}:${released.resource_id})`);
  maybeStampContext('lease_released', released, args.reason ?? `released lease ${released.lease_id}`);
}

function doRelease(leaseId) {
  return withLock(() => {
    const reg = loadRegistry();
    const idx = reg.leases.findIndex((l) => l.lease_id === leaseId);
    if (idx < 0) {
      const err = /** @type {Error & {code?: number}} */ (new Error(`lease not found: ${leaseId}`));
      err.code = 12;
      throw err;
    }
    const [lease] = reg.leases.splice(idx, 1);
    saveRegistry(reg);
    return lease;
  });
}

function runList() {
  const reg = loadRegistry();
  if (!args.includeExpired) pruneExpired(reg);
  let rows = reg.leases;
  if (args.resourceKind) rows = rows.filter((l) => l.resource_kind === args.resourceKind);
  if (args.resource) rows = rows.filter((l) => l.resource_id === args.resource);
  if (args.agent) rows = rows.filter((l) => l.agent_id === args.agent);
  if (args.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    console.log('(no active leases)');
    return;
  }
  console.log(
    `${pad('lease', 28)} ${pad('kind', 16)} ${pad('resource', 50)} ${pad('agent', 24)} expires`,
  );
  console.log('-'.repeat(140));
  for (const l of rows) {
    console.log(
      `${pad(l.lease_id, 28)} ${pad(l.resource_kind, 16)} ${pad(l.resource_id, 50)} ${pad(l.agent_id, 24)} ${l.expires_at}`,
    );
  }
}

function runStatus() {
  requireArg('resourceKind', '--resource-kind');
  requireArg('resource', '--resource');
  const reg = loadRegistry();
  pruneExpired(reg);
  const held = reg.leases.find(
    (l) => l.resource_kind === args.resourceKind && l.resource_id === args.resource,
  );
  if (!held) {
    if (args.json) console.log(JSON.stringify({ status: 'free' }));
    else console.log(`free: ${args.resourceKind}:${args.resource}`);
    exit(0);
  }
  const selfAgent = resolveAgent(resolveSessionId(args.session));
  const isSelf = selfAgent && held.agent_id === selfAgent;
  if (args.json) {
    console.log(JSON.stringify({ status: isSelf ? 'held_by_self' : 'held_by_other', lease: held }));
  } else {
    console.log(
      `${isSelf ? 'held-by-self' : 'held-by-other'}: ${args.resourceKind}:${args.resource} → ` +
      `${held.agent_id} (lease ${held.lease_id}, expires ${held.expires_at})`,
    );
    console.log(`intent: ${held.intent}`);
  }
  exit(isSelf ? 11 : 10);
}

function runExpire() {
  const removed = withLock(() => {
    const reg = loadRegistry();
    const before = reg.leases.length;
    pruneExpired(reg);
    const dropped = before - reg.leases.length;
    saveRegistry(reg);
    return dropped;
  });
  console.log(`expired and removed ${removed} lease(s)`);
}

// ── run subcommand: lease + spawn + release ─────────────────────────────────

async function runWrapped() {
  requireArg('resourceKind', '--resource-kind');
  requireArg('resource', '--resource');
  requireArg('intent', '--intent');
  if (!runChildArgs || !runChildArgs.length) {
    throw new Error('run: missing child command after `--`');
  }

  const lease = doAcquire({ force: false });
  console.log(`[sma-lease] acquired ${lease.resource_kind}:${lease.resource_id} (${lease.lease_id}, ttl until ${lease.expires_at})`);
  maybeStampContext('lease_acquired', lease, lease.intent);

  let renewInterval = null;
  if (args.renewEvery) {
    const everyMs = Number(args.renewEvery) * 1000;
    if (Number.isFinite(everyMs) && everyMs >= 5000) {
      renewInterval = setInterval(() => {
        try {
          const renewed = doRenew(lease.lease_id, parseTtl(args.ttl));
          console.error(`[sma-lease] renewed ${lease.lease_id} → ${renewed.expires_at}`);
        } catch (e) {
          console.error(`[sma-lease] renew failed: ${e.message}`);
        }
      }, everyMs);
    }
  }

  let releasedAlready = false;
  const releaseSafely = (label) => {
    if (releasedAlready) return;
    releasedAlready = true;
    if (renewInterval) clearInterval(renewInterval);
    try {
      doRelease(lease.lease_id);
      console.log(`[sma-lease] released ${lease.lease_id} (${label})`);
      maybeStampContext('lease_released', lease, `${label}: released ${lease.lease_id}`);
    } catch (e) {
      console.error(`[sma-lease] release failed: ${e.message}`);
    }
  };

  // Spawn the child. Inherit stdio so the user sees normal output.
  const [bin, ...rest] = runChildArgs;
  const child = spawn(bin, rest, {
    stdio: 'inherit',
    env: {
      ...env,
      SMA_ACTIVE_LEASE_ID: lease.lease_id,
      SMA_ACTIVE_RESOURCE_KIND: lease.resource_kind,
      SMA_ACTIVE_RESOURCE_ID: lease.resource_id,
    },
  });

  const onSig = (sig) => {
    console.error(`[sma-lease] received ${sig}, releasing lease then forwarding`);
    releaseSafely(`signal:${sig}`);
    try { child.kill(sig); } catch { /* ignore */ }
  };
  process.on('SIGINT', () => onSig('SIGINT'));
  process.on('SIGTERM', () => onSig('SIGTERM'));

  const exitCode = await new Promise((res) => {
    child.on('close', (code, signal) => {
      if (signal) {
        releaseSafely(`child-signal:${signal}`);
        res(128 + 1); // generic non-zero on signal
        return;
      }
      releaseSafely(`exit:${code}`);
      res(code ?? 0);
    });
    child.on('error', (e) => {
      console.error(`[sma-lease] spawn error: ${e.message}`);
      releaseSafely('spawn-error');
      res(1);
    });
  });

  exit(exitCode);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function maybeStampContext(kind, lease, intent) {
  const auto = args.autoContext || env.SMA_AUTO_CONTEXT === '1';
  if (!auto) return;
  const project = lease.project ?? args.project;
  const brick = args.brick ?? (lease.resource_kind === 'brick' ? lease.resource_id : null);
  if (!project || !brick) return;
  try {
    appendContextEvent({
      project,
      brick,
      kind,
      intent,
      actorKind: lease.actor_kind ?? 'agent',
      actorId: lease.agent_id,
      model: lease.model,
      sessionId: lease.session_id,
      taskId: lease.task_id,
      leaseId: lease.lease_id,
      linkedBacklog: lease.linked_backlog,
    });
  } catch (e) {
    console.error(`[sma-lease] auto-context append failed: ${e.message}`);
  }
}

function resolveAgent(sessionId) {
  return resolveActorId(args.agent, sessionId);
}

function pruneExpired(reg) {
  const now = Date.now();
  reg.leases = reg.leases.filter((l) => Date.parse(l.expires_at) > now);
}

function newLeaseId() {
  return `lease-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function parseTtl(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_TTL_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`bad --ttl: ${raw}`);
  return Math.floor(n);
}

function requireArg(key, flag) {
  if (args[key] === undefined || args[key] === null || args[key] === '') {
    throw new Error(`missing ${flag}`);
  }
}

function pad(s, n) {
  return String(s ?? '').slice(0, n).padEnd(n);
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = list[i + 1];
    const isBool = next === undefined || next.startsWith('--');
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (isBool) {
      out[camel] = true;
      continue;
    }
    if (camel === 'linkedBacklog') {
      out[camel] = out[camel] ? [...out[camel], next] : [next];
    } else {
      out[camel] = next;
    }
    i += 1;
  }
  return out;
}
