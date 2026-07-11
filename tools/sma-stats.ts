#!/usr/bin/env node
/**
 * WHAT: Summarizes adoption, activity, and coverage over time.
 * WHY: Current lease snapshots alone cannot show whether coordination practices are improving.
 * HOW: Aggregates durable project context events, merge proposals, and the active lease snapshot.
 * OUTPUTS: Prints summary, trend, or ranked metrics as text or structured data.
 * CALLERS: Operators and dashboards use it for adoption and session forensics.
 * USAGE: `node tools/sma-stats.ts summary --since 7d --project sma --json`
 * Glossary: [Gen3](../docs/GLOSSARY.md).
 */

import { argv, exit } from 'node:process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  projectRoot,
  PROJECTS_ROOT,
  PROJECT_PATH_OVERRIDES,
  PROJECT_ABSOLUTE_OVERRIDES,
} from './lib/context-log.ts';

type StatsArgs = {
  since?: string;
  project?: string | string[];
  json?: boolean;
  excludeVendored?: boolean;
  by?: string;
  metric?: string;
  n?: string;
};
type ContextEvent = Record<string, unknown> & {
  timestamp: string;
  project: string;
  brick_id?: string;
  kind?: string;
  actor_id?: string;
  actor_kind?: string;
  session_id?: string;
  files_touched?: string[];
  verification?: { status?: string };
};
type MergeProposal = Record<string, unknown> & {
  generated_at: string;
  resolved_at?: string;
};
type TrendRow = { date: string; total: number; leases: number; edits: number; conflicts: number; verifications: number; merges: number };

const cmd = argv[2];
const args = parseArgs(argv.slice(3));

