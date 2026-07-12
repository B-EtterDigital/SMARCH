import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const OUTPUT_LIMIT = 4_000;

/** @typedef {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, input?: string | Buffer }} RunOptions */
/** @typedef {{ command: string, status: number | null, signal: NodeJS.Signals | null, error: Error | undefined, stdout: string, stderr: string, durationMs: number }} RunResult */
/** @typedef {{ journey: string, success: boolean, durationMs: number, budgetMs: number, signal: string, threshold: string, details?: Record<string, unknown> }} TelemetryInput */
/** @typedef {{ journey: string, selftest?: boolean, repeats?: number, budgetMs: number, signal: string, threshold: string, runOnce: () => Promise<unknown> }} JourneyConfig */

/** @param {string} command @param {string[]} [args] @param {RunOptions} [options] @returns {RunResult} */
export function run(command, args = [], options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      npm_config_audit: "false",
      npm_config_fund: "false",
      ...options.env
    },
    encoding: "utf8",
    timeout: options.timeoutMs || 5 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
    input: options.input
  });
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    durationMs: Date.now() - started
  };
}

/** @param {RunResult} result */
export function outputOf(result) {
  return `${result.stdout}\n${result.stderr}`.trim();
}

/** @param {unknown} value */
function tail(value) {
  const text = String(value || "").trim();
  return text.length <= OUTPUT_LIMIT ? text : text.slice(-OUTPUT_LIMIT);
}

/** @param {RunResult} result @param {string} label @param {RegExp} [pattern] */
export function expectSuccess(result, label, pattern) {
  assert.equal(
    result.error,
    undefined,
    `${label} could not execute: ${result.error?.message || "unknown subprocess error"}`
  );
  assert.equal(result.status, 0, `${label} failed:\n${tail(outputOf(result))}`);
  if (pattern) assert.match(outputOf(result), pattern, `${label} omitted its user-visible success signal`);
}

/** @param {RunResult} result @param {string} label @param {RegExp} pattern */
export function expectFailure(result, label, pattern) {
  assert.equal(
    result.error,
    undefined,
    `${label} could not execute: ${result.error?.message || "unknown subprocess error"}`
  );
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  assert.match(outputOf(result), pattern, `${label} omitted its user-visible recovery signal`);
}

/** @template T @param {string} prefix @param {(root: string) => Promise<T>} callback @returns {Promise<T>} */
export async function withTemp(prefix, callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** @param {string} root */
export async function generateFixturePortfolio(root) {
  const portfolio = path.join(root, "portfolio");
  const result = run("node", ["tools/evals/fixtures/gen.mjs", "--out", portfolio]);
  expectSuccess(result, "fixture portfolio generation", /fixture|generated|portfolio/i);
  return portfolio;
}

/**
 * Clone is provenance-gated: the export guard blocks unless a license ledger
 * file exists (fail-closed). The real ledger is built by `npm run
 * provenance:ledger`, which needs a full scan absent on a fresh clone, so seed a
 * minimal one for the fixture clone. Every clone journey passes --allow-closed,
 * so a present ledger is sufficient. Never clobbers an operator's real ledger;
 * returns a cleanup that removes only a file this created.
 * @returns {Promise<() => Promise<void>>}
 */
export async function ensureFixtureLedger() {
  const ledger = path.join(REPO_ROOT, "registry", "license-ledger.generated.json");
  let created = false;
  try {
    await fs.access(ledger);
  } catch {
    await fs.writeFile(ledger, '{"licenses":[]}\n');
    created = true;
  }
  return async () => { if (created) await fs.rm(ledger, { force: true }); };
}

/** @param {TelemetryInput} input */
export function emitTelemetry({ journey, success, durationMs, budgetMs, signal, threshold, details = {} }) {
  const event = {
    event: "smarch.journey.health.v1",
    journey,
    success,
    duration_ms: durationMs,
    budget_ms: budgetMs,
    within_budget: durationMs <= budgetMs,
    signal,
    alert_threshold: threshold,
    ...details
  };
  console.log(`JOURNEY_TELEMETRY ${JSON.stringify(event)}`);
  return event;
}

/** @param {JourneyConfig} config */
export async function executeJourney({ journey, selftest, repeats = 3, budgetMs, signal, threshold, runOnce }) {
  const outcomes = [];
  const started = Date.now();
  const count = selftest ? repeats : 1;

  for (let index = 0; index < count; index += 1) {
    const outcome = await runOnce();
    outcomes.push(outcome);
    if (index > 0) {
      assert.deepEqual(outcome, outcomes[0], `${journey} produced a nondeterministic outcome on run ${index + 1}`);
    }
  }

  const durationMs = Date.now() - started;
  assert.ok(durationMs <= budgetMs, `${journey} exceeded ${budgetMs}ms budget (${durationMs}ms)`);
  emitTelemetry({
    journey,
    success: true,
    durationMs,
    budgetMs,
    signal,
    threshold,
    details: { runs: count, outcome: outcomes[0] }
  });
  console.log(`${journey} journey passed: ${count}/${count} deterministic run(s).`);
}

/** @param {string[]} argv */
export function parseJourneyArgs(argv) {
  let selftest = false;
  for (const arg of argv) {
    if (arg === "--selftest") selftest = true;
    else if (arg === "--help" || arg === "-h") return { help: true, selftest };
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { help: false, selftest };
}

/** @param {JourneyConfig} config */
export async function mainJourney(config) {
  const options = parseJourneyArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`${config.journey}\n\nUsage: node ${path.relative(REPO_ROOT, process.argv[1])} [--selftest]`);
    return;
  }
  try {
    await executeJourney({ ...config, selftest: options.selftest });
  } catch (error) {
    emitTelemetry({
      journey: config.journey,
      success: false,
      durationMs: 0,
      budgetMs: config.budgetMs,
      signal: config.signal,
      threshold: config.threshold,
      details: { error: error instanceof Error ? error.message : String(error) }
    });
    console.error(`${config.journey} journey failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exitCode = 1;
  }
}
