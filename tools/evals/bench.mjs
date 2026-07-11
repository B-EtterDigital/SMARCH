#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const FIXTURE_ROOT = path.join(SCRIPT_DIR, "fixtures", "portfolio");
const SCANNER_PATH = path.join(REPO_ROOT, "tools", "sma-scan.ts");
const GRAPHIFY_PATH = path.join(REPO_ROOT, "tools", "sma-graphify.mjs");
const TARGET_FILE_COUNT = 10_000;
const HEADROOM_PERCENT = 20;
const HEADROOM_FACTOR = (100 + HEADROOM_PERCENT) / 100;
const OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

/** @typedef {{ id: string, label: string, unit: "ms" | "bytes", budget: number }} Budget */
/** @typedef {{ json: boolean, selftest: boolean, only: string | null }} BenchOptions */
/** @typedef {{ cwd?: string, env?: NodeJS.ProcessEnv, measureRss?: boolean, timeoutMs?: number }} CommandOptions */
/** @typedef {{ durationMs: number, peakRssBytes: number, stdout: string, stderr: string, slowdownMs: number }} CommandResult */
/** @typedef {{ id: string, label: string, unit: "ms" | "bytes", actual: number, budget: number, gate_limit: number, headroom_percent: number, passed: boolean } & Record<string, unknown>} GateResult */
/** @typedef {{ schema_version: number, benchmark: string, baseline: string, fixture_file_count: number, headroom_percent: number, started_at: string, finished_at: string, passed: boolean, results: GateResult[], selftest?: { passed: boolean, injected_slowdown_ms: number, injected_metric: string, negative_exit_code: number | null, quality_gates_exit_code: number | null } }} BenchReport */
/** @typedef {{ exitCode: number | null, stdout: string, stderr: string }} ChildResult */

/** @type {Record<string, Budget>} */
const BUDGETS = Object.freeze({
  scan: { id: "scan", label: "sma scan", unit: "ms", budget: 60_000 },
  graphifyRefresh: {
    id: "graphify-refresh",
    label: "graphify module refresh",
    unit: "ms",
    budget: 30_000,
  },
  graphifyQueryWarm: {
    id: "graphify-query-warm",
    label: "graphify warm query",
    unit: "ms",
    budget: 2_000,
  },
  check: { id: "check", label: "npm run check", unit: "ms", budget: 120_000 },
  scanRss: {
    id: "scan-peak-rss",
    label: "sma scan peak RSS",
    unit: "bytes",
    budget: 512 * 1024 * 1024,
  },
});

const ALL_BENCHMARK_IDS = new Set(Object.values(BUDGETS).map(({ id }) => id));

/** @param {string[]} argv @returns {BenchOptions} */
function parseArgs(argv) {
  /** @type {BenchOptions} */
  const options = { json: false, selftest: false, only: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--selftest") {
      options.selftest = true;
    } else if (arg === "--only" && next) {
      if (!ALL_BENCHMARK_IDS.has(next)) throw new Error(`Unknown benchmark: ${next}`);
      options.only = next;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`SMARCH performance budget gate

Usage:
  node tools/evals/bench.mjs [--json] [--only <benchmark>]
  node tools/evals/bench.mjs --selftest [--json]

Benchmarks: ${[...ALL_BENCHMARK_IDS].join(", ")}

The gate applies ${HEADROOM_PERCENT}% CI headroom around the published 07-PERFORMANCE-PLAN limits.
Set SMARCH_BENCH_INJECT_SLEEP_MS and SMARCH_BENCH_INJECT_SLEEP_METRIC to exercise
the failure path with an artificial slowdown.`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

/** @param {number} milliseconds */
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** @param {string} metricId */
function injectedSleep(metricId) {
  const milliseconds = Number(process.env.SMARCH_BENCH_INJECT_SLEEP_MS ?? 0);
  const selectedMetric = process.env.SMARCH_BENCH_INJECT_SLEEP_METRIC || "scan";
  return selectedMetric === metricId && Number.isFinite(milliseconds) && milliseconds > 0
    ? milliseconds
    : 0;
}

/** @param {string} current @param {Buffer | string} chunk @param {string} streamName */
function appendBounded(current, chunk, streamName) {
  const next = current + String(chunk);
  if (Buffer.byteLength(next) > OUTPUT_LIMIT_BYTES) {
    throw new Error(`${streamName} exceeded ${OUTPUT_LIMIT_BYTES} bytes`);
  }
  return next;
}

/** @param {number | undefined} pid */
function linuxRssBytes(pid) {
  if (process.platform !== "linux" || !pid) return 0;
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

/** @param {string} metricId @param {string} command @param {string[]} args @param {CommandOptions} [options] @returns {Promise<CommandResult>} */
async function runCommand(metricId, command, args, options = {}) {
  const startedAt = performance.now();
  const slowdownMs = injectedSleep(metricId);
  if (slowdownMs) await sleep(slowdownMs);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || REPO_ROOT,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let peakRssBytes = 0;
    let settled = false;

    const sampleRss = () => {
      peakRssBytes = Math.max(peakRssBytes, linuxRssBytes(child.pid));
    };
    sampleRss();
    const sampler = options.measureRss ? setInterval(sampleRss, 5) : null;
    sampler?.unref();

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs || 300_000);
    timeout.unref();

    child.stdout.on("data", (chunk) => {
      try {
        stdout = appendBounded(stdout, chunk, "stdout");
      } catch (error) {
        child.kill("SIGKILL");
        reject(error);
      }
    });
    child.stderr.on("data", (chunk) => {
      try {
        stderr = appendBounded(stderr, chunk, "stderr");
      } catch (error) {
        child.kill("SIGKILL");
        reject(error);
      }
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (sampler) clearInterval(sampler);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (sampler) clearInterval(sampler);
      sampleRss();
      const durationMs = performance.now() - startedAt;
      if (exitCode !== 0) {
        reject(new Error([
          `${metricId} command failed (exit ${exitCode ?? "null"}${signal ? `, signal ${signal}` : ""})`,
          stderr.trim(),
          stdout.trim(),
        ].filter(Boolean).join("\n")));
        return;
      }
      resolve({ durationMs, peakRssBytes, stdout, stderr, slowdownMs });
    });
  });
}

