#!/usr/bin/env node

/**
 * Journey contract — new coder path start to finish
 * Entry: the production-like checkout, installed dependencies, and isolated temp roots.
 * Steps: execute every numbered docs/intro lesson in order through the existing
 * lesson runner, which executes every fenced Try it bash block against fixtures.
 * Success signal: every registered lesson contract and executable block passes.
 * Failure branch 1: an unknown lesson selector returns a visible no-match error.
 * Failure branch 2: an invalid CLI flag returns a visible argument error.
 * Monitor: `smarch.journey.health.v1` for `new-coder-path`; alert below 98% over
 * 10 runs, after 2 consecutive failures, or p95 above 15 minutes.
 */

import {
  expectFailure,
  expectSuccess,
  mainJourney,
  run
} from "./_shared.mjs";

const BUDGET_MS = 45 * 60 * 1000;

async function runOnce() {
  const curriculum = run("node", ["tools/evals/journeys/lessons.mjs"], { timeoutMs: 15 * 60 * 1000 });
  expectSuccess(curriculum, "complete intro curriculum", /Lesson journey passed:/);

  const unknownLesson = run("node", ["tools/evals/journeys/lessons.mjs", "--lesson", "99"]);
  expectFailure(unknownLesson, "unknown lesson branch", /No intro lesson matches: 99/);

  const invalidFlag = run("node", ["tools/evals/journeys/lessons.mjs", "--definitely-invalid"]);
  expectFailure(invalidFlag, "invalid lesson CLI branch", /Unknown or incomplete argument/);

  const match = curriculum.stdout.match(/Lesson journey passed: (\d+) lesson\(s\), (\d+) block\(s\)/);
  return {
    lessons: Number(match?.[1] || 0),
    blocks: Number(match?.[2] || 0),
    failure_branches: ["unknown-lesson", "invalid-argument"]
  };
}

await mainJourney({
  journey: "new-coder-path",
  budgetMs: BUDGET_MS,
  signal: "intro_curriculum_completion_rate_and_p95_duration",
  threshold: "alert below 98% over 10 runs, after 2 consecutive failures, or p95 above 900000ms",
  runOnce
});
