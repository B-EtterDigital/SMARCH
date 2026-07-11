#!/usr/bin/env node
/**
 * WHAT: Executes a provenance backfill plan in bounded, resumable batches.
 * WHY: Historical attribution across many bricks must be reviewable, restartable, and dry-run safe.
 * HOW: Resolves source paths and commits, derives touch events, and records batch outcomes and failures.
 * INPUTS: A generated plan, phase and project filters, limits, resume data, and an explicit commit switch.
 * OUTPUTS: Batch reports, failure reports, indexes, and, in commit mode, manifest and context updates.
 * CALLERS: Backfill operators run this after reviewing the deterministic plan.
 * @example node tools/sma-backfill-run.mjs --help
 */
/**
 * sma-backfill-run.mjs — execute a backfill plan in batches.
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

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { argv, exit } from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolveBrickPath } from './lib/source-path-resolver.ts';
import { resolveProjectRoot as canonicalProjectRoot } from './lib/project-paths.ts';
import { PROJECTS_ROOT, SMA_ROOT } from "./lib/sma-paths.ts";



const HANDOFFS_DIR = resolve(SMA_ROOT, 'handoffs/backfill');
const TOUCH_TOOL = resolve(SMA_ROOT, 'tools/sma-touch-backfill.mjs');

const PROJECT_OVERRIDES = {
  'acme-desktop': 'acme-desktop',
  'acme-factory': 'acme-factory',
  'acme-studio': 'acme-studio-workspace/acme-studio',
  'acme-cms': 'acme-cms',
  'acme-travel': 'acme-travel',
  'acme-agent': 'acme-agent',
  'acme-mcc': 'ACME_MCC',
  'acme-agent-standalone': 'acme-agent-standalone',
  'acme-lab': 'workspace/acme-lab',
  'acme-cleaner': 'acme-cleaner/acme-cleaner',
  'acme-strudel': '000_acme-strudel',
};

// Declared up here to avoid TDZ when referenced from lastCommits() invoked
// via the top-level dispatch switch below.
const SMARCH_COMMIT_PATTERN = /^chore\(smarch\):/i;

const cmd = argv[2];
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
  console.error(`sma-backfill-run: ${err.message}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-backfill-run.mjs run    --plan <path> [--phase <n>] [--limit <n>] [--commit]
                              [--project <id>] [--resume <prev-report-path>]
                              [--batch-id <label>] [--max-commits-per-brick 1]
                              [--max-touch-events-per-brick <n>]

  sma-backfill-run.mjs status --plan <path>

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
  const planPath = resolve(args.plan);
  if (!existsSync(planPath)) throw new Error(`plan not found: ${planPath}`);
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  const commit = !!args.commit;
  const phase = args.phase ? Number(args.phase) : null;
  const limit = args.limit ? Number(args.limit) : null;
  const projectFilter = args.project ?? null;
  const maxCommitsPerBrick = Number(args.maxCommitsPerBrick ?? 1);
  const maxEventsPerBrick = args.maxTouchEventsPerBrick != null
    ? Number(args.maxTouchEventsPerBrick)
    : Infinity;
  const batchId = args.batchId ?? `phase-${phase ?? 'all'}-${nowStamp()}`;

  const previouslyDone = args.resume ? loadResume(resolve(args.resume)) : new Set();

  let candidates = plan.bricks ?? [];
  if (phase !== null) candidates = candidates.filter((b) => Number(b.phase) === phase);
  if (projectFilter) candidates = candidates.filter((b) => b.project === projectFilter);
  if (limit !== null) candidates = candidates.slice(0, limit);

  console.log(`[backfill] mode:      ${commit ? 'COMMIT' : 'dry-run'}`);
  console.log(`[backfill] plan:      ${planPath}`);
  console.log(`[backfill] phase:     ${phase ?? 'all'}`);
  console.log(`[backfill] candidates: ${candidates.length}`);
  console.log(`[backfill] resume:    ${args.resume ? `${previouslyDone.size} skipped` : 'no'}`);
  console.log(`[backfill] batch_id:  ${batchId}`);
  console.log('');

  if (!existsSync(HANDOFFS_DIR)) mkdirSync(HANDOFFS_DIR, { recursive: true });

  const results = [];
  const failures = [];
  let processed = 0;
  let succeeded = 0;
  let skippedAlreadyDone = 0;
  let skippedNoCommit = 0;
  let skippedAlreadyAttested = 0;

  for (const brick of candidates) {
    if (previouslyDone.has(brick.id)) {
      skippedAlreadyDone += 1;
      continue;
    }
    processed += 1;
    const projectAbs = resolveProjectRoot(brick.project);
    if (!projectAbs) {
      failures.push({ brick: brick.id, reason: 'project-root-not-resolved' });
      continue;
    }
    const manifestPath = brick.manifest_path;
    if (!manifestPath || !existsSync(manifestPath)) {
      failures.push({ brick: brick.id, reason: 'manifest-not-on-disk', manifest_path: manifestPath });
      continue;
    }

    // Resolve the brick's path on disk (manifest-derived, fallback to
    // source_paths[0] direct, then prefix-stripped). Use the resulting
    // git-relative path for git log.
    const resolved = resolveBrickPath(brick, projectAbs);
    const gitPath = resolved?.gitRelativePath || brick.source_paths?.[0];
    if (!gitPath) {
      failures.push({ brick: brick.id, reason: 'no-source-path' });
      continue;
    }

    const commits = lastCommits(projectAbs, gitPath, maxCommitsPerBrick);
    if (!commits.length) {
      skippedNoCommit += 1;
      failures.push({ brick: brick.id, reason: 'no-git-history-for-source-path', source_path: gitPath });
      continue;
    }

    const alreadyAttested = readAttestedCommits(manifestPath);
    const existingEventCount = countTouchEvents(manifestPath);
    if (Number.isFinite(maxEventsPerBrick) && existingEventCount >= maxEventsPerBrick) {
      results.push({
        brick: brick.id,
        project: brick.project,
        manifest_path: manifestPath,
        composite_score: brick.composite_score,
        events: [{ status: 'skipped-max-events-reached', existing: existingEventCount, max: maxEventsPerBrick }],
      });
      continue;
    }

    const perBrickEvents = [];
    for (const sha of commits) {
      if (alreadyAttested.has(sha)) {
        skippedAlreadyAttested += 1;
        perBrickEvents.push({ commit: sha, status: 'skipped-already-attested' });
        continue;
      }

      if (!commit) {
        // dry-run: just record what would happen
        perBrickEvents.push({ commit: sha, status: 'would-backfill', dry_run: true });
        continue;
      }

      // commit mode: invoke sma-touch-backfill
      const ranArgs = [
        TOUCH_TOOL, 'from-git',
        '--manifest', manifestPath,
        '--commit', sha,
        '--intent-from-message',
        '--project', brick.project,
        '--role', 'implementer',
      ];
      const env = { ...process.env, SMA_BACKFILL_BATCH_ID: batchId };
      const res = spawnSync('node', ranArgs, { cwd: projectAbs, env, encoding: 'utf8' });
      if (res.status === 0) {
        perBrickEvents.push({ commit: sha, status: 'wrote' });
      } else {
        perBrickEvents.push({ commit: sha, status: 'error', stderr: (res.stderr ?? '').slice(0, 500) });
      }
    }

    const ok = perBrickEvents.every((e) => e.status !== 'error');
    if (ok && perBrickEvents.some((e) => e.status === 'wrote' || e.status === 'would-backfill')) succeeded += 1;
    if (!ok) failures.push({ brick: brick.id, reason: 'touch-backfill-error', events: perBrickEvents });

    results.push({
      brick: brick.id,
      project: brick.project,
      manifest_path: manifestPath,
      composite_score: brick.composite_score,
      events: perBrickEvents,
    });

    if (processed % 25 === 0) {
      console.log(`[backfill] ${processed}/${candidates.length} processed (${succeeded} succeeded, ${failures.length} failed)`);
    }
  }

  const reportPath = resolve(HANDOFFS_DIR, `${batchId}.json`);
  const failuresPath = resolve(HANDOFFS_DIR, `${batchId}-failures.json`);
  const report = {
    schema_version: '1.0.0',
    batch_id: batchId,
    generated_at: new Date().toISOString(),
    mode: commit ? 'commit' : 'dry-run',
    plan_path: planPath,
    phase,
    candidate_count: candidates.length,
    processed,
    succeeded,
    skipped_already_done: skippedAlreadyDone,
    skipped_no_commit: skippedNoCommit,
    skipped_already_attested: skippedAlreadyAttested,
    failure_count: failures.length,
    results,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (failures.length) writeFileSync(failuresPath, JSON.stringify({ batch_id: batchId, failures }, null, 2) + '\n');

  updateIndex(report);

  console.log('');
  console.log(`[backfill] DONE`);
  console.log(`[backfill] processed:               ${processed}`);
  console.log(`[backfill] succeeded:               ${succeeded}`);
  console.log(`[backfill] skipped (already done):  ${skippedAlreadyDone}`);
  console.log(`[backfill] skipped (no commit):     ${skippedNoCommit}`);
  console.log(`[backfill] skipped (attested):      ${skippedAlreadyAttested}`);
  console.log(`[backfill] failures:                ${failures.length}`);
  console.log(`[backfill] report:                  ${reportPath}`);
  if (failures.length) console.log(`[backfill] failures detail:         ${failuresPath}`);
  if (!commit) {
    console.log('');
    console.log('Dry-run only. Re-run with --commit to write manifests and context events.');
  } else {
    console.log('');
    console.log('Suggested next step:');
    console.log(`  git add -A && git commit -m "chore(backfill): SMARCH context backfill ${batchId}"`);
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
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  console.log(`batches:           ${index.batches?.length ?? 0}`);
  console.log(`bricks attempted:  ${index.totals?.processed ?? 0}`);
  console.log(`bricks succeeded:  ${index.totals?.succeeded ?? 0}`);
  console.log(`failures recorded: ${index.totals?.failures ?? 0}`);
  console.log('');
  console.log('history:');
  for (const b of (index.batches ?? []).slice(-12)) {
    console.log(`  ${b.batch_id}  ${b.mode}  phase=${b.phase ?? '-'}  ok=${b.succeeded}  fail=${b.failure_count}  ${b.generated_at}`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

// Single source of truth — delegates to lib/project-paths.ts (which mirrors
// the portfolio override map). Local PROJECT_OVERRIDES const above is now
// unused but kept for reference.
function resolveProjectRoot(projectId) {
  return canonicalProjectRoot(projectId);
}

// Skip SMARCH's own backfill commits when picking attestations. Without this
// filter, every cycle re-attests the previous cycle's "chore(smarch): backfill
// context provenance" commits because they touch module.sweetspot.json files
// inside source directories, so `git log -- <source_dir>` returns them as
// most-recent. The runner becomes idempotent once we exclude them.
// (SMARCH_COMMIT_PATTERN is declared at the top of the file; see comment there.)

function lastCommits(cwd, sourcePath, n) {
  try {
    // Fetch more than n so we can filter SMARCH self-attestations and still
    // return n actual non-SMARCH commits when they exist deeper in history.
    const fetchCount = Math.max(n * 5, 10);
    const out = execFileSync('git',
      ['log', `-n`, String(fetchCount), '--pretty=%H%x09%s', '--', sourcePath],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const result = [];
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

function readAttestedCommits(manifestPath) {
  const out = new Set();
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const events = [
      m?.provenance?.created_by,
      ...(m?.provenance?.touched_by ?? []),
      ...(m?.provenance?.reviewed_by ?? []),
    ].filter(Boolean);
    for (const ev of events) {
      if (ev?.commit) out.add(ev.commit);
      if (ev?.attestation?.method === 'git_commit' && ev?.attestation?.reference) {
        out.add(ev.attestation.reference);
      }
    }
  } catch { /* ignore */ }
  return out;
}

