#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, emitFailure, requireValue } from "../cli-contract.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOOL_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const OUTPUT_LIMIT = 16 * 1024 * 1024;

/** @typedef {{ id: string, script: string, args: string[] }} EvalCheck */
/** @typedef {{ json: boolean, quiet: boolean, verbose: boolean, selftest: boolean, only: string, help: boolean }} EvalOptions */
/** @typedef {{ status: number | null, stdout?: string, stderr?: string, error?: Error }} EvalSpawnResult */
/** @typedef {(command: string, args: string[], options: import("node:child_process").SpawnSyncOptionsWithStringEncoding) => EvalSpawnResult} EvalSpawn */
/** @typedef {{ spawnSync?: EvalSpawn }} EvalDependencies */

/** @type {EvalCheck[]} */
export const CHECKS = [
  { id: "fixture-snapshot", script: path.join(SCRIPT_DIR, "fixture-snapshot.mjs"), args: ["--selftest"] },
  { id: "lesson-curriculum", script: path.join(SCRIPT_DIR, "journeys", "lessons.mjs"), args: ["--selftest"] },
  { id: "plugin-clean-profile", script: path.join(REPO_ROOT, "tools", "sma-plugin-sync.mjs"), args: ["--check", "--selftest"] },
  { id: "skill-scenario-matrix", script: path.join(SCRIPT_DIR, "scenario-runner.mjs"), args: ["--selftest"] },
];

export function usage() {
  return `Run SMARCH evaluation quality gates.

Usage:
  sma evals-run [--only <check>] [--json] [--quiet | --verbose]
  sma evals-run --selftest [--json]

Checks: ${CHECKS.map((check) => check.id).join(", ")}

Examples:
  sma evals-run --json
  sma evals-run --only fixture-snapshot --verbose

Exit codes: 0 all pass; 2 usage; 4 evaluation failure; 1 runner failure.
Known limitation: checks execute serially and may take several minutes.`;
}

/** @param {string[]} argv @returns {EvalOptions} */
export function parseArgs(argv) {
  const options = { json: false, quiet: false, verbose: false, selftest: false, only: "", help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--only") { options.only = requireValue(argv, index, arg, "Run `sma evals-run --help`."); index += 1; }
    else if (arg === "--json") options.json = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--selftest") options.selftest = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new CliError("USAGE_ERROR", `Unknown option: ${arg}`, { exitCode: 2, nextCommand: "Run `sma evals-run --help`." });
  }
  if (options.only && !CHECKS.some((check) => check.id === options.only)) throw new CliError("USAGE_ERROR", `Unknown check: ${options.only}`, { exitCode: 2, nextCommand: "Run `sma evals-run --help` to list checks." });
  if (options.quiet && options.verbose) throw new CliError("USAGE_ERROR", "--quiet and --verbose cannot be combined.", { exitCode: 2, nextCommand: "Choose one output mode and retry." });
  return options;
}

/** @param {unknown} value @param {number} [limit] */
function tail(value, limit = 4_000) {
  const text = String(value || "").trim();
  return text.length <= limit ? text : text.slice(text.length - limit);
}

/** @param {EvalOptions} options @param {EvalDependencies} [dependencies] */
export function execute(options, dependencies = {}) {
  /** @type {EvalSpawn} */
  const spawn = dependencies.spawnSync || spawnSync;
  const checks = options.only ? CHECKS.filter((check) => check.id === options.only) : CHECKS;
  const results = [];
  for (const check of checks) {
    const forced = process.env.SMARCH_EVALS_FORCE_FAILURE === check.id;
    const result = forced
      ? { status: 9, stdout: "", stderr: "forced evaluation failure", error: null }
      : spawn(process.execPath, [check.script, ...check.args], { cwd: REPO_ROOT, env: { ...process.env, CI: "1", NO_COLOR: "1" }, encoding: "utf8", timeout: 10 * 60 * 1000, maxBuffer: OUTPUT_LIMIT });
    const passed = !result.error && result.status === 0;
    const details = tail([result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n"));
    results.push({ id: check.id, status: passed ? "passed" : "failed", exit_code: result.status ?? null, ...(passed ? {} : { details }) });
    if (options.verbose && details) process.stderr.write(`evals-run ${check.id}:\n${details}\n`);
  }
  return { ok: results.every((result) => result.status === "passed"), checks: results, passed: results.filter((result) => result.status === "passed").length, total: results.length };
}

/** @param {string[]} argv @param {EvalDependencies} [dependencies] */
export function run(argv, dependencies = {}) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) { process.stdout.write(`${usage()}\n`); return 0; }
    const report = execute(options, dependencies);
    if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else if (!options.quiet) {
      for (const result of report.checks) process.stdout.write(`${result.status === "passed" ? "PASS" : "FAIL"} ${result.id}\n`);
      process.stdout.write(`${report.ok ? "PASS" : "FAIL"} evaluation quality gates (${report.passed}/${report.total})\n`);
    }
    if (!report.ok) {
      const failed = report.checks.filter((result) => result.status === "failed").map((result) => result.id);
      return emitFailure("evals-run", new CliError("EVALUATION_FAILED", `Evaluation checks failed: ${failed.join(", ")}`, { exitCode: 4, nextCommand: `Run \`sma evals-run --only ${failed[0]} --verbose\`.` }), { failed_checks: failed });
    }
    return 0;
  } catch (error) {
    return emitFailure("evals-run", error, { only: options?.only || null });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === TOOL_PATH) process.exitCode = run(process.argv.slice(2));
