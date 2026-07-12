# Documentation module tour

This tour explains the framework guides, examples, templates, and public policy documents. Writers, maintainers, and reviewers need it before changing a user-facing claim or workflow explanation. Read it when a task changes how users install, operate, verify, or extend Sweetspot. Remember that a documented feature needs current code or evidence behind it.

## Purpose

The documentation module teaches the framework and records its public contracts. The architecture keeps it dependency-free so prose does not become a substitute for implementation.

## Owned files

- `docs/**`, `examples/**`, and `templates/project/**`
- `templates/agents/**` and `templates/brick/**`
- `SSA-v2/**`, `SSI/**`, `SPE/**`, `SRS/**`, and `STF-v1/**`
- Root public documents listed under the docs module in `sma.gen3.json`

## Gates

The module-local gate declared by `sma.gen3.json` is `npm run source:size:gate`. Also run `node tools/sma-doc-lint.mjs` and the strict module Graphify summary. Check links, introductory prose, glossary links, and command examples against their real entry points.

The module gate is available to Gen3 module dispatch, but the current GitHub workflow does not dispatch affected module gates. Treat affected-CI wiring as open shared-CI work.

## Public seams

Guides, examples, agent/project/brick templates, SPE/SRS/STF documents, and the root public documents registered in `sma.gen3.json` are the module's seams. Commands and schemas remain authoritative in their implementation modules; documentation links to them and states their observed behavior.

## Graph and ownership query

The graph lives at `graphify-out/modules/docs/graphify-out/graph.json`. Refresh with `npm run graphify:refresh:modules -- --project sma --missing-only`, then query with `npm run graphify:query -- --project sma --module docs -- "Which guide owns the public workflow for this command?"`.

## Telemetry and performance

Documentation has no runtime catch or promise surface. Broken links, invalid front matter, terminology drift, and stale command examples must fail the documentation gate with file context. The applicable performance-plan baseline is the repository check budget; documentation has no module-specific timing row. This audit found the benchmark red and absent from GitHub Actions, so the docs module has no performance-CI proof.

## Hot-path borders

`README.md` is a declared shared hot path and is outside ordinary docs edits. Generated plans and views, code comments, package scripts, schemas, and another module's tour must remain with their owning lane unless the controller assigns the overlap.

## How to work here

Claim the docs brick that matches the file group and leave unrelated generated plans untouched. Use the project terminology, state limits honestly, and update feature registers when a user-facing capability changes.
