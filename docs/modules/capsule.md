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

Run the focused brick command checks, `npm run source:size:gate`, and the strict module Graphify summary before handoff. A runnable example must prove the declared inputs, outputs, and failure behavior.

## How to work here

Claim the capsule brick before editing and keep shared schema or registry changes in their owning modules. Add behavior through the capsule contract, preserve inspectability, and report any cross-module collision before continuing.
