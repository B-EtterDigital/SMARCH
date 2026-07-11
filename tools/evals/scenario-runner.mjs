#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dispatch } from '../lib/workforce/contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const SCENARIOS = path.join(HERE, 'scenarios');
const DEFAULT_TREND = path.join(HERE, 'results', 'trend.jsonl');

function parseArgs(argv) {
  const out = { backend: 'stub', scenario: '', matrix: false, selftest: false, trend: process.env.SMA_EVAL_TREND || DEFAULT_TREND };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i], next = argv[i + 1];
    if (arg === '--backend' && next) { out.backend = next; i += 1; }
    else if (arg === '--scenario' && next) { out.scenario = next; i += 1; }
    else if (arg === '--trend' && next) { out.trend = path.resolve(next); i += 1; }
    else if (arg === '--matrix') out.matrix = true;
    else if (arg === '--selftest') out.selftest = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return out;
}

function loadScenarios(selected = '') {
  return fs.readdirSync(SCENARIOS).filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(fs.readFileSync(path.join(SCENARIOS, name), 'utf8')))
    .filter((scenario) => !selected || scenario.id === selected);
}

function scoreScenario(scenario, cwd, gateResults) {
  const required = scenario.expected?.files_shape?.required || [];
  const forbidden = scenario.expected?.forbidden || [];
  const criteria = scenario.expected?.criteria || [];
  const gatesPassed = gateResults.every((gate) => gate.ok);
  const requiredPassed = required.every((file) => fs.existsSync(path.join(cwd, file)));
  const forbiddenPassed = forbidden.every((file) => !fs.existsSync(path.join(cwd, file)));
  const criteriaPassed = criteria.length === 0 || criteria.every((text) => text.length > 0);
  const score = (gatesPassed ? 40 : 0) + (requiredPassed && criteriaPassed ? 40 : 0) + (forbiddenPassed ? 20 : 0);
  return { score, gates_passed: gatesPassed, required_files_passed: requiredPassed, forbidden_surfaces_untouched: forbiddenPassed, criteria_declared: criteriaPassed };
}

function runGates(scenario, cwd) {
  return (scenario.expected?.gate_outcomes || []).map((gate) => {
    const command = typeof gate === 'string' ? gate : gate.command;
    const result = spawnSync('bash', ['-lc', command], { cwd, encoding: 'utf8', timeout: 120_000 });
    return { command, ok: result.status === 0, exit_code: result.status, output: `${result.stdout || ''}${result.stderr || ''}`.slice(-2000) };
  });
}

async function evaluate(scenario, options) {
  let cwd = ROOT;
  let worktree = '';
  try {
    if (options.backend !== 'stub') {
      worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'smarch-eval-'));
      fs.rmSync(worktree, { recursive: true, force: true });
      const add = spawnSync('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
      if (add.status !== 0) throw new Error(`failed to create eval worktree: ${add.stderr}`);
      cwd = worktree;
      const result = await dispatch(scenario.packet, { backend: options.backend, cwd, readOnly: false, timeoutMs: 900_000 });
      if (!result.ok) throw new Error(`workforce ${options.backend} failed: ${result.raw?.error || result.raw?.stderr || 'unknown error'}`);
    }
    const gates = runGates(scenario, cwd);
    const scored = scoreScenario(scenario, cwd, gates);
    return { schema: 'smarch.eval-result.v1', timestamp: new Date().toISOString(), scenario_id: scenario.id, skill: scenario.skill, backend: options.backend, ...scored, gates };
  } finally {
    if (worktree) spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: ROOT, encoding: 'utf8' });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.selftest) {
    options.backend = 'stub';
    options.scenario = 'sma-gen3-seeded';
    options.trend = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smarch-eval-trend-')), 'trend.jsonl');
  }
  const scenarios = loadScenarios(options.scenario);
  if (!scenarios.length) throw new Error('no matching eval scenarios');
  const results = [];
  for (const scenario of scenarios) results.push(await evaluate(scenario, options));
  fs.mkdirSync(path.dirname(options.trend), { recursive: true });
  fs.appendFileSync(options.trend, results.map((result) => JSON.stringify(result)).join('\n') + '\n');
  if (options.selftest) {
    assert.equal(results.length, 1);
    assert.equal(results[0].score, 100);
    assert.equal(fs.readFileSync(options.trend, 'utf8').trim().split(/\r?\n/).length, 1);
    fs.appendFileSync(options.trend, `${JSON.stringify(results[0])}\n`);
    assert.equal(fs.readFileSync(options.trend, 'utf8').trim().split(/\r?\n/).length, 2);
  }
  console.log(JSON.stringify({ ok: results.every((result) => result.score === 100), results, trend: options.trend }, null, 2));
  if (results.some((result) => result.score < 100)) process.exitCode = 4;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
