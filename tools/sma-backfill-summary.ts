#!/usr/bin/env node
/**
 * WHAT: Rolls all persisted backfill batches and failures into operator-facing summaries.
 * WHY: Individual reports do not reveal portfolio progress, repeated failures, or project coverage.
 * HOW: Reads batch artifacts, aggregates counts by batch, project, and reason, then prints or writes results.
 * INPUTS: Backfill report directories plus a summary subcommand and optional output or display flags.
 * OUTPUTS: Console tables, structured data, or a generated summary file.
 * CALLERS: Backfill operators and controller reporting use this after one or more runs.
 * @example node tools/sma-backfill-summary.ts --help
 */
/**
 * sma-backfill-summary.ts — roll up every backfill batch report.
 *
 * Reads:
 *   handoffs/backfill/phase-*-*.json (batch reports, except *-failures.json)
 *   handoffs/backfill/phase-*-failures.json (when present)
 *
 * Writes (when --out passed) or prints:
 *   handoffs/backfill/summary.generated.json
 *
 * Aggregates across batches:
 *   - per-batch: id, phase, mode, processed/succeeded/failed, runtime
 *   - per-project: total succeeded, distinct bricks attested, top batch
 *   - per-failure-reason: counts
 *   - top intents: most common derived intent strings
 *   - top authors: most common attested commit authors
 *
 * Subcommands:
 *   summary [--out <path>] [--json] [--include-dry-runs]
 *   per-project [--json]
 *   per-batch [--json]
 *   failures [--json]
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { argv, exit } from 'node:process';
import { SMA_ROOT } from "./lib/sma-paths.ts";


const HANDOFFS = resolve(SMA_ROOT, 'handoffs/backfill');
const DEFAULT_OUT = resolve(HANDOFFS, 'summary.generated.json');

interface BackfillEvent { status?: string }
interface BackfillResult { project?: string; manifest_path?: string; events: BackfillEvent[] }
interface BatchReport {
  _file: string; batch_id: string; phase?: string | number; mode: string; generated_at: string;
  processed: number; succeeded: number; failure_count: number; skipped_already_done?: number;
  skipped_no_commit?: number; skipped_already_attested?: number; results: BackfillResult[];
}
interface BackfillFailure { reason: string; brick: string; batch_id?: string }
interface ProjectAccumulator { project: string; succeeded: number; attempted: number; distinct_bricks: number; batches: Set<string> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseBatch(value: unknown, file: string): BatchReport | null {
  if (!isRecord(value)) return null;
  const results: BackfillResult[] = (Array.isArray(value.results) ? value.results : []).flatMap((raw) => {
    if (!isRecord(raw)) return [];
    const events: BackfillEvent[] = (Array.isArray(raw.events) ? raw.events : []).flatMap((event) =>
      isRecord(event) && typeof event.status === 'string' ? [{ status: event.status }] : []);
    return [{
      project: typeof raw.project === 'string' ? raw.project : undefined,
      manifest_path: typeof raw.manifest_path === 'string' ? raw.manifest_path : undefined,
      events,
    }];
  });
  return {
    _file: file,
    batch_id: typeof value.batch_id === 'string' ? value.batch_id : file,
    phase: typeof value.phase === 'string' || typeof value.phase === 'number' ? value.phase : undefined,
    mode: typeof value.mode === 'string' ? value.mode : '',
    generated_at: typeof value.generated_at === 'string' ? value.generated_at : '',
    processed: typeof value.processed === 'number' ? value.processed : 0,
    succeeded: typeof value.succeeded === 'number' ? value.succeeded : 0,
    failure_count: typeof value.failure_count === 'number' ? value.failure_count : 0,
    skipped_already_done: typeof value.skipped_already_done === 'number' ? value.skipped_already_done : undefined,
    skipped_no_commit: typeof value.skipped_no_commit === 'number' ? value.skipped_no_commit : undefined,
    skipped_already_attested: typeof value.skipped_already_attested === 'number' ? value.skipped_already_attested : undefined,
    results,
  };
}

const cmd = argv[2];
const args = parseArgs(argv.slice(3));

try {
  switch (cmd) {
    case 'summary':
    case undefined:
      runSummary();
      break;
    case 'per-project':
      runPerProject();
      break;
    case 'per-batch':
      runPerBatch();
      break;
    case 'failures':
      runFailures();
      break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      exit(0);
      break;
    default:
      console.error(`unknown subcommand: ${cmd}`);
      usage();
      exit(2);
  }
} catch (err) {
  console.error(`sma-backfill-summary: ${err instanceof Error ? err.message : String(err)}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-backfill-summary.ts summary [--out <path>] [--json] [--include-dry-runs]
  sma-backfill-summary.ts per-project [--json]
  sma-backfill-summary.ts per-batch [--json]
  sma-backfill-summary.ts failures [--json] [--top 10]
`);
}

// ── data load ────────────────────────────────────────────────────────────────

function loadBatches(): BatchReport[] {
  if (!existsSync(HANDOFFS)) return [];
  const files = readdirSync(HANDOFFS)
    .filter((f: string) => /^phase-[0-9]/.test(f) && f.endsWith('.json') && !f.endsWith('-failures.json'));
  const batches: BatchReport[] = [];
  for (const f of files) {
    try {
      const report = parseBatch(JSON.parse(readFileSync(resolve(HANDOFFS, f), 'utf8')) as unknown, f);
      if (report) batches.push(report);
    } catch { /* skip malformed */ }
  }
  batches.sort((a, b) => a.generated_at.localeCompare(b.generated_at));
  return batches;
}

