import { execFileSync } from 'node:child_process';
import type { SplBudgetSnapshot, SplCommandRunner, SplPlatform, SplTerminateResult } from './contract.ts';

const realRunner: SplCommandRunner = { run: (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) };
const psArgs = (script: string) => ['-NoProfile', '-NonInteractive', '-Command', script];
function validPid(pid: number): boolean { return Number.isSafeInteger(pid) && pid > 0; }
function powershell(runner: SplCommandRunner, script: string): string | null {
  try { return runner.run('powershell.exe', psArgs(script)).trim(); } catch { return null; }
}

export function win32StartToken(pid: number, runner: SplCommandRunner = realRunner): string | null {
  if (!validPid(pid)) return null;
  const token = powershell(runner, `(Get-Process -Id ${String(pid)} -ErrorAction Stop).StartTime.Ticks`);
  return token?.length ? token : null;
}
export function win32SessionId(pid: number, runner: SplCommandRunner = realRunner): number | null {
  if (!validPid(pid)) return null;
  const value = Number(powershell(runner, `(Get-Process -Id ${String(pid)} -ErrorAction Stop).SessionId`));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function win32IsAlive(pid: number, token: string, runner: SplCommandRunner = realRunner): boolean {
  return Boolean(token) && win32StartToken(pid, runner) === token;
}
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
export async function win32Terminate(pid: number, token: string, options: { graceMs: number }, runner: SplCommandRunner = realRunner): Promise<SplTerminateResult> {
  if (pid <= 1 || pid === process.pid) throw new Error(`SPL_SIGNAL_REFUSED: unsafe pid ${String(pid)}`);
  const current = win32StartToken(pid, runner);
  if (!current) return { outcome: 'already-dead' };
  if (current !== token) return { outcome: 'identity-mismatch' };
  if (powershell(runner, `Stop-Process -Id ${String(pid)} -ErrorAction Stop`) === null) return { outcome: 'signal-refused' };
  const signals: ('SIGTERM' | 'SIGKILL')[] = ['SIGTERM'];
  const deadline = Date.now() + Math.max(0, options.graceMs);
  while (Date.now() < deadline && win32IsAlive(pid, token, runner)) await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  if (!win32IsAlive(pid, token, runner)) return { outcome: 'terminated', signals };
  if (powershell(runner, `Stop-Process -Id ${String(pid)} -Force -ErrorAction Stop`) === null) return { outcome: 'signal-refused', signals };
  signals.push('SIGKILL');
  return { outcome: 'killed', signals };
}

export function win32BudgetSnapshot(runner: SplCommandRunner = realRunner): SplBudgetSnapshot {
  const raw = powershell(runner, "$cpu=Get-CimInstance Win32_Processor; $os=Get-CimInstance Win32_OperatingSystem; @($cpu.NumberOfLogicalProcessors,$cpu.LoadPercentage,$os.FreePhysicalMemory,$os.TotalVisibleMemorySize) -join ','") ?? '';
  const [coreText, loadText, freeKbText, totalKbText] = raw.split(',').map((value) => value.trim());
  const cores = Math.max(1, Number(coreText) || 1);
  const load = (Number(loadText) || 0) * cores / 100;
  const availableGb = (Number(freeKbText) || 0) / 1024 / 1024;
  void totalKbText;
  const ratio = load / cores;
  const pressure = ratio >= 1.5 || availableGb < 1 ? 'critical' : ratio >= 0.85 || availableGb < 3 ? 'warn' : 'ok';
  const recommended = pressure === 'critical' ? 1 : pressure === 'warn' ? Math.max(1, Math.floor(cores / 4)) : Math.max(1, Math.floor(cores / 2));
  return { cores, load: Number(load.toFixed(2)), mem_available_gb: Number(availableGb.toFixed(2)), swap_used_pct: 0, pressure, recommended_agents: recommended };
}
export function win32SplPlatform(runner: SplCommandRunner = realRunner): SplPlatform {
  return { startToken: (pid) => win32StartToken(pid, runner), sessionId: (pid) => win32SessionId(pid, runner), isAlive: (pid, token) => win32IsAlive(pid, token, runner), terminate: (pid, token, options) => win32Terminate(pid, token, options, runner), budgetSnapshot: () => win32BudgetSnapshot(runner) };
}
