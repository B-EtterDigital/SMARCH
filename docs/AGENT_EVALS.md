<!-- docs-i18n: key=docs.agent-evals; source=en; media=media/{locale}/agent-evals/ -->
# Agent evaluations

This guide explains how SMARCH evaluates its agent-facing workflows with deterministic fixtures, lessons, journeys, and performance checks. Evaluation authors and maintainers should use it to choose the right proof surface and to reproduce a failure. An evaluation result is evidence about the declared scenario, not a blanket score for an agent or product.

## Run the quality-gate bundle

The registered evaluation command runs three checks serially: fixture snapshot, lesson curriculum, and clean plugin profile.

```bash
node tools/sma.ts evals-run --json
```

Isolate one check while diagnosing a failure:

```bash
node tools/sma.ts evals-run \
  --only fixture-snapshot \
  --verbose
```

Valid `--only` values are `fixture-snapshot`, `lesson-curriculum`, and `plugin-clean-profile`. Exit code `0` means all selected checks passed, `4` means an evaluation failed, `2` means usage was invalid, and `1` means the runner itself failed.

## Run end-to-end journeys

```bash
node tools/evals/journeys/index.mjs
```

The journey index exercises the registered user paths, including quickstart, scan-to-clone, capsule creation, collision handling, dashboard navigation, MCP discovery, lessons, and submission-to-promotion. Journeys use disposable fixtures or read-only/help paths where live control-plane mutation would be unsafe.

Run a focused journey directly when its output identifies the failing path:

```bash
node tools/evals/journeys/capsule-create-to-promote.mjs
```

## Run the benchmark

```bash
npm run evals:bench
```

The benchmark measures repository operations against the declared performance plan. Record the machine and runtime when comparing results. A local pass is not continuous-integration proof; the repository currently does not wire this benchmark into GitHub Actions.

## Add or change an evaluation

1. Define one user or agent outcome and the exact failure signal.
2. Use public-safe, deterministic fixture inputs.
3. Keep evaluator logic separate from the behavior being evaluated.
4. Emit the scenario name, failed check, and actionable context.
5. Add a self-test for the runner or parser you changed.
6. Run the focused scenario, `node tools/evals/run.mjs --selftest`, and the benchmark when timing-sensitive code changed.

Do not tune implementation code against hidden evaluator details, swallow runner failures, or convert missing dependencies into passes. Expected fallbacks need an explicit assertion; real failures need a non-zero exit.

## Interpreting evidence

Use the narrowest honest claim:

- fixture snapshot: generated fixture truth has not drifted;
- lesson curriculum: the declared learning path remains structurally valid;
- plugin clean profile: installation works without relying on a polluted user profile;
- journey: one user path completed under its recorded fixture and environment;
- benchmark: measured operations met the budget on the recorded machine.

The implementation boundary and required module gates are summarized in [the evaluations module tour](modules/evals.md).
