#!/usr/bin/env node
/**
 * WHAT: Rolls all persisted backfill batches and failures into operator-facing summaries.
 * WHY: Individual reports do not reveal portfolio progress, repeated failures, or project coverage.
 * HOW: Reads batch artifacts, aggregates counts by batch, project, and reason, then prints or writes results.
 * INPUTS: Backfill report directories plus a summary subcommand and optional output or display flags.
 * OUTPUTS: Console tables, structured data, or a generated summary file.
 * CALLERS: Backfill operators and controller reporting use this after one or more runs.
 * @example node tools/sma-backfill-summary.mjs --help
 */
/**
 * sma-backfill-summary.mjs — roll up every backfill batch report.
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
import { SMA_ROOT } from "./lib/sma-paths.mjs";


const HANDOFFS = resolve(SMA_ROOT, 'handoffs/backfill');
const DEFAULT_OUT = resolve(HANDOFFS, 'summary.generated.json');

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
  console.error(`sma-backfill-summary: ${err.message}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-backfill-summary.mjs summary [--out <path>] [--json] [--include-dry-runs]
  sma-backfill-summary.mjs per-project [--json]
  sma-backfill-summary.mjs per-batch [--json]
  sma-backfill-summary.mjs failures [--json] [--top 10]
`);
}

// ── data load ────────────────────────────────────────────────────────────────

function loadBatches() {
  if (!existsSync(HANDOFFS)) return [];
  const files = readdirSync(HANDOFFS)
    .filter((f) => /^phase-[0-9]/.test(f) && f.endsWith('.json') && !f.endsWith('-failures.json'));
  const batches = [];
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(resolve(HANDOFFS, f), 'utf8'));
      r._file = f;
      batches.push(r);
    } catch { /* skip malformed */ }
  }
  batches.sort((a, b) => (a.generated_at || '').localeCompare(b.generated_at || ''));
  return batches;
}

function loadFailures() {
  if (!existsSync(HANDOFFS)) return [];
  const files = readdirSync(HANDOFFS).filter((f) => f.endsWith('-failures.json'));
  const all = [];
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(resolve(HANDOFFS, f), 'utf8'));
      for (const x of r.failures || []) {
        all.push({ ...x, batch_id: r.batch_id });
      }
    } catch { /* skip */ }
  }
  return all;
}

// ── summary ──────────────────────────────────────────────────────────────────

function runSummary() {
  const includeDryRuns = !!args.includeDryRuns;
  const all = loadBatches();
  const batches = includeDryRuns ? all : all.filter((b) => b.mode === 'commit');
  const failures = loadFailures();

  const perProject = {};
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
  const distinctByProject = new Map();
  let totalProcessed = 0, totalSucceeded = 0, totalFailures = 0;
  for (const b of batches) {
    totalProcessed += b.processed ?? 0;
    totalSucceeded += b.succeeded ?? 0;
    totalFailures += b.failure_count ?? 0;
    for (const r of b.results || []) {
      const proj = r.project ?? 'unknown';
      if (!perProject[proj]) perProject[proj] = { project: proj, succeeded: 0, attempted: 0, distinct_bricks: 0, batches: new Set() };
      perProject[proj].attempted += 1;
      const wrote = (r.events || []).some((e) => e.status === 'wrote' || e.status === 'would-backfill');
      if (wrote) perProject[proj].succeeded += 1;
      perProject[proj].batches.add(b.batch_id);
      if (!distinctByProject.has(proj)) distinctByProject.set(proj, new Set());
      distinctByProject.get(proj).add(r.manifest_path);
    }
  }
  for (const [proj, set] of distinctByProject) {
    perProject[proj].distinct_bricks = set.size;
    perProject[proj].batches = [...perProject[proj].batches];
  }

  // failure analysis
  const byReason = {};
  const byProjectFail = {};
  for (const f of failures) {
    byReason[f.reason] = (byReason[f.reason] ?? 0) + 1;
    const proj = (f.brick || '').split('.')[0];
    byProjectFail[proj] = (byProjectFail[proj] ?? 0) + 1;
  }

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
    per_project: Object.values(perProject).sort((a, b) => b.succeeded - a.succeeded),
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
  const perProject = new Map();
  for (const b of all) {
    for (const r of b.results || []) {
      const proj = r.project ?? 'unknown';
      if (!perProject.has(proj)) perProject.set(proj, { project: proj, succeeded: 0, attempted: 0, distinct: new Set(), batches: new Set() });
      perProject.get(proj).attempted += 1;
      perProject.get(proj).distinct.add(r.manifest_path);
      perProject.get(proj).batches.add(b.batch_id);
      if ((r.events || []).some((e) => e.status === 'wrote')) perProject.get(proj).succeeded += 1;
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
  const byReason = {}, byProject = {};
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

function pad(s, n) { return String(s ?? '').slice(0, n).padEnd(n); }

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = list[i + 1];
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) { out[camel] = true; continue; }
    out[camel] = next;
    i += 1;
  }
  return out;
}
