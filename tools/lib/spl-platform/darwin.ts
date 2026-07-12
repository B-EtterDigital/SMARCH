import { execFileSync } from 'node:child_process';
import type { SplBudgetSnapshot, SplCommandRunner, SplPlatform, SplTerminateResult } from './contract.ts';

const realRunner: SplCommandRunner = {
  run: (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
};

function validPid(pid: number): boolean { return Number.isSafeInteger(pid) && pid > 0; }
function runOrNull(runner: SplCommandRunner, command: string, args: string[]): string | null {
  try { return runner.run(command, args).trim(); } catch { return null; }
}

export function darwinStartToken(pid: number, runner: SplCommandRunner = realRunner): string | null {
  if (!validPid(pid)) return null;
  const token = runOrNull(runner, 'ps', ['-o', 'lstart=', '-p', String(pid)]);
  return token?.length ? token : null;
}

export function darwinSessionId(pid: number, runner: SplCommandRunner = realRunner): number | null {
  if (!validPid(pid)) return null;
  const value = Number(runOrNull(runner, 'ps', ['-o', 'sess=', '-p', String(pid)]));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function darwinIsAlive(pid: number, token: string, runner: SplCommandRunner = realRunner): boolean {
  if (!validPid(pid) || !token || runOrNull(runner, 'kill', ['-0', String(pid)]) === null) return false;
  return darwinStartToken(pid, runner) === token;
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function darwinTerminate(pid: number, token: string, options: { graceMs: number }, runner: SplCommandRunner = realRunner): Promise<SplTerminateResult> {
  if (pid <= 1 || pid === process.pid) throw new Error(`SPL_SIGNAL_REFUSED: unsafe pid ${String(pid)}`);
  const current = darwinStartToken(pid, runner);
  if (!current) return { outcome: 'already-dead' };
  if (current !== token || !darwinIsAlive(pid, token, runner)) return { outcome: 'identity-mismatch' };
  try { runner.run('kill', ['-TERM', String(pid)]); } catch { return { outcome: 'signal-refused' }; }
  const signals: ('SIGTERM' | 'SIGKILL')[] = ['SIGTERM'];
  const deadline = Date.now() + Math.max(0, options.graceMs);
  while (Date.now() < deadline && darwinIsAlive(pid, token, runner)) await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  if (!darwinIsAlive(pid, token, runner)) return { outcome: 'terminated', signals };
  try { runner.run('kill', ['-KILL', String(pid)]); } catch { return { outcome: 'signal-refused', signals }; }
  signals.push('SIGKILL');
  return { outcome: 'killed', signals };
}

export function darwinBudgetSnapshot(runner: SplCommandRunner = realRunner): SplBudgetSnapshot {
  const cores = Math.max(1, Number(runOrNull(runner, 'sysctl', ['-n', 'hw.ncpu'])) || 1);
  const loadText = runOrNull(runner, 'sysctl', ['-n', 'vm.loadavg']) ?? '';
  const load = Number(/[\d.]+/.exec(loadText)?.[0] ?? 0);
  const vm = runOrNull(runner, 'vm_stat', []) ?? '';
  const pageSize = Number(/page size of (\d+) bytes/i.exec(vm)?.[1] ?? 4096);
  const pages = (name: string) => Number(new RegExp(`Pages ${name}:\\s+(\\d+)\\.`, 'i').exec(vm)?.[1] ?? 0);
  const availableGb = ((pages('free') + pages('inactive')) * pageSize) / 1024 ** 3;
  const ratio = load / cores;
  const pressure = ratio >= 1.5 || availableGb < 1 ? 'critical' : ratio >= 0.85 || availableGb < 3 ? 'warn' : 'ok';
  const recommended = pressure === 'critical' ? 1 : pressure === 'warn' ? Math.max(1, Math.floor(cores / 4)) : Math.max(1, Math.floor(cores / 2));
  return { cores, load, mem_available_gb: Number(availableGb.toFixed(2)), swap_used_pct: 0, pressure, recommended_agents: recommended };
}

export function darwinSplPlatform(runner: SplCommandRunner = realRunner): SplPlatform {
  return { startToken: (pid) => darwinStartToken(pid, runner), sessionId: (pid) => darwinSessionId(pid, runner), isAlive: (pid, token) => darwinIsAlive(pid, token, runner), terminate: (pid, token, options) => darwinTerminate(pid, token, options, runner), budgetSnapshot: () => darwinBudgetSnapshot(runner) };
}
