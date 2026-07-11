# Engineering Review Response

This document records the main engineering critiques of Sweetspot Modular Architecture and the concrete response to each one. Maintainers, reviewers, and adopters need it when they challenge the system's tradeoffs or verify that a concern has an operational answer. Read it before changing the architecture in response to a recurring objection. Remember that a response counts only when repository rules and tooling enforce it.

This file records the skeptical senior-engineer review and the design response.

## Critique: Too Many Acronyms

Risk: people dismiss SMA before understanding it.

Response:

- Public vocabulary is limited to five words: brick, manifest, gate, registry, canonical.
- Internal gate names stay in manifests and tooling.
- User education teaches lifecycle first, acronyms second.

Artifacts:

- `docs/PUBLIC_POSITIONING.md`
- `docs/TERMINOLOGY.md`
- `docs/intro/START_HERE.md`

## Critique: Methodology Without Enforcement

Risk: documents become taste, not architecture.

Response:

- Every brick has a schema.
- Every brick can be validated.
- Canonical status has hard blockers.
- CI templates run scan, validate, and wiki generation.

Artifacts:

- `schemas/brick.manifest.schema.json`
- `tools/sma-validate.mjs`
- `tools/sma-ci.mjs`
- `templates/github/sma-ci.yml`

## Critique: Copying Code Creates Hidden Coupling

Risk: copied bricks silently depend on auth, DB, env, routes, styles, billing, or provider assumptions.

Response:

- Clone contract is required.
- Adapter points are explicit.
- Env vars are declared by scope.
- RLS and storage access are declared when applicable.
- Known traps are required.

Artifacts:

- `docs/BRICK_METADATA.md`
- `docs/GOVERNANCE.md`
- `templates/brick/module.sweetspot.json`

## Critique: Global Registry Becomes A Junk Drawer

Risk: more collected modules make reuse harder, not easier.

Response:

- Registry status is explicit.
- Duplicate, legacy, project-bound, and unsafe bricks stay visible.
- Canonical promotion requires review and evidence.
- Deletion and deprecation are first-class governance actions.

Artifacts:

- `docs/REGISTRY_WORKFLOW.md`
- `docs/GOVERNANCE.md`
- `registry/global-modules.generated.json` (`canonicalization` and
  `scanner_report.duplicate_clusters`)
- `tools/sma-canonicalization.mjs`

## Critique: Subjective Quality Scores

Risk: score hides missing security or tests.

Response:

- Score is weighted by gates.
- Hard blockers override scores.
- Validator flags score drift and canonical violations.
- Findings are kept separate from score.

Artifacts:

- `tools/sma-score.mjs`
- `tools/sma-validate.mjs`
- `docs/ENFORCEMENT.md`

## Critique: Model Provenance Can Become Vanity Metadata

Risk: "made by model X" is treated as quality proof.

Response:

- Provenance records actors and evidence, not prestige.
- Model touches should include task, files, commit/hash, summary, and verification.
- Human/security review is separate.

Artifacts:

- `docs/BRICK_METADATA.md`
- `schemas/brick.manifest.schema.json`

## Critique: NASA Claims Sound Like Marketing

Risk: credibility loss.

Response:

- Public claim is reliability-oriented, not NASA-grade.
- Inspiration is described as fault isolation and checklist discipline only.
- Evidence and gates carry the argument.

Artifacts:

- `docs/PUBLIC_POSITIONING.md`

## Bottom Line

The serious version of SMA is not "my architecture is better."

It is:

> AI-heavy teams need reusable modules with explicit boundaries, proof, provenance, and rejection rules.

That is a defensible engineering position.
