# Provenance module tour

This tour explains attestations, seals, Merkle proofs, license decisions, and similarity evidence. Maintainers who publish or verify bricks need it before changing the trust chain. Read it when a task touches provenance records, export policy, or license compatibility. Remember that each trust claim must resolve to stable source material and a verifiable digest.

## Purpose

The provenance module records where reusable material came from and whether it can move between projects. It depends on schemas for evidence contracts.

## Owned files

- `tools/sma-attest*.mjs`, `tools/sma-provenance-*.mjs`, and `tools/sma-anchor.mjs`
- `tools/lib/merkle*.mjs`, license helpers, seals, attestations, exports, and similarity helpers
- `tools/lib/ledger-resolve.mjs`

## Gates

Run `npm run provenance:selftest`, verification commands for changed evidence formats, the source-size gate, and the strict module Graphify summary.

## How to work here

Preserve append-only evidence semantics and deterministic hashes. Keep registry actions outside this module and expose provenance decisions through narrow library functions.