function countTouchEvents(manifestPath) {
  try {
    const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const created = m?.provenance?.created_by ? 1 : 0;
    const touched = (m?.provenance?.touched_by ?? []).length;
    const reviewed = (m?.provenance?.reviewed_by ?? []).length;
    return created + touched + reviewed;
  } catch {
    return 0;
  }
}

function loadResume(path) {
  if (!existsSync(path)) return new Set();
  try {
    const r = JSON.parse(readFileSync(path, 'utf8'));
    const ids = (r.results ?? [])
      .filter((x) => x.events?.some((e) => e.status === 'wrote' || e.status === 'would-backfill'))
      .map((x) => x.brick);
    return new Set(ids);
  } catch {
    return new Set();
  }
}

function updateIndex(report) {
  const indexPath = resolve(HANDOFFS_DIR, 'index.json');
  let index = { batches: [], totals: { processed: 0, succeeded: 0, failures: 0 } };
  if (existsSync(indexPath)) {
    try { index = JSON.parse(readFileSync(indexPath, 'utf8')); }
    catch { /* keep default */ }
  }
  index.batches = index.batches ?? [];
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
    processed: (index.totals?.processed ?? 0) + report.processed,
    succeeded: (index.totals?.succeeded ?? 0) + report.succeeded,
    failures: (index.totals?.failures ?? 0) + report.failure_count,
  };
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function requireArg(key, flag) {
  if (args[key] === undefined || args[key] === null || args[key] === '') {
    throw new Error(`missing ${flag}`);
  }
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = list[i + 1];
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) {
      out[camel] = true;
      continue;
    }
    out[camel] = next;
    i += 1;
  }
  return out;
}
