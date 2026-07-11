# Community module tour

This tour explains community submissions, showcase material, and the supporting contribution tools. Maintainers who accept, publish, or monetize community work need it before changing those flows. Read it when a task touches submission intake, community documentation, or discussion templates. Remember that published claims must trace to a registered brick and its evidence.

## Purpose

The community module connects contributors with the registry while preserving provenance and gate results. It may depend on schemas, registry, provenance, and gates.

## Owned files

- `docs/community/**`
- `tools/sma-submit.mjs`
- `.github/ISSUE_TEMPLATE/**`
- `.github/DISCUSSION_TEMPLATE/**`

## Gates

The module-local gate declared by `sma.gen3.json` is `npm run source:size:gate`. Also validate the submission flow and run `node tools/sma-doc-lint.mjs`; contribution templates must request the evidence required for review.

The module gate is available to Gen3 module dispatch, but the current GitHub workflow does not dispatch affected module gates. Treat affected-CI wiring as open shared-CI work.

## Public seams

`tools/sma-submit.mjs` is the command seam for submission intake. The community guides and issue/discussion templates are the human-facing seams; registry, provenance, schema, and gate modules remain authoritative for their own contracts.

## Graph and ownership query

The graph lives at `graphify-out/modules/commun/graphify-out/graph.json`. Refresh with `npm run graphify:refresh:modules -- --project sma --missing-only`, then query with `npm run graphify:query -- --project sma --module commun -- "Where does a community submission enter the registry?"`.

## Telemetry and performance

Submission failures must exit non-zero and identify the rejected input or failed downstream seam; documentation-only paths have no promises or catch blocks to hide. This module has no dedicated runtime budget in `07-PERFORMANCE-PLAN.md`; its measurable baseline is the source-size gate plus the repository check budget. GitHub Actions does not run the benchmark, so this module has no performance-CI proof.

## Hot-path borders

`docs/community/**` and `tools/sma-submit.mjs` are normal module paths. `.github/ISSUE_TEMPLATE/**` and `.github/DISCUSSION_TEMPLATE/**` cross the shared CI surface and require serialized ownership; registry, schema, provenance, and gate changes belong to their modules.

## How to work here

Keep intake rules in this module and use registry or provenance APIs at their published seams. Treat `.github/**` as a shared CI surface and coordinate before editing it.
