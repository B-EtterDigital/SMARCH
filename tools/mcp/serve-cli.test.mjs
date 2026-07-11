import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs, run, usage } from "./serve-cli.mjs";

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "serve-cli.mjs");

test("mcp-serve argument boundaries are typed", () => {
  assert.deepEqual(parseArgs(["--check", "--json"]), { check: true, json: true, quiet: false, verbose: false, help: false });
  assert.throws(() => parseArgs(["--quiet", "--verbose"]), { code: "USAGE_ERROR", exitCode: 2 });
  assert.throws(() => parseArgs(["--json"]), { code: "USAGE_ERROR", exitCode: 2 });
  assert.match(usage(), /Exit codes:/);
  assert.match(usage(), /Examples:/);
});

test("mcp-serve check supports injected deterministic dependencies", async () => {
  assert.equal(await run(["--check", "--quiet"], { loadSdk: async () => ({}), loadToolModules: async () => [{ name: "fixture" }] }), 0);
  assert.equal(await run(["--check", "--quiet"], { loadSdk: async () => { throw new Error("MCP_SDK_MISSING: fixture"); }, loadToolModules: async () => [] }), 0);
  assert.equal(await run(["--check", "--quiet"], { loadSdk: async () => ({}), loadToolModules: async () => { throw new Error("MCP_TOOL_INVALID: fixture"); } }), 4);
});

test("mcp-serve real check and top usage failure preserve stream contracts", () => {
  const success = spawnSync(process.execPath, [script, "--check", "--json"], { encoding: "utf8" });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).ok, true);
  const failure = spawnSync(process.execPath, [script, "--bogus"], { encoding: "utf8" });
  assert.equal(failure.status, 2);
  assert.equal(failure.stdout, "");
  const telemetry = JSON.parse(failure.stderr.trim().split(/\r?\n/)[0]);
  assert.equal(telemetry.area, "cli:mcp-serve");
  assert.ok(telemetry.next_command);
});