try {
  switch (cmd) {
    case 'summary':
      runSummary();
      break;
    case 'trend':
      runTrend();
      break;
    case 'top':
      runTop();
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
  console.error(`sma-stats: ${err instanceof Error ? err.message : String(err)}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-stats.ts summary [--since 7d|30d|90d|<iso>] [--project <id>]... [--json]
                        [--exclude-vendored]
  sma-stats.ts trend   [--since 30d] [--project <id>]... [--by day|week] [--json]
                        [--exclude-vendored]
  sma-stats.ts top     [--since 30d] [--metric agent|session|brick|kind] [--n 10] [--json]
                        [--exclude-vendored]

  --exclude-vendored    Skip bricks whose ids/paths look like vendored code
                        (node_modules, vendor, dist, build, __generated__).
`);
}

// ── summary ──────────────────────────────────────────────────────────────────

function runSummary() {
  const cutoff = parseSince(args.since ?? '30d');
  const events = collectEvents(resolveProjects(), cutoff);
  const proposals = collectProposals(resolveProjects(), cutoff);

  const summary = {
    window_start: new Date(cutoff).toISOString(),
    window_end: new Date().toISOString(),
    projects_with_events: countProjectsWithEvents(events),
    total_events: events.length,
    by_kind: bucket(events, 'kind'),
    by_actor: topBucket(events.map((e) => e.actor_id).filter((value): value is string => Boolean(value)), 8),
    by_session: topBucket(events.map((e) => e.session_id).filter((value): value is string => Boolean(value)), 8),
    by_actor_kind: bucket(events, 'actor_kind'),
    distinct_bricks: new Set(events.map((e) => `${e.project}:${e.brick_id}`)).size,
    distinct_sessions: new Set(events.map((e) => e.session_id).filter((value): value is string => Boolean(value))).size,
    session_attributed_events: events.filter((e) => e.session_id).length,
    session_unattributed_events: events.filter((e) => !e.session_id).length,
    leases_acquired: events.filter((e) => e.kind === 'lease_acquired').length,
    leases_released: events.filter((e) => e.kind === 'lease_released').length,
    leases_force_acquired: events.filter((e) => e.kind === 'lease_force_acquired').length,
    edits_planned: events.filter((e) => e.kind === 'edit_planned').length,
    edits_applied: events.filter((e) => e.kind === 'edit_applied').length,
    decisions_recorded: events.filter((e) => e.kind === 'decision_recorded').length,
    conflicts_detected: events.filter((e) => e.kind === 'conflict_detected').length,
    conflicts_resolved: events.filter((e) => e.kind === 'conflict_resolved').length,
    open_conflicts_in_window: countOpenConflicts(events),
    verifications_passed: events.filter((e) => e.kind === 'verification_run' && e.verification?.status === 'pass').length,
    verifications_failed: events.filter((e) => e.kind === 'verification_run' && e.verification?.status === 'fail').length,
    proofs_recorded: events.filter((e) => e.kind === 'proof_recorded').length,
    merge_proposals_opened: proposals.length,
    merge_proposals_resolved: proposals.filter((p) => p.resolved_at).length,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  print('window:               ', `${summary.window_start} → ${summary.window_end}`);
  print('projects with events: ', summary.projects_with_events);
  print('total events:         ', summary.total_events);
  print('distinct bricks:      ', summary.distinct_bricks);
  print('distinct sessions:    ', summary.distinct_sessions);
  print('session attribution:  ', `${summary.session_attributed_events}/${summary.total_events} events`);
  print('leases acquired:      ', summary.leases_acquired);
  print('leases released:      ', summary.leases_released);
  print('force-acquired:       ', summary.leases_force_acquired);
  print('edits planned:        ', summary.edits_planned);
  print('edits applied:        ', summary.edits_applied);
  print('decisions:            ', summary.decisions_recorded);
  print('conflicts det/res/open:', `${summary.conflicts_detected} / ${summary.conflicts_resolved} / ${summary.open_conflicts_in_window}`);
  print('verify pass/fail:     ', `${summary.verifications_passed} / ${summary.verifications_failed}`);
  print('proofs recorded:      ', summary.proofs_recorded);
  print('merge proposals:      ', `${summary.merge_proposals_opened} opened, ${summary.merge_proposals_resolved} resolved`);
  console.log('');
  console.log('top kinds:');
  for (const [k, n] of Object.entries(summary.by_kind).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 8)) {
    console.log(`  ${pad(k, 24)} ${n}`);
  }
  console.log('top actors:');
  for (const [k, n] of Object.entries(summary.by_actor)) {
    console.log(`  ${pad(k, 24)} ${n}`);
  }
  if (Object.keys(summary.by_session).length) {
    console.log('top sessions:');
    for (const [k, n] of Object.entries(summary.by_session)) {
      console.log(`  ${pad(k, 36)} ${n}`);
    }
  }
}

// ── trend ────────────────────────────────────────────────────────────────────

function runTrend() {
  const cutoff = parseSince(args.since ?? '30d');
  const events = collectEvents(resolveProjects(), cutoff);
  const granularity = args.by ?? 'day';
  const buckets = new Map<string, TrendRow>();
  for (const e of events) {
    const key = bucketKey(e.timestamp, granularity);
    if (!buckets.has(key)) buckets.set(key, { date: key, total: 0, leases: 0, edits: 0, conflicts: 0, verifications: 0, merges: 0 });
    const row = buckets.get(key);
    if (!row) continue;
    row.total += 1;
    if (e.kind?.startsWith('lease_')) row.leases += 1;
    if (e.kind === 'edit_planned' || e.kind === 'edit_applied') row.edits += 1;
    if (e.kind === 'conflict_detected' || e.kind === 'conflict_resolved') row.conflicts += 1;
    if (e.kind === 'verification_run' || e.kind === 'proof_recorded') row.verifications += 1;
    if (e.kind?.startsWith('merge_')) row.merges += 1;
  }
  const rows = [...buckets.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (args.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) { console.log('(no events in window)'); return; }
  console.log(`${pad('date', 12)} ${pad('total', 6)} ${pad('leases', 7)} ${pad('edits', 6)} ${pad('conf', 6)} ${pad('verify', 7)} ${pad('merges', 7)}`);
  console.log('-'.repeat(58));
  for (const r of rows) {
    console.log(`${pad(r.date, 12)} ${pad(String(r.total), 6)} ${pad(String(r.leases), 7)} ${pad(String(r.edits), 6)} ${pad(String(r.conflicts), 6)} ${pad(String(r.verifications), 7)} ${pad(String(r.merges), 7)}`);
  }
}

// ── top ──────────────────────────────────────────────────────────────────────

function runTop() {
  const cutoff = parseSince(args.since ?? '30d');
  const events = collectEvents(resolveProjects(), cutoff);
  const metric = args.metric ?? 'brick';
  const n = Number(args.n ?? 10);
  let counts;
  let label;
  switch (metric) {
    case 'agent':
      counts = bucket(events, 'actor_id');
      label = 'agent';
      break;
    case 'session':
      counts = bucket(events.filter((e) => e.session_id), 'session_id');
      label = 'session';
      break;
    case 'brick':
      counts = events.reduce<Record<string, number>>((m, e) => {
        const k = `${e.project}:${e.brick_id}`;
        m[k] = (m[k] ?? 0) + 1;
        return m;
      }, {});
      label = 'project:brick';
      break;
    case 'kind':
      counts = bucket(events, 'kind');
      label = 'kind';
      break;
    default:
      throw new Error(`unknown --metric: ${metric}`);
  }
  const top = Object.entries(counts).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, n);
  if (args.json) {
    console.log(JSON.stringify(top.map(([k, v]) => ({ [label]: k, count: v })), null, 2));
    return;
  }
  console.log(`top ${top.length} by ${metric}:`);
  for (const [k, v] of top) console.log(`  ${pad(k, 80)} ${v}`);
}

// ── data collection ──────────────────────────────────────────────────────────

// Patterns that mark a brick as "vendored" (third-party code in your repos
// rather than your own work). Heuristic; refine over time.
const VENDORED_PATH_PATTERNS = [
  /(^|\/)node_modules\//,
  /(^|\/)vendor\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)\.next\//,
  /(^|\/)packages\/[^/]+\/dist\//,
  /\/__generated__\//,
];

