# Curated Build Acceptance Definitions

Status: conservative acceptance bars for curated builds under `builds/`.

This doc defines the minimum bar for four curated-build states:

- `candidate`
- `verified`
- `private publishable`
- `published release`

It is intentionally stricter than scanner confidence and intentionally more
honest than marketing language.

Current repo reality on `2026-04-22`:

- there are `3` curated builds under `builds/`
- all `3` are still `candidate`
- none should be treated as `verified`
- none should be treated as `private publishable`
- none should be treated as a published release approved for reuse

Use this with:

- [docs/CURATED_BUILD_LIFECYCLE_PLAYBOOK.md](~/DEV/SMARCH/docs/CURATED_BUILD_LIFECYCLE_PLAYBOOK.md)
- [docs/CURATED_BUILD_PRIVATE_PUBLISH_LANE.md](~/DEV/SMARCH/docs/CURATED_BUILD_PRIVATE_PUBLISH_LANE.md)
- `security/build-verification.generated.json`

## Main Rule

A curated build moves only as far as the strongest evidence supports.

Do not promote a build because:

- the scanner found a convincing cluster
- the manifest reads well
- a release file exists
- a publish bundle exists
- the build would look good on the site

Promotion must follow real evidence, not narrative momentum.

## 1. Candidate

Minimum bar:

- a real curated build manifest exists under `builds/`
- the capability boundary is understandable
- required and optional bricks are separated
- source paths and brick refs resolve honestly
- contracts, clone posture, upgrade posture, and publishing posture are filled
  in honestly enough for review
- the manifest does not invent runtime proof

Candidate means:

- the build is curated
- the build is worth deeper verification
- the capability shape is reviewable

Candidate does not mean:

- verified
- safe to publish
- safe to auto-update
- safe to install without review

Minimum evidence accepted at this level:

- scanner support
- source inspection
- manifest curation
- review notes

That evidence is enough for `candidate` and not enough for anything higher.

## 2. Verified

Minimum bar:

- the build still satisfies the full `candidate` bar
- there is build-level evidence, not just scanner-level or brick-level evidence
- at least one meaningful smoke, fixture, or target-specific check was actually
  run and recorded as successful
- clone steps are specific enough for another engineer or agent to follow
- post-clone checks and rollback steps are concrete
- major risk areas are acknowledged in the manifest instead of hand-waved away

Verified means:

- the build moved past theory
- the build has operational evidence strong enough for internal engineering
  trust
- the verifier has something better than review-only evidence

Verified does not mean:

- canonical
- private publishable
- public
- safe for unattended upgrades in every target

Minimum evidence accepted at this level:

- at least one real `pass` result from a smoke command, fixture run, or target
  installation check
- evidence tied to a real command, environment, date, and reviewer/operator

Still insufficient on its own:

- review-only evidence
- manifest completeness
- scanner clustering
- inferred installability
- a release artifact with no runtime proof

## 3. Private Publishable

Minimum bar:

- the build already satisfies the full `verified` bar
- publish review shows the build can be packaged for internal reuse without
  leaking secrets, customer data, internal-only URLs, local filesystem paths,
  private prompts, or project-private runbooks
- exclusions and redactions are explicit
- another internal team could understand install, verify, and rollback without
  raw repo archaeology

Private publishable means:

- the build is fit for internal capability sharing
- the package surface is intentionally smaller than the full project
- the publish gate and the build verifier both passed their part

Private publishable does not mean:

- public-safe
- marketplace-ready
- zero-risk
- auto-installable everywhere

Minimum evidence accepted at this level:

- strong enough verification evidence for `verified`
- a publish result with no unresolved leak blocker that would make the bundle
  unsafe for internal sharing

Still insufficient on its own:

- a publish bundle exists
- redaction was attempted
- the build is canonical
- the release version was incremented

## 4. Published Release

Minimum bar:

- the build already satisfies the full `private publishable` bar for the
  intended release lane
- a concrete release artifact exists and is versioned
- the release matches the approved manifest/build state
- release status and channel are explicit
- the artifact is usable by install, verify, and update-planning workflows

Published release means:

- there is a versioned artifact that can be referenced operationally
- release consumers are not expected to reverse-engineer the source project

Published release does not mean:

- universally safe
- automatically approved for production
- exempt from target-level import verification
- exempt from update planning or rollback review

Still insufficient on its own:

- "artifact exists"
- "artifact says published"
- "artifact installed once somewhere"

## Evidence Rules

## What Qualifies As Evidence

Strong evidence:

- an actual smoke or fixture command was run and recorded
- a target installation or replay was exercised and recorded
- a negative-path or auth/RLS check was explicitly run for a build that needs it
- the evidence record names the command, date, reviewer/operator, and outcome

Supporting evidence:

- code review notes
- manifest review
- source-path resolution
- brick-resolution checks
- scanner recurrence
- release/publish metadata

Supporting evidence can help explain a decision. It cannot replace runtime or
operational evidence when moving to `verified`.

## What Does Not Qualify As Sufficient Proof

These can support a decision but cannot carry the promotion by themselves:

- "the scanner found it"
- "the manifest looks complete"
- "the build was reviewed"
- "the release file was generated"
- "the publish bundle was generated"
- "the build probably works because the bricks work individually"

## Minimum Evidence Shape

For any evidence that claims more than review-only support, record:

- what was run or checked
- where it was run
- when it was run
- who ran or reviewed it
- whether it passed, failed, or was partial
- what limitation still remains

If that shape is missing, treat the evidence as weaker than it sounds.

## State-Change Guardrails

Before changing a curated build state:

1. check the verifier output
2. inspect whether the evidence is real or only review-level
3. check clone posture and rollback realism
4. check whether publish safety is still blocked
5. write the least flattering honest state that the evidence supports

If the answer is unclear, keep the build at the lower state.

## Current Honest Interpretation For This Repo

Given the current verifier output:

- `candidate` is real
- `verified` still requires more runtime-grade evidence
- `private publishable` is blocked by both proof and leak-review issues
- `published release` should not be treated as approved reuse until the earlier
  bars are satisfied

That is not a failure of the model. It is the model doing its job honestly.