/** @param {string} root */
async function countFiles(root) {
  let count = 0;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    if (current === undefined) continue;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      else if (entry.isFile()) count += 1;
    }
  }
  return count;
}

/** @param {string} tempRoot */
async function prepareFixture(tempRoot) {
  const portfolioRoot = path.join(tempRoot, "portfolio");
  await fs.cp(FIXTURE_ROOT, portfolioRoot, { recursive: true });
  const currentFileCount = await countFiles(portfolioRoot);
  assert(currentFileCount <= TARGET_FILE_COUNT, "fixture portfolio already exceeds 10k files");

  const paddingRoot = path.join(portfolioRoot, ".bench-padding");
  await fs.mkdir(paddingRoot, { recursive: true });
  const paddingCount = TARGET_FILE_COUNT - currentFileCount;
  for (let start = 0; start < paddingCount; start += 250) {
    const end = Math.min(paddingCount, start + 250);
    await Promise.all(Array.from({ length: end - start }, (_, offset) => {
      const ordinal = String(start + offset).padStart(5, "0");
      return fs.writeFile(path.join(paddingRoot, `fixture-${ordinal}.txt`), "smarch-bench-fixture\n");
    }));
  }

  assert.equal(await countFiles(portfolioRoot), TARGET_FILE_COUNT);
  return portfolioRoot;
}

/** @param {Budget} budget @param {number} actual @param {Record<string, unknown>} [details] @returns {GateResult} */
function gateResult(budget, actual, details = {}) {
  const gateLimit = budget.budget * HEADROOM_FACTOR;
  return {
    id: budget.id,
    label: budget.label,
    unit: budget.unit,
    actual,
    budget: budget.budget,
    gate_limit: gateLimit,
    headroom_percent: HEADROOM_PERCENT,
    passed: actual < gateLimit,
    ...details,
  };
}

/** @param {BenchOptions} options @param {Budget} budget */
function selected(options, budget) {
  return !options.only || options.only === budget.id;
}

