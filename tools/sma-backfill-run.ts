#!/usr/bin/env node
/**
 * WHAT: Executes a provenance backfill plan in bounded, resumable batches.
 * WHY: Historical attribution across many bricks must be reviewable, restartable, and dry-run safe.
 * HOW: Resolves source paths and commits, derives touch events, and records batch outcomes and failures.
 * INPUTS: A generated plan, phase and project filters, limits, resume data, and an explicit commit switch.
 * OUTPUTS: Batch reports, failure reports, indexes, and, in commit mode, manifest and context updates.
 * CALLERS: Backfill operators run this after reviewing the deterministic plan.
 * @example node tools/sma-backfill-run.ts --help
 */
/**
 * sma-backfill-run.ts — execute a backfill plan in batches.
 *
 * Reads:
 *   handoffs/backfill/plan.generated.json (the plan from sma-backfill-plan)
 *
 * Writes:
 *   handoffs/backfill/<phase>-<timestamp>.json           (run report)
 *   handoffs/backfill/<phase>-<timestamp>-failures.json  (skips, errors)
 *   handoffs/backfill/index.json                         (rolling index)
 *
 *   With --commit: also writes touch_event into each brick's
 *   module.sweetspot.json AND appends an agent-context event.
 *
 * Subcommands:
 *   run    --plan <path> [--phase <n>] [--limit <n>] [--commit]
 *          [--project <id>] [--resume <prev-report-path>]
 *          [--batch-id <label>] [--max-commits-per-brick 1]
 *
 *   status --plan <path>             → show how much is done across all reports
 *
 * Default is dry-run. --commit is required to actually write manifests.
 *
 * Per-brick flow:
 *   1. Resolve project absolute root
 *   2. git log -n <max-commits-per-brick> --pretty=%H -- <source_path>
 *   3. For each commit (most recent first), run sma-touch-backfill from-git
 *      with --intent-from-message --project <id> --commit <sha>
 *   4. Skip if commit already attested in the manifest's source_chain
 *   5. Record outcome
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolveBrickPath } from './lib/source-path-resolver.ts';
import { resolveProjectRoot as canonicalProjectRoot } from './lib/project-paths.ts';
import { SMA_ROOT } from "./lib/sma-paths.ts";



const HANDOFFS_DIR = resolve(SMA_ROOT, 'handoffs/backfill');
const TOUCH_TOOL = resolve(SMA_ROOT, 'tools/sma-touch-backfill.ts');

// Declared up here to avoid TDZ when referenced from lastCommits() invoked
// via the top-level dispatch switch below.
const SMARCH_COMMIT_PATTERN = /^chore\(smarch\):/i;

interface BackfillArgs {
  plan?: string;
  commit?: boolean;
  phase?: string;
  limit?: string;
  project?: string;
  resume?: string;
  batchId?: string;
  maxCommitsPerBrick?: string;
  maxTouchEventsPerBrick?: string;
}
interface BackfillReportSummary {
  batch_id: string;
  generated_at: string;
  mode: string;
  phase: number | null;
  processed: number;
  succeeded: number;
  failure_count: number;
}
interface BackfillIndex {
  batches: BackfillReportSummary[];
  totals: { processed: number; succeeded: number; failures: number };
}
interface BackfillBrick { id: string; project: string; manifest_path: string; source_paths?: string[]; composite_score?: number; phase?: number }
interface BackfillEvent { commit?: string; status: string; dry_run?: boolean; stderr?: string; existing?: number; max?: number }
interface BackfillResult { brick: string; project: string; manifest_path: string; composite_score?: number; events: BackfillEvent[] }
interface BackfillFailure { brick: string; reason: string; manifest_path?: string; source_path?: string; events?: BackfillEvent[] }
interface BackfillCounters { processed: number; succeeded: number; skippedAlreadyDone: number; skippedNoCommit: number; skippedAlreadyAttested: number }
interface BackfillContext {
  commit: boolean; batchId: string; maxCommitsPerBrick: number; maxEventsPerBrick: number; previouslyDone: Set<string>;
  results: BackfillResult[]; failures: BackfillFailure[]; counters: BackfillCounters;
}
interface BackfillRunMetadata { planPath: string; phase: number | null; candidateCount: number; commit: boolean; batchId: string }

const cmd = argv.at(2);
const args = parseArgs(argv.slice(3));

try {
  switch (cmd) {
    case 'run':
      runBackfill();
      break;
    case 'status':
      runStatus();
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
  console.error(`sma-backfill-run: ${err instanceof Error ? err.message : String(err)}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-backfill-run.ts run    --plan <path> [--phase <n>] [--limit <n>] [--commit]
                              [--project <id>] [--resume <prev-report-path>]
                              [--batch-id <label>] [--max-commits-per-brick 1]
                              [--max-touch-events-per-brick <n>]

  sma-backfill-run.ts status --plan <path>

Default is --dry-run. Use --commit to actually write manifests + context events.

--max-touch-events-per-brick caps the lifetime number of provenance entries
per brick (created_by + touched_by + reviewed_by). Once a brick reaches the
cap it's skipped until you bump the cap. Useful as a circuit-breaker on top
of the SMARCH-commit subject filter.
`);
}

// ── run ──────────────────────────────────────────────────────────────────────

function runBackfill() {
  requireArg('plan', '--plan');
  const planPath = resolve(String(args.plan));
  if (!existsSync(planPath)) throw new Error(`plan not found: ${planPath}`);
  const plan = readBackfillPlan(planPath);
  const commit = !!args.commit;
  const phase = args.phase ? Number(args.phase) : null;
  const limit = args.limit ? Number(args.limit) : null;
  const projectFilter = args.project ?? null;
  const maxCommitsPerBrick = Number(args.maxCommitsPerBrick ?? 1);
  const maxEventsPerBrick = args.maxTouchEventsPerBrick != null
    ? Number(args.maxTouchEventsPerBrick)
    : Infinity;
  const batchId = args.batchId ?? `phase-${String(phase ?? 'all')}-${nowStamp()}`;

  const previouslyDone = args.resume ? loadResume(resolve(args.resume)) : new Set<string>();

  const candidates = selectCandidates(plan, phase, projectFilter, limit);

  console.log(`[backfill] mode:      ${commit ? 'COMMIT' : 'dry-run'}`);
  console.log(`[backfill] plan:      ${planPath}`);
  console.log(`[backfill] phase:     ${String(phase ?? 'all')}`);
  console.log(`[backfill] candidates: ${String(candidates.length)}`);
  console.log(`[backfill] resume:    ${args.resume ? `${String(previouslyDone.size)} skipped` : 'no'}`);
  console.log(`[backfill] batch_id:  ${batchId}`);
  console.log('');

  if (!existsSync(HANDOFFS_DIR)) mkdirSync(HANDOFFS_DIR, { recursive: true });

  const context: BackfillContext = { commit, batchId, maxCommitsPerBrick, maxEventsPerBrick, previouslyDone,
    results: [], failures: [], counters: { processed: 0, succeeded: 0, skippedAlreadyDone: 0, skippedNoCommit: 0, skippedAlreadyAttested: 0 } };
  for (const brick of candidates) {
    processBackfillBrick(brick, context);
    printBackfillProgress(context, candidates.length);
  }
  finishBackfill(context, { planPath, phase, candidateCount: candidates.length, commit, batchId });
}

function selectCandidates(plan: BackfillBrick[], phase: number | null, project: string | null, limit: number | null) {
  let candidates = phase === null ? plan : plan.filter((brick) => brick.phase === phase);
  if (project) candidates = candidates.filter((brick) => brick.project === project);
  return limit === null ? candidates : candidates.slice(0, limit);
}

function finishBackfill(context: BackfillContext, metadata: BackfillRunMetadata) {
  const { results, failures, counters } = context;
  const { processed, succeeded, skippedAlreadyDone, skippedNoCommit, skippedAlreadyAttested } = counters;
  const reportPath = resolve(HANDOFFS_DIR, `${metadata.batchId}.json`);
  const failuresPath = resolve(HANDOFFS_DIR, `${metadata.batchId}-failures.json`);
  const report = {
    schema_version: '1.0.0',
    batch_id: metadata.batchId,
    generated_at: new Date().toISOString(),
    mode: metadata.commit ? 'commit' : 'dry-run',
    plan_path: metadata.planPath,
    phase: metadata.phase,
    candidate_count: metadata.candidateCount,
    processed,
    succeeded,
    skipped_already_done: skippedAlreadyDone,
    skipped_no_commit: skippedNoCommit,
    skipped_already_attested: skippedAlreadyAttested,
    failure_count: failures.length,
    results,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (failures.length) writeFileSync(failuresPath, JSON.stringify({ batch_id: metadata.batchId, failures }, null, 2) + '\n');

  updateIndex(report);

  console.log('');
  console.log(`[backfill] DONE`);
  console.log(`[backfill] processed:               ${String(processed)}`);
  console.log(`[backfill] succeeded:               ${String(succeeded)}`);
  console.log(`[backfill] skipped (already done):  ${String(skippedAlreadyDone)}`);
  console.log(`[backfill] skipped (no commit):     ${String(skippedNoCommit)}`);
  console.log(`[backfill] skipped (attested):      ${String(skippedAlreadyAttested)}`);
  console.log(`[backfill] failures:                ${String(failures.length)}`);
  console.log(`[backfill] report:                  ${reportPath}`);
  if (failures.length) console.log(`[backfill] failures detail:         ${failuresPath}`);
  if (!metadata.commit) {
    console.log('');
    console.log('Dry-run only. Re-run with --commit to write manifests and context events.');
  } else {
    console.log('');
    console.log('Suggested next step:');
    console.log(`  git add -A && git commit -m "chore(backfill): SMARCH context backfill ${metadata.batchId}"`);
  }
}

function processBackfillBrick(brick: BackfillBrick, context: BackfillContext) {
  if (context.previouslyDone.has(brick.id)) {
    context.counters.skippedAlreadyDone += 1;
    return;
  }
  context.counters.processed += 1;
  const projectRoot = resolveProjectRoot(brick.project);
  if (!projectRoot) {
    addFailure(context, brick, 'project-root-not-resolved');
    return;
  }
  if (!existsSync(brick.manifest_path)) {
    addFailure(context, brick, 'manifest-not-on-disk', { manifest_path: brick.manifest_path });
    return;
  }
  const gitPath = resolveBrickPath(brick, projectRoot)?.gitRelativePath ?? brick.source_paths?.[0];
  if (!gitPath) {
    addFailure(context, brick, 'no-source-path');
    return;
  }
  const commits = lastCommits(projectRoot, gitPath, context.maxCommitsPerBrick);
  if (commits.length === 0) {
    context.counters.skippedNoCommit += 1;
    addFailure(context, brick, 'no-git-history-for-source-path', { source_path: gitPath });
    return;
  }
  const existingEventCount = countTouchEvents(brick.manifest_path);
  if (Number.isFinite(context.maxEventsPerBrick) && existingEventCount >= context.maxEventsPerBrick) {
    context.results.push(backfillResult(brick, [{ status: 'skipped-max-events-reached', existing: existingEventCount, max: context.maxEventsPerBrick }]));
    return;
  }
  const events = processCommits(brick, projectRoot, commits, readAttestedCommits(brick.manifest_path), context);
  const ok = events.every((event) => event.status !== 'error');
  if (ok && events.some((event) => event.status === 'wrote' || event.status === 'would-backfill')) context.counters.succeeded += 1;
  if (!ok) addFailure(context, brick, 'touch-backfill-error', { events });
  context.results.push(backfillResult(brick, events));
}

function processCommits(brick: BackfillBrick, projectRoot: string, commits: string[], attested: Set<string>, context: BackfillContext) {
  const events: BackfillEvent[] = [];
  for (const sha of commits) {
    if (attested.has(sha)) {
      context.counters.skippedAlreadyAttested += 1;
      events.push({ commit: sha, status: 'skipped-already-attested' });
    } else if (!context.commit) {
      events.push({ commit: sha, status: 'would-backfill', dry_run: true });
    } else {
      events.push(runTouchBackfill(brick, projectRoot, sha, context.batchId));
    }
  }
  return events;
}

function runTouchBackfill(brick: BackfillBrick, projectRoot: string, sha: string, batchId: string): BackfillEvent {
  const command = [TOUCH_TOOL, 'from-git', '--manifest', brick.manifest_path, '--commit', sha, '--intent-from-message',
    '--project', brick.project, '--role', 'implementer'];
  const env = { ...process.env, SMA_BACKFILL_BATCH_ID: batchId };
  const result = spawnSync('node', command, { cwd: projectRoot, env, encoding: 'utf8' });
  return result.status === 0 ? { commit: sha, status: 'wrote' } : { commit: sha, status: 'error', stderr: result.stderr.slice(0, 500) };
}

function backfillResult(brick: BackfillBrick, events: BackfillEvent[]): BackfillResult {
  return { brick: brick.id, project: brick.project, manifest_path: brick.manifest_path, composite_score: brick.composite_score, events };
}

function addFailure(context: BackfillContext, brick: BackfillBrick, reason: string, detail: Partial<BackfillFailure> = {}) {
  context.failures.push({ brick: brick.id, reason, ...detail });
}

function printBackfillProgress(context: BackfillContext, candidateCount: number) {
  const { processed, succeeded } = context.counters;
  if (processed > 0 && processed % 25 === 0) {
    console.log(`[backfill] ${String(processed)}/${String(candidateCount)} processed (${String(succeeded)} succeeded, ${String(context.failures.length)} failed)`);
  }
}

// ── status ───────────────────────────────────────────────────────────────────

function runStatus() {
  requireArg('plan', '--plan');
  const indexPath = resolve(HANDOFFS_DIR, 'index.json');
  if (!existsSync(indexPath)) {
    console.log('(no index.json — no batches have run yet)');
    return;
  }
  const index = readBackfillIndex(indexPath);
  console.log(`batches:           ${String(index.batches.length)}`);
  console.log(`bricks attempted:  ${String(index.totals.processed)}`);
  console.log(`bricks succeeded:  ${String(index.totals.succeeded)}`);
  console.log(`failures recorded: ${String(index.totals.failures)}`);
  console.log('');
  console.log('history:');
  for (const b of index.batches.slice(-12)) {
    console.log(`  ${b.batch_id}  ${b.mode}  phase=${String(b.phase ?? '-')}  ok=${String(b.succeeded)}  fail=${String(b.failure_count)}  ${b.generated_at}`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Single source of truth — delegates to lib/project-paths.ts (which mirrors
// the portfolio override map). Local PROJECT_OVERRIDES const above is now
// unused but kept for reference.
function resolveProjectRoot(projectId: string|null|undefined) {
  return canonicalProjectRoot(projectId);
}

// Skip SMARCH's own backfill commits when picking attestations. Without this
// filter, every cycle re-attests the previous cycle's "chore(smarch): backfill
// context provenance" commits because they touch module.sweetspot.json files
// inside source directories, so `git log -- <source_dir>` returns them as
// most-recent. The runner becomes idempotent once we exclude them.
// (SMARCH_COMMIT_PATTERN is declared at the top of the file; see comment there.)

function lastCommits(cwd: string, sourcePath: string, n: number) {
  try {
    // Fetch more than n so we can filter SMARCH self-attestations and still
    // return n actual non-SMARCH commits when they exist deeper in history.
    const fetchCount = Math.max(n * 5, 10);
    const out = execFileSync('git',
      ['log', `-n`, String(fetchCount), '--pretty=%H%x09%s', '--', sourcePath],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const result: string[] = [];
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const tabIdx = trimmed.indexOf('\t');
      const sha = tabIdx > 0 ? trimmed.slice(0, tabIdx) : trimmed;
      const subject = tabIdx > 0 ? trimmed.slice(tabIdx + 1) : '';
      if (SMARCH_COMMIT_PATTERN.test(subject)) continue;
      result.push(sha);
      if (result.length >= n) break;
    }
    return result;
  } catch {
    return [];
  }
}

function readAttestedCommits(manifestPath: string) {
  const out = new Set<string>();
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const m = isRecord(parsed) ? parsed : {};
    const provenance = isRecord(m.provenance) ? m.provenance : {};
    const events = [
      provenance.created_by,
      ...safeArray(provenance.touched_by),
      ...safeArray(provenance.reviewed_by),
    ].filter(isRecord);
    for (const ev of events) {
      if (typeof ev.commit === 'string') out.add(ev.commit);
      const attestation = isRecord(ev.attestation) ? ev.attestation : null;
      if (attestation?.method === 'git_commit' && typeof attestation.reference === 'string') {
        out.add(attestation.reference);
      }
    }
  } catch { /* ignore */ }
  return out;
}

