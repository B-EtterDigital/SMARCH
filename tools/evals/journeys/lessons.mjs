#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../../..");
const INTRO_DIR = path.join(REPO_ROOT, "docs", "intro");
const BLOCK_TIMEOUT_MS = 5 * 60 * 1000;
const FAILURE_OUTPUT_LIMIT = 4_000;
const REGISTERED_LESSONS = new Set([
  "00-orientation.md",
  "01-what-is-a-brick.md",
  "02-your-first-scan.md",
  "03-reading-the-brick-wall.md",
  "04-manifests-explained.md",
  "05-gates-what-blocks-and-why.md",
  "06-your-first-clone.md",
  "07-provenance-and-seals.md",
  "08-leases-working-alongside-agents.md",
  "09-conflicts-are-normal.md",
  "10-your-first-capsule.md",
  "11-the-graph-asking-questions.md",
  "12-agents-and-skills-setup.md",
  "13-contributing-your-first-brick.md",
  "14-canonical-the-registry-story.md",
  "15-mcp-connect-your-agent.md",
  "16-glossary-safari.md",
  "17-reading-the-plan-uvp.md",
  "18-your-first-agent-swarm.md"
]);
const LESSON_CONTRACTS = new Map([
  ["07-provenance-and-seals.md", {
    requiredSnippets: [
      "## Why this matters",
      "## The idea",
      "## Try it",
      "## What you just did",
      "## Where to go next",
      "SMARCH_FIXTURE_PORTFOLIO",
      "tools/evals/fixtures/portfolio",
      "tools/lib/provenance-seal.mjs"
    ]
  }],
  ["08-leases-working-alongside-agents.md", {
    requiredSnippets: [
      "## Why this matters",
      "## The idea",
      "## Try it",
      "## What you just did",
      "## Where to go next",
      "SMARCH_FIXTURE_PORTFOLIO",
      "tools/evals/fixtures/portfolio",
      "tools/sma-start-edit.mjs",
      "tools/sma-end-edit.mjs"
    ]
  }],
  ["09-conflicts-are-normal.md", {
    requiredSnippets: [
      "## Why this matters",
      "## The idea",
      "## Try it",
      "## What you just did",
      "## Where to go next",
      "SMARCH_FIXTURE_PORTFOLIO",
      "tools/evals/fixtures/portfolio",
      "tools/sma-conflict.mjs"
    ]
  }],
  ["10-your-first-capsule.md", {
    requiredSnippets: [
      "## Why this matters",
      "## The idea",
      "## Try it",
      "## What you just did",
      "## Where to go next",
      "SMARCH_FIXTURE_PORTFOLIO",
      "tools/evals/fixtures/portfolio",
      "tools/sma-brick-run.mjs"
    ]
  }],
  ["11-the-graph-asking-questions.md", {
    requiredSnippets: [
      "## Why this matters",
      "## The idea",
      "## Try it",
      "## What you just did",
      "## Where to go next",
      "SMARCH_FIXTURE_PORTFOLIO",
      "tools/evals/fixtures/portfolio",
      "tools/sma-graphify.mjs query"
    ]
  }],
  ["12-agents-and-skills-setup.md", {
    requiredSnippets: [
      "## Why this matters",
      "## The idea",
      "## Try it",
      "## What you just did",
      "## Where to go next",
      "SMARCH_FIXTURE_PORTFOLIO",
      "tools/evals/fixtures/portfolio",
      "tools/install-agent-skills.mjs"
    ]
  }],
  ["13-contributing-your-first-brick.md", {
    requiredSnippets: [
      "## Why this matters",
      "## The idea",
      "## Try it",
      "## What you just did",
      "## Where to go next",
      "SMARCH_FIXTURE_PORTFOLIO",
      "tools/evals/fixtures/portfolio",
      "tools/sma-bootstrap-manifests.mjs"
    ]
  }],
  ["14-canonical-the-registry-story.md", {
    requiredSnippets: [
      "## Why this matters",
      "## The idea",
      "## Try it",
      "## What you just did",
      "## Where to go next",
      "SMARCH_FIXTURE_PORTFOLIO",
      "tools/evals/fixtures/portfolio",
      "tools/sma-canonicalization.mjs"
    ]
  }],
  ["15-mcp-connect-your-agent.md", {
    requiredSnippets: [
      "## Why this matters",
      "## The idea",
      "## Try it",
      "## What you just did",
      "## Where to go next",
      "SMARCH_FIXTURE_PORTFOLIO",
      "tools/evals/fixtures/portfolio",
      "tools/mcp/server.mjs"
    ]
  }],
  ["16-glossary-safari.md", {
    requiredSnippets: [
      "## Why this matters",
      "## The idea",
      "## Try it",
      "## What you just did",
      "## Where to go next",
      "SMARCH_FIXTURE_PORTFOLIO",
      "tools/evals/fixtures/portfolio",
      "tools/sma-scan.mjs"
    ]
  }],
  ["17-reading-the-plan-uvp.md", {
    requiredSnippets: [
      "## Why this matters",
      "## The idea",
      "## Try it",
      "## What you just did",
      "## Where to go next",
      "SMARCH_FIXTURE_PORTFOLIO",
      "tools/evals/fixtures/portfolio",
      "~/.claude/skills/f5-ultravisionplan/scripts/uvp.py",
      "git archive HEAD .UltraVision"
    ]
  }],
  ["18-your-first-agent-swarm.md", {
    requiredSnippets: [
      "## Why this matters",
      "## The idea",
      "## Try it",
      "## What you just did",
      "## Where to go next",
      "SMARCH_FIXTURE_PORTFOLIO",
      "tools/evals/fixtures/portfolio",
      "SMA_AGENT=\"swarm-blue\"",
      "tools/sma-start-edit.mjs",
      "conflict_detected"
    ]
  }]
]);

