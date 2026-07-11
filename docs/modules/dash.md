# Dashboard module tour

This tour explains the generated wiki, controller dashboard, local server, and dashboard data APIs. Maintainers and operators need it before changing portfolio views or controller rendering. Read it when a task changes displayed readiness, module state, or dashboard interactions. Remember that the dashboard must render stable generated truth rather than inventing status.

## Purpose

The dashboard module turns registry, coordination, and graph data into self-hostable operator views. It may depend on schemas, registry, coordination, and graph modules.

## Owned files

- `tools/sma-wiki*.mjs`
- `tools/sma-gen3-dashboard.mjs` and `tools/sma-dashboard-server.mjs`
- `tools/sma-brick-wall-lego.mjs` and `tools/lib/gen3-renderers.mjs`
- `tools/lib/dash-api/**` and `web/**`

## Gates

The module-local gate declared by `sma.gen3.json` is `node tools/sma-gen3-dashboard.mjs --selftest`. In this audit, that command exited with `unknown subcommand: --selftest`; the dashboard CLI exposes `build` only. Treat the declared gate as an open harness defect. Do not substitute a different command. Also run available renderer/API checks, regenerate the affected view under its lease, then run the source-size gate and strict module Graphify summary. Compare generated output for stable ordering and meaningful changes.

The module gate is available to Gen3 module dispatch, but the current GitHub workflow does not dispatch affected module gates. Treat affected-CI wiring as open shared-CI work.

## Public seams

The dashboard build and local server commands, generated wiki/dashboard files, `tools/lib/dash-api/**`, and browser-facing `web/**` payloads are public seams. Renderers consume registry, coordination, and graph truth; callers must not infer state from presentation markup.

## Graph and ownership query

The graph lives at `graphify-out/modules/dash/graphify-out/graph.json`. Refresh with `npm run graphify:refresh:modules -- --project sma --missing-only`, then query with `npm run graphify:query -- --project sma --module dash -- "Where does controller state become dashboard output?"`.

## Telemetry and performance

Optional generated inputs may return an explicit `null` or fallback object; user actions and server failures must render or return an error. Malformed graph inputs contribute unreadable counts. The dashboard budget is TTI under 2 seconds and input latency under 100 milliseconds on fixture data. `tools/evals/bench.mjs` measures other shared budgets but not dashboard TTI. Its self-test is red, and GitHub Actions does not run it; dashboard performance-CI coverage remains open.

## Hot-path borders

Generated wiki/state/dashboard files and their regeneration leases are shared hot paths. Keep registry calculations, coordination policy, graph extraction, and schema changes in their owning modules; visible UI changes require live rendered verification.

## How to work here

Keep calculations in the owning data layer and render their result here. Serialize writes to generated shared views and verify the final page when a visible surface changes.
