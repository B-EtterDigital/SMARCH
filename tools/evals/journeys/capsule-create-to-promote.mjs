#!/usr/bin/env node
/**
 * Journey: capsule create to promote
 * Entry state: a clean temporary workspace and the production capsule template/CLIs.
 * Steps: create a capsule; run and inspect its fixture; add the semantics and sibling
 * test evidence required by promotion; run the real promotion CLI; inspect canonical status.
 * Success signal: capsule_promotion_success_total / capsule_promotion_attempt_total >= 0.98
 * over 15 minutes; page when below 0.95 for two windows or any promotion corrupts a manifest.
 * Failure branches: duplicate destination returns DESTINATION_EXISTS; missing promotion
 * semantics remains project_bound with reason missing-semantics.
 * TODO(UV-EV-j-capsule-create-to-promote-impl): server-side submission/review/promotion is
 * an M3 feature. This journey proves the local lifecycle that exists today and must be
 * extended when that task lands; it does not fake a server.
 */

import { fileURLToPath } from "node:url";
import { assert, fs, parseJourneyArgs, path, runNode, runSelftest, withTempRoot } from "./_helpers.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TOOLS = path.join(REPO_ROOT, "tools");
const BUDGET_MS = 5_000;

/** @param {string} output */
function firstJsonLine(output) {
  return JSON.parse(output.trim().split(/\r?\n/)[0]);
}

/** @param {string} capsule @param {string} candidatePath @param {NodeJS.ProcessEnv} [env] */
async function promote(capsule, candidatePath, env) {
  const manifestPath = path.join(capsule, "module.sweetspot.json");
  await fs.writeFile(candidatePath, `${JSON.stringify({
    bricks: [{
      id: "journey.promoted-capsule",
      project: "",
      score: 100,
      kind: "capsule",
      manifest_path: manifestPath,
      source_paths: [capsule],
    }],
  })}\n`);
  // Promotion re-runs the capsule fixture to prove it; it must inherit the same
  // isolation opt-in so it validates on the Node 24 LTS floor, not just Node 25.
  return runNode(path.join(TOOLS, "sma-promote.ts"), ["--candidates", candidatePath], {
    cwd: REPO_ROOT,
    env,
    label: "sma-promote",
  });
}

export async function runJourney() {
  return withTempRoot("smarch-capsule-journey-", async (root) => {
    const capsule = path.join(root, "promoted-capsule");
    const unready = path.join(root, "unready-capsule");
    // Strict capsule isolation needs Node >=25; on the declared engine floor
    // (Node 24 LTS) accept reduced isolation via the operator opt-in. The env
    // reaches every child — including brick-inspect, which spawns brick-run.
    const env = { ...process.env, CI: "1", NO_COLOR: "1", SMA_CAPSULE_ISOLATION_FALLBACK: "1" };

    const created = runNode(path.join(TOOLS, "sma-brick-new.mjs"), [
      "--id", "journey.promoted-capsule", "--directory", capsule, "--json",
    ], { cwd: REPO_ROOT, env, label: "brick-new" });
    assert.equal(JSON.parse(created.stdout).ok, true);

    const duplicate = runNode(path.join(TOOLS, "sma-brick-new.mjs"), [
      "--id", "journey.promoted-capsule", "--directory", capsule, "--json",
    ], { cwd: REPO_ROOT, env, expectStatus: 3, label: "duplicate brick-new" });
    assert.equal(JSON.parse(duplicate.stdout).error.code, "DESTINATION_EXISTS");
    assert.equal(firstJsonLine(duplicate.stderr).code, "DESTINATION_EXISTS");

    const fixture = runNode(path.join(TOOLS, "sma-brick-run.mjs"), [capsule, "--json"], {
      cwd: REPO_ROOT, env, label: "brick-run",
    });
    assert.equal(JSON.parse(fixture.stdout).status, "PASS");
    const inspected = runNode(path.join(TOOLS, "sma-brick-inspect.mjs"), [capsule, "--json"], {
      cwd: REPO_ROOT, env, label: "brick-inspect",
    });
    assert.equal(JSON.parse(inspected.stdout).manifest.id, "journey.promoted-capsule");

    const manifestPath = path.join(capsule, "module.sweetspot.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.semantics = {
      purpose: "Prove the capsule lifecycle journey.",
      tags: ["journey", "capsule"],
      public_api: ["default"],
      clone_steps: ["Copy the capsule and run its fixture."],
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.writeFile(path.join(capsule, "promotion.test.ts"), "export {};\n");
    const promoted = await promote(capsule, path.join(root, "ready-candidates.json"), env);
    assert.equal(JSON.parse(promoted.stdout).results.canonical, 1);
    assert.equal(JSON.parse(await fs.readFile(manifestPath, "utf8")).brick.status, "canonical");

    runNode(path.join(TOOLS, "sma-brick-new.mjs"), [
      "--id", "journey.unready-capsule", "--directory", unready, "--json",
    ], { cwd: REPO_ROOT, env, label: "unready brick-new" });
    const blocked = await promote(unready, path.join(root, "unready-candidates.json"), env);
    const blockedReport = JSON.parse(blocked.stdout);
    assert.equal(blockedReport.results.project_bound, 1);
    assert.equal(blockedReport.reasons["missing-semantics"], 1);

    return {
      created: true,
      fixture: "PASS",
      promoted: "canonical",
      duplicate: "DESTINATION_EXISTS",
      unready: "missing-semantics",
    };
  });
}

try {
  const { selftest } = parseJourneyArgs(process.argv.slice(2), "capsule-create-to-promote");
  if (selftest) await runSelftest("capsule-create-to-promote", runJourney, BUDGET_MS);
  else console.log(`PASS capsule-create-to-promote ${JSON.stringify(await runJourney())}`);
} catch (error) {
  console.error(`FAIL capsule-create-to-promote: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
