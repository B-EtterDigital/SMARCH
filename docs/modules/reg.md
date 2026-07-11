# Registry module tour

This tour explains scanning, registry generation, brick storage, cloning, release, promotion, and portfolio state. Registry maintainers and controllers need it before changing discovery or lifecycle behavior. Read it when a task changes how projects or bricks enter, move through, or leave the registry. Remember that generated registry state must trace to manifests and current gate evidence.

## Purpose

The registry module is the lifecycle hub for Sweetspot projects and reusable bricks. It may depend on schemas, provenance, gates, and the Rust kernel.

## Owned files

- `tools/sma-scan.mjs`, state and registry merge tools
- Store, clone, release, publish, promote, doctor, filter, match, and update tools
- Portfolio, backlog, reuse, propagation, scoring, token, and module-work tools
- Registry support libraries listed under `reg` in `sma.gen3.json`

## Gates

Run focused registry self-tests, validate generated output stability, then run the source-size gate and strict module Graphify summary. Lifecycle changes also need a representative scan-to-release path.

## How to work here

Use the registry lease for global regeneration and keep fork updates separate from canonical source releases. Avoid hand-editing generated registry artifacts.
