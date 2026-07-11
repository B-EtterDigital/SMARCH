#!/usr/bin/env node
/**
 * WHAT: Measures SMARCH's strict-type, lint, dead-code, duplication, and library-coverage budgets.
 * WHY: Quality debt must only shrink, even while legacy debt is paid down incrementally.
 * HOW: Runs each native checker, normalizes its report, and compares it with a monotonic JSON ratchet.
 * INPUTS: tools/quality-ratchet.json and optional --update-ratchet or --selftest flags.
 * OUTPUTS: A compact metric summary and a non-zero exit when any ratchet budget regresses.
 * CALLERS: npm run gate:quality, npm run quality:ratchet, and the CI quality job.
 * Usage: `node tools/sma-quality-gate.mjs [--update-ratchet|--selftest]`
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(TOOL_PATH), "..");
const DEFAULT_RATCHET = resolve(ROOT, "tools/quality-ratchet.json");
const MAX_BUFFER = 64 * 1024 * 1024;
const METRICS = Object.freeze({
  ts_strict_errors: "max",
  eslint_errors: "max",
  knip_issues: "max",
  dup_pct: "max",
  lib_coverage_min: "min",
});

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) {
    runSelftest();
  } else {
    const ratchet = readRatchet(DEFAULT_RATCHET);
    const measured = measureQuality();
    const failures = compareMetrics(measured, ratchet);

    printSummary(measured, ratchet);
    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAIL ${failure}`);
      process.exitCode = 1;
    } else if (args.updateRatchet) {
      const updated = tightenRatchet(ratchet, measured);
      writeRatchet(DEFAULT_RATCHET, updated);
      console.log(`quality ratchet tightened: ${relativePath(DEFAULT_RATCHET)}`);
    } else {
      console.log("quality gate passed");
    }
  }
} catch (error) {
  const code = error?.code ?? "QUALITY_GATE_ERROR";
  console.error(`[${code}] ${error?.message ?? String(error)}`);
  process.exitCode = 2;
}

function parseArgs(values) {
  const known = new Set(["--selftest", "--update-ratchet"]);
  const unknown = values.filter((value) => !known.has(value));
  if (unknown.length > 0) {
    throw codedError("INVALID_ARGUMENT", `unknown argument(s): ${unknown.join(", ")}`);
  }
  if (values.includes("--selftest") && values.includes("--update-ratchet")) {
    throw codedError("INVALID_ARGUMENT", "--selftest and --update-ratchet are mutually exclusive");
  }
  return {
    selftest: values.includes("--selftest"),
    updateRatchet: values.includes("--update-ratchet"),
  };
}

function measureQuality() {
  const workspace = mkdtempSync(join(tmpdir(), "sma-quality-gate-"));
  try {
    return {
      ts_strict_errors: measureTypeScript(),
      eslint_errors: measureEslint(),
      knip_issues: measureKnip(),
      dup_pct: measureDuplication(workspace),
      lib_coverage_min: measureCoverage(workspace),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function measureTypeScript() {
  const result = runBin("tsc", ["-p", "tsconfig.strict.json", "--pretty", "false"]);
  const output = `${result.stdout}\n${result.stderr}`;
  const count = output.match(/\berror TS\d+:/g)?.length ?? 0;
  assertStatus("tsc", result, count > 0 ? [0, 2] : [0]);
  return count;
}

function measureEslint() {
  const result = runBin("eslint", [
    "--format",
    "json",
    "--no-error-on-unmatched-pattern",
    "tools/**/*.ts",
    "web/src/**/*.{ts,tsx}",
  ]);
  const report = parseJsonReport("eslint", result.stdout, result);
  assertStatus("eslint", result, [0, 1]);
  if (!Array.isArray(report)) throw codedError("ESLINT_REPORT_INVALID", "ESLint JSON report must be an array");
  return report.reduce((sum, file) => sum + numeric(file.errorCount, "ESLint errorCount"), 0);
}

function measureKnip() {
  const result = runBin("knip", [
    "--reporter",
    "json",
    "--no-exit-code",
    "--include",
    "dependencies,devDependencies,optionalPeerDependencies,unlisted,unresolved,binaries,catalog,exports,types,enumMembers,namespaceMembers,duplicates",
  ]);
  const report = parseJsonReport("knip", result.stdout, result);
  assertStatus("knip", result, [0]);
  if (!Array.isArray(report.issues)) throw codedError("KNIP_REPORT_INVALID", "Knip JSON report is missing issues[]");
  const issueKeys = [
    "dependencies",
    "devDependencies",
    "optionalPeerDependencies",
    "unlisted",
    "unresolved",
    "binaries",
    "catalog",
    "exports",
    "types",
    "enumMembers",
    "namespaceMembers",
    "duplicates",
  ];
  return report.issues.reduce(
    (total, issue) => total + issueKeys.reduce((sum, key) => sum + arrayLength(issue[key]), 0),
    0,
  );
}

function measureDuplication(workspace) {
  const outputDir = join(workspace, "jscpd");
  const result = runBin("jscpd", [
    "--silent",
    "--reporters",
    "json",
    "--output",
    outputDir,
    "--ignore",
    "**/fixtures/**",
    "tools",
  ]);
  assertStatus("jscpd", result, [0]);
  const reportPath = join(outputDir, "jscpd-report.json");
  if (!existsSync(reportPath)) throw codedError("JSCPD_REPORT_MISSING", `missing report: ${reportPath}`);
  const report = parseJsonText("jscpd", readFileSync(reportPath, "utf8"));
  return numeric(report?.statistics?.total?.percentage, "jscpd duplication percentage");
}

