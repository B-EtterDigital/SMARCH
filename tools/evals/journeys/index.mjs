#!/usr/bin/env node
/**
 * CI journey registry. Every user journey is named explicitly so adding a file without
 * registering it fails closed. Production monitoring consumes the PASS/FAIL boundary;
 * individual headers define the journey-specific signal and alert threshold.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const JOURNEYS = [
  { file: "quickstart.mjs", args: ["--selftest"] },
  { file: "lessons.mjs", args: ["--selftest"] },
  { file: "capsule-create-to-promote.mjs", args: [] },
  { file: "collision-flow.mjs", args: [] },
  { file: "dashboard-tour.mjs", args: [] },
  { file: "demo-tape.mjs", args: [] },
  { file: "mcp-discovery-install.mjs", args: [] },
  { file: "new-coder-path.mjs", args: [] },
  { file: "quickstart-5min.mjs", args: [] },
  { file: "scan-to-clone.mjs", args: [] },
  { file: "submission-to-promotion.mjs", args: [] },
];

function registeredFiles() {
  return new Set(JOURNEYS.map((journey) => journey.file));
}

function discoveredFiles() {
  return fs.readdirSync(DIRECTORY)
    .filter((name) => name.endsWith(".mjs") && !name.startsWith("_") && name !== "index.mjs")
    .sort();
}

function assertRegistration() {
  assert.deepEqual([...registeredFiles()].sort(), discoveredFiles(), "journey registry drift");
}

function runAll() {
  assertRegistration();
  let failures = 0;
  for (const journey of JOURNEYS) {
    const started = performance.now();
    const result = spawnSync(process.execPath, [path.join(DIRECTORY, journey.file), ...journey.args], {
      cwd: path.resolve(DIRECTORY, "../../.."),
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 6 * 60 * 1000,
      maxBuffer: 24 * 1024 * 1024,
    });
    const duration = Math.ceil(performance.now() - started);
    if (result.status === 0 && !result.error) {
      console.log(`PASS ${journey.file} ${duration}ms`);
      continue;
    }
    failures += 1;
    console.error(`FAIL ${journey.file} ${duration}ms`);
    if (result.error) console.error(result.error.message);
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    if (output) console.error(output.slice(-4_000));
  }
  if (failures > 0) throw new Error(`${failures}/${JOURNEYS.length} journey(s) failed`);
  console.log(`PASS journey registry: ${JOURNEYS.length}/${JOURNEYS.length} journeys`);
}

try {
  runAll();
} catch (error) {
  console.error(`FAIL journey registry: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
