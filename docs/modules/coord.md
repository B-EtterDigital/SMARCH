# Coordination module tour

This tour explains leases, agent context, conflict records, controller snapshots, and ambient hooks. Controllers and implementers need it before changing how concurrent work is claimed or observed. Read it when a task touches edit sessions, dirty ownership, dispatch, or collision handling. Remember that coordination tools must record contention before an agent changes course.

## Purpose

The coordination module keeps concurrent agents from overwriting one another and gives controllers a compact view of active work. It depends on schemas for durable event contracts.

## Owned files

- `tools/sma-lease.ts`, `tools/sma-start-edit.ts`, and `tools/sma-end-edit.ts`
- `tools/sma-context*.mjs`, `tools/sma-conflict.ts`, and `tools/sma-merge.ts`
- `tools/sma-controller-snapshot.ts`, dirty-baseline, preflight, cleanup, and wave tools
- `tools/lib/context-log.ts`, `tools/lib/gen3-state.ts`, and `tools/hooks/**`

## Gates

The module-local gate declared by `sma.gen3.json` is `npm run gen3:selftest`. Also run `npm run conflict:check -- --project sma --strict`, `npm run source:size:gate`, and the strict module Graphify summary. Verify both the success path and the held-lease path.

The module gate is available to Gen3 module dispatch, but the current GitHub workflow does not dispatch affected module gates. Treat affected-CI wiring as open shared-CI work.

## Public seams

The public command seams are `start:edit`, `end:edit`, lease acquire/release/run, context receipts, conflict report/resolve/check, dirty baselines, controller snapshots, and preflight/cleanup packets. Durable NDJSON context and conflict records are machine-readable contracts; preserve their schema and stdout discipline.

## Graph and ownership query

The graph lives at `graphify-out/modules/coord/graphify-out/graph.json`. Refresh with `npm run graphify:refresh:modules -- --project sma --missing-only`, then query with `npm run graphify:query -- --project sma --module coord -- "How does a held lease become a controller-visible conflict?"`.

## Telemetry and performance

Expected absence and parse fallbacks return explicit fallback values; operational failures must surface in command output, result objects, context events, or non-zero exits with project, resource, and intent context. Cleanup-only failures such as a best-effort child kill may be ignored where the process result remains authoritative. The performance plan gives no separate coordination budget; measure relevant commands within the repository check budget and use the benchmark harness for shared scan/graph limits. This audit found the benchmark red and absent from GitHub Actions.

## Hot-path borders

Lease registries, context logs, conflict logs, controller snapshots, dirty baselines, and global regeneration resources are serialized state. Do not combine coordination edits with module implementation or generated portfolio refreshes, and never force-acquire without a recorded conflict and controller reason.

## How to work here

Claim a coordination brick before editing because these tools share state and logs. Preserve fail-soft hooks, stable machine-readable output, and session attribution across every command path.
