# Roadmap to SMARCH 1.0

This page turns the 100-improvement campaign into a readable release path. It explains what each milestone proves, what is deliberately deferred, and where contributors should look for exact task state.

## How to read the roadmap

The roadmap is outcome-based. A milestone is complete only when its definition of done is backed by current tests, security checks, documentation, and release evidence. The machine-readable `.UltraVision/` records are the plan of record for individual tasks; this page does not duplicate their live status.

## M0 — Trust and plumbing

M0 establishes the evidence floor:

- erasable TypeScript and a real `tsc --noEmit` gate;
- strict UltraVision validation and fresh module graphs;
- public CI, secret scanning, and private-identifier leak checks;
- provenance, licensing, seals, and reproducible fixture evidence;
- docs lint and executable journeys that fail when examples drift.

M0 is done only when the repository can explain a failure without hiding it and a clean checkout can reproduce the core checks.

## M1 — The new face

M1 makes the system understandable and usable without reading its internals:

- demo-first onboarding and a verified five-minute quickstart;
- the intro learning lane, glossary, contributor path, and community submission flow;
- a self-hosted dashboard foundation using the Blueprint Ledger design language;
- registry, lease, conflict, and graph APIs behind explicit contracts;
- accessibility and locale-ready string/media boundaries from the first UI commit.

M1 is done when a new user can scan a fixture portfolio, read what happened, clone a brick, and recover from the documented failure paths.

## M2 — Beta

M2 strengthens scale and portability:

- schema-derived types and broader tool migration;
- evaluated skills and multi-agent workflows;
- pluggable workforce-backend contracts with tested failure semantics;
- capsule-grade bricks with constraint-first scaffolds;
- richer Graphify retrieval and trustworthy staleness detection;
- signed release, propagation, and dependent-update workflows.

Beta means the workflows are useful beyond the founding repository, not that every future backend or hosted service exists.

## M3 — 1.0

The 1.0 bar is a product proof, not a version-number ceremony:

- the `smarch-core` Rust kernel passes parity tests against the Node scanner on the fixture portfolio and ships as a release binary;
- seeded agent evaluations produce trend reports;
- the self-hosted dashboard covers the lease board, conflict strip, registry wall, and graph navigation;
- commercial metadata and entitlement boundaries are documented without weakening the open Apache-2.0 core;
- oversized shared files are split along maintainable module seams;
- the public showcase and release artifacts are reproducible from a clean checkout.

## Beyond 1.0

Federation, hosted operation, and cloud lease coordination remain research lanes until their threat models, cost boundaries, and maintenance owners are explicit. They should not block a strong local-first 1.0.

## Release-ready checklist

Every milestone release requires the repository check, typecheck, docs lint, journey suite, secret and private-identifier scans, strict UltraVision validation, fresh module graphs, and a clean integration branch. Any unavailable external proof is named as a blocker; it is not replaced by a mock success.

For adoption sequencing rather than product milestones, use [Adoption Roadmap](ADOPTION_ROADMAP.md). For the exact UltraVision workflow, use [Sweetspot Ultra Plan](SUP_SWEETSPOT_ULTRA_PLAN.md).

<!-- docs-i18n: key=docs.roadmap-100; source=en; media=media/{locale}/roadmap-100/ -->
