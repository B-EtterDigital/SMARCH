#!/usr/bin/env node

/**
 * Journey contract — quickstart 5min
 * Entry: a checked-out production-like build, dependencies installed, and a
 * clean temporary workspace.
 * Steps: generate fixtures; scan with the live CLI; build state; run doctor;
 * clone activity-feed and verify its import receipt. These are the functional
 * CLI seams of docs/QUICKSTART.md, using the current TypeScript entrypoints.
 * Success signal: doctor passes and the clone records an installed receipt.
 * Failure branch 1: doctor rejects a missing registry/state pair visibly.
 * Failure branch 2: clone rejects an unknown brick visibly.
 * Monitor: `smarch.journey.health.v1` for `quickstart-5min`; alert below 99%
 * completion over 20 runs, after 3 consecutive failures, or p95 above 5 min.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  expectFailure,
  expectSuccess,
  generateFixturePortfolio,
  mainJourney,
  run,
  withTemp
} from "./_shared.mjs";

const BUDGET_MS = 5 * 60 * 1000;

async function runOnce() {
  return withTemp("smarch-quickstart-5min-", async (root) => {
    const portfolio = await generateFixturePortfolio(root);
    const registry = path.join(root, "quickstart.registry.json");
    const state = path.join(root, "quickstart.state.json");
    const target = path.join(root, "first-clone");

    expectSuccess(
      run("node", ["tools/sma-scan.ts", "--root", portfolio, "--out", registry]),
      "quickstart scan",
      /scan complete|brick/i
    );
    expectSuccess(
      run("node", ["tools/sma-state.ts", "--registry", registry, "--out", state]),
      "quickstart state build",
      /state|written|project|brick/i
    );
    expectSuccess(
      run("node", ["tools/sma-doctor.ts", "--registry", registry, "--state", state]),
      "quickstart doctor",
      /doctor|healthy|pass|ok/i
    );
    expectSuccess(
      run("node", [
        "tools/sma-clone.ts", "--registry", registry,
        "--brick", "acme-desktop.activity-feed", "--target", target,
        "--write", "--allow-closed"
      ]),
      "quickstart clone",
      /install|copied|write|clone/i
    );

    const imports = JSON.parse(await fs.readFile(path.join(target, ".smarch/imports.json"), "utf8"));
    const record = imports.imports[0];

    const missingDoctor = run("node", [
      "tools/sma-doctor.ts", "--registry", path.join(root, "missing.registry.json"),
      "--state", path.join(root, "missing.state.json")
    ]);
    expectFailure(missingDoctor, "missing quickstart state branch", /ENOENT|no such file|missing\.(registry|state)/i);

    const unknownClone = run("node", [
      "tools/sma-clone.ts", "--registry", registry,
      "--brick", "missing.quickstart-brick", "--target", path.join(root, "missing"), "--write"
    ]);
    expectFailure(unknownClone, "unknown quickstart brick branch", /not found|no brick|missing\.quickstart-brick/i);

    return {
      doctor: "passed",
      brick: record.artifact_id,
      install_status: record.status,
      failure_branches: ["missing-registry-state", "unknown-brick"]
    };
  });
}

await mainJourney({
  journey: "quickstart-5min",
  budgetMs: BUDGET_MS,
  signal: "quickstart_completion_rate_and_p95_duration",
  threshold: "alert below 99% over 20 runs, after 3 consecutive failures, or p95 above 300000ms",
  runOnce
});
