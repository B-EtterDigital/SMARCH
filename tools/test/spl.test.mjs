import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { linuxBudgetSnapshot, linuxIsAlive, linuxSessionId, linuxStartToken, linuxTerminate } from '../lib/spl-platform/linux.ts';
import { findAgentOrphans } from '../lib/spl-agents.ts';
import { list, register, unregister, unregisterLease } from '../lib/spl-registry.ts';

/** @param {number} pid @param {number} ppid @param {number} [start] @param {number} [utime] @param {number} [stime] @param {number} [session] */
function statLine(pid, ppid, start = 1234, utime = 10, stime = 5, session = 1) {
  const fields = ['S', String(ppid), '0', String(session), '0', '0', '0', '0', '0', '0', '0', String(utime), String(stime), '0', '0', '0', '0', '1', '0', String(start), '1000', '10'];
  return `${pid} (agent process (worker)) ${fields.join(' ')}\n`;
}

/** @param {string} root @param {number} pid @param {{ppid?:number,start?:number,argv?:string,rss?:number,session?:number}} [options] */
async function procEntry(root, pid, { ppid = 1, start = 1234, argv = 'codex', rss = 2048, session = 1 } = {}) {
  const dir = join(root, String(pid));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'stat'), statLine(pid, ppid, start, 10, 5, session));
  await writeFile(join(dir, 'cmdline'), argv.split(' ').join('\0'));
  await writeFile(join(dir, 'status'), `Name:\tagent\nVmRSS:\t${rss} kB\n`);
}

test('Linux identity parser handles parentheses and refuses start-token mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spl-proc-'));
  await procEntry(root, 42, { start: 9988 });
  assert.equal(linuxStartToken(42, root), '9988');
  assert.equal(linuxSessionId(42, root), 1);
  assert.equal(linuxIsAlive(42, '9988', root), true);
  assert.equal(linuxIsAlive(42, 'other', root), false);
  assert.deepEqual(await linuxTerminate(42, 'other', { graceMs: 0 }, root), { outcome: 'identity-mismatch' });
});

test('registry annotates ACTIVE, EXPIRED, DEAD and unregisters by lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spl-registry-'));
  const procRoot = join(root, 'proc');
  await mkdir(join(root, 'registry'), { recursive: true });
  await procEntry(procRoot, 42, { start: 111 });
  const registryPath = join(root, 'registry/spl.ndjson');
  const leasePath = join(root, 'registry/leases.json');
  /** @type {import('../lib/spl-platform/contract.ts').SplPlatform} */
  const platform = { startToken: (pid) => linuxStartToken(pid, procRoot), sessionId: (pid) => linuxSessionId(pid, procRoot), isAlive: (pid, token) => linuxIsAlive(pid, token, procRoot), terminate: () => Promise.resolve({ outcome: 'terminated' }), budgetSnapshot: () => ({ cores: 1, load: 0, mem_available_gb: 1, swap_used_pct: 0, pressure: 'ok', recommended_agents: 1 }) };
  await writeFile(leasePath, JSON.stringify({ leases: [{ lease_id: 'live', expires_at: '2999-01-01T00:00:00Z' }] }));
  await register('live', 42, 'worker', { registryPath, leaseRegistryPath: leasePath, platform });
  assert.equal((await list({ registryPath, leaseRegistryPath: leasePath, platform }))[0].state, 'ACTIVE');
  await writeFile(leasePath, JSON.stringify({ leases: [] }));
  assert.equal((await list({ registryPath, leaseRegistryPath: leasePath, platform }))[0].state, 'EXPIRED');
  await writeFile(join(procRoot, '42/stat'), statLine(42, 1, 222));
  assert.equal((await list({ registryPath, leaseRegistryPath: leasePath, platform }))[0].state, 'DEAD');
  assert.equal(await unregisterLease('live', { registryPath, leaseRegistryPath: leasePath, platform }), 1);
  assert.equal((await list({ registryPath, leaseRegistryPath: leasePath, platform })).length, 0);
  assert.match(await readFile(registryPath, 'utf8'), /"event":"unregistered"/);
});

