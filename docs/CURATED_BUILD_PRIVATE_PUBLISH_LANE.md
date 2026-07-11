# Curated Build Private Publish Lane

This playbook explains the controlled path for publishing a curated build to an approved private audience. Build owners and release operators need it when reuse must stay inside a restricted boundary. Read it before packaging, granting access, or changing a private build's publication state. Remember that private publication still requires verified provenance, security, and consumer instructions.

Status: operational playbook for curated builds under `builds/`.

This is the short decision doc for one narrow question:

How does a curated build move from `candidate` to a released private artifact
without pretending proof exists where it does not?

Use this together with:

- [docs/CURATED_BUILD_LIFECYCLE_PLAYBOOK.md](CURATED_BUILD_LIFECYCLE_PLAYBOOK.md)
- [docs/BUILD_LAYER_IMPLEMENTATION_PLAN.md](BUILD_LAYER_IMPLEMENTATION_PLAN.md)

Current repo reality:

- there are `3` curated builds under `builds/`
- all `3` are still `candidate`
- none should be treated as privately publishable yet
- none should be treated as a published release yet

## Conservative Rule

In theory, trust and publishability are separate axes.

In practice, for curated builds in this repo, the private publish lane should be:

`candidate -> verified -> private publishable -> published release`

This is stricter than the abstract model on purpose. It keeps teams from
shipping a neat package for a build that still lacks operational proof.

## The Four States

## 1. Candidate Build

What it means:

- the build has a real curated manifest
- the boundary and composition are clear enough to review
- clone, upgrade, publishing, and economics sections are filled in honestly
- scanner evidence may support the shape of the build

What it does not mean:

- the build is proven on a real target
- the build is safe to publish
- the build is safe to update automatically

Allowed claims:

- "curated"
- "candidate"
- "worth verification"

Forbidden claims:

- "verified"
- "publishable"
- "release-ready"

## 2. Verified Build

What it means:

- the verifier has produced build-level evidence strong enough to move past
  scanner confidence
- the install assumptions were exercised in at least one meaningful way
- the build manifest no longer reads like a hypothesis

Minimum bar:

- `npm run build:verify` produces evidence that supports the build's stated
  verification posture
- the resulting report is reviewed before changing the build status
- clone steps, checks, and rollback notes are specific enough to follow
- major risk areas are addressed honestly in the manifest

What it still does not mean:

- the build is automatically safe to publish
- the build is canonical
- the build is safe for unattended upgrades everywhere

## 3. Private Publishable Build

What it means:

- the build is already verified
- the publish gate says the build can be packaged for internal reuse without
  leaking secrets, tenant data, project-private runbooks, or hidden
  composition details
- another internal team could consume it as a capability instead of doing raw
  repo archaeology

Minimum bar:

- the build is already `verified`
- `node tools/sma-publish.mjs --manifest <build>` produces a clean enough
  publish result and leak review
- exclusions, redactions, and exposed docs are explicit
- release consumers can understand install, verify, and rollback expectations

What it still does not mean:

- the build should be public
- the build is marketplace-ready
- the build is low-risk in every context

## 4. Published Release

What it means:

- a concrete release artifact was emitted for the build
- the release is versioned and can be referenced by install, verify, and
  update-planning workflows
- the release packages the approved publishable surface, not the whole project

What it does not mean:

- the build should be auto-installed everywhere
- future updates are automatic
- the release no longer needs review on high-risk targets

## Verifier Vs Publish Gate

The verifier and the publish gate answer different questions.

Verifier:

- asks "is this build operationally trustworthy enough to move past
  candidate?"
- cares about evidence, smoke coverage, install assumptions, risks, and
  rollback realism
- should block promotion to `verified` when the manifest is still mostly
  theory

Publish gate:

- asks "can this verified build be packaged for reuse without leaking things
  that should remain private?"
- cares about redaction, exclusions, private paths, private prompts, customer
  data, secrets, operator notes, and release hygiene
- should block promotion to `private publishable` even when verification is
  strong

Main rule:

- verifier first
- publish gate second
- release emission only after both are satisfied

One does not replace the other.

## Operational Flow

1. Curate the build manifest until the capability boundary, clone stance,
   upgrade stance, provenance, and risks are honest.
2. Run `npm run build:verify` and review
   `security/build-verification.generated.json`.
3. If the evidence is still weak, keep the build at `candidate`.
4. If the evidence is strong enough, promote the build to `verified`.
5. Run `node tools/sma-publish.mjs --manifest <build>` and review the leak
   report and package surface.
6. If redaction or private-surface issues remain, stop at `verified`.
7. If the publish result is clean enough, the build can move to `private
   publishable`.
8. Only then emit and keep a versioned release artifact.

## Decision Table

If verification is weak:

- state stays `candidate`
- do not run the publish lane as if release is imminent

If verification is strong but publish review fails:

- state can be `verified`
- state must not become `private publishable`
- no release artifact should be treated as approved for reuse

If verification is strong and publish review is clean:

- state can move to `private publishable`
- a versioned release can be emitted

## What To Say Internally

Good:

- "This build is curated but still candidate."
- "This build is verified for internal reuse, but not publishable yet."
- "This build is privately publishable, with exclusions and rollback guidance."

Bad:

- "The scanner found it, so it is basically ready."
- "We have a release artifact, so the hard part is done."
- "Publishable means safe everywhere."

## What This Doc Deliberately Does Not Claim

- It does not claim the current curated builds have completed this lane.
- It does not claim verification replaces install verification on the target.
- It does not claim private publishability is the same as community-safe
  publishing.
- It does not claim update safety without running install verify and update
  planning on the consuming project.

That last check still belongs to:

- `node tools/sma-import-verify.mjs --target /path/to/project`
- `node tools/sma-update-plan.mjs --target /path/to/project --release <artifact>`
