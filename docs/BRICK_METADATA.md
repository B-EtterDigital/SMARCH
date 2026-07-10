# Brick Metadata

Every reusable brick gets a `module.sweetspot.json` file at its module root.

The file has two jobs:

1. Tell humans whether the brick is worth copying.
2. Tell scanners how to index, score, and compare it.

## Known Optional Modules

Optional SMA modules use the same manifest contract as any other brick. For Sweetspot Visual Demo (SVD), declare:

- `brick.kind`: `module`
- `brick.domain`: include `visual-demo`, `walkthrough`, and `proof-gallery`
- `classification.data_classes`: include the highest class visible in screenshots or video
- `interfaces.public_api`: list the run script, artifact manifest, numbered claim ledger, gallery, replay, screenshot quality, and annotation contracts
- `clone.adaptation_points`: include route registry, screenshot driver, screenshot visibility check, annotation renderer, redaction policy, and artifact storage path

SVD requirements are documented in [SWEETSPOT_VISUAL_DEMO.md](SWEETSPOT_VISUAL_DEMO.md).

## Required Sections

| Section | Purpose |
|---------|---------|
| `brick` | Identity, type, status, language, domain |
| `hierarchy` | Optional placement: brick group, brick, module, submodule, or component |
| `source` | Project, repository, paths, copy lineage |
| `owner` | Primary owner, team, reviewers |
| `boundaries` | Owned paths, public paths, private paths, forbidden imports |
| `classification` | Data sensitivity and risk |
| `sweetspot` | Gate status for SSA-v2, SSI, SSTF, SPE, SRS, SSRA, SAS, SVA, SRLS, SEV, SSC, SAI |
| `interfaces` | Public API, adapters, dependencies, forbidden dependencies |
| `security` | RLS, env, vulnerabilities |
| `supply_chain` | Dependencies, licenses, checksums, SBOM path |
| `quality` | Score, line count, code budget, test commands, verification |
| `clone` | Readiness, adaptation points, install steps, traps |
| `provenance` | Humans, agents, models, tools, source chain |

## Model Provenance

Yes, each brick can and should record which models touched it or made it.

Use this for traceability:
- Which model generated the first version?
- Which model refactored it?
- Which model performed security review?
- Which human reviewed it?
- Which commit/session/task produced the change?

Do not use it as proof of quality.

Quality comes from gates:
- tests pass
- security checks pass
- RLS checks pass
- env checks pass
- performance is measured
- reviewer approved

## Hierarchy Metadata

Use `hierarchy` when a brick needs to explain where it sits:

```json
{
  "hierarchy": {
    "level": "brick",
    "group_id": "acme-studio:apps/web/src/features",
    "contains": ["module", "component", "hook", "service"],
    "component_policy": "internal_by_default"
  }
}
```

Rules:

- A brick is the registry/copy boundary.
- A brick may contain modules and submodules.
- A module may contain components, services, hooks, adapters, utilities, and files.
- Components stay internal unless a manifest promotes them into a brick.
- Wide bricks should become `module_group` or declare child bricks instead of hiding complexity.

## Recommended Touch Event

```json
{
  "actor_kind": "ai_model",
  "actor_id": "codex",
  "provider": "openai",
  "model": "gpt-5-codex",
  "role": "implementer",
  "session_id": "local-session-id",
  "task_id": "SSTT-123",
  "commit": "abc123",
  "files_touched": ["src/modules/example/index.ts"],
  "verification": [
    {
      "command": "pnpm test -- example",
      "status": "pass",
      "timestamp": "2026-04-15T00:00:00Z"
    }
  ],
  "timestamp": "2026-04-15T00:00:00Z",
  "summary": "Implemented adapter and tests.",
  "attestation": {
    "method": "git_commit",
    "reference": "abc123"
  }
}
```

## Provenance Rules

- Append touch events; do not rewrite history except to correct false metadata.
- Prefer commit hashes over free-text claims.
- If no commit exists, record an archive hash or session reference.
- Human review should be recorded separately from model generation.
- Security-sensitive bricks need a security review event before canonical status.
- Copied bricks must update `source.copied_from` and `provenance.source_chain`.

## Status Rules

| Status | Meaning |
|--------|---------|
| `experimental` | Interesting but not reusable yet |
| `project_bound` | Works only in the source project |
| `variant` | Valid alternate implementation |
| `duplicate` | Same purpose as a better brick |
| `legacy` | Kept for reference, not for new use |
| `candidate` | Almost canonical, missing limited proof |
| `canonical` | Preferred brick for new projects |

Canonical requires evidence, not confidence.

## Code Budget

`quality.code_budget` enforces the SSA-v2 base rule of minimum responsible code.

Record:

- `status`: lean, acceptable, bloated, or unknown
- `feature_lines`: approximate lines owned by the brick
- `file_count`: source files in the brick
- `dependency_count`: direct dependencies required by the brick
- `notes`: why the shape is justified
- `exceptions`: generated/vendor/necessary exceptions

The goal is not fewer lines at any cost. The goal is no code bloat, no dependency creep, and no speculative architecture that makes the brick harder to copy.