function measureCoverage(workspace) {
  const outputDir = join(workspace, "coverage");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = runBin("c8", [
    "--all",
    "--include=tools/lib/**/*.ts",
    "--exclude=tools/lib/**/*-selftest.ts",
    "--reporter=json-summary",
    `--reports-dir=${outputDir}`,
    npmCommand,
    "run",
    "provenance:selftest",
  ]);
  assertStatus("c8 provenance:selftest", result, [0]);
  const reportPath = join(outputDir, "coverage-summary.json");
  if (!existsSync(reportPath)) throw codedError("COVERAGE_REPORT_MISSING", `missing report: ${reportPath}`);
  const report = parseJsonText("c8", readFileSync(reportPath, "utf8"));
  return numeric(report?.total?.lines?.pct, "c8 line coverage percentage");
}

function runBin(name, commandArgs) {
  const executable = resolve(ROOT, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
  if (!existsSync(executable)) throw codedError("TOOL_NOT_INSTALLED", `${name} is not installed at ${executable}`);
  const result = spawnSync(executable, commandArgs, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    maxBuffer: MAX_BUFFER,
  });
  if (result.error) throw codedError("TOOL_EXEC_FAILED", `${name}: ${result.error.message}`);
  return result;
}

function assertStatus(label, result, allowedStatuses) {
  if (allowedStatuses.includes(result.status)) return;
  const detail = String(result.stderr || result.stdout || "no diagnostic output").trim().slice(0, 2_000);
  throw codedError("CHECKER_FAILED", `${label} exited ${result.status}: ${detail}`);
}

function parseJsonReport(label, text, result) {
  try {
    return parseJsonText(label, text);
  } catch (error) {
    const detail = String(result.stderr || "").trim().slice(0, 2_000);
    throw codedError(error.code, `${error.message}${detail ? `; stderr: ${detail}` : ""}`);
  }
}

function parseJsonText(label, text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw codedError("REPORT_PARSE_FAILED", `${label} did not emit valid JSON: ${error.message}`);
  }
}

function readRatchet(path) {
  if (!existsSync(path)) throw codedError("RATCHET_MISSING", `missing ratchet: ${path}`);
  const ratchet = parseJsonText("quality ratchet", readFileSync(path, "utf8"));
  for (const key of Object.keys(METRICS)) numeric(ratchet[key], `ratchet.${key}`);
  return ratchet;
}

function compareMetrics(measured, ratchet) {
  const failures = [];
  for (const [key, direction] of Object.entries(METRICS)) {
    const current = numeric(measured[key], `measured.${key}`);
    const budget = numeric(ratchet[key], `ratchet.${key}`);
    if (direction === "max" && current > budget) failures.push(`${key}: ${current} exceeds maximum ${budget}`);
    if (direction === "min" && current < budget) failures.push(`${key}: ${current} is below minimum ${budget}`);
  }
  return failures;
}

function tightenRatchet(ratchet, measured) {
  const updated = {};
  for (const [key, direction] of Object.entries(METRICS)) {
    updated[key] = direction === "max"
      ? Math.min(ratchet[key], measured[key])
      : Math.max(ratchet[key], measured[key]);
  }
  return updated;
}

function writeRatchet(path, ratchet) {
  writeFileSync(path, `${JSON.stringify(ratchet, null, 2)}\n`);
}

function printSummary(measured, ratchet) {
  for (const [key, direction] of Object.entries(METRICS)) {
    const comparator = direction === "max" ? "max" : "min";
    console.log(`${key}: ${measured[key]} (${comparator} ${ratchet[key]})`);
  }
}

function runSelftest() {
  const workspace = mkdtempSync(join(tmpdir(), "sma-quality-selftest-"));
  const ratchetPath = join(workspace, "ratchet.json");
  const baseline = {
    ts_strict_errors: 10,
    eslint_errors: 20,
    knip_issues: 30,
    dup_pct: 4,
    lib_coverage_min: 80,
  };
  try {
    writeRatchet(ratchetPath, baseline);
    const regression = { ...baseline, ts_strict_errors: 11 };
    assert.deepEqual(compareMetrics(regression, readRatchet(ratchetPath)), [
      "ts_strict_errors: 11 exceeds maximum 10",
    ]);
    assert.deepEqual(readRatchet(ratchetPath), baseline, "a regression must not mutate the ratchet");

    const improvement = {
      ts_strict_errors: 8,
      eslint_errors: 18,
      knip_issues: 25,
      dup_pct: 3.5,
      lib_coverage_min: 82,
    };
    assert.deepEqual(compareMetrics(improvement, baseline), []);
    writeRatchet(ratchetPath, tightenRatchet(baseline, improvement));
    assert.deepEqual(readRatchet(ratchetPath), improvement, "improvements must tighten every budget");

    const mixedRegression = { ...improvement, ts_strict_errors: 9, lib_coverage_min: 83 };
    assert.equal(compareMetrics(mixedRegression, readRatchet(ratchetPath)).length, 1);
    assert.deepEqual(readRatchet(ratchetPath), improvement, "mixed results must never loosen a budget");
    console.log("quality gate selftest passed: regressions fail; improvements tighten; budgets never loosen");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function numeric(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw codedError("INVALID_METRIC", `${label} must be a non-negative finite number`);
  }
  return value;
}

function relativePath(path) {
  return path.startsWith(`${ROOT}/`) ? path.slice(ROOT.length + 1) : path;
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
