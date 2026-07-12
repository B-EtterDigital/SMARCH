/** Data-driven discovery of unregistered AI-agent orphan candidates. */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SMA_ROOT } from './sma-paths.ts';
import type { SplProcess } from './spl-registry.ts';

export interface SplOrphan { pid: number; start_token: string; parent_pid: number; agent: string; label: string; age_seconds: number; rss_mb: number; cpu_seconds: number; tier: 'ORPHAN?' }
interface ProcessInfo { pid: number; ppid: number; sessionId: number; startToken: string; startTicks: number; argv: string; rssKb: number; cpuTicks: number }
interface Signature { id: string; argv_regex: string }

export function processResourceEstimate(pid: number, procRoot = '/proc', clockTicks = 100): { rss_mb: number; cpu_seconds: number } {
  const processInfo = info(pid, procRoot);
  return processInfo ? { rss_mb: Number((processInfo.rssKb / 1024).toFixed(1)), cpu_seconds: Number((processInfo.cpuTicks / clockTicks).toFixed(1)) } : { rss_mb: 0, cpu_seconds: 0 };
}

function parseStat(pid: number, procRoot: string): { ppid: number; sessionId: number; startToken: string; startTicks: number; cpuTicks: number } | null {
  try {
    const raw = readFileSync(`${procRoot}/${String(pid)}/stat`, 'utf8').trim();
    const close = raw.lastIndexOf(')');
    const fields = raw.slice(close + 2).split(/\s+/);
    return { ppid: Number(fields[1]), sessionId: Number(fields[3]), cpuTicks: Number(fields[11]) + Number(fields[12]), startToken: fields[19] ?? '', startTicks: Number(fields[19]) };
  } catch { return null; }
}

function info(pid: number, procRoot: string): ProcessInfo | null {
  const stat = parseStat(pid, procRoot);
  if (!stat) return null;
  try {
    const argv = readFileSync(`${procRoot}/${String(pid)}/cmdline`).toString('utf8').replaceAll('\0', ' ').trim();
    const status = readFileSync(`${procRoot}/${String(pid)}/status`, 'utf8');
    const rssKb = Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0);
    return { pid, ...stat, argv, rssKb };
  } catch { return null; }
}

function ancestry(procRoot: string): Set<number> {
  const result = new Set<number>();
  let pid = process.pid;
  while (pid > 1 && !result.has(pid)) {
    result.add(pid);
    pid = parseStat(pid, procRoot)?.ppid ?? 1;
  }
  result.add(1);
  return result;
}

function signatures(configPath: string): { id: string; regex: RegExp }[] {
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { signatures?: Signature[] };
  return (parsed.signatures ?? []).map((entry) => ({ id: entry.id, regex: new RegExp(entry.argv_regex, 'i') }));
}

interface OrphanOptions { procRoot?: string; configPath?: string; minAgeSeconds?: number; clockTicks?: number; currentPid?: number }

function isOrphanParent(processInfo: ProcessInfo, registered: SplProcess[], procRoot: string): boolean {
  if (processInfo.ppid === 1 || processInfo.sessionId === processInfo.pid) return true;
  const parentInfo = info(processInfo.ppid, procRoot);
  const parent = parentInfo
    ? registered.find((entry) => entry.pid === parentInfo.pid && entry.start_token === parentInfo.startToken)
    : undefined;
  return parent?.state === 'EXPIRED';
}

function candidate(processInfo: ProcessInfo, registered: SplProcess[], protectedPids: Set<number>, protectedSession: number | null, knownIdentity: Set<string>, procRoot: string): boolean {
  if (protectedPids.has(processInfo.pid) || knownIdentity.has(`${String(processInfo.pid)}:${processInfo.startToken}`)) return false;
  if (protectedSession !== null && processInfo.sessionId === protectedSession) return false;
  return isOrphanParent(processInfo, registered, procRoot);
}

function orphanRow(processInfo: ProcessInfo, agent: string, age: number, hz: number): SplOrphan {
  return { pid: processInfo.pid, start_token: processInfo.startToken, parent_pid: processInfo.ppid, agent, label: processInfo.argv.slice(0, 120), age_seconds: Math.floor(age), rss_mb: Number((processInfo.rssKb / 1024).toFixed(1)), cpu_seconds: Number((processInfo.cpuTicks / hz).toFixed(1)), tier: 'ORPHAN?' };
}

function inspectCandidate(name: string, registered: SplProcess[], protectedPids: Set<number>, protectedSession: number | null, knownIdentity: Set<string>, matchers: { id: string; regex: RegExp }[], procRoot: string, bootSeconds: number, minAge: number, hz: number): SplOrphan | null {
  if (!/^\d+$/.exec(name)) return null;
  const processInfo = info(Number(name), procRoot);
  if (!processInfo || !candidate(processInfo, registered, protectedPids, protectedSession, knownIdentity, procRoot)) return null;
  const match = matchers.find((entry) => entry.regex.test(processInfo.argv));
  if (!match) return null;
  const age = Math.max(0, bootSeconds - processInfo.startTicks / hz);
  return age < minAge ? null : orphanRow(processInfo, match.id, age, hz);
}

export function findAgentOrphans(registered: SplProcess[], options: OrphanOptions = {}): SplOrphan[] {
  const procRoot = options.procRoot ?? '/proc';
  const minAge = options.minAgeSeconds ?? 600;
  const hz = options.clockTicks ?? 100;
  const bootSeconds = Number(readFileSync(`${procRoot}/uptime`, 'utf8').split(/\s+/)[0] ?? 0);
  const knownIdentity = new Set(registered.map((entry) => `${String(entry.pid)}:${entry.start_token}`));
  const protectedPids = ancestry(procRoot);
  const protectedSession = parseStat(options.currentPid ?? process.pid, procRoot)?.sessionId ?? null;
  const matchers = signatures(options.configPath ?? resolve(SMA_ROOT, 'registry/spl-agents.json'));
  const result: SplOrphan[] = [];
  for (const name of readdirSync(procRoot)) {
    const row = inspectCandidate(name, registered, protectedPids, protectedSession, knownIdentity, matchers, procRoot, bootSeconds, minAge, hz);
    if (row) result.push(row);
  }
  return result.sort((a, b) => b.rss_mb - a.rss_mb);
}
