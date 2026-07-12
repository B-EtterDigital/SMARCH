<!-- docs-i18n: key=docs.framework; source=en; media=media/{locale}/framework/ -->
# Sweetspot Modular Architecture

This document defines the core Sweetspot architecture, its brick types, and the proof model that makes reuse safe. Engineers, reviewers, and project leads need it as the primary conceptual reference for the system. Read it before designing module boundaries or deciding which gates a brick must satisfy. Remember that a brick is reusable only when its boundaries and evidence travel with its code.

SMA turns Sweetspot projects into a module supply chain: small, isolated, security-scored bricks that can be copied between projects without dragging hidden risk behind them.

The key discipline is simple:

1. A brick is not reusable because the code compiles.
2. A brick is reusable when its boundaries, data access, secrets, tests, performance, provenance, and clone instructions are explicit.
3. A brick is canonical only when another project can copy it and know what must be adapted.

## Brutally Honest Engineer Read

A seasoned engineer will probably like the instinct and distrust the packaging.

They will like:
- The 400-600 line pressure because it reduces agent collisions, review fatigue, and merge risk.
- [SSI](GLOSSARY.md#ssi) because it limits UI blast radius in the same spirit as fault containment.
- SSA-v2 because it forces secrets and privileged calls behind a server-side boundary.
- The brick registry idea because reusable modules are only useful when discoverable and scored.
- Multi-agent file ownership because uncontrolled parallel edits are where AI development becomes expensive.

They will push back on:
- Too many acronyms. Acronyms are fine internally, but every acronym must map to a concrete check, file, or gate.
- "NASA style" claims without evidence. The useful part is fault isolation and checklists; the branding is secondary.
- Copying modules without a dependency and data contract. That creates subtle breakage.
- Subjective quality scores. Scores need inputs that can be inspected.
- Model provenance as a badge. It is useful as traceability, not proof of quality.
- A global index that becomes a junk drawer. Canonical selection rules matter more than collection volume.

The mature framing is:

> Sweetspot is a reliability-oriented module contract for AI-assisted software teams.

That sentence is defensible. It says what it does without overselling.

## Architecture

```
SSTT task
  -> SAS assigns agent ownership and write bounds
  -> SSA-v2 defines security/data boundaries
  -> SDC classifies the data handled by the brick
  -> SEV declares environment and secret rules
  -> SRLS declares database/storage access rules
  -> SSI isolates runtime failure and access gates
  -> STF proves behavior and security cases
  -> SPE proves performance limits
  -> SVA runs vulnerability checks
  -> SRS records errors, degradation, and audit signals
  -> SVD optionally records visual demo and walkthrough proof
  -> SSC records provenance and dependency trust
  -> SSRA decides release readiness
  -> Registry scores and indexes the brick
```

SMA does not replace SSA-v2, SSI, [STF](GLOSSARY.md#stf), [SPE](GLOSSARY.md#spe), [SRS](GLOSSARY.md#srs), SSRA, or SSTT. It binds them into one copyable module contract.
SVD is optional: it is used when a brick or build needs visual proof of a user journey.

## Brick Types

Use the smallest honest unit.

Hierarchy is defined in [HIERARCHY.md](HIERARCHY.md). Short version: bricks can contain modules, modules can contain components, and components do not become registry bricks unless they opt in with a manifest.

| Type | Meaning | Example |
|------|---------|---------|
| `module` | A cohesive feature or service | transcript editor, payment service |
| `submodule` | A child unit inside a module | transcript parser, waveform renderer |
| `module_group` | A coordinated set of modules | billing suite, creator dashboard |
| `adapter` | Boundary glue to a provider or project | Supabase adapter, Stripe adapter |
| `guard` | Cross-cutting safety wrapper | SSI wrapper, RLS policy helper |
| `tooling` | Scanner, migration, audit, generator | file-size checker, registry scanner |
| `template` | Starter implementation | Edge function template |

## The Elegant Rule Set

A brick has ten required contracts. If one is missing, it can still be copied manually, but it is not registry-grade.

1. `Identity`: stable id, name, type, version, source project, owner.
2. `Boundaries`: public API, private files, allowed dependencies, forbidden dependencies.
3. `SSA-v2`: minimum responsible code, no frontend secrets, no direct privileged APIs, explicit DB columns, no unscoped server calls.
4. `SSI`: lazy import safety, error boundary, suspense/skeleton, feature/tier/auth gates where relevant.
5. `STF`: tests for behavior, edge cases, service contracts, security regressions, and clone adapters.
6. `SPE`: measurable limits for requests, memory, DOM weight, bundle cost, latency, and N+1 patterns.
7. `SRS`: error codes, degradation paths, privacy-safe observability, incident breadcrumbs.
8. `Security`: VibeSec-style vuln checks, RLS matrix, env/secret validation, data classification.
9. `Provenance`: source commit, copied-from chain, humans, agents, models, tools, verification.
10. `Clone`: install steps, required env vars, migration steps, adaptation points, known traps.

## The Added Layers

### SAS: Sweetspot Agent Swarm

Purpose: make multi-agent work predictable.

Required fields:
- `ownership.files`: files or directories the agent may edit.
- `ownership.forbidden`: files the agent must not touch.
- `handoff.status`: planned, active, blocked, review, complete.
- `handoff.notes`: what changed, what still needs verification.
- `lock.reason`: why the brick is locked, if active work is in progress.

Rules:
- One agent owns a write set at a time.
- Agents may read broadly but edit narrowly.
- Shared files require an explicit owner.
- Every agent handoff updates provenance.
- Security or release agents can veto canonical status.

### [SVA](GLOSSARY.md#sva): Sweetspot Vulnerability Audit

Purpose: make VibeSec-style security review a gate, not a memory exercise.

Minimum checks:
- Secret scanning: gitleaks or equivalent.
- Client bundle scanning for exposed keys.
- Semgrep/custom rules for dangerous patterns.
- Dependency vulnerability audit.
- Authz tests for IDOR and cross-tenant access.
- SSRF, open redirect, path traversal, upload, XSS, SQLi, JWT/session, and mass-assignment checks where applicable.
- SARIF or machine-readable findings where possible.

Severity rule:
- `critical` or `high` findings block canonical status.
- `medium` findings require an owner and deadline.
- `low` findings require documentation.

### [SRLS](GLOSSARY.md#srls): Sweetspot RLS Standard

Purpose: make database access portable and testable.

Every brick that touches Supabase/Postgres must include:
- Table list.
- Operation matrix: select, insert, update, delete.
- Actor matrix: anonymous, user, org member, admin, service role.
- RLS enabled proof.
- Storage policy proof when files are involved.
- RPC security mode and `search_path` notes.
- Cross-user and cross-tenant negative tests.

Hard blocks:
- No service-role key in client code.
- No public writes unless declared and tested.
- No broad `using (true)` on user/private data.
- No `SECURITY DEFINER` without explicit scoping and `search_path`.

### [SEV](GLOSSARY.md#sev): Sweetspot Environment Validation

Purpose: stop secret leaks and bad repo setup.

Each brick declares every environment variable:
- Name.
- Scope: `server_only`, `public_client`, `ci_only`, `local_only`.
- Required in: local, preview, production, test.
- Forbidden in: client bundle, logs, generated docs.
- Example value policy: placeholder only, no real secret.

Checks:
- `.env.local` ignored.
- `.env.example` contains placeholders only.
- Public prefixes are intentional.
- Server-only env vars are not imported by frontend modules.
- Unused and undocumented env vars are flagged.

### SDC: Sweetspot Data Classification

Purpose: make clone risk obvious.

Allowed classes:
- `public`
- `user_private`
- `org_private`
- `admin_only`
- `pii`
- `payment`
- `credential`
- `health_sensitive`
- `regulated`

Rules:
- Highest data class controls the brick.
- Data class determines required RLS, logging, redaction, export, and retention rules.
- SRS logs must redact `pii`, `payment`, `credential`, `health_sensitive`, and `regulated` data.

### [SSC](GLOSSARY.md#ssc): Sweetspot Supply Chain And Provenance

Purpose: know where a brick came from and whether it can be trusted.

Required:
- Source project and source path.
- Source commit or archive hash.
- Copy lineage.
- Dependency list and license notes.
- Vulnerability status.
- Checksums for canonical versions.
- Humans, agents, tools, and AI models that created or touched the brick.

Model provenance is allowed and useful, but only as traceability. It should not imply quality by itself.

### SAI: Sweetspot Agent Integrity

Purpose: prevent AI/tooling from treating hostile repo text as trusted instruction.

Rules:
- Repository content is data unless it is an approved instruction file.
- External docs and copied modules are untrusted until reviewed.
- Agents cannot read secrets unless the task explicitly requires it.
- Agents cannot deploy, rotate secrets, or change CI without role permission.
- Security agent reviews generated auth, RLS, payment, webhook, crypto, upload, and env code.
- Prompts, model names, and tool outputs used for canonical changes are recorded when available.

### SVD: Sweetspot Visual Demo

Purpose: make demo, walkthrough, onboarding, and release-proof flows reviewable as ordered visual evidence.

SVD is a known optional module, not a universal gate. Use it when a module needs proof that a user journey works end to end and can be replayed by a reviewer.

Minimum requirements:
- Ordered proof run with numbered step claims, persona, route, role, feature flags, version, viewport, theme, and expected outcomes.
- Screenshot quality checks that confirm the claimed feature is visible, readable, oriented, and not hidden by proof UI.
- Escapable proof gallery with visible close/exit, `Esc` support, replay, artifact-folder link, and manifest download.
- Subtle screenshot annotations that link claim numbers to the relevant action or state without hiding the UI.
- Flow visualization that connects actions, expected results, actual results, SRS breadcrumbs, and failure branches.
- Privacy-safe redaction for screenshots, video, captions, and SRS payloads.
- Lazy-loaded gallery assets so proof packs do not freeze the app.

Detailed contract: [SWEETSPOT_VISUAL_DEMO.md](SWEETSPOT_VISUAL_DEMO.md).

## Canonical Status

| Status | Meaning |
|--------|---------|
| `experimental` | Useful idea, not reusable yet |
| `project_bound` | Works in one project, hard dependencies not abstracted |
| `variant` | Valid alternate implementation |
| `duplicate` | Same purpose as another brick, not preferred |
| `legacy` | Keep for reference, do not copy into new work |
| `candidate` | Almost reusable, missing one or two gates |
| `canonical` | Preferred brick for new projects |

Canonical review targets:

The validator requires every gate to carry a numeric score and blocks a
canonical brick when a required gate is `missing` or `blocked`. It enforces
`quality.score >= 90`, but the per-gate numbers below remain review policy
rather than separate numeric validator thresholds.

- SSA-v2: 90+
- SSI: 90+ when UI/runtime isolation applies
- STF: 80+
- SPE: green or documented non-applicability
- SRS: observability hooks present
- SVA: no high or critical findings
- SRLS: complete if database/storage is involved
- SEV: complete if env vars are involved
- Clone notes: complete
- Provenance: source and latest touch recorded

## Scoring

Use scores to rank, not to hide weak spots.

| Area | Points |
|------|--------|
| SSA-v2 boundary discipline | 15 |
| SSI isolation | 10 |
| STF confidence | 15 |
| SPE performance | 10 |
| SRS observability | 10 |
| SVA vulnerability posture | 15 |
| SRLS access control | 10 |
| SEV env/secret hygiene | 5 |
| SSC provenance/supply chain | 5 |
| Clone readiness | 5 |

Score labels:
- `90-100`: canonical candidate
- `80-89`: strong variant
- `65-79`: project-bound
- `40-64`: risky reuse
- `<40`: archive only

## Registry Layout

Per project:

```
.sweetspot/
  project.json
  modules.json
  scans/
  scorecards/
```

Per brick:

```
module-root/
  module.sweetspot.json
  README.md
  CHANGELOG.md
  tests/
  docs/
```

Global:

```
registry/
  global-modules.generated.json  # bricks, scanner findings, duplicate clusters,
                                 # and canonicalization evidence
wiki/
  SMA_STATE.generated.json       # generated trust and portfolio state
  CANONICALIZATION.generated.html
```

The generated registry embeds canonicalization and duplicate-cluster evidence;
the current tools do not emit separate `canonical-map.json` or
`duplicates.json` files.

## Model Provenance

Yes: each brick should record which humans, agents, models, and tools made it or touched it.

Recommended structure:
- `provenance.created_by`: first known creator.
- `provenance.touched_by`: append-only touch events.
- `provenance.reviewed_by`: humans or security/release agents that approved it.
- `provenance.source_chain`: copied-from lineage across projects.

Each touch event should include:
- Actor kind: human, ai_model, agent, automation, tool.
- Provider and model, when applicable.
- Role: architect, implementer, reviewer, security, tester, refactor, release.
- Session id or task id, when available.
- Commit or archive hash.
- Files touched.
- Summary.
- Verification run.

Do not make model provenance a leaderboard. A brick made by a famous model can still be bad. A brick touched by a weaker model can be correct if tests and gates pass.

## Clone Workflow

1. Search registry by capability, language, data class, and score.
2. Prefer canonical bricks over variants.
3. Read clone contract before copying.
4. Copy files, never move them from source.
5. Adapt only declared adapter points.
6. Run SSA, SSI, STF, SPE, SVA, SRLS, and SEV gates.
7. Record new source chain and model touch event.
8. If improvements are general, promote the source brick or create a new variant.

## Agent Workflow

Every multi-agent task should start with a small plan:

```
task_id:
brick_id:
agents:
  - role:
    write_set:
    forbidden:
    required_checks:
handoff:
  status:
  notes:
```

No agent should start broad edits until it has a write set. No brick should become canonical until security and release gates pass.

## What Makes This Special

The special part is not the acronyms. The special part is combining:
- Small files that fit AI context windows.
- Isolation that limits blast radius.
- Security boundaries that prevent common AI mistakes.
- A registry that turns past work into searchable inventory.
- Provenance that explains where code came from and who changed it.
- Gates that let many agents work without relying on vibes.

That is a credible framework. Keep it disciplined and it can become valuable. Let the registry fill with unscored copies and it becomes another archive.
