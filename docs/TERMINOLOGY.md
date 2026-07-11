# Terminology

This document is the naming contract for public concepts, internal gates, and optional modules in Sweetspot. Writers, implementers, and reviewers need it when they introduce or rename a term. Read it before publishing user-facing copy, schemas, commands, or architecture documents. Remember to use one approved name for each concept so code and documentation stay searchable together.

Public SMA vocabulary should stay small.

## Public Terms

| Term | Meaning |
|------|---------|
| Project | A private app, repo, or monorepo that composes builds, bricks, and private product logic |
| Build | A reusable capability composed from multiple bricks |
| Brick | A reusable unit with a contract |
| Module | A cohesive unit inside a brick; sometimes a brick itself when separately reusable |
| Component | A UI or implementation unit inside a module; not a brick unless it opts in |
| Manifest | The metadata file that explains contract, gates, provenance, and clone or update rules |
| Release | A versioned snapshot of a brick or build |
| Import | An installed instance of a released brick or build inside a target project |
| Placement | The exact mapping from source artifact parts to target files and symbols |
| Gate | A required proof such as tests, security checks, RLS checks, or performance checks |
| Registry | The searchable inventory of bricks, builds, and releases |
| Canonical | The preferred brick or build for new projects |

## Boundary Meanings

Keep these distinctions sharp:

- `Project` = private composition boundary
- `Build` = capability boundary
- `Brick` = copy boundary
- `Release` = publish and update boundary
- `Import` = installed-instance boundary
- `Placement` = exact source-to-target mapping boundary

## Internal Gate Names

These names are useful in tooling and manifests, but should not be the first thing new users learn.

| Gate | Plain Meaning |
|------|---------------|
| SSA-v2 | Security and architecture boundary |
| [SSI](GLOSSARY.md#ssi) | Failure isolation and access gating |
| [SSTF](GLOSSARY.md#sstf) | Testing proof |
| [SPE](GLOSSARY.md#spe) | Performance proof |
| [SRS](GLOSSARY.md#srs) | Observability proof |
| SSRA | Release readiness |
| SSTT | Task tracking |
| SAS | Agent swarm ownership |
| [SVA](GLOSSARY.md#sva) | Vulnerability audit |
| [SRLS](GLOSSARY.md#srls) | RLS/storage/database access proof |
| [SEV](GLOSSARY.md#sev) | Env and secret hygiene |
| SDC | Data classification |
| [SSC](GLOSSARY.md#ssc) | Supply-chain and provenance |
| SAI | Agent integrity |

## Known Optional Module Names

These names are not universal gates. They are known module contracts that a project can opt into when the use case needs them.

| Module | Plain Meaning |
|--------|---------------|
| SVD | Sweetspot Visual Demo: ordered demo, walkthrough, numbered proof claims, screenshot quality checks, proof gallery, and annotated screenshot evidence |

## Naming Rule

If an acronym does not produce a check, field, command, or review decision, it should not exist.

<!-- docs-i18n: key=docs.terminology; source=en; media=media/{locale}/terminology/ -->