test('orphan classifier catches init and detached leaders but protects orchestrator session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spl-orphan-'));
  await writeFile(join(root, 'uptime'), '1000.00 0.00\n');
  await procEntry(root, 500, { ppid: 1, start: 1000, argv: 'codex --session old' });
  await procEntry(root, 502, { ppid: 88, start: 2000, argv: 'codex --session detached', session: 502 });
  await procEntry(root, 503, { ppid: 88, start: 2000, argv: 'codex --session live', session: 700 });
  await procEntry(root, 700, { ppid: 1, start: 90000, argv: 'node orchestrator', session: 700 });
  await procEntry(root, 501, { ppid: 99, start: 1000, argv: 'claude --resume old' });
  await procEntry(root, 99, { ppid: 1, start: 5000, argv: 'bash' });
  const config = join(root, 'agents.json');
  await writeFile(config, JSON.stringify({ signatures: [{ id: 'codex', argv_regex: '(^|/)codex(\\s|$)' }, { id: 'claude', argv_regex: '(^|/)claude(\\s|$)' }] }));
  /** @type {import('../lib/spl-registry.ts').SplProcess} */
  const staleParent = { pid: 99, start_token: '4000', lease_id: 'expired', agent: 'test', label: 'old parent', registered_at: '2026-01-01T00:00:00Z', state: 'EXPIRED' };
  const rows = findAgentOrphans([staleParent], { procRoot: root, configPath: config, minAgeSeconds: 600, clockTicks: 100, currentPid: 700 });
  assert.deepEqual(rows.map((row) => row.pid).sort(), [500, 502]);
  assert.equal(rows[0].tier, 'ORPHAN?');
});

test('unregister is PID plus start-token safe across reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spl-reuse-'));
  const procRoot = join(root, 'proc');
  await mkdir(join(root, 'registry'), { recursive: true });
  const registryPath = join(root, 'registry/spl.ndjson');
  const leasePath = join(root, 'registry/leases.json');
  await writeFile(leasePath, JSON.stringify({ leases: [] }));
  await procEntry(procRoot, 77, { start: 100 });
  /** @type {import('../lib/spl-platform/contract.ts').SplPlatform} */
  const platform = { startToken: (pid) => linuxStartToken(pid, procRoot), sessionId: (pid) => linuxSessionId(pid, procRoot), isAlive: (pid, token) => linuxIsAlive(pid, token, procRoot), terminate: () => Promise.resolve({ outcome: 'terminated' }), budgetSnapshot: () => ({ cores: 1, load: 0, mem_available_gb: 1, swap_used_pct: 0, pressure: 'ok', recommended_agents: 1 }) };
  await register('old', 77, 'old', { registryPath, leaseRegistryPath: leasePath, platform });
  await writeFile(join(procRoot, '77/stat'), statLine(77, 1, 200));
  await register('new', 77, 'new', { registryPath, leaseRegistryPath: leasePath, platform });
  assert.equal(await unregister(77, '100', { registryPath, leaseRegistryPath: leasePath, platform }), true);
  const rows = await list({ registryPath, leaseRegistryPath: leasePath, platform });
  assert.deepEqual(rows.map((row) => row.start_token), ['200']);
});

test('budget thresholds cover ok, warn, and critical fixtures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'spl-budget-'));
  await writeFile(join(root, 'loadavg'), '0.01 0 0 1/1 1\n');
  await writeFile(join(root, 'meminfo'), 'MemAvailable: 8388608 kB\nSwapTotal: 1000 kB\nSwapFree: 1000 kB\n');
  assert.equal(linuxBudgetSnapshot(root).pressure, 'ok');
  await writeFile(join(root, 'meminfo'), 'MemAvailable: 2097152 kB\nSwapTotal: 1000 kB\nSwapFree: 300 kB\n');
  assert.equal(linuxBudgetSnapshot(root).pressure, 'warn');
  await writeFile(join(root, 'meminfo'), 'MemAvailable: 524288 kB\nSwapTotal: 1000 kB\nSwapFree: 100 kB\n');
  assert.equal(linuxBudgetSnapshot(root).pressure, 'critical');
});

test('real process termination verifies identity before signalling', async () => {
  const child = spawn('sleep', ['30']);
  assert.ok(child.pid);
  const pid = child.pid;
  await new Promise((resolve) => setTimeout(resolve, 30));
  const token = linuxStartToken(pid);
  assert.ok(token);
  assert.deepEqual(await linuxTerminate(pid, `${token}-wrong`, { graceMs: 0 }), { outcome: 'identity-mismatch' });
  assert.equal(linuxIsAlive(pid, token), true);
  const closed = new Promise((resolve) => child.once('close', resolve));
  const result = await linuxTerminate(pid, token, { graceMs: 500 });
  assert.ok(result.outcome === 'terminated' || result.outcome === 'killed');
  await closed;
});
