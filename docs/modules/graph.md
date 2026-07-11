# Graph module tour

This tour explains the Graphify bridge, graph repair packets, staleness checks, and query surfaces. Module agents and controllers need it before refreshing or changing project knowledge graphs. Read it when a task changes graph extraction, lookup, summaries, or repair routing. Remember that agents should query the smallest current graph that can answer their question.

## Purpose

The graph module gives agents bounded structural context for module and project work. It may depend on schemas and the registry.

## Owned files

- `tools/sma-graphify.ts`
- `tools/sma-graph-packets.ts`

## Ownership and lane

`sma.gen3.json` maps these files to `graph`; the default lane is `single-module` and its required local gate is `node tools/sma-graphify.ts selftest`. Module source maps, project manifests, registry records, and `.UltraVision/` stay with their owners. Writes to project, module, or global graph caches are shared-state operations and must be claimed and serialized.

This module's own graph lives at `graphify-out/modules/graph/graphify-out/graph.json`. Query it with `npm run graphify:query -- --project sma --module graph -- "Where are graph refresh, staleness checks, queries, and repair packets implemented?"` before broad reads.

## Gates

Run the graph self-check, a representative query, `npm run source:size:gate`, and the strict module Graphify summary. Confirm that stale or missing graphs produce an actionable repair path.

The performance plan budgets a code-only single-module refresh below 30 seconds, a warm query below 2 seconds, and a cold index build below 10 seconds per 1,000 nodes on the named baseline. Measure those paths with `npm run evals:bench` when graph runtime behavior changes. The current GitHub workflow does not dispatch the graph self-test or benchmark by affected path.

## How to work here

Claim graph refresh work before writing global graph state. Keep local code-only extraction as the default and treat semantic provider use as an explicit option.

Fallbacks must distinguish an expected missing optional cache from an unreadable or malformed graph. Report real failures with operation, project/module, severity, path, and fallback context; a fallback is not permission to silently discard the cause.
