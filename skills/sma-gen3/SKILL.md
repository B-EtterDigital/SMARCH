---
name: sma-gen3
description: Use when working in any modular SMA project on implementation, planning, hooks, SRS telemetry, Graphify retrieval, parallel agents, Gen3 lanes, module ownership, claims, CI gates, worktrees, or collision prevention.
---

# SMA Gen3

## Core Rule

SMA Gen3 is the operating standard for all modular SMA projects. Use this as the single entrypoint for every project that follows the same modular pattern. (The bundled reference profiles use a fictional `acme-*` portfolio — swap in your own projects via `references/project-profiles.md`.)

The goal is speed without regression:
- module-local work moves fast,
- shared hot paths are serialized,
- every real failure is visible through the project telemetry system,
- final claims are backed by current evidence,
- paid acceleration stays opt-in.

Do not create a separate skill per project. Use project-local config and docs to specialize this universal skill.

## User-Attention Signal (NEED-YOU convention, standing rule)

Whenever the agent needs ANYTHING from the user (a decision, a manual step, a
restart, DNS/credentials, a visual check on their screen), it must be flagged
with a dedicated marker line so it can never be missed while skimming:

> 🟡 **NEED YOU** — <exactly what is needed, one line per item>

Rules:
- The 🟡 marker is the user's requested "yellow font" — terminal markdown
  cannot render colored text, so the yellow dot + bold header is the standard.
- Use it in checkpoint reports AND final reports, as a standalone blockquote
  line (never buried inside prose or a table).
- Zero 🟡 lines in a report means: nothing is needed from the user.
- Applies to every agent in every SMA session, same weight as the
  checkbox-status-list rule.

## Required First Moves

1. Run `git status --short --branch`.
2. Detect project shape:
   - if `sma.gen3.json` exists, use it as the source of truth,
   - otherwise inspect modules, package scripts, CI workflows, agent docs, and telemetry docs before editing.
3. Identify the files or modules you intend to own.
4. Use the best available Graphify graph before broad manual reading:
   - module agent: module graph first,
   - multi-module controller: relevant module graphs plus project graph,
   - portfolio/cross-project work: global graph.
5. Classify the lane:
   - with Gen3 config: `pnpm sma:gen3 -- --changed-file <path>` or `pnpm sma:gen3:json`,
   - without Gen3 config: treat as provisional `unmapped`/single-agent work and plan a bootstrap.
6. Follow the lane output before editing.
7. Preserve unrelated dirty work. Do not stash, reset, checkout, or bulk restore.

## Portable SMA Gen3 Model

Every modular SMA repo should converge on the same primitives:
- `sma.gen3.json` for module ownership, shared hot paths, gates, and cost policy,
- agent-rule anchors such as `AGENTS.md`, `CLAUDE.md`, or repo-specific AI instructions,
- package scripts for Gen3 classification and checks,
- telemetry/SRS-equivalent proof rules,
- affected gates for module-local work,
- serialized merge/release gates for shared hot paths,
- local-first cost policy with paid acceleration manual-only.

The names of modules differ by project; the workflow should not.

## Lane Rules

| Lane | Meaning | Agent Rule | Gates |
| --- | --- | --- | --- |
| `single-module` | Work stays inside one owned module | Fast lane; parallel only when paths do not overlap | Module gates plus Gen3 check |
| `multi-module` | Multiple modules touched | Split by module where practical | Affected gates before completion |
| `shared-hot-path` | Shell, package, CI, SMA, branding, native, shared data, or agent rules | One active owner only | Merge queue/release-train thinking |
| `unmapped` | Ownership missing | Single-agent work until mapped | Update `sma.gen3.json` or document why |

Never dispatch parallel agents into the same shared hot path.

## SMA Requirements

For every implementation:
- stay inside declared module ownership when possible,
- keep files within the SMA line budget (Acme Desktop: warn 500 / hard 600) — decompose proactively (extract components/hooks/pure modules) rather than growing a file past it,
- use registry/module seams instead of central glue edits,
- keep architecture boundaries intact for that repo,
- run the gates listed by project-local Gen3/SMA config,
- update docs only when they reflect current evidence.

**Always-compliant — if it isn't, MAKE it.** Any file you touch or notice that violates SMA (over the line budget, raw `ipcRenderer` in the renderer, uninstrumented catch, renderer external fetch) gets FIXED in place — split it, add the boundary, instrument the catch — not left as debt. "This file was already too big" is not an excuse to add to it.

