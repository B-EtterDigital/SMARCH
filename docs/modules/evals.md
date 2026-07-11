# Evaluations module tour

This tour explains the harness that measures agent behavior and workflow quality. Evaluation authors and maintainers need it before adding a scenario, metric, or benchmark runner. Read it when a task changes how agent performance is measured or compared. Remember that an evaluation must produce repeatable evidence from a declared scenario.

## Purpose

The evaluations module runs agent-performance scenarios against coordination and workforce surfaces. It may depend on schemas, coordination, and the [SMOA](../GLOSSARY.md#smoa) workforce layer.

## Owned files

- `tools/evals/**`

## Gates

Run the focused evaluation scenario and `npm run evals:bench`, then run the source-size gate and strict module Graphify summary. Record environment limits that prevent a benchmark from representing the intended path.

## How to work here

Keep fixtures deterministic, separate evaluator logic from the behavior under test, and version material scoring changes. Do not tune the implementation against hidden evaluator details.
