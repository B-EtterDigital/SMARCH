import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const tools = path.dirname(fileURLToPath(import.meta.url));

function invoke(script, args) {
  return spawnSync(process.execPath, [path.join(tools, script), ...args], { encoding: "utf8", timeout: 120_000 });
}

test("umbrella sma router exposes every hardened command", () => {
  for (const command of ["mcp-serve", "brick-new", "brick-run", "brick-inspect", "submit", "sync-public", "evals-run"]) {
    const result = invoke("sma.ts", [command, "--help"]);
    assert.equal(result.status, 0, `${command}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/, command);
    assert.match(result.stdout, /Exit codes:/, command);
  }
});

test("submit help, selftest, and typed usage failure", () => {
  const help = invoke("sma-submit.mjs", ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Exit codes:/);
  const success = invoke("sma-submit.mjs", ["--selftest"]);
  assert.equal(success.status, 0, success.stderr);
  const failure = invoke("sma-submit.mjs", ["--unknown", "--json"]);
  assert.equal(failure.status, 2);
  assert.equal(JSON.parse(failure.stdout).ok, false);
  assert.equal(JSON.parse(failure.stderr.trim().split(/\r?\n/)[0]).area, "cli:submit");
});

test("sync-public help, selftest, and JSON failure remain parseable", () => {
  const help = invoke("sma-sync-public.mjs", ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Known limitation:/);
  const success = invoke("sma-sync-public.mjs", ["--selftest"]);
  assert.equal(success.status, 0, success.stderr);
  const failure = invoke("sma-sync-public.mjs", ["--from", "/definitely/missing", "--to", "/tmp/smarch-sync-target", "--json"]);
  assert.equal(failure.status, 3);
  assert.equal(JSON.parse(failure.stdout).error.code, "SOURCE_NOT_FOUND");
  const telemetry = JSON.parse(failure.stderr.trim().split(/\r?\n/)[0]);
  assert.equal(telemetry.area, "cli:sync-public");
  assert.ok(telemetry.next_command);
});
