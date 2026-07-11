#!/usr/bin/env node
/**
 * WHAT: Evaluates declared legal and safety controls against evidence present in a project checkout.
 * WHY: Release automation needs a repeatable [gate](../docs/GLOSSARY.md#gate) that exposes missing obligations instead of relying on manual recollection.
 * HOW: Reads the control catalog and project files, prints a scorecard or structured report, and returns stricter failures for release callers.
 * Usage: `node tools/sma-compliance-gate.mjs --root . --json`
 */
/**
 * sma-compliance.mjs — SMA pre-release compliance gate (EU GDPR + DSA + CSAM
 * Reg., Swiss nFADP).
 *
 * Evaluates the declarative control catalog (complianceControls.mjs) against the
 * repository and prints a COVERED / PARTIAL / MISSING scorecard with regulation
 * citations. Designed to run before every release:
 *
 *   node scripts/compliance/sma-compliance.mjs            # report
 *   node scripts/compliance/sma-compliance.mjs --gate     # fail if a blocker is missing
 *   node scripts/compliance/sma-compliance.mjs --strict   # fail if any required/blocker unmet
 *   node scripts/compliance/sma-compliance.mjs --json      # machine-readable
 *
 * Reusable: this file + complianceControls.mjs are project-agnostic. Drop them
 * into any SMA project and the gate enumerates every obligation from day one.
 */

import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rawArgs = process.argv.slice(2);
const argv = new Set(rawArgs);
const GATE = argv.has('--gate') || argv.has('--strict');
const STRICT = argv.has('--strict');
const JSON_OUT = argv.has('--json');

// --root <path> scans an external project (framework use). Without it, the gate
// self-detects the repo it lives in (in-project use). One portable checker.
function readRootArg() {
  const i = rawArgs.indexOf('--root');
  if (i >= 0 && rawArgs[i + 1]) return path.resolve(rawArgs[i + 1]);
  return null;
}

function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start, '..', '..');
}
const REPO_ROOT = readRootArg() ?? findRepoRoot(__dirname);

const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.sql', '.md', '.json', '.html', '.css']);
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out', '.turbo', 'release-worktrees']);

async function* walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.well-known') continue;
    if (SKIP_DIR.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else if (TEXT_EXT.has(path.extname(e.name))) {
      yield full;
    }
  }
}

// Build the repo context the control detectors run against.
async function buildContext() {
  // Index files under the dirs the controls reference (bounded for speed).
  const SEARCH_ROOTS = ['src', 'supabase', 'website', 'scripts', 'docs', 'legal'];
  const files = [];
  for (const root of SEARCH_ROOTS) {
    const abs = path.join(REPO_ROOT, root);
    if (!existsSync(abs)) continue;
    for await (const f of walk(abs)) files.push(f);
  }
  const cache = new Map();
  const readCached = (relOrAbs) => {
    const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(REPO_ROOT, relOrAbs);
    if (cache.has(abs)) return cache.get(abs);
    let text = '';
    try { text = readFileSync(abs, 'utf-8'); } catch { text = ''; }
    cache.set(abs, text);
    return text;
  };

  const applicationRoots = ['src', 'supabase', 'website', 'legal'].map((dir) => path.join(REPO_ROOT, dir));
  const applicationFileCount = files.filter((file) => applicationRoots.some((dir) => file.startsWith(`${dir}${path.sep}`))).length;
  const manifestCount = await countFiles(path.join(REPO_ROOT, 'builds'), (file) => file.endsWith('.build.sweetspot.json'));

  return {
    repoRoot: REPO_ROOT,
    applicationFileCount,
    manifestCount,
    fileExists: (rel) => existsSync(path.join(REPO_ROOT, rel)),
    readFile: (rel) => readCached(rel),
    hasScript: (name) => {
      try {
        const pkg = JSON.parse(readCached('package.json') || '{}');
        return Boolean(pkg.scripts && pkg.scripts[name]);
      } catch { return false; }
    },
    /** grep(dirs, regex) → [{ file, line }] across indexed text files under dirs.
     *  Test/spec files are excluded — they are not real implementations and
     *  would otherwise produce false "covered" results. */
    grep: (dirs, regex) => {
      const wantDirs = (Array.isArray(dirs) ? dirs : [dirs]).map((d) => path.join(REPO_ROOT, d));
      const hits = [];
      for (const f of files) {
        if (!wantDirs.some((d) => f.startsWith(d))) continue;
        if (/(__tests__|__mocks__)\/|\.test\.|\.spec\.|\.stories\./.test(f)) continue;
        const text = readCached(f);
        if (!text) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            hits.push({ file: path.relative(REPO_ROOT, f), line: lines[i].trim().slice(0, 160) });
            if (hits.length > 50) return hits;
          }
        }
      }
      return hits;
    },
  };
}

