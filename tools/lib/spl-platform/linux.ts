import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import type { SplBudgetSnapshot, SplPlatform, SplTerminateResult } from './contract.ts';

const DEFAULT_PROC_ROOT = '/proc';

function statFields(pid: number, procRoot: string): string[] | null {
  try {
    const raw = readFileSync(`${procRoot}/${String(pid)}/stat`, 'utf8').trim();
    const close = raw.lastIndexOf(')');
    if (close < 0) return null;
    return raw.slice(close + 2).split(/\s+/);
  } catch { return null; }
}

export function linuxStartToken(pid: number, procRoot = DEFAULT_PROC_ROOT): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return statFields(pid, procRoot)?.[19] ?? null;
}

export function linuxSessionId(pid: number, procRoot = DEFAULT_PROC_ROOT): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const value = Number(statFields(pid, procRoot)?.[3]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function linuxIsAlive(pid: number, token: string, procRoot = DEFAULT_PROC_ROOT): boolean {
  const fields = statFields(pid, procRoot);
  return Boolean(token) && fields?.[0] !== 'Z' && fields?.[19] === token;
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

function signal(pid: number, name: 'SIGTERM' | 'SIGKILL'): 'sent' | 'dead' | 'refused' {
  try {
    process.kill(pid, name);
    return 'sent';
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    return code === 'ESRCH' ? 'dead' : 'refused';
  }
}

async function waitForExit(pid: number, token: string, graceMs: number, procRoot: string): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, graceMs);
  while (Date.now() < deadline) {
    if (!linuxIsAlive(pid, token, procRoot)) return true;
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
  }
  return !linuxIsAlive(pid, token, procRoot);
}

export async function linuxTerminate(pid: number, token: string, options: { graceMs: number }, procRoot = DEFAULT_PROC_ROOT): Promise<SplTerminateResult> {
  if (pid <= 1 || pid === process.pid) throw new Error(`SPL_SIGNAL_REFUSED: unsafe pid ${String(pid)}`);
  if (!linuxStartToken(pid, procRoot)) return { outcome: 'already-dead' };
  if (!linuxIsAlive(pid, token, procRoot)) return { outcome: 'identity-mismatch' };
  const term = signal(pid, 'SIGTERM');
  if (term !== 'sent') return { outcome: term === 'dead' ? 'already-dead' : 'signal-refused' };
  const signals: ('SIGTERM' | 'SIGKILL')[] = ['SIGTERM'];
  if (await waitForExit(pid, token, options.graceMs, procRoot)) return { outcome: 'terminated', signals };
  const kill = signal(pid, 'SIGKILL');
  if (kill !== 'sent') return { outcome: kill === 'dead' ? 'already-dead' : 'signal-refused', signals };
  signals.push('SIGKILL');
  return { outcome: 'killed', signals };
}

function memInfo(procRoot: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of readFileSync(`${procRoot}/meminfo`, 'utf8').split('\n')) {
    const match = /^([^:]+):\s+(\d+)/.exec(line);
    if (match) result[match[1]] = Number(match[2]);
  }
  return result;
}

export function linuxBudgetSnapshot(procRoot = DEFAULT_PROC_ROOT): SplBudgetSnapshot {
  const cores = Math.max(1, cpus().length);
  const load = Number(readFileSync(`${procRoot}/loadavg`, 'utf8').trim().split(/\s+/)[0] ?? 0);
  const mem = memInfo(procRoot);
  const availableKb = mem.MemAvailable;
  const swapTotal = mem.SwapTotal;
  const swapUsedPct = swapTotal > 0 ? ((swapTotal - mem.SwapFree) / swapTotal) * 100 : 0;
  const loadRatio = load / cores;
  const availableGb = availableKb / 1024 / 1024;
  const pressure = loadRatio >= 1.5 || availableGb < 1 || swapUsedPct >= 85 ? 'critical'
    : loadRatio >= 0.85 || availableGb < 3 || swapUsedPct >= 60 ? 'warn' : 'ok';
  const recommended = pressure === 'critical' ? 1 : pressure === 'warn' ? Math.max(1, Math.floor(cores / 4)) : Math.max(1, Math.floor(cores / 2));
  return { cores, load, mem_available_gb: Number(availableGb.toFixed(2)), swap_used_pct: Number(swapUsedPct.toFixed(1)), pressure, recommended_agents: recommended };
}

export function linuxSplPlatform(procRoot = DEFAULT_PROC_ROOT): SplPlatform {
  return {
    startToken: (pid) => linuxStartToken(pid, procRoot),
    sessionId: (pid) => linuxSessionId(pid, procRoot),
    isAlive: (pid, token) => linuxIsAlive(pid, token, procRoot),
    terminate: (pid, token, options) => linuxTerminate(pid, token, options, procRoot),
    budgetSnapshot: () => linuxBudgetSnapshot(procRoot),
  };
}
