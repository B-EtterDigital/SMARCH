# Build Layer Implementation Plan

This plan describes how SMARCH will represent and validate reusable builds assembled from several bricks. Maintainers implementing the build layer need it before changing schemas, scanners, registries, or promotion tooling. Read it when selecting the next implementation slice or checking a design decision against the intended model. Remember that a build must preserve the contracts and evidence of every brick it composes.

Status: proposed implementation outline.

This document defines the missing layer above bricks in SMA/SMARCH. It is
anchored in the current repo vision and the current scanner reality:

- The product story is already `vision -> selected bricks -> integration plan -> clone`
  in the value masterplan.
- The registry is already broad, but trust and cloneability are still weak in
  `scans/all-projects/latest.registry.json`.
- The current brick model in [README.md](../README.md) and
  [schemas/brick.manifest.schema.json](../schemas/brick.manifest.schema.json)
  is necessary but not sufficient for capability-level reuse.

## Why Builds Are Necessary

Bricks are the right unit for indexing, auditing, and copying code. They are
not the right unit for expressing complete reusable capability.

Today SMA can answer:

- what a brick is
- where it came from
- what it touches
- how reusable it might be

It cannot yet answer well enough:

- what complete capability already exists here
- which exact set of bricks must travel together
- which order those bricks integrate in
- what contracts the combined capability requires
- how to upgrade the capability later without rediscovering its internals

That gap matters because a builder rarely wants "15 bricks". They want:

- AI image generation pipeline
- auth system
- billing stack
- chat capability
- screen capture workflow

Those are not bricks. They are composed capabilities. SMA needs a first-class
`build` layer for them.

## Current Constraints From Scanner Reality

The current merged registry shows why the build layer cannot wait:

- `3481` bricks across `5` projects
- readiness `43 / F`
- compliance `75 / C`
- `1948` undeclared env refs
- `1923` boundary remediation actions
- effectively `0` `copy_ready` bricks across the scanned projects

This means the scanner already has enough raw graph and quality signal to mine
build candidates, but the system still lacks a trustworthy capability-level
object.

## Core Model

SMA/SMARCH should operate on three layers:

- `Brick`
  - Smallest reusable code unit with boundary, manifest, tests, security,
    provenance, and clone notes.
- `Build`
  - A reusable capability composed of multiple bricks plus explicit integration
    order, shared contracts, verification, and upgrade rules.
- `Project`
  - The private composition of builds, business logic, prompts, sequencing, and
    product-specific orchestration.

This preserves the core SMA promise:

- publish reusable parts without open-sourcing the whole project
- let agents search a structured registry instead of reverse-engineering the repo
- make updates possible because imported capability is explicitly mapped

## Relation To Existing Brick Model

Builds should not replace bricks. They should sit above them.

- A build references bricks as the implementation substrate.
- A brick can belong to zero, one, or many builds.
- Canonical bricks remain the trust substrate for canonical builds.
- Projects remain private and may contain unpublished build manifests.

Recommended rules:

- Bricks stay the copy boundary for fine-grained reuse.
- Builds become the default planning boundary for agent workflows.
- Projects stay the secrecy boundary.

## Build Manifest Shape

Add a new schema and manifest type:

- `schemas/build.manifest.schema.json`
- `examples/build.sweetspot.json`
- default filename: `build.sweetspot.json`

Suggested shape:

```json
{
  "schema_version": "1.0.0",
  "build": {
    "id": "sma.build.ai-image-generation.multi-provider.v1",
    "name": "AI Image Generation",
    "slug": "ai-image-generation",
    "status": "candidate",
    "version": "0.1.0",
    "kind": "capability_build",
    "domain": ["ai", "media", "generation"],
    "runtimes": ["node", "browser", "edge"],
    "visibility": "private",
    "stability": "evolving"
  },
  "source": {
    "project": "acme-studio",
    "paths": ["apps/web/src/features/image-gen"],
    "derived_from_bricks": [
      {
        "brick_id": "acme-studio.acme-studio.service-module.apps-web-src-services-image.1234abcd",
        "role": "provider_adapter",
        "required": true
      }
    ]
  },
  "composition": {
    "brick_refs": [
      {
        "brick_id": "acme-studio....",
        "role": "provider_adapter",
        "required": true,
        "order": 20
      }
    ],
    "flows": [
      {
        "id": "generate_image",
        "steps": [
          "request_validation",
          "policy_gate",
          "provider_selection",
          "job_dispatch",
          "asset_persist",
          "result_publish"
        ]
      }
    ],
    "optional_bricks": [],
    "alternatives": [],
    "shared_contracts": ["env", "storage", "authz", "telemetry"]
  },
  "interfaces": {
    "entrypoints": ["generateImage()", "POST /api/images", "ImageGenPanel"],
    "ui_surfaces": ["prompt_panel", "history_panel", "provider_status"],
    "events": ["image.requested", "image.completed", "image.failed"],
    "api_endpoints": ["POST /api/images", "GET /api/images/:id"],
    "commands": ["npm run smoke:image-gen"]
  },
  "contracts": {
    "env": {
      "required": ["FAL_KEY"],
      "optional": ["OPENAI_API_KEY"],
      "forbidden": ["service_role_on_client"]
    },
    "data": {
      "inputs": ["prompt", "style", "aspect_ratio"],
      "outputs": ["image_url", "provider_job_id"],
      "stores": ["generated_assets"]
    },
    "auth": {
      "required": true,
      "modes": ["user_session", "admin_override"]
    },
    "rls": {
      "required": true,
      "tables": ["generated_assets", "usage_events"]
    },
    "network": {
      "outbound_hosts": ["fal.ai"],
      "webhooks": []
    },
    "performance": {
      "latency_budget_ms": 2000,
      "queue_allowed": true
    }
  },
  "verification": {
    "status": "candidate",
    "fixture_targets": ["fixtures/next-image-gen", "fixtures/electron-image-gen"],
    "smoke_commands": ["npm run smoke:image-gen"],
    "integration_targets": ["next-app", "electron-app"],
    "evidence": []
  },
  "clone": {
    "readiness": "guided",
    "greenfield_support": true,
    "required_ports": ["auth_facade", "blob_store", "telemetry"],
    "file_map": [],
    "install_steps": [],
    "post_clone_checks": [],
    "rollback_steps": []
  },
  "upgrade": {
    "channel": "minor_safe",
    "compatibility_policy": "manifested_ports_only",
    "migration_hooks": [],
    "supersedes": [],
    "replacement_policy": "manual_review_if_contract_changes"
  },
  "publishing": {
    "visibility": "private",
    "publishable": false,
    "redaction_profile": "internal-default",
    "license": "private"
  },
  "economics": {
    "estimated_prompt_token_savings": 0,
    "estimated_clone_time_minutes": 0,
    "maintenance_score": 0
  },
  "provenance": {
    "created_by": {},
    "touched_by": [],
    "reviewed_by": [],
    "source_chain": []
  }
}
```

## Manifest Design Rules

The build manifest should encode things the brick manifest should not:

- composition order
- capability flows
- cross-brick contracts
- target runtime support
- upgrade policy
- publication/redaction policy
- fixture-level verification

The build manifest should not duplicate all brick detail. It should reference
bricks by id and only aggregate the capability-level contract.

## Scanner Detection Strategy

Add build discovery as a new scanner phase after brick discovery and before
promotion.

New outputs:

- `scanner_report.build_candidate_count`
- `build_report`
- `build_candidates[]`

Detection should combine four signals:

1. `Import graph clustering`
- Find groups of bricks with dense internal coupling and repeated co-usage.
- Favor clusters with stable boundary entrypoints and low external entropy.

2. `Contract overlap`
- Shared env vars
- Shared storage tables
- Shared route prefixes
- Shared event names
- Shared test commands

3. `Capability semantics`
- Use brick tags, public APIs, clone steps, and Codex semantics to label the
  cluster as a likely capability such as auth, billing, image gen, chat.

4. `Cross-project recurrence`
- If a similar brick constellation appears in more than one project, boost it.
- If the same capability appears with minor variation, produce a build family
  candidate with alternative bricks.

Suggested scoring fields per candidate:

- `cluster_score`
- `contract_score`
- `recurrence_score`
- `verification_score`
- `cloneability_score`
- `publishability_score`

Suggested heuristics for the first version:

- minimum `3` bricks per build candidate
- at least `1` explicit entrypoint surface
- at least `1` integration flow
- shared env or data contract signal
- exclude clusters dominated by unresolved imports or blocked clone preflight

## Build Lifecycle

Builds should follow a stricter lifecycle than raw scanner discovery.

### 1. Candidate Build

Created by scanner heuristics or manual authoring.

Requirements:

- build manifest exists
- references valid brick ids
- has at least one declared flow
- has entrypoints and contracts
- has initial clone notes

Scanner status:

- `candidate`

### 2. Verified Build

Promoted after a real integration proof.

Requirements:

- dry-run clone passes
- fixture target integration passes
- post-clone smoke command passes
- env contract complete
- boundary report below threshold
- no blocked critical security gate

Scanner status:

- `verified`

### 3. Canonical Build

Promoted only after repeated success.

Requirements:

- at least `2` successful integration targets
- stable manifest for one review window
- reviewed by a human owner
- upgrade policy defined
- rollback path defined
- success telemetry attached
- documented known traps and unsafe contexts

Scanner status:

- `canonical`

Recommended statuses:

- `candidate`
- `verified`
- `canonical`
- `deprecated`
- `unsafe`

## Relation To Planning And Cloning

Once builds exist, the main agent loop should change from:

- vision -> selected bricks -> integration plan -> clone

To:

- vision -> selected builds -> supporting bricks -> integration plan -> clone

That gives the ranker a more useful first-pass object while still allowing
brick-level fallback when a build is missing or too rigid.

Recommended behavior:

- ranker retrieves builds first
- ranker falls back to bricks for gaps
- clone operation records both build-level and brick-level provenance
- target project stores both the build lock and imported brick map

New target-side artifacts:

- `.smarch/build-lock.json`
- `.smarch/build-imports.json`
- `.smarch/build-placements.json`
- `docs/imported-builds/<build-id>.portable.md`

## Update System Implications

The build layer is what makes upgrades tractable.

For each imported build, record:

- source build id and version
- source brick ids and versions
- copied file paths
- adapted ports
- local deviations
- last verified target runtime

With that in place, an advanced agent can:

- diff local imported build against newer canonical build
- see which bricks changed
- know which files in the target correspond to which source parts
- generate migration steps only for changed ports and contracts

Without the build layer, upgrade automation stays too granular and too fragile.

## Marketplace / Publication Relevance

The build layer is also the right object for community publication.

Publishing only bricks is often too low-level. Publishing only whole projects is
too revealing. Builds create the middle layer:

- reusable enough to be valuable
- bounded enough to publish safely
- abstract enough to avoid leaking the full project plan

Required publication controls:

- redaction profile
- secret/env scrub check
- internal URL scrub check
- private schema name scrub check
- prompt leakage scrub check
- sensitive provenance trimming

## Suggested Repo Artifacts

Add these first:

- [docs/BUILD_LAYER_IMPLEMENTATION_PLAN.md](BUILD_LAYER_IMPLEMENTATION_PLAN.md)
- `docs/BUILD_MANIFEST_SPEC.md`
- `docs/BUILD_LIFECYCLE.md`
- `docs/BUILD_MARKETPLACE_MODEL.md`
- `schemas/build.manifest.schema.json`
- `examples/build.sweetspot.json`
- `tools/sma-build-detect.mjs`
- `tools/sma-build-verify.mjs`
- `tools/sma-build-promote.mjs`
- `security/build_publish_gate.json`

Then extend existing outputs:

- `scans/*/latest.registry.json` with `build_report`
- `wiki/` with build catalog, build trust panels, and build comparison views
- `sma-codex-rank` to prefer builds before bricks
- `sma-clone` to clone builds and emit build lockfiles

## Parallel Workstreams

This can be tackled in parallel if the contracts freeze first.

### Agent 1: Manifest And Schema
- define build schema
- write example build manifest
- add validation rules

### Agent 2: Scanner And Detection
- add build clustering
- emit build candidates and scores
- add build report to merged registry

### Agent 3: Verification And Clone
- add build dry-run verifier
- add fixture integration harness
- add target-side build lock artifacts

### Agent 4: Ranker And Retrieval
- teach ranker to retrieve builds first
- add compact build cards
- add rejected-build reasoning

### Agent 5: Wiki / BRICKWORKS / Marketplace
- add build catalog views
- add build trust panels
- add publication and redaction surfaces

## Risks

Main risks:

- false build clusters from incidental coupling
- giant sloppy "builds" that are really mini-projects
- manifest duplication drifting away from brick truth
- update promises stronger than actual boundary discipline
- marketplace spam if publication quality gates are weak

Controls:

- cap build scope
- require capability label and flow
- require build verification before strong claims
- keep brick refs authoritative for code-level truth
- block publication for unsafe redaction or unresolved contracts

## Acceptance Criteria

The build layer should not be considered real until all of these pass:

1. `Schema`
- `schemas/build.manifest.schema.json` validates at least `3` authored example builds.

2. `Scanner`
- scanner emits build candidates for at least `3` obvious capabilities from the
  current repo set
- each candidate includes bricks, entrypoints, contracts, and a score breakdown

3. `Verification`
- at least `2` build candidates can be verified against fixture apps
- verified builds produce repeatable dry-run clone results

4. `Planning`
- ranker returns at least one build-first integration plan for a realistic
  vision such as auth, billing, or AI image generation
- output includes selected build, supporting bricks, missing pieces, and risks

5. `Clone`
- `sma-clone` can clone a build and emit target-side build lock artifacts
- post-clone checks are machine-readable and executable

6. `Updateability`
- at least one imported build can be diffed against a newer version and produce
  an agent-readable upgrade plan

7. `UI`
- BRICKWORKS and wiki expose build trust state separately from brick trust state

8. `Marketplace Readiness`
- one build can be exported through a publish gate with redactions applied and
  without leaking project-only composition data

## Recommended First Milestone

The first milestone should stay narrow:

- define the schema
- author `3` manual build manifests
- detect `10` build candidates automatically
- verify `2` of them end to end
- teach the ranker one build-first path

Do not start with coins, public marketplace economics, or broad community
claims. First prove that builds are a better planning and cloning unit than raw
bricks.