function countTouchEvents(manifestPath: string) {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const manifest = isRecord(parsed) ? parsed : {};
    const provenance = isRecord(manifest.provenance) ? manifest.provenance : {};
    const created = provenance.created_by ? 1 : 0;
    const touched = safeArray(provenance.touched_by).length;
    const reviewed = safeArray(provenance.reviewed_by).length;
    return created + touched + reviewed;
  } catch {
    return 0;
  }
}

function loadResume(path: string): Set<string> {
  if (!existsSync(path)) return new Set<string>();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const report = isRecord(parsed) ? parsed : {};
    const ids = safeArray(report.results).filter(isRecord)
      .filter((result) => safeArray(result.events).filter(isRecord).some((event) => event.status === 'wrote' || event.status === 'would-backfill'))
      .map((result) => result.brick)
      .filter((brick): brick is string => typeof brick === 'string');
    return new Set(ids);
  } catch {
    return new Set<string>();
  }
}

function updateIndex(report: BackfillReportSummary) {
  const indexPath = resolve(HANDOFFS_DIR, 'index.json');
  let index: BackfillIndex = { batches: [], totals: { processed: 0, succeeded: 0, failures: 0 } };
  if (existsSync(indexPath)) {
    try { index = readBackfillIndex(indexPath); }
    catch { /* keep default */ }
  }
  index.batches.push({
    batch_id: report.batch_id,
    generated_at: report.generated_at,
    mode: report.mode,
    phase: report.phase,
    processed: report.processed,
    succeeded: report.succeeded,
    failure_count: report.failure_count,
  });
  index.totals = {
    processed: index.totals.processed + report.processed,
    succeeded: index.totals.succeeded + report.succeeded,
    failures: index.totals.failures + report.failure_count,
  };
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
}