function usage() {
  console.log(`SMARCH intro lesson journey

Usage:
  node tools/evals/journeys/lessons.mjs
  node tools/evals/journeys/lessons.mjs --lesson 01
  node tools/evals/journeys/lessons.mjs --lessons 01,02,03
  node tools/evals/journeys/lessons.mjs --selftest

The runner executes fenced bash blocks in docs/intro/NN-*.md. Use --lesson
for one lesson or --lessons for a comma-separated group. With no filter, the
runner checks every numbered lesson that contains a bash block.
`);
}

function addSelectors(target, value) {
  for (const selector of value.split(",")) {
    const normalized = selector.trim();
    if (normalized) target.add(/^\d+$/.test(normalized) ? normalized.padStart(2, "0") : normalized);
  }
}

function parseArgs(argv) {
  const selectors = new Set();
  let selftest = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if ((arg === "--lesson" || arg === "--lessons") && next) {
      addSelectors(selectors, next);
      index += 1;
    } else if (arg === "--selftest") {
      selftest = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  if (selftest && selectors.size > 0) {
    throw new Error("--selftest cannot be combined with lesson selectors");
  }

  return { selectors, selftest };
}

function parseBashBlocks(markdown) {
  const blocks = [];
  const pattern = /```bash[ \t]*\r?\n([\s\S]*?)\r?\n```/g;
  let match;

  while ((match = pattern.exec(markdown)) !== null) {
    const line = markdown.slice(0, match.index).split(/\r?\n/).length;
    blocks.push({ code: match[1], line });
  }

  return blocks;
}

function validateLessonContract(filename, markdown) {
  const contract = LESSON_CONTRACTS.get(filename);
  if (!contract) return [];
  return contract.requiredSnippets.filter((snippet) => !markdown.includes(snippet));
}

function matchesSelector(filename, selector) {
  const basename = filename.replace(/\.md$/, "");
  return basename === selector || basename.startsWith(`${selector}-`);
}

function assertCurriculumCoverage(discovered) {
  const discoveredSet = new Set(discovered);
  const unregistered = discovered.filter((name) => !REGISTERED_LESSONS.has(name));
  const stale = [...REGISTERED_LESSONS].filter((name) => !discoveredSet.has(name));

  if (unregistered.length > 0 || stale.length > 0) {
    throw new Error(
      `Intro curriculum registration drift (unregistered: ${unregistered.join(", ") || "none"}; stale: ${stale.join(", ") || "none"})`
    );
  }
}

async function discoverLessons() {
  const entries = (await fs.readdir(INTRO_DIR))
    .filter((name) => /^\d\d-.*\.md$/.test(name))
    .sort();
  assertCurriculumCoverage(entries);
  return entries;
}

async function findLessons(selectors) {
  const entries = await discoverLessons();

  if (selectors.size === 0) return entries;

  const selected = [];
  for (const selector of selectors) {
    const matches = entries.filter((name) => matchesSelector(name, selector));
    if (matches.length === 0) {
      throw new Error(`No intro lesson matches: ${selector}`);
    }
    selected.push(...matches);
  }

  return [...new Set(selected)].sort();
}

async function selftest() {
  const entries = await discoverLessons();
  assertCurriculumCoverage(entries);
  assert.throws(
    () => assertCurriculumCoverage([...entries, "19-unregistered-selftest.md"]),
    /unregistered: 19-unregistered-selftest\.md/,
    "an unregistered intro lesson must fail closed"
  );
  assert.throws(
    () => assertCurriculumCoverage(entries.filter((name) => name !== "00-orientation.md")),
    /stale: 00-orientation\.md/,
    "a stale curriculum registration must fail closed"
  );
  console.log(`Lesson curriculum selftest passed: ${entries.length} registered lesson(s); drift negatives rejected.`);
}

function tail(value) {
  const text = String(value || "").trim();
  return text.length <= FAILURE_OUTPUT_LIMIT
    ? text
    : text.slice(text.length - FAILURE_OUTPUT_LIMIT);
}

function executeBlock({ block, filename, index, total, lessonTemp, env }) {
  const result = spawnSync(
    "bash",
    ["-c", `set -euo pipefail\n${block.code}`],
    {
      cwd: REPO_ROOT,
      env: {
        ...env,
        SMARCH_LESSON_TMP: lessonTemp,
        SMARCH_FIXTURE_PORTFOLIO: path.join(lessonTemp, "portfolio"),
        SMARCH_CLONE_TARGET: path.join(lessonTemp, "first-clone")
      },
      encoding: "utf8",
      timeout: BLOCK_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024
    }
  );

  const label = `${filename}:${block.line} block ${index + 1}/${total}`;
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

async function runJourney(selectors) {
  const filenames = await findLessons(selectors);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "smarch-lessons-"));
  const env = {
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    SMARCH_REPO: REPO_ROOT,
    SMARCH_DIR: REPO_ROOT
  };
  let failures = 0;
  let executedBlocks = 0;

  try {
    for (const filename of filenames) {
      const markdown = await fs.readFile(path.join(INTRO_DIR, filename), "utf8");
      const blocks = parseBashBlocks(markdown);
      const missingSnippets = validateLessonContract(filename, markdown);

      if (missingSnippets.length > 0) {
        console.error(`FAIL ${filename} is missing lesson contract text: ${missingSnippets.join(", ")}`);
        failures += 1;
      }

      if (blocks.length === 0) {
        if (selectors.size > 0) {
          console.error(`FAIL ${filename} contains no fenced bash blocks`);
          failures += 1;
        } else {
          console.log(`SKIP ${filename} contains no fenced bash blocks`);
        }
        continue;
      }

      const lessonTemp = path.join(tempRoot, filename.replace(/\.md$/, ""));
      await fs.mkdir(lessonTemp, { recursive: true });
      for (let index = 0; index < blocks.length; index += 1) {
        executedBlocks += 1;
        if (!executeBlock({
          block: blocks[index],
          filename,
          index,
          total: blocks.length,
          lessonTemp,
          env
        })) {
          failures += 1;
        }
      }
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`Lesson journey failed: ${failures} failure(s), ${executedBlocks} block(s) run.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Lesson journey passed: ${filenames.length} lesson(s), ${executedBlocks} block(s).`);
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.selftest) await selftest();
  else await runJourney(options.selectors);
} catch (error) {
  console.error(`Lesson journey error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