**Simulate over real app paths — no fakes, no workarounds.** Any simulation (friends, presence, messages, sessions, events) injects through the REAL data paths the production app uses, so a simulated entity flows through the same source of truth as a real one and appears consistently across EVERY surface (not just one view). Simulation exists to exercise real code paths and surface real bugs; a fake that lights up one component hides the inconsistencies the real flow would expose. If a sim reaches only one surface, that inconsistency IS a bug — fix the data path, never add a second injection point or renderer special-case.

For projects without Gen3 tooling yet, first add the smallest portable control plane: config, classifier script, package scripts, tests, and agent-rule anchors.

## Telemetry And SRS Requirements

100% maintainable-by-agents requires actionable telemetry, not silent failure.

Default for Acme Desktop is SRS. Other SMA projects should have an equivalent telemetry/error-reporting surface before claiming agent-maintainability.

Rules:
- every real error is captured or breadcrumbed with context,
- no silent catches, no ignored promise failures, no fake success,
- **SRS/telemetry sensory everywhere:** every module/surface needs an error boundary routing to the telemetry facade, and every async/IPC/render path that can throw is instrumented. A crash or error with no report (e.g. a module crashing silently) is a P1 gap — when you find code with no sensory, ADD it, don't just note it,
- user-facing or runtime failures include area, severity, and useful diagnostics,
- run the project telemetry audit for touched code,
- final product claims require real runtime/backend/device proof or a stated blocker.

Unit tests can prove code paths. They do not prove final product progress when real backends, devices, users, CI, or peer lanes are part of acceptance.

## Graphify Retrieval Layer

Module graphs are mandatory for SMA Gen3 because each module can be large enough to exceed efficient manual context loading. Use the most local graph that can answer the question.

Graph levels:
- module graph: required daily work surface for a module agent,
- project graph: orchestration layer for shell/shared paths and cross-module joins,
- global graph: portfolio layer for cross-project discovery and reuse.

Default retrieval policy:
- `single-module`: query that module's graph before broad file reads.
- `multi-module`: each module agent queries its own graph; the controller compares module answers and uses the project graph for joins.
- `shared-hot-path`: use project graph first, then relevant module graphs.
- portfolio questions: use the global graph or `$SMARCH_DIR` wrapper.

Preferred SMA wrapper from `$SMARCH_DIR`:
- `npm run graphify:check:modules -- --project <project-id> --strict`
- `npm run graphify:refresh:self` for the SMA control-plane graph in `$SMARCH_DIR`
- `npm run graphify:query:self -- -- "question"` for SMA control-plane retrieval
- `npm run graphify:refresh:modules -- --project <project-id> --global`
- `npm run graphify:refresh:modules -- --project <project-id> --missing-only --limit 25 --global`
- `npm run graphify:query -- --project <project-id> --module <module-id> -- "question"`
- `npm run graphify:query -- --project <project-id> -- "cross-module question"`
- `npm run graphify:global:list`

Preferred installed CLI when already inside a graph root:
- `graphify query "<question>" --graph graphify-out/graph.json --budget 1500`
- `graphify path "Node A" "Node B" --graph graphify-out/graph.json`
- `graphify explain "Node" --graph graphify-out/graph.json`

If a required module graph is missing, treat it as a bootstrap gap. For small urgent edits, continue with `rg`/file reads and document that the graph is missing. For planned Gen3 work, refresh module graphs first.

## Global SMA Scanner

The global SMA layer lives at `$SMARCH_DIR`. It is the portfolio registry, scanner, state, wiki, Gen3 dashboard, lease system, and shared rulebook above all projects.

Use the scanner whenever work changes module boundaries, manifests, build/release surfaces, shared architecture, agent rules, or a project's SMA/Gen3 readiness. Do not leave portfolio numbers stale after meaningful project work.

Preferred commands from `$SMARCH_DIR`:
- `npm run scan:safe` refreshes `registry/global-modules.generated.json` under a lease.
- `npm run state:safe` refreshes `wiki/SMA_STATE.generated.json` under a lease.
- `npm run gen3:dashboard` refreshes `wiki/GEN3_DASHBOARD.generated.html`.
- `npm run ci:gen3` runs the Gen3 CI pipeline with context required and unresolved conflicts blocked.
- `npm run stats:summary -- --since 7d` reports adoption metrics.
- `npm run controller:snapshot -- --project <project-id>` gives a fast read-only leases/conflicts/graphs/dirty snapshot.
- `npm run state && npm run gen3:dashboard` refreshes active lease and conflict-observability snapshots.

