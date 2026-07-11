#!/usr/bin/env node
/**
 * Journey: demo tape
 * Entry state: the committed docs/demo/demo.tape and a clean generated fixture portfolio.
 * Steps: validate the tape contract; run its real fixture generation and scan scene;
 * execute the real two-agent lease collision scene in an isolated SMA root.
 * Success signal: demo_tape_scene_success_total / demo_tape_scene_attempt_total = 1
 * per release; alert on any failed scene or when a checked-in tape has no executable preflight.
 * Failure branches: an unavailable VHS executable produces the documented prerequisite
 * outcome; the second agent is refused with exit 10 and a conflict_detected record.
 * Recording itself remains an operator artifact when VHS is installed; CI proves every
 * product seam shown in the tape and never substitutes a fake GIF.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assert, fs, parseJourneyArgs, path, runNode, runSelftest, withTempRoot } from "./_helpers.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TAPE_PATH = path.join(REPO_ROOT, "docs", "demo", "demo.tape");
const FIXTURE_GEN = path.join(REPO_ROOT, "tools", "evals", "fixtures", "gen.mjs");
const SCAN = path.join(REPO_ROOT, "tools", "sma-scan.ts");
const START_EDIT = path.join(REPO_ROOT, "tools", "sma-start-edit.ts");
const BUDGET_MS = 15_000;

export async function runJourney() {
  return withTempRoot("smarch-demo-journey-", async (root) => {
    const tape = await fs.readFile(TAPE_PATH, "utf8");
    for (const snippet of [
      'Output "demo.gif"',
      "npm run fixtures:gen",
      "node tools/sma-scan.mjs",
      "SMA_AGENT=agent-a npm run start:edit",
      "SMA_AGENT=agent-b npm run start:edit",
    ]) assert.ok(tape.includes(snippet), `demo tape missing contract: ${snippet}`);

    const portfolio = path.join(root, "fixture-portfolio");
    const registry = path.join(root, "demo-registry.json");
    const env = { ...process.env, CI: "1", NO_COLOR: "1" };
    runNode(FIXTURE_GEN, ["--out", portfolio], { cwd: REPO_ROOT, env, label: "fixture generation" });
    runNode(SCAN, ["--root", portfolio, "--out", registry], {
      cwd: REPO_ROOT, env, timeoutMs: 10_000, label: "demo scan",
    });
    const scan = JSON.parse(await fs.readFile(registry, "utf8"));
    assert.equal(scan.projects.length, 3);
    assert.equal(scan.count, 40);
    assert.equal(scan.failure_count, 0);

    const leaseEnv = {
      ...env,
      SMA_ROOT: path.join(root, "sma-runtime"),
      SMA_AGENT: "agent-a",
      SMA_SESSION_ID: "demo-agent-a",
    };
    const first = runNode(START_EDIT, [
      "--project", "sma", "--brick", "demo-brick", "--intent", "wire the demo", "--json",
    ], { cwd: REPO_ROOT, env: leaseEnv, timeoutMs: 10_000, label: "demo first claim" });
    assert.equal(JSON.parse(first.stdout).lease.agent_id, "agent-a");
    const second = runNode(START_EDIT, [
      "--project", "sma", "--brick", "demo-brick", "--intent", "wire the demo", "--json",
    ], {
      cwd: REPO_ROOT,
      env: { ...leaseEnv, SMA_AGENT: "agent-b", SMA_SESSION_ID: "demo-agent-b" },
      expectStatus: 10,
      timeoutMs: 10_000,
      label: "demo collision",
    });
    assert.match(second.stderr, /resource is leased/);
    assert.match(second.stderr, /\[conflict\] logged/);
    const log = await fs.readFile(path.join(leaseEnv.SMA_ROOT, ".smarch", "agent-context", "demo-brick.ndjson"), "utf8");
    assert.ok(log.trim().split(/\r?\n/).map((line) => JSON.parse(line)).some((event) => event.kind === "conflict_detected"));

    const vhs = spawnSync("vhs", ["--version"], { encoding: "utf8" });
    const recorder = vhs.error && "code" in vhs.error && vhs.error.code === "ENOENT"
      ? "prerequisite-missing"
      : vhs.status === 0 ? "available" : "preflight-failed";
    assert.ok(["prerequisite-missing", "available"].includes(recorder), `VHS preflight failed: ${vhs.stderr || vhs.error?.message}`);

    return {
      tape_contract: "valid",
      projects: 3,
      bricks: 40,
      scan_failures: 0,
      collision_exit: 10,
      conflict_signal: "conflict_detected",
      recorder,
    };
  });
}

try {
  const { selftest } = parseJourneyArgs(process.argv.slice(2), "demo-tape");
  if (selftest) await runSelftest("demo-tape", runJourney, BUDGET_MS);
  else console.log(`PASS demo-tape ${JSON.stringify(await runJourney())}`);
} catch (error) {
  console.error(`FAIL demo-tape: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
