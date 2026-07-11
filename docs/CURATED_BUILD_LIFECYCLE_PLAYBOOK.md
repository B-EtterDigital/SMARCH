# Curated Build Lifecycle Playbook

This playbook explains how a scanned capability becomes a reviewed, reusable build. Build curators, project owners, and release reviewers need it as they move work between lifecycle states. Read it before promoting, updating, or retiring a build under `builds/`. Remember that each transition requires current source evidence and an explicit reviewer decision.

Status: operating playbook for promoted builds under `builds/`.

This doc explains how a curated build moves through the real SMARCH lifecycle:

- scanner candidate
- curated build candidate
- verified build
- canonical build
- private publishable build

It is intentionally conservative.

Current repo reality:

- `builds/` contains no curated `*.build.sweetspot.json` manifests
- the build schema, verifier, promotion, release, publish, clone, and index
  tooling exist
- `examples/build.sweetspot.json` is a schema example, not a promoted build
- no repository build should currently be treated as candidate, verified,
  canonical, or privately publishable

Source of truth:

- `schemas/build.manifest.schema.json`
- `examples/build.sweetspot.json`
- `tools/sma-build-verify.ts`
- `tools/sma-build-promote.ts`
- [docs/BUILD_LAYER_IMPLEMENTATION_PLAN.md](BUILD_LAYER_IMPLEMENTATION_PLAN.md)
- [docs/GOVERNANCE.md](GOVERNANCE.md)

## The Main Rule

Scanner evidence can justify creating a curated build candidate.

Scanner evidence cannot justify:

- verified
- canonical
- publishable

Those states require explicit proof and review.

## Lifecycle Overview

## 1. Scanner Candidate

This is the discovery state.

What it means:

- the scanner found a recurring or high-confidence capability cluster
- the cluster has enough structure to be worth human review

What it does not mean:

- the capability is safe to clone
- the capability is safe to update
- the capability is safe to publish

Required outputs:

- build candidate key or recurrence key
- candidate explanation
- source project and sample paths

## 2. Curated Build Candidate

This is the first real build state under `builds/`.

A curated candidate must have:

- explicit build id, summary, and owner
- explicit brick composition
- explicit flows and interfaces
- explicit env/auth/data/network/performance contracts
- explicit clone stance
- explicit upgrade stance
- explicit publishing stance
- explicit provenance
- no invented runtime proof

This is the first stage a future curated manifest under `builds/` may enter.

## Candidate Checklist

A build is ready for curated `candidate` only when:

- the capability boundary is clear enough to describe in one paragraph
- required vs optional bricks are separated
- non-prod helpers are called out explicitly
- verification is honest about what was reviewed vs what was actually run
- clone says `manual_only`, `guided`, or `copy_ready` honestly
- publishing says `publishable: false` unless a real redaction and release story exists
- economics are marked as estimates, not measured facts
- provenance clearly shows curation and source inputs

## 3. Verified Build

Verified is not a style upgrade. It is a proof upgrade.

A build becomes `verified` only when it has build-level evidence, not just
brick-level or scanner-level evidence.

Minimum verified bar:

- at least one build-level smoke or fixture result recorded as `pass`
- at least one target or fixture where install assumptions were exercised
- clone steps are explicit enough that another engineer could follow them
- update planning is meaningful for the installed artifact
- env, auth, and negative-path checks are explicit for the risk class

For high-risk builds, verified also requires:

- privileged auth review for admin builds
- tenant-isolation or RLS review where data scoping matters
- rollback steps that are specific enough to execute

## Verified Checklist

- `verification.status` is `verified`
- at least one `verification.evidence[].status` is `pass` from a real smoke, fixture, or review command
- no verification event still uses scanner clustering as its strongest proof
- `clone.readiness` is at least honestly aligned with what was proven
- `upgrade` no longer reads like guesswork
- `provenance.reviewed_by` is no longer empty when separate review actually happened

## 4. Canonical Build

Canonical is a preference decision, not just a proof decision.