function isVendoredBrickId(brickId: string): boolean {
  if (!brickId) return false;
  // Brick IDs like "<project>.<kind>.packages-foo-dist-..." encode the path with
  // dashes. We approximate the same heuristic on the id itself.
  return /(^|[.-])(node_modules|vendor|dist|build)([.-]|$)/.test(brickId)
      || /\.__generated__\./.test(brickId);
}

function collectEvents(projects: string[], cutoff: number): ContextEvent[] {
  const excludeVendored = args.excludeVendored === true;
  const out: ContextEvent[] = [];
  for (const id of projects) {
    const root = resolveProjectRoot(id);
    if (!root) continue;
    const dir = resolve(root, '.smarch/agent-context');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ndjson'))) {
      // Filter at file level when possible (cheap; saves per-line parsing)
      const brickId = f.replace(/\.ndjson$/, '');
      if (excludeVendored && isVendoredBrickId(brickId)) continue;
      let raw: string;
      try { raw = readFileSync(resolve(dir, f), 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const ev = JSON.parse(t) as ContextEvent;
          if (!ev.timestamp) continue;
          if (Date.parse(ev.timestamp) < cutoff) continue;
          if (!ev.project) ev.project = id;
          if (excludeVendored && (ev.files_touched || []).some((p) => VENDORED_PATH_PATTERNS.some((rx) => rx.test(p)))) continue;
          out.push(ev);
        } catch { /* skip malformed */ }
      }
    }
  }
  return out;
}

function collectProposals(projects: string[], cutoff: number): MergeProposal[] {
  const out: MergeProposal[] = [];
  for (const id of projects) {
    const root = resolveProjectRoot(id);
    if (!root) continue;
    const dir = resolve(root, '.smarch/merge-proposals');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try {
        const p = JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as MergeProposal;
        if (!p.generated_at) continue;
        if (Date.parse(p.generated_at) < cutoff) continue;
        out.push(p);
      } catch { /* skip */ }
    }
  }
  return out;
}

