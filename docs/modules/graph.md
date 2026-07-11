# Graph module tour

This tour explains the Graphify bridge, graph repair packets, staleness checks, and query surfaces. Module agents and controllers need it before refreshing or changing project knowledge graphs. Read it when a task changes graph extraction, lookup, summaries, or repair routing. Remember that agents should query the smallest current graph that can answer their question.

## Purpose

The graph module gives agents bounded structural context for module and project work. It may depend on schemas and the registry.

## Owned files

- `tools/sma-graphify.mjs`
- `tools/sma-graph-packets.mjs`

## Gates

Run the graph self-check, a representative query, `npm run source:size:gate`, and the strict module Graphify summary. Confirm that stale or missing graphs produce an actionable repair path.

## How to work here

Claim graph refresh work before writing global graph state. Keep local code-only extraction as the default and treat semantic provider use as an explicit option.
