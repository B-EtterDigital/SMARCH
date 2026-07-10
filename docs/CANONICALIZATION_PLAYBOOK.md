# SMARCH Canonicalization Playbook

This is the line between central SMARCH work and project-by-project truth work.

The central layer is responsible for:

- finding bricks and build candidates
- indexing trust signals, contracts, boundaries, and refactor pressure
- generating manifests, releases, import locks, placements, and update plans
- proving that the control plane itself works end to end

Project-by-project canonicalization starts when the central layer is no longer the bottleneck.

## When To Leave The Central Layer

Move into individual projects when all of these are true:

1. Bricks and builds install as first-class artifacts.
2. Release artifacts and a release index exist.
3. Import verification and update planning work against installed artifacts.
4. There is a ranked canonicalization queue with concrete targets and blockers.
5. The highest-value recurring build candidates have hand-authored manifests.

If any of those are still missing, stay central.

## What “Canonical” Actually Means

`canonical` is not “looks reusable”.

For a brick:

- clear public API
- declared env contract
- declared data and security posture
- clean enough boundaries to import safely
- clone steps or automated install path
- at least one verification path
- low enough drift that the manifest still matches the source

For a build:

- hand-authored build manifest
- explicit composition of bricks
- known flows and topology
- installable as a first-class build
- release artifact exists
- import verification passes after install
- update planning works against the installed result
- publish classification is understood, even if still private

## Promotion Order

Do not canonicalize randomly.

Use this order:

1. High-recurrence build candidates with strong business value
2. Bricks inside those builds that block trust, install, or updates
3. Common dependency bricks reused across multiple builds
4. Remaining high-value standalone bricks

This keeps canonicalization tied to reusable capability, not inventory vanity.

## Canonicalization Pass Inside A Project

When you enter a project, use one pass per target build:

1. Confirm the build manifest matches the live code.
2. Fix boundary leaks and unresolved local dependencies.
3. Declare missing env contracts and RLS/security surfaces.
4. Add or repair tests for the critical path.
5. Run install, verify, and update-plan against the build.
6. Promote the build and its required bricks only when the evidence is real.

Do not try to canonicalize the whole project in one sweep.

## Brutal Rule

More candidate bricks do not create more value by themselves.

Canonical value comes from:

- repeatable install
- trustworthy contracts
- clean boundaries
- successful verification
- successful updates

If a brick or build cannot survive that path, it is still inventory, not leverage.

## Current Program Logic

Stay central while the platform is still turning candidate capability into installable, releasable, updateable artifacts.

Go project-by-project when the queue is concrete and the remaining blockers are mostly source-truth issues:

- missing env declarations
- broken boundaries
- stale manifests
- missing tests
- domain-specific integration gaps

That is the moment when project work creates more value than more central tooling.
