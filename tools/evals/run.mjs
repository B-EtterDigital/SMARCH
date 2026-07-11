#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const OUTPUT_LIMIT = 16 * 1024 * 1024;

const SELFTESTS = [
  {
    id: "fixture-snapshot",
    script: path.join(SCRIPT_DIR, "fixtures", "gen.mjs"),
    args: ["--selftest"]
  },
  {
    id: "lesson-curriculum",
    script: path.join(SCRIPT_DIR, "journeys", "lessons.mjs"),
    args: ["--selftest"]
  },
  {
    id: "plugin-clean-profile",
    script: path.join(REPO_ROOT, "tools", "sma-plugin-sync.mjs"),
    args: ["--check", "--selftest"]
  }
];

function usage() {
  console.log(`SMARCH evaluation quality gates

Usage:
  node tools/evals/run.mjs --selftest
`);
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--selftest") return;
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    usage();
    process.exit(0);
  }
  throw new Error("Expected exactly --selftest");
}

function tail(value, limit = 4_000) {
  const text = String(value || "").trim();
  return text.length <= limit ? text : text.slice(text.length - limit);
}

function runSelftest(check) {
  const result = spawnSync(process.execPath, [check.script, ...check.args], {
    cwd: REPO_ROOT,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 10 * 60 * 1000,
    maxBuffer: OUTPUT_LIMIT
  });

  if (result.error || result.status !== 0) {
    const details = tail([result.stdout, result.stderr, result.error?.message].filter(Boolean).join("\n"));
    throw new Error(`${check.id} failed with exit ${result.status ?? "spawn-error"}${details ? `:\n${details}` : ""}`);
  }

  console.log(`PASS ${check.id}`);
}

try {
  parseArgs(process.argv.slice(2));
  for (const check of SELFTESTS) runSelftest(check);
  console.log(`PASS evaluation quality gates (${SELFTESTS.length}/${SELFTESTS.length})`);
} catch (error) {
  console.error(`Evaluation quality gates failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