function loadFailures(): BackfillFailure[] {
  if (!existsSync(HANDOFFS)) return [];
  const files = readdirSync(HANDOFFS).filter((f: string) => f.endsWith('-failures.json'));
  const all: BackfillFailure[] = [];
  for (const f of files) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(resolve(HANDOFFS, f), 'utf8'));
      if (!isRecord(parsed)) continue;
      for (const failure of Array.isArray(parsed.failures) ? parsed.failures : []) {
        if (!isRecord(failure) || typeof failure.reason !== 'string') continue;
        all.push({ reason: failure.reason, brick: typeof failure.brick === 'string' ? failure.brick : '', batch_id: typeof parsed.batch_id === 'string' ? parsed.batch_id : undefined });
      }
    } catch { /* skip */ }
  }
  return all;
}

// ── summary ──────────────────────────────────────────────────────────────────

function runSummary() {
  const includeDryRuns = args.includeDryRuns === true;
  const all = loadBatches();
  const batches = includeDryRuns ? all : all.filter((b) => b.mode === 'commit');
  const failures = loadFailures();

  const perProject: Record<string, ProjectAccumulator> = {};
  const perBatch = batches.map((b) => ({
    batch_id: b.batch_id,
    phase: b.phase,
    mode: b.mode,
    generated_at: b.generated_at,
    processed: b.processed,
    succeeded: b.succeeded,
    skipped_already_done: b.skipped_already_done ?? 0,
    skipped_no_commit: b.skipped_no_commit ?? 0,
    skipped_already_attested: b.skipped_already_attested ?? 0,
    failure_count: b.failure_count ?? 0,
  }));

  // distinct bricks per project (a brick appears multiple times if it was
  // attested in more than one batch — count distinct manifest_paths)
  const distinctByProject = new Map<string, Set<string>>();
  let totalProcessed = 0, totalSucceeded = 0, totalFailures = 0;
  for (const b of batches) {
    totalProcessed += b.processed ?? 0;
    totalSucceeded += b.succeeded ?? 0;
    totalFailures += b.failure_count ?? 0;
    for (const r of b.results || []) {
      const proj = r.project ?? 'unknown';
      if (!perProject[proj]) perProject[proj] = { project: proj, succeeded: 0, attempted: 0, distinct_bricks: 0, batches: new Set() };
      const project = perProject[proj];
      if (!project) continue;
      project.attempted += 1;
      const wrote = r.events.some((event) => event.status === 'wrote' || event.status === 'would-backfill');
      if (wrote) project.succeeded += 1;
      project.batches.add(b.batch_id);
      if (!distinctByProject.has(proj)) distinctByProject.set(proj, new Set());
      if (r.manifest_path) distinctByProject.get(proj)?.add(r.manifest_path);
    }
  }
  for (const [proj, set] of distinctByProject) {
    const project = perProject[proj];
    if (project) project.distinct_bricks = set.size;
  }

  // failure analysis
  const byReason: Record<string, number> = {};
  const byProjectFail: Record<string, number> = {};
  for (const f of failures) {
    byReason[f.reason] = (byReason[f.reason] ?? 0) + 1;
    const proj = (f.brick || '').split('.')[0];
    byProjectFail[proj] = (byProjectFail[proj] ?? 0) + 1;
  }

  const perProjectRows = Object.values(perProject).map((project) => ({ ...project, batches: [...project.batches] })).sort((a, b) => b.succeeded - a.succeeded);
  const summary = {
    generated_at: new Date().toISOString(),
    counts: {
      batches: batches.length,
      total_processed: totalProcessed,
      total_succeeded: totalSucceeded,
      total_failures: totalFailures,
      distinct_projects: Object.keys(perProject).length,
      distinct_bricks_attempted: [...distinctByProject.values()].reduce((n, s) => n + s.size, 0),
    },
    per_batch: perBatch,
    per_project: perProjectRows,
    failures: {
      total: failures.length,
      by_reason: byReason,
      by_project: byProjectFail,
      sample: failures.slice(0, 5),
    },
  };

  const outPath = args.out ? resolve(args.out) : DEFAULT_OUT;
  if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(summary, null, 2) + '\n');

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`wrote ${outPath}`);
  console.log('');
  console.log(`batches:         ${summary.counts.batches}`);
  console.log(`processed:       ${summary.counts.total_processed}`);
  console.log(`succeeded:       ${summary.counts.total_succeeded}`);
  console.log(`failures:        ${summary.counts.total_failures}`);
  console.log(`distinct bricks: ${summary.counts.distinct_bricks_attempted}`);
  console.log(`projects:        ${summary.counts.distinct_projects}`);
  console.log('');
  console.log('per-project (top 12):');
  for (const p of summary.per_project.slice(0, 12)) {
    console.log(`  ${pad(p.project, 24)}  succ=${pad(String(p.succeeded), 5)}  distinct=${pad(String(p.distinct_bricks), 5)}  batches=${p.batches.length}`);
  }
  if (failures.length) {
    console.log('');
    console.log('failures by reason:');
    for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${pad(String(v), 5)}  ${k}`);
    }
    console.log('');
    console.log('failures by project:');
    for (const [k, v] of Object.entries(byProjectFail).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${pad(String(v), 5)}  ${k}`);
    }
  }
}

