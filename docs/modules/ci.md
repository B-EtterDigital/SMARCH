# CI module tour

This tour explains the repository automation that runs checks on commits and pull requests. Maintainers and release engineers need it before changing workflow, leak scanning, TypeScript, or pre-commit configuration. Read it when a task changes automated verification or runner behavior. Remember that CI changes affect every module and require serialized review.

## Purpose

The CI module owns shared automation surfaces, including GitHub Actions and repository-wide tool configuration. The target architecture classifies it as a shared hot path with no module dependencies.

## Owned files

- `.github/**`
- `.gitleaks.toml`
- `.pre-commit-config.yaml`
- `tsconfig.json`

## Gates

The module-local gate declared by `sma.gen3.json` is `npm run check`. Run the changed workflow locally where tooling permits, then run `npm run ci:gen3` before integration. Confirm that secret scanning and required checks still fail closed.

The current `.github/workflows/gates.yml` syntax-checks tools but does not dispatch the affected module gates or `tools/evals/bench.mjs`. Treat affected-CI and performance-budget coverage as open until that shared workflow is changed by its serialized owner.

## Public seams

GitHub workflow triggers, job outputs, repository check names, leak rules, pre-commit hooks, and the shared TypeScript contract are the module's public seams. Downstream modules consume their pass/fail result; they do not import CI implementation details.

## Graph and ownership query

The module graph is expected at `graphify-out/modules/ci/graphify-out/graph.json`. Refresh it with `npm run graphify:refresh:modules -- --project sma --missing-only`, then query it with `npm run graphify:query -- --project sma --module ci -- "What automation does CI own?"`.

The current graph file is a known-empty graph because Graphify extracts code files and the CI-owned workflow/configuration surface contributes no supported code nodes. Use `sma.gen3.json` for ownership answers until Graphify supports this surface; do not present the empty graph as query proof.

## Telemetry and performance

CI failures must remain visible as failed checks with the command, module, and provider context; do not swallow workflow failures or convert them to successful steps. The applicable performance-plan budget is `npm run check` under 120 seconds on the named baseline runner. `node tools/evals/bench.mjs --selftest --json` is the measuring harness, but this audit found its fixture-quality preflight failing on schema version drift. The performance gate is red.

## Hot-path borders

All `.github/workflows/**`, `.gitleaks.toml`, and `tsconfig.json` changes are shared hot-path work. Keep product code, module-specific implementation, and generated UltraVision records outside this module's patch.

## How to work here

Serialize edits under one lease, keep workflow permissions narrow, and avoid mixing product changes into the same patch. Record provider or credential blockers when a live runner path cannot be exercised.