function readBackfillPlan(filePath: string): BackfillBrick[] {
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!isRecord(parsed) || !Array.isArray(parsed.bricks)) throw new Error(`invalid backfill plan: ${filePath}`);
  return parsed.bricks.map(parseBackfillBrick).filter((brick): brick is BackfillBrick => brick !== null);
}

function parseBackfillBrick(value: unknown): BackfillBrick | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.project !== 'string' || typeof value.manifest_path !== 'string') return null;
  return { id: value.id, project: value.project, manifest_path: value.manifest_path,
    source_paths: safeArray(value.source_paths).filter((item): item is string => typeof item === 'string'),
    composite_score: typeof value.composite_score === 'number' ? value.composite_score : undefined,
    phase: typeof value.phase === 'number' ? value.phase : undefined };
}

function readBackfillIndex(filePath: string): BackfillIndex {
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`invalid backfill index: ${filePath}`);
  const totals = isRecord(parsed.totals) ? parsed.totals : {};
  const batches = safeArray(parsed.batches).map(parseBatchSummary).filter((batch): batch is BackfillReportSummary => batch !== null);
  return { batches, totals: { processed: numeric(totals.processed), succeeded: numeric(totals.succeeded), failures: numeric(totals.failures) } };
}

function parseBatchSummary(value: unknown): BackfillReportSummary | null {
  if (!isRecord(value) || typeof value.batch_id !== 'string' || typeof value.generated_at !== 'string' || typeof value.mode !== 'string') return null;
  return { batch_id: value.batch_id, generated_at: value.generated_at, mode: value.mode,
    phase: typeof value.phase === 'number' ? value.phase : null, processed: numeric(value.processed), succeeded: numeric(value.succeeded),
    failure_count: numeric(value.failure_count) };
}

function numeric(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nowStamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getUTCFullYear())}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function requireArg(key: keyof BackfillArgs, flag: string) {
  if (args[key] === undefined || args[key] === '') {
    throw new Error(`missing ${flag}`);
  }
}

function parseArgs(list: string[]): BackfillArgs {
  const out: BackfillArgs = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_match: string, character: string) => character.toUpperCase());
    const next = list.at(i + 1);
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) {
      if (camel === 'commit') out.commit = true;
      continue;
    }
    if (camel === 'plan' || camel === 'phase' || camel === 'limit' || camel === 'project'
      || camel === 'resume' || camel === 'batchId' || camel === 'maxCommitsPerBrick'
      || camel === 'maxTouchEventsPerBrick') out[camel] = next;
    i += 1;
  }
  return out;
}