function resolveProjects(): string[] {
  if (Array.isArray(args.project)) return args.project;
  if (args.project) return [args.project];
  // Discovery uses two paths:
  //   (a) every project ID in the override map whose mapped path has .smarch/
  //   (b) every top-level dir under PROJECTS_ROOT with .smarch/
  // Combining the two catches both flat layouts and nested ones (e.g.
  // acme-lab → workspace/acme-lab, two levels deep).
  const out = new Set<string>();
  const seenRoots = new Set<string>();

  const addIfContextProject = (id: string): void => {
    const root = resolveProjectRoot(id);
    if (!root || !existsSync(resolve(root, '.smarch'))) return;
    if (seenRoots.has(root)) return;
    seenRoots.add(root);
    out.add(id);
  };

  // (a) absolute control-plane projects outside /DEV/Projects
  for (const id of Object.keys(PROJECT_ABSOLUTE_OVERRIDES)) {
    addIfContextProject(id);
  }

  // (b) override-map IDs
  for (const id of Object.keys(PROJECT_PATH_OVERRIDES)) {
    addIfContextProject(id);
  }

  // (c) top-level dirs with .smarch/
  try {
    for (const top of readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
      if (!top.isDirectory()) continue;
      addIfContextProject(top.name);
    }
  } catch { /* empty */ }

  return [...out];
}

function resolveProjectRoot(projectId: string): string | null {
  try { return projectRoot(projectId); } catch { return null; }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function parseSince(raw: string): number {
  const dm = String(raw).match(/^(\d+)([dwm])$/);
  if (dm) {
    const n = Number(dm[1]);
    const unit = dm[2];
    const ms = unit === 'd' ? 86400000 : unit === 'w' ? 7 * 86400000 : 30 * 86400000;
    return Date.now() - n * ms;
  }
  const t = Date.parse(raw);
  if (!Number.isNaN(t)) return t;
  throw new Error(`bad --since: ${raw}`);
}

function bucketKey(iso: string, by: string): string {
  if (by === 'week') {
    const d = new Date(iso);
    const yearStart = new Date(d.getUTCFullYear(), 0, 1);
    const week = Math.floor(((d.getTime() - yearStart.getTime()) / 86400000 + yearStart.getUTCDay() + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }
  return iso.slice(0, 10);
}

function bucket<T extends Record<string, unknown>>(arr: T[], key: keyof T): Record<string, number> {
  return arr.reduce<Record<string, number>>((counts, entry) => {
    const value = String(entry[key] ?? 'unknown');
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function topBucket(arr: string[], n: number): Record<string, number> {
  const all = arr.reduce<Record<string, number>>((counts, key) => {
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  return Object.fromEntries(Object.entries(all).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, n));
}

function countProjectsWithEvents(events: ContextEvent[]): number {
  return new Set(events.map((e) => e.project)).size;
}

function countOpenConflicts(events: ContextEvent[]): number {
  const byBrick = new Map<string, number>();
  for (const event of [...events].sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))) {
    if (event.kind !== 'conflict_detected' && event.kind !== 'conflict_resolved') continue;
    const key = `${event.project}:${event.brick_id}`;
    const current = byBrick.get(key) ?? 0;
    if (event.kind === 'conflict_detected') byBrick.set(key, current + 1);
    else if (current > 0) byBrick.set(key, current - 1);
  }
  return [...byBrick.values()].reduce((sum, value) => sum + value, 0);
}

function pad(s: unknown, n: number): string { return String(s ?? '').slice(0, n).padEnd(n); }
function print(label: string, value: unknown): void { console.log(`${label}${String(value)}`); }

function parseArgs(list: string[]): StatsArgs {
  const out: StatsArgs = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_match: string, c: string) => c.toUpperCase()) as keyof StatsArgs;
    const next = list[i + 1];
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) {
      if (camel === 'json' || camel === 'excludeVendored') out[camel] = true;
      continue;
    }
    if (camel === 'project') {
      if (Array.isArray(out.project)) out.project.push(next);
      else if (out.project) out.project = [out.project, next];
      else out.project = next;
    } else {
      if (camel === 'since' || camel === 'by' || camel === 'metric' || camel === 'n') out[camel] = next;
    }
    i += 1;
  }
  return out;
}