A canonical build is the preferred build for new work inside the organization.

Canonical requires everything verified requires, plus:

- repeated success on a second target, fixture, or repeated installation path
- explicit owner and review cadence
- acceptable risk posture for its domain
- no unresolved blocker in the build’s critical trust surfaces
- no better internal alternative that should stay preferred instead

Canonical should be rare.

Do not promote a build to canonical because:

- it looks impressive
- it has a good summary
- the scanner score is high
- the site needs more “finished” assets

## Canonical Checklist

- build `status` becomes `canonical`
- build `trust_tier` becomes `canonical`
- evidence exists for repeated reuse or repeated verification
- the build has a clear successor/demotion path if trust drops later

## 5. Private Publishable Build

This is a separate axis from canonical.

A build can be:

- verified but not privately publishable
- canonical but still not publishable
- privately publishable without being canonical for all teams

Private publishable means:

- the build can be packaged and shared internally without shipping the whole project
- secrets, tenant data, internal runbooks, and private composition details are excluded
- the redaction profile is explicit
- the release and import/update story is good enough that another team can consume it responsibly

## Private Publishable Checklist

- `publishing.publishable` can move from `false` to `true` only when:
- a release artifact exists
- excluded assets are explicit and believable
- exposed docs are sufficient for another internal team
- source paths do not leak private customer or operator data
- the build can be reviewed as a capability instead of raw repo archaeology

For high-risk builds, private publishable also needs:

- explicit authz/audit posture
- explicit rollback instructions
- evidence that the build does not rely on project-private secrets or manual tribal knowledge

## Two Separate Promotion Tracks

Think of the lifecycle as two tracks, not one.

Trust track:

`candidate -> verified -> canonical`

Publishing track:

`not publishable -> private publishable -> broader publishability later`

Do not force both tracks to move together.

## Current Curated Inventory

There is no current curated inventory. The three manifests previously described
here are not present under `builds/`, so their old source-specific readiness
claims are no longer evidence. Reintroducing any of those capabilities requires
a current manifest plus fresh verification; the historical names alone confer
no lifecycle state.

## Section-By-Section Rules For Curated Builds

## Verification

Use only real statuses:

- `pass`
- `fail`
- `skipped`
- `blocked`

Never write evidence entries as:

- “planned”
- “verified”

Those are vague and structurally wrong for the manifest.

## Clone

Be strict:

- `manual_only` if a build touches privileged auth, billing, or operator state and cannot yet be safely transplanted
- `guided` only when the required ports and checks are explicit enough
- `copy_ready` only after repeated evidence, not optimism

## Upgrade

Use the most conservative honest channel:

- `pinned` for project-specific privileged admin capability
- `review_required` for most evolving builds
- `minor_safe` only when compatibility has real evidence

## Publishing

`publishable: false` is the default until proven otherwise.

That is not a weakness. It is good governance.

## Economics

Treat economics as planning estimates unless measured.

Use wording like:

- “planning estimate”
- “not yet benchmarked end to end”

Do not present token savings or maintenance savings as measured facts unless
they were actually measured.

## Provenance

Provenance should show:

- who created the build
- who hardened it
- what source bricks or fixtures it came from

Provenance should not fake:

- runtime proof
- human review that did not happen
- release readiness that does not exist

## Promotion Decision Template

Use this decision shape:

1. What evidence exists today?
2. What proof is still missing?
3. Is the build safe enough to verify further?
4. Is it preferred for new work yet?
5. Is it safe enough to package internally?

If any answer is unclear, keep the build where it is.

## Non-Negotiables

- Never confuse scanner recurrence with verified capability.
- Never mark a build publishable because the docs look polished.
- Never promote a high-risk build faster just to make the catalog look complete.
- Never invent evidence to close a status gap.

## Related Docs

- [docs/BUILD_LAYER_IMPLEMENTATION_PLAN.md](BUILD_LAYER_IMPLEMENTATION_PLAN.md)
- [docs/GOVERNANCE.md](GOVERNANCE.md)
