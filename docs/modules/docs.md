# Documentation module tour

This tour explains the framework guides, examples, templates, and public policy documents. Writers, maintainers, and reviewers need it before changing a user-facing claim or workflow explanation. Read it when a task changes how users install, operate, verify, or extend Sweetspot. Remember that a documented feature needs current code or evidence behind it.

## Purpose

The documentation module teaches the framework and records its public contracts. The architecture keeps it dependency-free so prose does not become a substitute for implementation.

## Owned files

- `docs/**`, `examples/**`, and `templates/project/**`
- `templates/agents/**` and `templates/brick/**`
- `SPE/**`, `SRS/**`, and `SSTF-v1/**`
- Root public documents listed under the docs module in `sma.gen3.json`

## Gates

Run `npm run gate:docs`, `npm run source:size:gate`, and the strict module Graphify summary. Check links, introductory prose, glossary links, and command examples against their real entry points.

## How to work here

Claim the docs brick that matches the file group and leave unrelated generated plans untouched. Use the project terminology, state limits honestly, and update feature registers when a user-facing capability changes.
