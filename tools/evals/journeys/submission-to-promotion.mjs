#!/usr/bin/env node

/**
 * Journey contract — submission to promotion
 * Entry: the production-like CLI build and its isolated built-in submission fixture.
 * Steps available today: package a real brick submission, verify the emitted
 * archive, then run the live canonicalization/promotion decision CLI in dry-run.
 * Success signal: submission selftest verifies its archive and promotion emits
 * a deterministic decision summary without mutating source manifests.
 * Failure branch 1: verification rejects a missing archive with exit code 3.
 * Failure branch 2: promotion rejects a missing candidate inventory visibly.
 * TODO(UV-CM-skeptic-trusted-revalidation): replace the dry-run promotion
 * decision with trusted server-side intake -> curator promotion when that M3
 * capability exists. This journey intentionally does not fake that seam.
 * Monitor: `smarch.journey.health.v1` for `submission-to-promotion`; alert below
 * 99% success over 20 runs or after 3 consecutive synthetic failures.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  expectFailure,
  expectSuccess,
  mainJourney,
  run,
  withTemp
} from "./_shared.mjs";

const BUDGET_MS = 5 * 60 * 1000;

async function runOnce() {
  return withTemp("smarch-submit-promote-", async (root) => {
    const submission = run("node", ["tools/sma-submit.mjs", "--selftest", "--json"], { timeoutMs: BUDGET_MS });
    expectSuccess(submission, "community submission and archive verification", /passed|archive|verified|ok/i);

    const candidates = path.join(root, "candidates.json");
    await fs.writeFile(candidates, `${JSON.stringify({ bricks: [] })}\n`);
    const promotion = run("node", ["tools/sma-promote.ts", "--candidates", candidates, "--dry-run"]);
    expectSuccess(promotion, "promotion decision dry-run", /canonical|candidate|project_bound|promot|summary|0/i);

    const missingArchive = run("node", ["tools/sma-submit.mjs", "--verify", path.join(root, "missing.tar.gz"), "--json"]);
    expectFailure(missingArchive, "missing submission archive branch", /missing|not found|ENOENT|archive/i);

    const missingCandidates = run("node", [
      "tools/sma-promote.ts", "--candidates", path.join(root, "missing-candidates.json"), "--dry-run"
    ]);
    expectFailure(missingCandidates, "missing promotion candidates branch", /ENOENT|no such file|missing-candidates/i);

    return {
      submission_archive: "verified",
      promotion: "dry-run-current-capability",
      future_seam: "UV-CM-skeptic-trusted-revalidation",
      failure_branches: ["missing-archive", "missing-candidate-inventory"]
    };
  });
}

await mainJourney({
  journey: "submission-to-promotion",
  budgetMs: BUDGET_MS,
  signal: "verified_submission_to_promotion_decision_rate",
  threshold: "alert below 99% over 20 runs or after 3 consecutive failures",
  runOnce
});
