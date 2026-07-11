#!/usr/bin/env node
/**
 * Journey: collision flow
 * Entry state: an isolated SMA root with no conflict log for the fixture brick.
 * Steps: report a real brick collision; run the strict gate; resolve the handoff;
 * rerun the same strict gate and verify the append-only evidence.
 * Success signal: conflict_resolved_total / conflict_detected_total >= 0.95 within
 * 30 minutes; alert when any strict gate reports clear with an unresolved conflict,
 * or when the resolution ratio stays below 0.90 for 30 minutes.
 * Failure branches: strict check exits non-zero while conflict is open; resolving a
 * different brick does not clear the original conflict.
 */

import { fileURLToPath } from "node:url";
import { assert, fs, parseJourneyArgs, path, runNode, runSelftest, withTempRoot } from "./_helpers.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CONFLICT_CLI = path.join(REPO_ROOT, "tools", "sma-conflict.ts");
const BUDGET_MS = 5_000;

/** @param {string[]} args @param {NodeJS.ProcessEnv} env @param {number} [expectStatus] */
function invoke(args, env, expectStatus = 0) {
  return runNode(CONFLICT_CLI, args, {
    cwd: REPO_ROOT,
    env,
    expectStatus,
    label: `sma-conflict ${args[0]}`,
  });
}

export async function runJourney() {
  return withTempRoot("smarch-collision-journey-", async (root) => {
    const fixtureFile = path.join(root, "fixture-portfolio", "acme-cms", "src", "modules", "slug-service", "index.mjs");
    await fs.mkdir(path.dirname(fixtureFile), { recursive: true });
    await fs.writeFile(fixtureFile, "export const slug = (value) => value;\n");
    const env = {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      SMA_ROOT: root,
      SMA_AGENT: "journey-agent-b",
      SMA_SESSION_ID: "collision-journey",
    };
    const common = ["--project", "sma", "--brick", "acme-cms.slug-service", "--json"];

    const reported = invoke([
      "report", ...common,
      "--intent", "edit the fixture slug service",
      "--resource-kind", "brick",
      "--resource", "acme-cms.slug-service",
      "--blocked-agent", "journey-agent-b",
      "--holder-agent", "journey-agent-a",
      "--resolution-plan", "wait for handoff",
      "--file", fixtureFile,
    ], env);
    assert.equal(JSON.parse(reported.stdout).event.kind, "conflict_detected");

    const open = invoke(["check", ...common, "--strict"], env, 3);
    const openReport = JSON.parse(open.stdout);
    assert.equal(openReport.status, "blocked");
    assert.equal(openReport.open_conflicts, 1);

    invoke([
      "resolve", "--project", "sma", "--brick", "acme-cms.other-brick",
      "--intent", "unrelated handoff", "--decision", "unrelated brick finished", "--json",
    ], env);
    const stillOpen = invoke(["check", ...common, "--strict"], env, 3);
    assert.equal(JSON.parse(stillOpen.stdout).open_conflicts, 1);

    const resolved = invoke([
      "resolve", ...common,
      "--intent", "fixture handoff received",
      "--decision", "journey-agent-a finished; journey-agent-b may continue",
      "--file", fixtureFile,
    ], env);
    assert.equal(JSON.parse(resolved.stdout).kind, "conflict_resolved");
    const clear = invoke(["check", ...common, "--strict"], env);
    const clearReport = JSON.parse(clear.stdout);
    assert.equal(clearReport.status, "clear");
    assert.equal(clearReport.open_conflicts, 0);

    return {
      detected: "conflict_detected",
      strict_open: "blocked",
      wrong_resolution: "still-blocked",
      resolved: "conflict_resolved",
      strict_final: "clear",
    };
  });
}

try {
  const { selftest } = parseJourneyArgs(process.argv.slice(2), "collision-flow");
  if (selftest) await runSelftest("collision-flow", runJourney, BUDGET_MS);
  else console.log(`PASS collision-flow ${JSON.stringify(await runJourney())}`);
} catch (error) {
  console.error(`FAIL collision-flow: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
