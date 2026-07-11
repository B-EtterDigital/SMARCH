# Evaluations module tour

This tour explains the harness that measures agent behavior and workflow quality. Evaluation authors and maintainers need it before adding a scenario, metric, or benchmark runner. Read it when a task changes how agent performance is measured or compared. Remember that an evaluation must produce repeatable evidence from a declared scenario.

## Purpose

The evaluations module runs agent-performance scenarios against coordination and workforce surfaces. It may depend on schemas, coordination, and the [SMOA](../GLOSSARY.md#smoa) workforce layer.

## Owned files

- `tools/evals/**`

## Ownership and lane

`sma.gen3.json` maps `tools/evals/**` to `evals`; the default lane is `single-module` and the required local gate is `node tools/evals/run.mjs --selftest`. The tour is the module's documentation seam, but changes to schemas, coordination, SMOA workforce code, CI, or `.UltraVision/` remain outside this module and require their own owner.

The module graph lives at `graphify-out/modules/evals/graphify-out/graph.json`. Query it with `npm run graphify:query -- --project sma --module evals -- "How does the evaluation runner reach its scenarios and scoring gates?"` before broad reads. Refreshing shared or global graph state is a claimed graph-module operation.

## Gates

Run `node tools/evals/run.mjs --selftest`, the focused evaluation scenario, and `npm run evals:bench`, then run the source-size gate and strict module Graphify summary. The performance plan names the GitHub Actions `ubuntu-latest` runner as the baseline; the benchmark measures the scan, Graphify, MCP, full-check, and memory budgets with the plan's headroom. Record environment limits that prevent a benchmark from representing the intended path.

The module command is registered in `sma.gen3.json`. The current GitHub workflow does not dispatch module-required gates by affected path, so do not describe the self-test or benchmark as CI-wired until that shared workflow is updated by its owner.

## How to work here

Keep fixtures deterministic, separate evaluator logic from the behavior under test, and version material scoring changes. Do not tune the implementation against hidden evaluator details.

Treat scenario load, execution, and scoring failures as evidence: include the scenario or benchmark name, severity, and actionable context. Expected fixture fallbacks must be documented; real failures must not be hidden by empty catches or ignored promises.
