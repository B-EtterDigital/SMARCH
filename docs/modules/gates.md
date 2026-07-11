# Gates module tour

This tour explains the rule, scope, security, license, compliance, size, and validation gates. Gate authors and release controllers need it before changing a pass condition or report format. Read it when a task changes what blocks integration or promotion. Remember that a gate must fail with an actionable reason and no false success.

## Purpose

The gates module enforces the project contracts used by local work, CI, and release flows. It depends on schemas for validation contracts.

## Owned files

- `tools/sma-rule-gate.mjs`, `tools/sma-scope-drift.mjs`, and security, license, and compliance gates
- `tools/sma-source-size-gate.mjs` and `tools/source-size-baseline.json`
- `tools/sma-validate*.mjs`, `tools/sma-ci.mjs`, and `tools/lib/compliance-controls.mjs`

## Ownership and lane

`sma.gen3.json` assigns the paths above to `gates`; the default lane is `single-module` and its required local gate is `npm run gate:all`. Package scripts, workflow files, schemas, registry code, provenance internals, and `.UltraVision/` are shared or separately owned borders rather than gate-module implementation space.

The module graph lives at `graphify-out/modules/gates/graphify-out/graph.json`. Query it with `npm run graphify:query -- --project sma --module gates -- "Which gate commands call each validator and report writer?"` before broad reads. Global graph refreshes require a graph-state claim.

## Gates

Run the changed gate's self-test, `npm run gate:all`, `npm run validate:gen3`, and the strict module Graphify summary. Include a fixture that proves the gate rejects the target violation.

The performance-plan budget relevant to this module is the complete `npm run check` suite in under 120 seconds on the named baseline runner. Capture elapsed time when validating a gate-path change. The current GitHub workflow runs syntax and ledger checks only; it does not yet dispatch `npm run gate:all` by affected module, so CI coverage must not be claimed from the registered local gate alone.

## How to work here

Keep each rule deterministic and explain remediation in machine and human output. Coordinate baseline changes and never weaken a gate to make an unrelated patch pass.

Every caught validation, file, or subprocess failure must reach the gate report or stderr with the gate area, severity, and target context. Suppress only explicitly expected absence checks; never turn malformed or unreadable input into a silent pass.
