# Provenance module tour

This tour explains attestations, seals, Merkle proofs, license decisions, and similarity evidence. Maintainers who publish or verify bricks need it before changing the trust chain. Read it when a task touches provenance records, export policy, or license compatibility. Remember that each trust claim must resolve to stable source material and a verifiable digest.

## Purpose

The provenance module records where reusable material came from and whether it can move between projects. It depends on schemas for evidence contracts.

## Owned files

- `tools/sma-attest*.mjs`, `tools/sma-provenance-*.mjs`, and `tools/sma-anchor.mjs`
- `tools/lib/merkle*.mjs`, license helpers, seals, attestations, exports, and similarity helpers
- `tools/lib/ledger-resolve.mjs`

## Ownership and lane

`sma.gen3.json` assigns these paths to `prov`; the default lane is `single-module` and the required local gate is `npm run provenance:selftest`. Registry lifecycle operations, schemas, workflow files, package scripts, and `.UltraVision/` are outside this module; coordinate any evidence-format change that crosses those borders.

The module graph lives at `graphify-out/modules/prov/graphify-out/graph.json`. Query it with `npm run graphify:query -- --project sma --module prov -- "How do attestations, seals, Merkle proofs, license evidence, and exports connect?"` before broad reads.

## Gates

Run `npm run provenance:selftest`, verification commands for changed evidence formats, the source-size gate, and the strict module Graphify summary.

The performance-plan ceiling applicable to the integrated provenance path is `npm run check` below 120 seconds on the named baseline. Record elapsed time for material verifier or hashing changes; there is not a separate provenance latency budget in the current plan. The current GitHub workflow proves public-ledger generation but does not dispatch `npm run provenance:selftest` by affected path.

## How to work here

Preserve append-only evidence semantics and deterministic hashes. Keep registry actions outside this module and expose provenance decisions through narrow library functions.

Parse, digest, verification, license, and export failures must carry operation, evidence identifier or safe path, severity, and cause. Only explicitly expected absence may be treated as a documented fallback; never convert malformed evidence into silent success.
