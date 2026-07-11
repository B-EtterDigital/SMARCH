# Sync module tour

This tour explains the controlled flow between the local and public repositories. Release maintainers need it before changing scrub rules, leak checks, or public synchronization. Read it when a task prepares or verifies a public export. Remember that public sync must fail closed when private paths or secrets remain.

## Purpose

The sync module exports approved repository content through scrub and leak gates. It may depend on gates and the registry.

## Owned files

- `tools/sma-sync-public.mjs`
- `docs/SYNC_RUNBOOK.md`

## Gates

Run the sync command in dry-run mode, leak and compliance gates, the source-size gate, and the strict module Graphify summary. Inspect the produced public diff before publication.

## How to work here

Keep the scrub map explicit and review additions to the public surface. Never bypass a failed leak gate or copy fork-only material into the canonical public source.
