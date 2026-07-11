#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const QUICKSTART_PATH = path.join(REPO_ROOT, "docs", "QUICKSTART.md");
const BLOCK_TIMEOUT_MS = 5 * 60 * 1000;
const FAILURE_OUTPUT_LIMIT = 4_000;

/** @typedef {{ code: string, line: number }} BashBlock */

function usage() {
  console.log(`SMARCH quickstart journey

Usage:
  node tools/evals/journeys/quickstart.mjs
  node tools/evals/journeys/quickstart.mjs --selftest

Both forms execute every fenced bash block in docs/QUICKSTART.md. The
--selftest flag is provided for explicit journey discovery and CI use.
`);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  for (const arg of argv) {
    if (arg === "--selftest") continue;
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
}

/** @param {string} markdown @returns {BashBlock[]} */
function parseBashBlocks(markdown) {
  /** @type {BashBlock[]} */
  const blocks = [];
  const pattern = /```bash[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
  let match;

  while ((match = pattern.exec(markdown)) !== null) {
    const line = markdown.slice(0, match.index).split(/\r?\n/).length;
    blocks.push({ code: match[1], line });
  }

  if (blocks.length === 0) {
    throw new Error("docs/QUICKSTART.md contains no fenced bash blocks");
  }

  return blocks;
}

/** @param {unknown} value */
function tail(value) {
  const text = String(value || "").trim();
  return text.length <= FAILURE_OUTPUT_LIMIT
    ? text
    : text.slice(text.length - FAILURE_OUTPUT_LIMIT);
}

/** @param {BashBlock} block @param {number} index @param {number} total @param {string} tempRoot @param {NodeJS.ProcessEnv} env */
function executeBlock(block, index, total, tempRoot, env) {
  const result = spawnSync(
    "bash",
    ["-c", `set -euo pipefail\n${block.code}`],
    {
      cwd: tempRoot,
      env,
      encoding: "utf8",
      timeout: BLOCK_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024
    }
  );

  const label = `block ${index + 1}/${total} (QUICKSTART.md:${block.line})`;
  if (result.status === 0 && !result.error) {
    console.log(`PASS ${label}`);
    return true;
  }

  console.error(`FAIL ${label}`);
  if (result.error) console.error(result.error.message);
  const output = tail([result.stdout, result.stderr].filter(Boolean).join("\n"));
  if (output) console.error(output);
  return false;
}

async function runJourney() {
  const markdown = await fs.readFile(QUICKSTART_PATH, "utf8");
  const blocks = parseBashBlocks(markdown);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "smarch-quickstart-"));
  const checkout = path.join(tempRoot, "SMARCH");
  const fixturePortfolio = path.join(tempRoot, "fixture-portfolio");
  const fixtureRegistry = path.join(tempRoot, "quickstart.registry.json");
  const fixtureState = path.join(tempRoot, "quickstart.state.json");
  const cloneTarget = path.join(tempRoot, "first-clone");
  const env = {
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    SMARCH_REPO: REPO_ROOT,
    SMARCH_DIR: checkout,
    SMARCH_FIXTURE_PORTFOLIO: fixturePortfolio,
    SMARCH_FIXTURE_REGISTRY: fixtureRegistry,
    SMARCH_FIXTURE_STATE: fixtureState,
    SMARCH_CLONE_TARGET: cloneTarget
  };

  let failures = 0;
  try {
    for (let index = 0; index < blocks.length; index += 1) {
      if (!executeBlock(blocks[index], index, blocks.length, tempRoot, env)) {
        failures += 1;
      }
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`Quickstart journey failed: ${failures}/${blocks.length} block(s) failed.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Quickstart journey passed: ${blocks.length}/${blocks.length} block(s).`);
}

try {
  parseArgs(process.argv.slice(2));
  await runJourney();
} catch (error) {
  console.error(`Quickstart journey error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
