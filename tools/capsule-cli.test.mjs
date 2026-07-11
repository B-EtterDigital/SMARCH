import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBrick, parseArgs as parseNewArgs } from "./sma-brick-new.mjs";
import { parseArgs as parseInspectArgs } from "./sma-brick-inspect.mjs";

const tools = path.dirname(fileURLToPath(import.meta.url));

test("capsule CLI parsers reject conflicting and missing values", () => {
  assert.equal(parseNewArgs(["--id", "acme.one", "--directory", "one"]).id, "acme.one");
  assert.throws(() => parseNewArgs(["--id"]), { code: "USAGE_ERROR" });
  assert.throws(() => parseInspectArgs(["one", "two"]), { code: "USAGE_ERROR" });
});

test("brick-new, brick-run, and brick-inspect execute against a real fixture workspace", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "smarch-capsule-cli-"));
  try {
    const capsule = path.join(root, "identity");
    const created = createBrick({ id: "fixture.identity", directory: capsule });
    assert.equal(created.ok, true);
    assert.equal(JSON.parse(readFileSync(path.join(capsule, "module.sweetspot.json"), "utf8")).brick.id, "fixture.identity");

    const run = spawnSync(process.execPath, [path.join(tools, "sma-brick-run.mjs"), capsule, "--json"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout.trim()).status, "PASS");

    const inspect = spawnSync(process.execPath, [path.join(tools, "sma-brick-inspect.mjs"), capsule, "--json"], { encoding: "utf8" });
    assert.equal(inspect.status, 0, inspect.stderr);
    const report = JSON.parse(inspect.stdout);
    assert.equal(report.manifest.id, "fixture.identity");
    assert.equal(report.fixtures[0].status, "PASS");

    const duplicate = spawnSync(process.execPath, [path.join(tools, "sma-brick-new.mjs"), "--id", "fixture.identity", "--directory", capsule, "--json"], { encoding: "utf8" });
    assert.equal(duplicate.status, 3);
    assert.equal(JSON.parse(duplicate.stdout).error.code, "DESTINATION_EXISTS");
    assert.equal(JSON.parse(duplicate.stderr.trim().split(/\r?\n/)[0]).code, "DESTINATION_EXISTS");

    const missing = spawnSync(process.execPath, [path.join(tools, "sma-brick-inspect.mjs"), path.join(root, "missing"), "--json"], { encoding: "utf8" });
    assert.equal(missing.status, 3);
    assert.equal(JSON.parse(missing.stdout).error.code, "MANIFEST_NOT_FOUND");
    assert.equal(JSON.parse(missing.stderr.trim().split(/\r?\n/)[0]).code, "MANIFEST_NOT_FOUND");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
