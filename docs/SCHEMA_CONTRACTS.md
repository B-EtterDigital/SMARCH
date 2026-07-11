# Schema contracts

This reference records how SMARCH JSON Schemas are versioned, consumed, validated, retained, and rolled back. The schemas remain static contracts for files and interchange payloads; they are not database tables. Database query plans, indexes, down migrations, and full-scan budgets are therefore not applicable here.

## Compatibility and rollback

Every contract declares JSON Schema draft 2020-12, a stable `$id`, an instance version discriminator, and `x-sma-contract.version`. Optional additive fields may ship within v1. Removing or renaming a field, adding a required field, narrowing accepted values, or changing meaning requires a new versioned `$id` and instance discriminator.

Consumers must retain the prior decoder for a coordinated rollback window. A v1 rollback removes only fields that were optional additions; it must not rewrite immutable hashes, historical evaluations, release evidence, or audit records. The schema-case selftest performs a JSON round trip for every valid fixture and verifies the prior-compatible minimal instance after generation.

Corrupt or partial JSON is rejected before schema validation. The selftest injects a truncated payload for every contract, verifies detection, and emits a bounded `schema_integrity_failure` telemetry record instead of allowing consumers to continue with ambiguous data.

## Access and lifecycle

| Contract | Primary writers | Primary readers | Lifecycle and retention |
| --- | --- | --- | --- |
| `active-leases.schema.json` | lease tooling | Gen3 validators/controllers | Regenerated coordination state; retain only active/recent operational evidence. |
| `agent-context-event.schema.json` | context tooling | Gen3 validators/controllers | Append-only task evidence; retain with the project audit trail. |
| `backlog.schema.json` | backlog tooling | backlog/reporting tools | Durable debt record; retain through resolution or explicit wontfix rationale. |
| `brick.manifest.schema.json` | scaffolds and brick owners | scanner, validator, registry | Source-owned contract; retain with every brick version. |
| `build.manifest.schema.json` | build tooling and owners | build validation/release tools | Source-owned composition contract; retain with every build version. |
| `capsule-manifest-schema.json` | capsule template/new tooling | capsule runner and manifest validator | Source-owned executable capsule contract; retain with every capsule release. |
| `dependents-index.schema.json` | dependents index generator | propagation tooling | Regenerable index; retain current state and release evidence that referenced it. |
| `entitlement-schema.json` | downstream auth adapters | host authorization boundaries | Host-owned audit evidence; retention follows host policy and excludes secrets. |
| `eval-run-schema.json` | `tools/evals/bench.mjs` | CI/report consumers | Per-run measurement evidence; retain with CI/release evidence when needed. |
| `global.registry.schema.json` | registry scanner/merge tooling | discovery and controller tooling | Regenerable registry snapshot; retain published/release snapshots. |
| `import-lock.schema.json` | import tooling | verification and propagation tooling | Immutable import evidence; retain while the import or dependent release exists. |
| `merge-proposal.schema.json` | merge tooling | Gen3 validators/controllers | Coordination proposal; retain with its resolution evidence. |
| `placement-map.schema.json` | placement tooling | import/verification tooling | Project-local placement evidence; retain while placements exist. |
| `project.index.schema.json` | scanner | registry/report consumers | Regenerable project index; retain current and referenced release snapshots. |
| `release.schema.json` | release tooling | install/publish/wiki tooling | Immutable release evidence; retain permanently with the release. |
| `reuse-receipt.schema.json` | reuse tooling | scanner/backlog/reporting | Inheritance evidence; retain while dependent content or debt exists. |
| `server-card-schema.json` | MCP server-card tool | MCP clients/selftests | Request-scoped static metadata; clients may cache for the server version. |
| `submission-bundle-schema.json` | submission packager | verifier and curators | Immutable archive manifest; retain with the archive and curator decision. |
| `workforce-packet-schema.json` | orchestrators/callers | workforce dispatch and executors | Bounded task payload; retain with task evidence and never include credentials. |

Generated declarations in `tools/lib/schema-types/` are the typed query/access surface for feature code. Consumers should import those declarations instead of recreating record shapes or issuing raw assumptions against artifacts. Runtime producers remain responsible for validating at their boundary; the fixture selftest proves every shared contract independently.

## Validation and performance

Each contract has a reusable `valid.json` and `invalid.json` under `tools/evals/fixtures/schema-cases/<schema-name>/`. `selftest.mjs` rejects unsupported schema keywords, proves valid and invalid cases, checks corruption telemetry and JSON round trips, and runs a realistic repeated-validation budget.

Because these are static file/payload contracts, “hot query”, “index usage”, and “10x database volume” are N/A. The relevant budget is bounded validation: arrays representing result sets are capped where the shipped producer has a natural bound, and the selftest validates every fixture repeatedly under one explicit wall-clock budget.
