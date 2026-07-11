import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { execute, parseArgs, run } from "./run.mjs";

const script = fileURLToPath(new URL("./run.mjs", import.meta.url));

test("evals-run parses boundaries and deterministic injected results", () => {
  assert.equal(parseArgs(["--only", "fixture-snapshot"]).only, "fixture-snapshot");
  assert.throws(() => parseArgs(["--only", "missing"]), { code: "USAGE_ERROR", exitCode: 2 });
  assert.throws(() => parseArgs(["--quiet", "--verbose"]), { code: "USAGE_ERROR" });
  const success = execute(parseArgs(["--only", "fixture-snapshot", "--quiet"]), { spawnSync: () => ({ status: 0, stdout: "ok", stderr: "" }) });
  assert.equal(success.ok, true);
  assert.equal(run(["--only", "fixture-snapshot", "--quiet"], { spawnSync: () => ({ status: 7, stdout: "", stderr: "boom" }) }), 4);
});

test("evals-run invokes a real fixture and reports a forced top failure", () => {
  const success = spawnSync(process.execPath, [script, "--only", "fixture-snapshot", "--json"], { encoding: "utf8", timeout: 120_000 });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).ok, true);
  const failure = spawnSync(process.execPath, [script, "--only", "fixture-snapshot", "--json"], { encoding: "utf8", env: { ...process.env, SMARCH_EVALS_FORCE_FAILURE: "fixture-snapshot" } });
  assert.equal(failure.status, 4);
  assert.equal(JSON.parse(failure.stdout).ok, false);
  assert.equal(JSON.parse(failure.stderr.trim().split(/\r?\n/)[0]).area, "cli:evals-run");
});