async function countFiles(dir, include) {
  let count = 0;
  if (!existsSync(dir)) return count;
  for await (const file of walk(dir)) if (include(file)) count += 1;
  return count;
}

const STATUS_ORDER = { missing: 0, partial: 1, covered: 2 };
const ICON = { covered: '✅', partial: '🟡', missing: '❌' };

async function main() {
  const ctx = await buildContext();
  if (ctx.applicationFileCount === 0 && ctx.manifestCount === 0) {
    const warning = 'nothing to check; run npm run scan to discover manifests, then rerun this gate';
    if (JSON_OUT) {
      console.log(JSON.stringify({
        status: 'warn',
        generatedFor: path.basename(REPO_ROOT),
        warning,
        summary: { total: 0, covered: 0, partial: 0, missing: 0, blockersMissing: 0, requiredUnmet: 0 },
        controls: [],
      }, null, 2));
    } else {
      console.log(`[compliance-gate] WARN — ${warning}`);
    }
    process.exitCode = 0;
    return;
  }

  const { COMPLIANCE_CONTROLS } = await import('./lib/compliance-controls.ts');

  /** @type {Array<{control: any, status: string, evidence?: string, note?: string}>} */
  const results = COMPLIANCE_CONTROLS.map((control) => {
    let r;
    try {
      r = control.detect(ctx) || { status: 'missing' };
    } catch (err) {
      r = { status: 'missing', note: `detector error: ${err.message}` };
    }
    return { control, ...r };
  });

  const blockersMissing = results.filter((r) => r.control.severity === 'blocker' && r.status !== 'covered');
  const requiredUnmet = results.filter((r) => r.control.severity === 'required' && r.status !== 'covered');

  if (JSON_OUT) {
    console.log(JSON.stringify({
      generatedFor: path.basename(REPO_ROOT),
      summary: {
        total: results.length,
        covered: results.filter((r) => r.status === 'covered').length,
        partial: results.filter((r) => r.status === 'partial').length,
        missing: results.filter((r) => r.status === 'missing').length,
        blockersMissing: blockersMissing.length,
        requiredUnmet: requiredUnmet.length,
      },
      controls: results.map((r) => ({
        id: r.control.id,
        regulation: r.control.regulation,
        title: r.control.title,
        severity: r.control.severity,
        status: r.status,
        evidence: r.evidence,
        note: r.note,
        remediation: r.status !== 'covered' ? r.control.remediation : undefined,
      })),
    }, null, 2));
  } else {
    console.log(`\n  SMA Compliance Gate — EU (GDPR · DSA · CSAM Reg.) + Swiss (nFADP)`);
    console.log(`  project: ${path.basename(REPO_ROOT)}\n`);
    const sorted = [...results].sort((a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.control.severity === 'blocker' ? -1 : 1));
    for (const r of sorted) {
      const sev = r.control.severity === 'blocker' ? 'BLOCKER ' : r.control.severity === 'required' ? 'required' : 'advisory';
      console.log(`  ${ICON[r.status]} [${sev}] ${r.control.id} — ${r.control.title}`);
      console.log(`        ${r.control.regulation.join(' · ')}`);
      if (r.evidence) console.log(`        evidence: ${r.evidence}`);
      if (r.note) console.log(`        note: ${r.note}`);
      if (r.status !== 'covered') console.log(`        → ${r.control.remediation}`);
    }
    const c = results.filter((r) => r.status === 'covered').length;
    console.log(`\n  ${c}/${results.length} controls covered · ${blockersMissing.length} blocker(s) unmet · ${requiredUnmet.length} required unmet`);
    if (blockersMissing.length) {
      console.log(`  RELEASE BLOCKED: ${blockersMissing.map((r) => r.control.id).join(', ')}`);
    }
  }

  if (GATE) {
    const failCount = STRICT ? blockersMissing.length + requiredUnmet.length : blockersMissing.length;
    process.exitCode = failCount > 0 ? 1 : 0;
  } else {
    process.exitCode = 0;
  }
}

main().catch((e) => {
  console.error('sma-compliance failed:', e);
  process.exit(2);
});
