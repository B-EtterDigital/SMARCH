#!/usr/bin/env node
/**
 * What: Plans and records how a source-brick release reaches its known dependents.
 * Why: Locked imports and intentional forks need different updates or they silently drift.
 * How: Reads the dependents index and release data, then writes reports, plans, or review stubs.
 * Callers: Release operators run it after a source brick version changes.
 * Example: `node tools/sma-propagate.ts --help`
 */
/**
 * sma-propagate.ts — push-side fan-out when a source brick is upgraded.
 *
 * Pipeline:
 *   1. Read ~/DEV/SMARCH/registry/dependents.generated.json (built by
 *      sma-dependents-index.ts).
 *   2. For the given --source-brick (or all bricks with a release artifact since
 *      <since-commit>), enumerate dependents.
 *   3. For each dependent that has a formal .smarch/import-lock.json, run the
 *      existing tools/sma-update-plan.ts to produce a per-target update plan.
 *   4. For each dependent that only has a reuse-receipt (informal copy), produce
 *      a "manual review" diff hint: which files in target diverge from current
 *      source HEAD; flagged for human/agent decision.
 *   5. Write a fan-out report to ~/DEV/SMARCH/registry/propagation/<brick>/<ts>.json
 *      and per-target stub files at <target>/.smarch/incoming-updates/<brick>-<ts>.json.
 *
 * Default is dry-run: produces the report but does not modify any target. Use
 * --apply only on dependents that are formally locked (kind=import-lock); never
 * on reuse-receipt dependents (those are explicit forks by intent).
 *
 * Use:
 *   node tools/sma-propagate.ts --source-brick <id> [--release <path>] [--apply]
 *   node tools/sma-propagate.ts --since <git-sha> --source-project acme-desktop
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { argv, exit } from 'node:process';
import { PROJECTS_ROOT, SMA_ROOT, smaPath } from "./lib/sma-paths.ts";


const DEPENDENTS_INDEX = join(SMA_ROOT, 'registry/dependents.generated.json');

const args = parseArgs(argv.slice(2));
if (args.help || (!args.sourceBrick && !args.since)) {
  console.log(`Usage:
  sma-propagate.ts --source-brick <id> [--release <path>] [--apply] [--json]
  sma-propagate.ts --since <git-sha> --source-project <id> [--release <path>]

  --source-brick <id>     Brick id whose update should fan out. Required (or --since).
  --since <sha>           Run propagation for every brick whose source files
                          changed since this commit in --source-project.
  --release <path>        Release artifact to propagate. Defaults to latest in
                          ~/DEV/SMARCH/releases/<brick>/.
  --apply                 Actually run sma-update-plan against each formally-locked
                          target (writes plan files). Reuse-receipt dependents are
                          NEVER auto-applied; they require human/agent review.
  --apply-pr              Reserved: open draft PRs in dependent repos. Not implemented.
  --json                  Machine output.

Reads:  ~/DEV/SMARCH/registry/dependents.generated.json
Writes: ~/DEV/SMARCH/registry/propagation/<brick>/<ts>.json (fan-out report)
        <target_root>/.smarch/incoming-updates/<brick>-<ts>.json  (per dependent)
`);
  exit(args.help ? 0 : 2);
}

if (!existsSync(DEPENDENTS_INDEX)) {
  console.error(`Dependents index missing — run: node tools/sma-dependents-index.ts --write`);
  exit(1);
}
const index = JSON.parse(readFileSync(DEPENDENTS_INDEX, 'utf8'));

const targetBricks = args.sourceBrick
  ? [args.sourceBrick]
  : enumerateBricksSince(args.since, args.sourceProject);

const reports = [];
const ts = new Date().toISOString().replace(/[:.]/g, '-');

for (const brickId of targetBricks) {
  const sourceMeta = index.sources[brickId];
  const links = index.dependents[brickId] ?? [];
  const report: Record<string, any> = {
    schema_version: '1.0.0',
    generated_at: new Date().toISOString(),
    source_brick_id: brickId,
    source_meta: sourceMeta,
    release_artifact: args.release,
    dependent_count: links.length,
    fan_out: [],
  };

  if (links.length === 0) {
    console.log(`[${brickId}] no dependents recorded`);
    reports.push(report);
    continue;
  }

  for (const l of links) {
    const item = {
      target_project: l.target_project,
      target_root: l.target_root,
      target_path: l.target_path,
      evidence_kind: l.evidence_kind,
      action: 'review',
      plan_path: null,
      stub_path: null,
      notes: [],
    };

    // Formal lock → run sma-update-plan
    if (l.evidence_kind === 'import-lock') {
      item.action = args.apply ? 'plan-written' : 'plan-dry-run';
      const planArgs = [smaPath('tools/sma-update-plan.ts'), '--target', l.target_root];
      if (args.release) planArgs.push('--release', args.release);
      planArgs.push('--artifact-id', brickId);
      if (args.apply) {
        const planOut = join(l.target_root, '.smarch', `update-plan-${brickId.replace(/[^\w]/g, '-')}-${ts}.json`);
        if (!existsSync(dirname(planOut))) mkdirSync(dirname(planOut), { recursive: true });
        planArgs.push('--out', planOut);
        const r = spawnSync('node', planArgs, { encoding: 'utf8' });
        if (r.status === 0) item.plan_path = planOut;
        else item.notes.push(`update-plan exited ${r.status}: ${(r.stderr || '').slice(0, 200)}`);
      } else {
        planArgs.push('--stdout', '--dry-run');
        item.notes.push(`would run: ${planArgs.join(' ')}`);
      }
    }

    // Reuse-receipt or source-chain → soft notification
    if (l.evidence_kind === 'reuse-receipt' || l.evidence_kind === 'provenance-source-chain') {
      item.action = 'notify-only';
      item.notes.push(
        'Dependent is a manual fork (no import-lock). Auto-apply forbidden — open backlog entry to review upstream changes manually.',
      );
    }

    // Always drop a stub at <target>/.smarch/incoming-updates/<brick>-<ts>.json so the
    // dependent project's next agent picks it up.
    const incomingDir = join(l.target_root, '.smarch/incoming-updates');
    const stubPath = join(incomingDir, `${brickId.replace(/[^\w]/g, '-')}-${ts}.json`);
    if (args.apply) {
      if (!existsSync(incomingDir)) mkdirSync(incomingDir, { recursive: true });
      writeFileSync(stubPath, JSON.stringify({
        schema_version: '1.0.0',
        notification_kind: 'incoming-update',
        source_brick_id: brickId,
        source_project: sourceMeta?.source_project,
        source_latest_version: sourceMeta?.latest_version,
        release_artifact: args.release ?? null,
        suggested_action: l.evidence_kind === 'import-lock'
          ? 'run sma-update-plan and review the plan'
          : 'manual review: this is a fork. compare diff against source HEAD and decide whether to upstream-track.',
        target_path: l.target_path,
        evidence_kind: l.evidence_kind,
        emitted_at: new Date().toISOString(),
      }, null, 2));
      item.stub_path = stubPath;
    } else {
      item.notes.push(`would write stub: ${stubPath}`);
    }

    report.fan_out.push(item);
  }

  // Persist the fan-out report
  const reportDir = join(SMA_ROOT, 'registry/propagation', brickId.replace(/[^\w]/g, '-'));
  const reportPath = join(reportDir, `${ts}.json`);
  if (args.apply) {
    if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`[${brickId}] wrote fan-out report: ${reportPath}`);
  } else {
    console.log(`[${brickId}] dry-run — ${report.dependent_count} dependent(s)`);
    for (const fo of report.fan_out) {
      console.log(`  - ${fo.target_project}  [${fo.evidence_kind}]  → ${fo.action}`);
    }
  }
  reports.push(report);
}

if (args.json) console.log(JSON.stringify(reports, null, 2));

function enumerateBricksSince(since, sourceProject) {
  if (!sourceProject) {
    console.error('--since requires --source-project');
    exit(2);
  }
  const projectDir = join(PROJECTS_ROOT, sourceProject);
  try {
    const out = execSync(`git -C "${projectDir}" diff --name-only ${since}..HEAD`, { encoding: 'utf8' });
    const changedFiles = out.split('\n').filter(Boolean);
    const bricks = new Set();
    for (const id of Object.keys(index.sources)) {
      const meta = index.sources[id];
      if (meta.source_project !== sourceProject || !meta.source_path) continue;
      if (changedFiles.some((f) => f.startsWith(meta.source_path))) bricks.add(id);
    }
    return [...bricks];
  } catch (e) {
    console.error(`git diff failed: ${e.message}`);
    return [];
  }
}

function parseArgs(argv): Record<string, any> {
  const out: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source-brick') out.sourceBrick = argv[++i];
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--source-project') out.sourceProject = argv[++i];
    else if (a === '--release') out.release = argv[++i];
    else if (a === '--apply') out.apply = true;
    else if (a === '--apply-pr') out.applyPr = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}
