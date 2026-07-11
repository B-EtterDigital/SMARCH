# Capsule module tour

This tour explains the constraint-first brick runtime and the tools that scaffold, run, and inspect capsules. Brick authors and maintainers need it before changing the capsule template or command surface. Read it when a task touches capsule packaging or execution. Remember that a capsule must expose a small, inspectable contract instead of carrying project assumptions.

## Purpose

The capsule module provides the smallest runnable tier for a portable brick. It depends on schemas, the registry, and gates for contracts, discovery, and verification.

## Owned files

- `templates/capsule/**`
- `tools/sma-brick-new.mjs`
- `tools/sma-brick-run.mjs`
- `tools/sma-brick-inspect.mjs`

## Gates

The module-local gate declared by `sma.gen3.json` is `node tools/sma-brick-run.mjs --selftest`. Also run `npm run source:size:gate` and the strict module Graphify summary before handoff. A runnable example must prove the declared inputs, outputs, and failure behavior.

The module gate is available to Gen3 module dispatch, but the current GitHub workflow does not dispatch affected module gates. Treat affected-CI wiring as open shared-CI work.

## Public seams

`sma-brick-new`, `sma-brick-run`, and `sma-brick-inspect` are the command seams. `templates/capsule/**` defines the generated runtime contract: declared inputs, outputs, ports, constraints, result protocol, and inspectable metadata.

## Graph and ownership query

The graph lives at `graphify-out/modules/capsule/graphify-out/graph.json`. Refresh with `npm run graphify:refresh:modules -- --project sma --missing-only`, then query with `npm run graphify:query -- --project sma --module capsule -- "What contract does a generated capsule expose?"`.

## Telemetry and performance

Runtime and child-protocol errors must become typed capsule failures or failed self-test results with fixture and constraint context. Test-only catches may capture an expected refusal when a following assertion proves the exact failure. The applicable performance-plan baseline is the repository check budget; there is no capsule-specific timing row. This audit found the shared benchmark red and absent from GitHub Actions, so the capsule module has no performance-CI proof.

## Hot-path borders

Keep capsule templates and runner/scaffolder behavior here. Schema, registry, gate, package, and UltraVision changes are separate owned or shared surfaces and require their own serialized handoff.

## How to work here

Claim the capsule brick before editing and keep shared schema or registry changes in their owning modules. Add behavior through the capsule contract, preserve inspectability, and report any cross-module collision before continuing.
