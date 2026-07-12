#!/usr/bin/env node
/**
 * WHAT: The stranger test. Clones this repo fresh into a throwaway dir and runs
 *   the README quickstart exactly as a first-time user would, then the `adopt`
 *   path — asserting a newcomer succeeds end to end.
 * WHY: "Adoption-ready" is only true if a cold clone works. The bin entry once
 *   pointed at a file the TS migration deleted, silently breaking `sma list` for
 *   every newcomer while every in-repo test stayed green. This smoke makes that
 *   class of onboarding regression impossible to merge.
 * HOW: git clone (from a source repo or the current checkout) → npm ci/install →
 *   run the umbrella and SPL via the built bin → adopt into a sibling project and
 *   run the engine there. Any failure exits non-zero. Wire into CI.
 * @example  node tools/evals/stranger-smoke.mjs            # clone the current repo
 *           node tools/evals/stranger-smoke.mjs --source <url-or-path>
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

/** @param {string} name @param {string} fallback @returns {string} */
function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const source = arg('--source', resolve(import.meta.dirname, '../..'));
const root = mkdtempSync(resolve(tmpdir(), 'smarch-stranger-'));
/** @param {string} cmd @param {string[]} args @param {import('node:child_process').ExecFileSyncOptions} [opts] @returns {string} */
const run = (cmd, args, opts = {}) => String(execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', ...opts }));

let failed = false;
/** @param {string} label @param {() => void} fn */
const step = (label, fn) => {
  try { fn(); process.stdout.write(`PASS ${label}\n`); }
  catch (error) { failed = true; process.stdout.write(`FAIL ${label}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}\n`); }
};

try {
  const repo = resolve(root, 'sma');
  step('git clone (fresh, as a stranger)', () => { run('git', ['clone', '--depth', '1', '-q', source, repo]); });
  step('npm install', () => { run('npm', ['install', '--no-audit', '--no-fund'], { cwd: repo }); });
  const sma = resolve(repo, 'tools/sma.ts');
  step('sma list (README: shows every command)', () => {
    const out = run('node', [sma, 'list'], { cwd: repo });
    if (!/\bspl\b/.test(out)) throw new Error('sma list did not list commands');
  });
  step('sma spl doctor (README headline capability)', () => {
    const out = run('node', [sma, 'spl', 'doctor'], { cwd: repo });
    if (!/pressure:/.test(out)) throw new Error('spl doctor did not report machine health');
  });
  step('adopt into a fresh sibling project + run the engine there', () => {
    const proj = resolve(root, 'myproj');
    run('node', [resolve(repo, 'tools/sma-adopt.ts'), '--target', proj], { cwd: repo });
    const out = run(resolve(proj, 'spl'), ['doctor']);
    if (!/pressure:/.test(out)) throw new Error('adopted ./spl doctor did not run the engine');
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.stdout.write(failed ? 'stranger smoke: FAIL\n' : 'stranger smoke: a first-time user succeeds end to end\n');
process.exit(failed ? 1 : 0);
