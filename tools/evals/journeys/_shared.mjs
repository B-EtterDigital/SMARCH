import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const OUTPUT_LIMIT = 4_000;

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

export function outputOf(result) {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function tail(value) {
  const text = String(value || "").trim();
  return text.length <= OUTPUT_LIMIT ? text : text.slice(-OUTPUT_LIMIT);
}

export function expectSuccess(result, label, pattern) {
  assert.equal(
    result.error,
    undefined,
    `${label} could not execute: ${result.error?.message || "unknown subprocess error"}`
  );
  assert.equal(result.status, 0, `${label} failed:\n${tail(outputOf(result))}`);
  if (pattern) assert.match(outputOf(result), pattern, `${label} omitted its user-visible success signal`);
}

export function expectFailure(result, label, pattern) {
  assert.equal(
    result.error,
    undefined,
    `${label} could not execute: ${result.error?.message || "unknown subprocess error"}`
  );
  assert.notEqual(result.status, 0, `${label} unexpectedly succeeded`);
  assert.match(outputOf(result), pattern, `${label} omitted its user-visible recovery signal`);
}

export async function withTemp(prefix, callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

export async function generateFixturePortfolio(root) {
  const portfolio = path.join(root, "portfolio");
  const result = run("node", ["tools/evals/fixtures/gen.mjs", "--out", portfolio]);
  expectSuccess(result, "fixture portfolio generation", /fixture|generated|portfolio/i);
  return portfolio;
}

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

export function parseJourneyArgs(argv) {
  let selftest = false;
  for (const arg of argv) {
    if (arg === "--selftest") selftest = true;
    else if (arg === "--help" || arg === "-h") return { help: true, selftest };
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { help: false, selftest };
}

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
