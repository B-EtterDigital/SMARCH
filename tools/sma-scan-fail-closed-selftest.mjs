#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const scanner = path.join(toolsDir, "sma-scan.mjs");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sma-scan-fail-closed-"));
const out = path.join(tempRoot, "registry.json");
const rejectedOut = `${out}.rejected.json`;
const previousRegistry = '{"sentinel":"previous"}\n';
const run = (...args) => spawnSync(process.execPath, [scanner, "--root", tempRoot, "--out", out, "--json", ...args], { encoding: "utf8" });

try {
  fs.mkdirSync(path.join(tempRoot, "project"));
  fs.writeFileSync(path.join(tempRoot, "project", "module.sweetspot.json"), "{broken\n");
  fs.writeFileSync(out, previousRegistry);

  const rejected = run();
  assert.equal(rejected.status, 2, rejected.stderr);
  assert.equal(fs.readFileSync(out, "utf8"), previousRegistry);
  assert.equal(JSON.parse(fs.readFileSync(rejectedOut, "utf8")).failure_count, 1);

  const checked = run("--check");
  assert.equal(checked.status, 1, checked.stderr);
  assert.equal(fs.readFileSync(out, "utf8"), previousRegistry);

  const forced = run("--force");
  assert.equal(forced.status, 0, forced.stderr);
  assert.notEqual(fs.readFileSync(out, "utf8"), previousRegistry);
  assert.match(forced.stderr, /WARN --force/);
  assert.equal(JSON.parse(fs.readFileSync(rejectedOut, "utf8")).forced, true);

  fs.writeFileSync(path.join(tempRoot, "project", "module.sweetspot.json"), '{"schema_version":"1.0.0"}\n');
  fs.writeFileSync(out, previousRegistry);
  const invalid = run();
  const invalidReport = JSON.parse(fs.readFileSync(rejectedOut, "utf8"));
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.equal(fs.readFileSync(out, "utf8"), previousRegistry);
  assert.equal(invalidReport.failure_count, 0);
  assert.ok(invalidReport.validation_error_count > 0);
  console.log("sma-scan fail-closed selftest: passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
