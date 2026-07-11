# Coordination module tour

This tour explains leases, agent context, conflict records, controller snapshots, and ambient hooks. Controllers and implementers need it before changing how concurrent work is claimed or observed. Read it when a task touches edit sessions, dirty ownership, dispatch, or collision handling. Remember that coordination tools must record contention before an agent changes course.

## Purpose

The coordination module keeps concurrent agents from overwriting one another and gives controllers a compact view of active work. It depends on schemas for durable event contracts.

## Owned files

- `tools/sma-lease.mjs`, `tools/sma-start-edit.mjs`, and `tools/sma-end-edit.mjs`
- `tools/sma-context*.mjs`, `tools/sma-conflict.mjs`, and `tools/sma-merge.mjs`
- `tools/sma-controller-snapshot.mjs`, dirty-baseline, preflight, cleanup, and wave tools
- `tools/lib/context-log.mjs`, `tools/lib/gen3-state.mjs`, and `tools/hooks/**`

## Gates

Run the focused coordination self-tests, conflict checks, `npm run source:size:gate`, and the strict module Graphify summary. Verify both the success path and the held-lease path.

## How to work here

Claim a coordination brick before editing because these tools share state and logs. Preserve fail-soft hooks, stable machine-readable output, and session attribution across every command path.
