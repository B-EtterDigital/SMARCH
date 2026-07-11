#!/usr/bin/env node

/**
 * Journey contract — scan to clone
 * Entry: a clean temporary directory and the checked-in fixture generator.
 * Steps: generate the fixture portfolio; scan it with the live scanner; clone
 * acme-desktop.activity-feed with the live clone CLI; inspect the copied source,
 * import receipt, and checklist.
 * Success signal: a source file, installed import receipt, and checklist exist.
 * Failure branch 1: an unknown brick is rejected with a visible not-found error.
 * Failure branch 2: a missing registry is rejected with a visible filesystem error.
 * Monitor: `smarch.journey.health.v1` for `scan-to-clone`; alert if fewer than
 * 99% of the last 20 CI/synthetic runs pass or any 3 consecutive runs fail.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  expectFailure,
  expectSuccess,
  generateFixturePortfolio,
  mainJourney,
  outputOf,
  run,
  withTemp
} from "./_shared.mjs";

const BUDGET_MS = 3 * 60 * 1000;

async function runOnce() {
  return withTemp("smarch-scan-clone-", async (root) => {
    const portfolio = await generateFixturePortfolio(root);
    const registry = path.join(root, "registry.json");
    const target = path.join(root, "target");
    const scan = run("node", ["tools/sma-scan.ts", "--root", portfolio, "--out", registry]);
    expectSuccess(scan, "fixture portfolio scan", /scan complete|brick/i);

    const clone = run("node", [
      "tools/sma-clone.ts", "--registry", registry,
      "--brick", "acme-desktop.activity-feed", "--target", target,
      "--write", "--allow-closed"
    ]);
    expectSuccess(clone, "fixture brick clone", /install|copied|write|clone/i);

    const imports = JSON.parse(await fs.readFile(path.join(target, ".smarch", "imports.json"), "utf8"));
    const record = imports.imports[0];
    const sourceExists = await fs.access(path.join(target, "src/modules/activity-feed/index.mjs")).then(() => true, () => false);
    const checklistExists = await fs.access(path.join(target, record.checklist_path)).then(() => true, () => false);

    const unknown = run("node", [
      "tools/sma-clone.ts", "--registry", registry,
      "--brick", "missing.example", "--target", path.join(root, "missing"), "--write"
    ]);
    expectFailure(unknown, "unknown brick branch", /not found|no brick|missing\.example/i);

    const missingRegistry = run("node", [
      "tools/sma-clone.ts", "--registry", path.join(root, "absent.json"),
      "--brick", "acme-desktop.activity-feed", "--target", path.join(root, "absent"), "--write"
    ]);
    expectFailure(missingRegistry, "missing registry branch", /ENOENT|no such file|absent\.json/i);

    return {
      scan: /scan complete|brick/i.test(outputOf(scan)),
      brick: record.artifact_id,
      install_status: record.status,
      source_exists: sourceExists,
      checklist_exists: checklistExists,
      failure_branches: ["unknown-brick", "missing-registry"]
    };
  });
}

await mainJourney({
  journey: "scan-to-clone",
  budgetMs: BUDGET_MS,
  signal: "successful_clone_receipt_rate",
  threshold: "alert below 99% over 20 runs or after 3 consecutive failures",
  runOnce
});
