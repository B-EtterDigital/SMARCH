#!/usr/bin/env node
/** Run one command as a lease-bound SPL process. Umbrella registration is controller-owned. */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { list, register, unregister } from './lib/spl-registry.ts';

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const LEASE_TOOL = resolve(TOOL_DIR, 'sma-lease.ts');
const SPL_TOOL = resolve(TOOL_DIR, 'sma-spl.ts');
const AUTO_TTL_SECONDS = '30';

interface Args { lease: string; project?: string; label: string; command: string[] }
interface LeaseReceipt { lease_id: string; agent_id: string }
interface CommandResult { code: number; stdout: string; stderr: string }

function failure(code: string, message: string, details: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({ error: { code, message, ...details } }));
}

function parse(input: string[]): Args {
  const separator = input.indexOf('--');
  if (separator < 0) throw new Error('missing `--` separator before command');
  const flags = input.slice(0, separator);
  const command = input.slice(separator + 1);
  let lease = '';
  let project: string | undefined;
  let label = '';
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (flag === '--lease') lease = flags[++index] ?? '';
    else if (flag === '--project') project = flags[++index] ?? '';
    else if (flag === '--label') label = flags[++index] ?? '';
    else throw new Error(`unknown argument: ${flag}`);
  }
  if (!lease) throw new Error('missing --lease <id|auto>');
  if (!label) throw new Error('missing --label <text>');
  if (!command.length) throw new Error('missing command after `--`');
  return { lease, project, label, command };
}

function runTool(script: string, args: string[], childEnv: NodeJS.ProcessEnv = env): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [script, ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', (error) => { resolveResult({ code: 1, stdout, stderr: `${stderr}${error.message}` }); });
    child.once('close', (code) => { resolveResult({ code: code ?? 1, stdout, stderr }); });
  });
}

