# Registry Workflow

The registry is the inventory of usable Sweetspot bricks across projects.

The workflow is deliberately simple:

1. Add `module.sweetspot.json` to a reusable module.
2. Add or update the project-local `.sweetspot/modules.json`.
3. Run the global scanner.
4. Compare duplicates.
5. Promote one canonical brick when evidence is strong enough.

## Project Index

Each project should eventually have:

```
.sweetspot/
  project.json
  modules.json
  scans/
  scorecards/
```

`project.json` identifies the project and its stack.

`modules.json` lists all known bricks in that project.

## Global Index

The global SMA registry lives here:

```
~/DEV/SMARCH/registry/
  projects.json
  global-modules.json
  canonical-map.json
  duplicates.json
  model-provenance.json
  security-findings.json
```

Generated scanner output should use a `.generated.json` suffix until reviewed.

## Hierarchy-Aware Scan Output

The scanner separates three things:

- `bricks`: manifested registry bricks.
- `candidate_groups`: rollups such as apps, packages, function families, feature folders, and component-module families.
- `unmanifested_bricks`: individual candidates that need a manifest before they can be treated as real SMA bricks.

This matters for large projects. A monorepo with hundreds of functions should not become a flat junk drawer. Humans should read the group view first, then decide which candidates deserve manifests.

## Bootstrap Manifest Pass

For a project that has no manifests yet, use the bootstrapper:

```bash
node ~/DEV/SMARCH/tools/sma-bootstrap-manifests.mjs \
  --registry ~/DEV/SMARCH/scans/<project>/latest.registry.json \
  --write
```

Bootstrap manifests are intentionally `project_bound`.

They make the project indexable, teach the scanner about every discovered candidate, and capture hierarchy/provenance. They do not claim the brick is reusable, copy-ready, or canonical. Promotion comes later through tests, RLS/env proof, security review, code-budget review, and clone verification.

Scanner edge cases are tracked in [SCANNER_EDGE_CASES.md](SCANNER_EDGE_CASES.md).

## Duplicate Policy

Duplicates are not bad. Unlabeled duplicates are bad.

When two bricks solve the same problem:
- mark one as `canonical` if it meets the bar
- mark others as `variant`, `duplicate`, `project_bound`, or `legacy`
- record why
- preserve useful variants when tradeoffs are real

## Canonical Promotion

A brick can become canonical only if:
- score is 90 or higher
- no high or critical SVA findings
- clone readiness is `copy_ready` or clearly `guided`
- provenance includes source and latest touch
- tests are documented and current
- RLS/env contracts are complete when applicable
- security-sensitive code has a review event

## Scanner Command

```bash
node ~/DEV/SMARCH/tools/sma-scan.mjs \
  --root ~/DEV/Projects \
  --out ~/DEV/SMARCH/registry/global-modules.generated.json
```

The generated file is an index, not an approval. Human or security-agent review promotes entries into canonical maps.
