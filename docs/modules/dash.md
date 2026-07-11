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

Run renderer and API self-tests, regenerate the affected view, then run the source-size gate and strict module Graphify summary. Compare generated output for stable ordering and meaningful changes.

## How to work here

Keep calculations in the owning data layer and render their result here. Serialize writes to generated shared views and verify the final page when a visible surface changes.