async function acquireAuto(args: Args): Promise<LeaseReceipt> {
  const resource = `spl-exec-${String(process.pid)}-${String(Date.now())}`;
  const command = ['acquire', '--resource-kind', 'other', '--resource', resource, '--intent', args.label,
    '--ttl', env.SMA_SPL_EXEC_AUTO_TTL ?? AUTO_TTL_SECONDS, '--json'];
  if (args.project) command.push('--project', args.project);
  const result = await runTool(LEASE_TOOL, command);
  if (result.code !== 0) throw new Error(`auto lease acquire failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return JSON.parse(result.stdout) as LeaseReceipt;
}

async function resolveLease(args: Args): Promise<{ receipt: LeaseReceipt; automatic: boolean }> {
  if (args.lease === 'auto') return { receipt: await acquireAuto(args), automatic: true };
  const result = await runTool(LEASE_TOOL, ['list', '--include-expired', '--json']);
  if (result.code !== 0) throw new Error(`lease lookup failed: ${result.stderr.trim() || result.stdout.trim()}`);
  const leases = JSON.parse(result.stdout) as (LeaseReceipt & { expires_at: string })[];
  const receipt = leases.find((lease) => lease.lease_id === args.lease && Date.parse(lease.expires_at) > Date.now());
  if (!receipt) throw new Error(`active lease not found: ${args.lease}`);
  return { receipt, automatic: false };
}

async function execute(args: Args): Promise<number> {
  const { receipt, automatic } = await resolveLease(args);
  let child: ChildProcess | null = null;
  let startToken: string | null = null;
  let cleaned = false;
  let forcedCode: number | null = null;
  const cleanup = async (reason: string): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    if (child?.pid && startToken) await unregister(child.pid, startToken, {}, reason);
    if (automatic) {
      const released = await runTool(LEASE_TOOL, ['release', '--lease', receipt.lease_id, '--agent', receipt.agent_id, '--reason', reason, '--json']);
      if (released.code !== 0 && !released.stderr.includes('lease not found')) {
        failure('SPL_EXEC_RELEASE_FAILED', 'automatic lease release failed', { lease_id: receipt.lease_id, detail: released.stderr.trim() });
      }
    }
  };
  const forward = (signal: NodeJS.Signals): void => {
    forcedCode = signal === 'SIGINT' ? 130 : 143;
    if (child?.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const onInt = (): void => { forward('SIGINT'); };
  const onTerm = (): void => { forward('SIGTERM'); };
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  try {
    const [command, ...commandArgs] = args.command;
    child = spawn(command, commandArgs, { stdio: 'inherit', env: { ...env, SMA_ACTIVE_LEASE_ID: receipt.lease_id } });
    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child?.once('spawn', resolveSpawn);
      child?.once('error', rejectSpawn);
    });
    if (!child.pid) throw new Error(`spawn returned no pid for ${command}`);
    const record = await register(receipt.lease_id, child.pid, args.label);
    startToken = record.start_token;
    return await new Promise<number>((resolveCode) => {
      const onError = async (error: Error): Promise<void> => {
        failure('SPL_EXEC_SPAWN_ERROR', error.message, { command });
        await cleanup('spawn-error');
        resolveCode(1);
      };
      const onClose = async (code: number | null, signal: NodeJS.Signals | null): Promise<void> => {
        await cleanup(signal ? `child-signal:${signal}` : `child-exit:${String(code)}`);
        resolveCode(forcedCode ?? code ?? (signal ? 128 : 1));
      };
      // Listeners expect void; run the async closer and void the promise —
      // resolveCode settles the outer await, so no work is left floating.
      child?.once('error', (error) => { void onError(error); });
      child?.once('close', (code, signal) => { void onClose(code, signal); });
    });
  } catch (error) {
    if (child?.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await cleanup('wrapper-error');
    throw error;
  } finally {
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  }
}

async function selftest(): Promise<void> {
  const root = mkdtempSync(resolve(tmpdir(), 'sma-spl-exec-'));
  const leasePath = resolve(root, 'leases.json');
  const splPath = resolve(root, 'spl.ndjson');
  const testEnv = { ...env, SMA_LEASE_REGISTRY_PATH: leasePath, SMA_SPL_REGISTRY_PATH: splPath, SMA_SPL_EXEC_AUTO_TTL: '30' };
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--lease', 'auto', '--project', 'selftest', '--label', 'selftest-sleep', '--', 'sleep', '2'],
      { env: testEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    let active = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const records = await list({ registryPath: splPath, leaseRegistryPath: leasePath });
      if (records.some((record) => record.pid !== process.pid && record.state === 'ACTIVE')) { active = true; break; }
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    if (!active) throw new Error(`child was not ACTIVE mid-run: ${stderr}`);
    const registry = JSON.parse(readFileSync(leasePath, 'utf8')) as { leases: { expires_at: string }[] };
    registry.leases[0].expires_at = new Date(Date.now() - 1000).toISOString();
    writeFileSync(leasePath, `${JSON.stringify(registry, null, 2)}\n`);
    const expired = await list({ registryPath: splPath, leaseRegistryPath: leasePath });
    if (!expired.some((record) => record.state === 'EXPIRED')) throw new Error('force-expired child was not classified EXPIRED');
    const reap = await runTool(SPL_TOOL, ['reap', '--json'], testEnv);
    const reapData = JSON.parse(reap.stdout) as { dry_run: boolean; results: { action?: string; tier: string }[] };
    if (reap.code !== 0 || !reapData.dry_run || !reapData.results.some((item) => item.tier === 'EXPIRED' && item.action === 'would-reap')) {
      throw new Error(`dry-run reap did not target EXPIRED child: ${reap.stderr || reap.stdout}`);
    }
    const code = await new Promise<number>((resolveCode) => {
      child.once('close', (value) => { resolveCode(value ?? 1); });
    });
    if (code !== 0) throw new Error(`wrapped sleep exited ${String(code)}: ${stderr}`);
    const after = await list({ registryPath: splPath, leaseRegistryPath: leasePath });
    if (after.length !== 0) throw new Error('registry entry remained after child exit');
    console.log('OK sma-spl-exec selftest (ACTIVE mid-run; EXPIRED dry-run target; unregistered after exit)');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  if (argv[2] === '--selftest') { await selftest(); return; }
  let args: Args;
  try { args = parse(argv.slice(2)); }
  catch (error) { failure('SPL_EXEC_USAGE', error instanceof Error ? error.message : String(error), { usage: 'sma spl-exec --lease <id|auto> [--project <id>] --label <s> -- <command...>' }); exit(2); return; }
  try { exit(await execute(args)); }
  catch (error) { failure('SPL_EXEC_FAILED', error instanceof Error ? error.message : String(error)); exit(1); }
}

await main();