function runPerProject() {
  const all = loadBatches().filter((b) => b.mode === 'commit');
  const perProject = new Map<string, { project: string; succeeded: number; attempted: number; distinct: Set<string>; batches: Set<string> }>();
  for (const b of all) {
    for (const r of b.results || []) {
      const proj = r.project ?? 'unknown';
      if (!perProject.has(proj)) perProject.set(proj, { project: proj, succeeded: 0, attempted: 0, distinct: new Set(), batches: new Set() });
      const project = perProject.get(proj);
      if (!project) continue;
      project.attempted += 1;
      if (r.manifest_path) project.distinct.add(r.manifest_path);
      project.batches.add(b.batch_id);
      if (r.events.some((event) => event.status === 'wrote')) project.succeeded += 1;
    }
  }
  const rows = [...perProject.values()].map((x) => ({
    project: x.project, succeeded: x.succeeded, attempted: x.attempted,
    distinct_bricks: x.distinct.size, batches: [...x.batches],
  })).sort((a, b) => b.succeeded - a.succeeded);
  if (args.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  console.log(`${pad('project', 24)} ${pad('succ', 6)} ${pad('attempted', 10)} ${pad('distinct', 9)} batches`);
  console.log('-'.repeat(80));
  for (const r of rows) console.log(`${pad(r.project, 24)} ${pad(String(r.succeeded), 6)} ${pad(String(r.attempted), 10)} ${pad(String(r.distinct_bricks), 9)} ${r.batches.length}`);
}

function runPerBatch() {
  const batches = loadBatches();
  if (args.json) { console.log(JSON.stringify(batches.map(({ _file, ...rest }) => rest), null, 2)); return; }
  console.log(`${pad('batch_id', 38)} ${pad('phase', 5)} ${pad('mode', 8)} ${pad('processed', 9)} ${pad('succ', 5)} ${pad('fail', 5)} ${pad('generated_at', 28)}`);
  console.log('-'.repeat(110));
  for (const b of batches) {
    console.log(`${pad(b.batch_id, 38)} ${pad(String(b.phase ?? '-'), 5)} ${pad(b.mode, 8)} ${pad(String(b.processed ?? 0), 9)} ${pad(String(b.succeeded ?? 0), 5)} ${pad(String(b.failure_count ?? 0), 5)} ${b.generated_at}`);
  }
}

function runFailures() {
  const failures = loadFailures();
  if (args.json) { console.log(JSON.stringify({ count: failures.length, failures }, null, 2)); return; }
  const top = Number(args.top ?? 10);
  const byReason: Record<string, number> = {}, byProject: Record<string, number> = {};
  for (const f of failures) {
    byReason[f.reason] = (byReason[f.reason] ?? 0) + 1;
    byProject[(f.brick || '').split('.')[0]] = (byProject[(f.brick || '').split('.')[0]] ?? 0) + 1;
  }
  console.log(`total failures: ${failures.length}`);
  console.log('');
  console.log(`by reason (top ${top}):`);
  for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`  ${pad(String(v), 5)}  ${k}`);
  console.log('');
  console.log(`by project (top ${top}):`);
  for (const [k, v] of Object.entries(byProject).sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`  ${pad(String(v), 5)}  ${k}`);
  if (failures.length) {
    console.log('');
    console.log('sample:');
    for (const f of failures.slice(0, 3)) console.log(`  ${f.brick}  ←  ${f.reason}`);
  }
}

function pad(s: string, n: number) { return String(s ?? '').slice(0, n).padEnd(n); }

type SummaryArgs = { out?: string; json?: boolean; includeDryRuns?: boolean; top?: string };

function parseArgs(list: string[]): SummaryArgs {
  const out: SummaryArgs = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_match: string, c: string) => c.toUpperCase());
    const next = list[i + 1];
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) {
      if (camel === 'json') out.json = true;
      if (camel === 'includeDryRuns') out.includeDryRuns = true;
      continue;
    }
    if (camel === 'out') out.out = next;
    if (camel === 'top') out.top = next;
    i += 1;
  }
  return out;
}