Use safe lease-wrapped commands for generated global artifacts. Do not run overlapping scanner/state/wiki/dashboard regeneration from multiple agents without a lease.

For edits inside `$SMARCH_DIR`, use the project id `sma` with a descriptive control-plane brick id in `start:edit`, `end:edit`, `context`, and `conflict` commands. Before broad SMA control-plane reads, prefer `npm run graphify:query:self -- -- "question"`; if the graph is missing, refresh it with `npm run graphify:refresh:self`. SMA Graphify refresh commands default to local code-only extraction; semantic/provider enrichment is opt-in with `--semantic`.

For small code-only edits that do not affect SMA manifests, module ownership, or portfolio readiness, it is enough to note that the global scanner was not required. For any claim about portfolio numbers, always refresh or explicitly say the numbers are stale.

## Standalone SMA Discipline

This is the primary skill. Superpowers remains part of SMARCH's skill-
distribution lineage; see `docs/INFLUENCES.md`. Do not require Superpowers for
SMA Gen3 work.

If a legacy session still injects Superpowers context, treat it as optional background only. Follow `$sma-gen3`, project agent docs, `sma.gen3.json`, SRS/telemetry rules, mandatory module Graphify, and the SMA scanner wrappers as the current standard.

Use the built-in SMA flow:
- plan from the current lane and ownership map,
- test or gate before broad implementation claims,
- use worktrees for isolated large work,
- use module Graphify before broad manual reads,
- use SMA leases for global regeneration,
- verify before completion with project-local gates.

## Hook And Tooling Rules

Hooks must increase reliability without blocking normal safe work.

Review or change hooks when:
- tool calls fail before execution,
- session-start context is stale,
- plugin updates break startup,
- hook output pollutes stdout,
- a guard blocks safe commands,
- old sessions do not pick up Gen3.

Hook changes are shared control-plane work. Keep hooks small, fail-soft where possible, and verify with:
- hook JSON parse,
- a harmless command that previously failed,
- nested agent smoke when startup behavior changed,
- project Gen3 classification after edits.

Do not re-enable archived or legacy hooks until they are audited for Gen3 lanes, shell quoting, stdout cleanliness, stale-path behavior, and current project boundaries.

## Conflict Reporting

Every collision must be documented before the blocked agent continues elsewhere.

Use the project-local SMA conflict command when available:
- automatic path: `npm run start:edit -- --project <id> --brick <id> --intent "..."` records `conflict_detected` if the brick lease is already held,
- manual path: `npm run conflict -- report --project <id> --brick <id> --intent "..." --resolution-plan "..."`,
- closeout path: `npm run conflict -- resolve --project <id> --brick <id> --intent "..." --decision "..."`,
- controller gate: `npm run conflict:check -- --project <id> --strict`.
- portfolio gate: `npm run ci:gen3` includes the strict unresolved-conflict check.

Report collisions for held leases, dirty-file overlap, shared-hot-path contention, regen/global graph writes, and any forced handoff. After a conflict report, back off, pick a non-overlapping module, wait for release, or get explicit controller approval. Do not force-acquire over live work without a recorded conflict and a human/controller reason.

## Parallel Agent Rules

Parallel work is safe only when all are true:
- each agent has a separate claimed module/path set,
- no two agents touch the same shared hot path,
- work happens in isolated worktrees or clean branches,
- each agent runs lane gates for its changes,
- one controller integrates and reviews before release.

Best practical ceilings:
- runner swap only: about 5 agents,
- affected CI + cache + worktrees: 8-12 agents,
- full Gen3 control plane + merge queue + module ownership: 15-25 agents,
- 30+ only after most hot shared files are reduced or module-localized.

## Claims And Completion

Before saying work is done:
1. Re-run `git status --short --branch`.
2. Run project Gen3 classification if available.
3. Run lane-specific gates.
4. Run telemetry/SRS audit if code changed.
5. Run SMA/release gates for shared/release surfaces.
6. Attach real runtime proof for product behavior, or state the blocker.
7. End clean, pushed, or with a classified dirty-tree handoff.

If the branch is behind origin or heavily diverged, do not push directly unless explicitly asked.

## Bootstrap For Any Modular Project