/** @param {BenchOptions} [options] @returns {Promise<BenchReport>} */
async function executeBench(options = { json: false, selftest: false, only: null }) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "smarch-perf-bench-"));
  const startedAt = new Date().toISOString();
    /** @type {GateResult[]} */
    const results = [];

  try {
    const portfolioRoot = await prepareFixture(tempRoot);
    const registryPath = path.join(tempRoot, "fixture.registry.json");
    const scanArgs = [
      SCANNER_PATH,
      "--root", portfolioRoot,
      "--out", registryPath,
      "--json",
    ];
    const scan = await runCommand(BUDGETS.scan.id, process.execPath, scanArgs, {
      measureRss: true,
      timeoutMs: BUDGETS.scan.budget * 2,
    });
    if (selected(options, BUDGETS.scan)) {
      results.push(gateResult(BUDGETS.scan, scan.durationMs, { injected_sleep_ms: scan.slowdownMs }));
    }
    if (selected(options, BUDGETS.scanRss)) {
      results.push(gateResult(BUDGETS.scanRss, scan.peakRssBytes));
    }

    const projectRoot = path.join(portfolioRoot, "acme-desktop");
    const moduleId = "acme-desktop.activity-feed";
    const graphArgs = [
      GRAPHIFY_PATH,
      "refresh",
      "--project-root", projectRoot,
      "--registry", registryPath,
      "--module", moduleId,
      "--no-cluster",
      "--quiet",
    ];
    const refresh = await runCommand(BUDGETS.graphifyRefresh.id, process.execPath, graphArgs, {
      timeoutMs: BUDGETS.graphifyRefresh.budget * 2,
    });
    if (selected(options, BUDGETS.graphifyRefresh)) {
      results.push(gateResult(BUDGETS.graphifyRefresh, refresh.durationMs, {
        injected_sleep_ms: refresh.slowdownMs,
      }));
    }

    const queryArgs = [
      GRAPHIFY_PATH,
      "query",
      "--project-root", projectRoot,
      "--registry", registryPath,
      "--module", moduleId,
      "--",
      "activity feed fixture token",
    ];
    await runCommand("graphify-query-warmup", process.execPath, queryArgs, {
      timeoutMs: BUDGETS.graphifyQueryWarm.budget * 4,
    });
    const query = await runCommand(BUDGETS.graphifyQueryWarm.id, process.execPath, queryArgs, {
      timeoutMs: BUDGETS.graphifyQueryWarm.budget * 4,
    });
    if (selected(options, BUDGETS.graphifyQueryWarm)) {
      results.push(gateResult(BUDGETS.graphifyQueryWarm, query.durationMs, {
        injected_sleep_ms: query.slowdownMs,
      }));
    }

    if (selected(options, BUDGETS.check)) {
      const check = await runCommand(BUDGETS.check.id, "npm", ["run", "check"], {
        timeoutMs: BUDGETS.check.budget * 2,
        env: { SMARCH_BENCH_CHILD: "1" },
      });
      results.push(gateResult(BUDGETS.check, check.durationMs, {
        injected_sleep_ms: check.slowdownMs,
      }));
    }

    return {
      schema_version: 1,
      benchmark: "07-performance-plan",
      baseline: "GitHub Actions ubuntu-latest (2 vCPU, 7 GB RAM)",
      fixture_file_count: TARGET_FILE_COUNT,
      headroom_percent: HEADROOM_PERCENT,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      passed: results.length > 0 && results.every((result) => result.passed),
      results,
    };
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

/** @param {string} script @param {string[]} args @param {NodeJS.ProcessEnv} [env] @returns {Promise<ChildResult>} */
function runNodeScript(script, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

/** @param {string[]} args @param {NodeJS.ProcessEnv} [env] */
function runChild(args, env = {}) {
  return runNodeScript(fileURLToPath(import.meta.url), args, env);
}

async function selftest() {
  const qualityGates = await runNodeScript(path.join(SCRIPT_DIR, "run.mjs"), ["--selftest"]);
  assert.equal(
    qualityGates.exitCode,
    0,
    `evaluation quality gates must pass:\n${qualityGates.stderr || qualityGates.stdout}`
  );

  const report = await executeBench();
  assert.equal(
    report.passed,
    true,
    `baseline performance bench must pass:\n${JSON.stringify(report.results, null, 2)}`,
  );
  assert.equal(report.fixture_file_count, TARGET_FILE_COUNT);
  assert.deepEqual(
    report.results.map(({ id }) => id),
    ["scan", "scan-peak-rss", "graphify-refresh", "graphify-query-warm", "check"],
  );

  const queryGateLimit = BUDGETS.graphifyQueryWarm.budget * HEADROOM_FACTOR;
  const negative = await runChild(["--json", "--only", BUDGETS.graphifyQueryWarm.id], {
    SMARCH_BENCH_INJECT_SLEEP_METRIC: BUDGETS.graphifyQueryWarm.id,
    SMARCH_BENCH_INJECT_SLEEP_MS: String(queryGateLimit + 250),
  });
  assert.equal(negative.exitCode, 1, `injected slowdown must fail the bench:\n${negative.stderr}`);
  const negativeReport = JSON.parse(negative.stdout);
  assert.equal(negativeReport.passed, false);
  assert.equal(negativeReport.results.length, 1);
  assert.equal(negativeReport.results[0].id, BUDGETS.graphifyQueryWarm.id);
  assert.equal(negativeReport.results[0].passed, false);

  return {
    ...report,
    selftest: {
      passed: true,
      injected_slowdown_ms: queryGateLimit + 250,
      injected_metric: BUDGETS.graphifyQueryWarm.id,
      negative_exit_code: negative.exitCode,
      quality_gates_exit_code: qualityGates.exitCode,
    },
  };
}

/** @param {number} value @param {"ms" | "bytes"} unit */
function formatValue(value, unit) {
  if (unit === "bytes") return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)} s`;
  return `${value.toFixed(1)} ms`;
}

/** @param {BenchReport} report */
function printHuman(report) {
  for (const result of report.results) {
    const marker = result.passed ? "PASS" : "FAIL";
    console.log(`${marker} ${result.label}: ${formatValue(result.actual, result.unit)} < ${formatValue(result.gate_limit, result.unit)} (${HEADROOM_PERCENT}% CI headroom)`);
  }
  if (report.selftest) {
    console.log(`PASS evaluation quality gates exited ${report.selftest.quality_gates_exit_code}`);
    console.log(`PASS injected slowdown failed ${report.selftest.injected_metric} with exit ${report.selftest.negative_exit_code}`);
  }
  console.log(`${report.passed ? "PASS" : "FAIL"} 07 performance plan (${report.fixture_file_count} fixture files)`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = options.selftest ? await selftest() : await executeBench(options);
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printHuman(report);
  return report.passed ? 0 : 1;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(`bench failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
