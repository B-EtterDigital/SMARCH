# Schemas module tour

This tour explains the JSON Schemas and generated types that define shared data contracts. Schema authors and every dependent module maintainer need it before changing a field, enum, or validation rule. Read it before editing a contract or consuming a type from a schema change. Remember that schema changes are shared hot-path work and generated types must match the source schema.

## Purpose

The schemas module is the single source of truth for data exchanged across Sweetspot modules. Other modules may depend on it, while it remains dependency-free.

## Owned files

- `schemas/**`
- `tools/lib/schema-types/**`

## Gates

Run `node tools/lib/schema-types/generate.mjs --check`, schema validation tests, the source-size gate, and the strict module Graphify summary.

## How to work here

Serialize schema edits, describe every field, and regenerate types in the same change. Treat breaking changes as versioned migrations and coordinate every dependent module before release.
