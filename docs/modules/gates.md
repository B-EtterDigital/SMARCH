# Gates module tour

This tour explains the rule, scope, security, license, compliance, size, and validation gates. Gate authors and release controllers need it before changing a pass condition or report format. Read it when a task changes what blocks integration or promotion. Remember that a gate must fail with an actionable reason and no false success.

## Purpose

The gates module enforces the project contracts used by local work, CI, and release flows. It depends on schemas for validation contracts.

## Owned files

- `tools/sma-rule-gate.mjs`, `tools/sma-scope-drift.mjs`, and security, license, and compliance gates
- `tools/sma-source-size-gate.mjs` and `tools/source-size-baseline.json`
- `tools/sma-validate*.mjs`, `tools/sma-ci.mjs`, and `tools/lib/compliance-controls.mjs`

## Gates

Run the changed gate's self-test, `npm run gate:all`, `npm run validate:gen3`, and the strict module Graphify summary. Include a fixture that proves the gate rejects the target violation.

## How to work here

Keep each rule deterministic and explain remediation in machine and human output. Coordinate baseline changes and never weaken a gate to make an unrelated patch pass.