For a project that is modular like Acme Desktop but not yet Gen3-enabled:
1. Identify modules from folder structure, package scripts, feature docs, and CI paths.
2. Identify shared hot paths: package/dependencies, CI, app shell, auth, telemetry, agent docs, build/release, native/platform code.
3. Create `sma.gen3.json` with `paidServicesEnabledByDefault: false`.
4. Copy or adapt the Gen3 classifier and tests.
5. Add `sma:gen3`, `sma:gen3:json`, `sma:gen3:check`.
6. Wire Gen3 validation into release gates.
7. Anchor the rule in repo agent docs.
8. Add a project profile only if commands differ; do not create a new skill.
9. Run the global SMA scanner/state/dashboard refresh after the project is mapped.

## SUP — Sweetspot Ultra Plan (optional layer, explicit trigger only)

SUP is the opt-in maximum-granularity planning layer above normal Gen3 work:
full vision reconstruction plus an exhaustive machine-readable task
decomposition in a repo-root `.UltraVision/` folder. Registered in the control
plane at `$SMARCH_DIR/docs/SUP_SWEETSPOT_ULTRA_PLAN.md`; reference
implementation is the `f5-ultravisionplan` skill.

- Never run SUP as part of normal SMA development. Trigger only on explicit
  user request ("SUP", "plan to perfection") or via `/f5-ultravisionplan`.
  A missing `.UltraVision/` folder is not a gap.
- When `.UltraVision/` exists, it is the plan of record: pick work with
  `uvp next`, claim/complete/verify through the bundled `uvp` tool with real
  evidence; never hand-edit `tasks/*.jsonl` or generated views.
- Executing SUP tasks follows normal Gen3 lanes, leases, gates, and
  telemetry proof. SUP changes what is planned, never how work is gated.

## SMOA — Sweetspot MoA (optional layer, explicit trigger only)

SMOA is the opt-in multi-model orchestration layer (Mixture of Agents):
Claude (Fable) plans, arbitrates, and holds every Gen3 gate at xhigh; Codex
CLI agents via `codex exec` are the ONLY execution workforce (model id
configurable per your codex auth), cross-reviewing each other under an
evidence-forced contract.
Registered in the control plane at
`$SMARCH_DIR/docs/SMOA_SWEETSPOT_MOA.md`; reference
implementation is the `sweetspot-moa` skill.

- Never self-trigger. Activate only on the literal tokens `SMOA`,
  `Sweetspot MoA`, `/smoa`, `run in SMOA mode`, `SMOA ensemble`, `SMOA-max`
  (legacy `SMOE` resolves here). Difficulty or task size is not a trigger.
- Autonomous fan-out, codex-only workforce, max 10 concurrent (standing
  rule). Never ask before dispatching; implementers are Codex agents at
  xhigh via `codex exec` only. Claude models never serve as fan-out implementers; the
  Opus second-executor from SMOA v1 is disabled unless the user explicitly
  asks ("SMOA with opus").
- The orchestrator holds all leases, gates, telemetry, and commits;
  executors never touch the Gen3 control plane. SMOA changes who executes,
  never how work is gated.
- Token summary at delivery is mandatory: per-agent model/tokens/API cost
  (USD) plus % of recent Claude spend (local session-log
  denominators; `unavailable — <reason>` over guessing), plus savings lines
  vs Fable-5 solo and vs Opus 4.8 solo (exact offloaded tokens, est. USD).
  A missing table blocks completion.
- Fable-only reservations: core planning, strategy, architecture, task
  decomposition, and acceptance criteria are never delegated. Frontend
  design decisions are Fable's own at the highest UI/UX standard; codex may
  implement frontend only from a Fable-authored design_spec in the packet,
  with Fable verifying the rendered result at the gate.

## SFF — Sweetspot Frontend-Fix (optional layer, explicit trigger only)

SFF is the opt-in design-excellence layer: Fable designs with its design
skill stack force-loaded, known AI-slop tells are hard-banned, delivery
requires Playwright screenshot verification at 3 breakpoints, and the result
is locked in a repo `.sff/DESIGN-LOCK.md`. Registered in the control plane
at `$SMARCH_DIR/docs/SFF_SWEETSPOT_FRONTEND_FIX.md`; reference
implementation is the `sweetspot-frontend-fix` skill.

- Never self-trigger. Activate only on literal `SFF` / `/sff` /
  `Sweetspot Frontend-Fix` / `frontend fix`.
- **Lock binds everyone, trigger or not:** when `.sff/DESIGN-LOCK.md`
  exists, any agent editing frontend surfaces reads it and matches it;
  LOCKED lines change only via Fable re-running SFF on explicit user
  request. `.sff/` is a shared hot path (lease + serialize).
- Under SMOA, frontend `design_spec`s derive from the lock.

## Project Profiles

For known project command hints and bootstrap notes, read `references/project-profiles.md`.
