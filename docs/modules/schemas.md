# Schemas module tour

This tour explains the JSON Schemas and generated types that define shared data contracts. Schema authors and every dependent module maintainer need it before changing a field, enum, or validation rule. Read it before editing a contract or consuming a type from a schema change. Remember that schema changes are shared hot-path work and generated types must match the source schema.

## Purpose

The schemas module is the single source of truth for data exchanged across Sweetspot modules. Other modules may depend on it, while it remains dependency-free.

## Owned files

- `schemas/**`
- `tools/lib/schema-types/**`

## Gates

Run `node tools/lib/schema-types/generate.mjs --check`, `node tools/evals/fixtures/schema-cases/selftest.mjs`, the source-size gate, and the strict module Graphify summary. The full access, versioning, lifecycle, retention, rollback, integrity, and static-contract performance policy lives in [Schema contracts](../SCHEMA_CONTRACTS.md).

The configured module gate is `npm run validate:gen3 -- all`. Query the module graph with `npm run graphify:query -- --project sma --module schemas -- "<question>"`; its generated graph lives under `graphify-out/modules/schemas/`.

## How to work here

Serialize schema edits, describe every field, and regenerate types in the same change. Treat breaking changes as versioned migrations and coordinate every dependent module before release.
