---
name: f5-ultravisionplan
description: F5-UltraVisionPlan — the reference implementation of SUP (Sweetspot Ultra Plan), SMA's opt-in maximum-granularity planning layer. Audits a repo, reconstructs its ultimate vision, and mechanically generates an exhaustive, complexity-rated, machine-readable task plan into a .UltraVision folder that SMA Gen3 agents execute in parallel. Use whenever the user says SUP, Sweetspot Ultra Plan, UltraVision, /f5-ultravisionplan, "plan to perfection", "full vision plan", asks for every remaining task to finish or perfect a project, or when a repo contains a .UltraVision folder (this skill then governs reading, executing from, refreshing, and extending it). Never self-trigger for normal SMA development.
---

# F5-UltraVisionPlan — SUP (Sweetspot Ultra Plan)

Turn a repo into a complete, evidence-backed, **machine-readable** plan from current state to the perfect realization of its vision: documented in `.UltraVision/`, decomposed into atomic tasks with deterministic IDs, complexity-rated for model-strength delegation, DAG-chained, and grouped by SMA Gen3 module ownership so parallel agents never collide.

SUP is registered in the SMA control plane (`$SMARCH_DIR/docs/SUP_SWEETSPOT_ULTRA_PLAN.md`; portfolio roll-up: `npm run sup:status` there). It is **opt-in**: run it only when explicitly requested or when a `.UltraVision/` folder already exists. This is a planning skill — it writes plans, not product code.

## Architecture in one paragraph

The plan's source of truth is JSONL (`tasks/<module>.jsonl`, schema in `schema/task.schema.json`) — markdown is a generated view. Volume comes from **mechanics, not prose**: you build *inventories* (every screen, component, endpoint, entity, locale, asset — bootstrapped mechanically by `scripts/extract_inventory.py`, then curated), and the bundled `uvp` tool cross-multiplies them with *checklist templates* (`templates/*.json` — 15 templates sharing quality steps via a `$ref` library so tests, a11y, i18n, perf, telemetry, docs can't drift apart) into thousands of consistent tasks with deterministic, permanent IDs. 300 components × ~11 steps = 3,300 real tasks, mechanically, idempotently — with per-platform fan-out and per-project complexity calibration when configured. Freehand task-writing is reserved for bespoke work templates can't express. That is how 100k+ tasks means coverage, never padding.

```
.UltraVision/
├── 00-VISION.md … 08-QUALITY-RELEASE-PLAN.md   strategy docs (templates: references/ultravision-structure.md)
├── modules.json          Gen3 binding: ownership, gates, hot_paths, allowed_deps,
│                         product{media_class, platforms, calibration}, sma{control_plane, project_id}
├── inventories/*.json    enumerations that drive expansion (proposed/ holds extractor output)
├── tasks/<module>.jsonl  SOURCE OF TRUTH — one task per line
├── tasklists/            generated views + hand-written _MODULE.md charters
├── INDEX.md              generated dashboard
└── meta/                 vision registry & source hashes, pipeline state, stats,
                          validation, topo, wave, journal, reports, waivers, notes
```

## The tool

Everything mechanical goes through `uvp` (stdlib Python, bundled). All mutations are lock-serialized and journaled.

```bash
UVP="python3 <this-skill-path>/scripts/uvp.py --root <repo>/.UltraVision"
# plan lifecycle
$UVP expand [--dry-run]       # inventories × templates; dry-run = volume/tier/effort projection + template-drift check
$UVP validate --strict        # schema+DAG+allowed_deps+hot-paths+vision-registry+coverage (SMA-C1..C10); --pedantic promotes lints
$UVP render | stats | topo    # views+INDEX / stats.json / waves+critical path
$UVP migrate [--rehash]       # stamp schema versions + spec hashes; --rehash accepts intentional hand-edits
$UVP drift [--update]         # vision-source hash check — did the vision's evidence change since G1?
# consumer contract (execution)
$UVP next --module m --tier sonnet [--critical]   # ready tasks; --critical = deepest downstream chain first
$UVP dispatch --ceiling 8     # wave manifest for parallel agents → meta/wave.json (hot-path queue serialized)
$UVP claim <id> --agent a [--lease]               # --lease bridges SMA start:edit (aborts on conflict)
$UVP complete <id> --evidence-cmd "pnpm test:m"   # gate must exit 0; recorded as auditable structured evidence
$UVP verify <id> --agent controller | obsolete <id> --reason "…"
$UVP report | audit-claims --sample 5 | featmap | gen3-draft
```

## Non-negotiables

1. **Opt-in only.** Never generate `.UltraVision/` because it "would help"; a missing folder is not a gap.
2. **SMA spec or stop.** Resolve the SMA rules per `references/sma-gen3-spec.md` (project `sma.gen3.json` → `$sma-gen3` skill/control plane → bundled spec). If sources can't be reconciled, stop and report — never improvise SMA-ish structure. "100% compliant" means the mechanical checklist (SMA-C1..C10) passes, not an assertion.
3. **Evidence first.** Every vision pillar, audit claim, and gap cites sources (`path:line`, commits, memories). Audit claims carry confidence: `[verified]` (inspected) or `[inferred]` — every `[inferred]` claim that matters spawns a cheap C1 verification task instead of becoming a silent assumption.
4. **Vision gate before volume.** Mass generation against an unapproved vision is the most expensive possible mistake. G1 is blocking; vetoed pillars are recorded and the validator rejects tasks referencing them forever after.
5. **Deterministic IDs are permanent contracts.** `UV-<CODE>-<item>-<step>` — re-runs merge, never duplicate or renumber; statuses and evidence always survive re-expansion. Spec hashes catch out-of-band edits; `--dry-run` catches template drift.
6. **Bounded perfection.** Milestones M0 (foundation) → M1 (MVP) → M2 (beta) → M3 (1.0) → M4+ (vision-complete), each with a definition-of-done in `08-QUALITY-RELEASE-PLAN.md`. Every task is tagged; "perfection" is the top tier, not an excuse for padding.
7. **Complexity by rubric, not vibes.** Score context/ambiguity/blast-radius/risk 0–3 each; sum → C1..C5 → model tier (C1 haiku, C2–C3 sonnet, C4 opus, C5 fable + controller review). Templates carry calibrated defaults; pilot results feed `calibration.complexity_shift` in modules.json rather than hand-adjusting thousands of tasks. Rubric: `references/task-schema.md`.
8. **Quality lives inside tasks.** Templates force tests, a11y (WCAG 2.2 AA), i18n readiness, perf budgets, telemetry, docs onto every inventory item. There is no "hardening later".
9. **Paid stays opt-in.** Media tasks (Higgsfield/Fal/ElevenLabs) carry `paid` + a ready-to-run `prompt`; execution needs explicit user approval, batch-approved per milestone in `05-MEDIA-PLAN.md`.
10. **Resumable, honest pipeline.** Progress is checkpointed in `meta/pipeline-state.json`; a re-invoked session resumes at the first incomplete phase. Claims cite validator output and `uvp` reports, never estimates. Completion evidence is auditable (`audit-claims` re-runs sampled gates).

## The pipeline

Phases P0–P9, each ending with a checkpoint in `meta/pipeline-state.json` (on invocation: read it first, resume at the first phase not `done`/`approved`). P1–P5 are controller work; P6–P7 fan out — when the Workflow tool is available, run the fan-outs through it (journaled, resumable, capped concurrency) instead of hand-managed agent waves. If the user gave a token budget ("+200k"-style), scale audit depth and wave sizes to it and record the budget in pipeline-state.

### P0 — Preflight
`git status --short --branch` (preserve dirty work). Resolve the SMA spec (non-negotiable #2). Existing `.UltraVision/` → **refresh mode** (below). Take the project lease on brick `ultravision-plan` where lease tooling exists — record `lease: <id>` or `lease: none (no tooling)` in pipeline-state either way; never run two generations concurrently. Mode: **full** (default) / **pilot** / **refresh**.

**Pilot mode, precisely** (calibration before committing to volume): all root docs and `modules.json`; the `module`-type inventory and `_MODULE.md` charters for **all** modules (the SMA floor always applies); full inventories + expansion + bespoke tasks for **one representative module** plus the shared-hot-path M0 bespoke tasks; the P7 coverage check scoped to the pilot module's gaps — remaining gaps are recorded as `deferred` in pipeline-state, not failures; coverage waivers for deferred modules use the reason prefix `pilot-deferred:` and MUST be deleted when the full run generates the real tasks. Pilot ends at G3 with the full-plan projection.

### P1 — Vision reconstruction → `00-VISION.md` + the G1 packet
Mine intent, most-reliable-first: explicit vision artifacts (README, docs/, .planning/, PRDs, roadmaps, landing copy) → agent memory (claude-mem `mem-search`) → code archaeology (TODO/FIXME/WISH, disabled flags, stubbed routes) → git history (first commits, README diffs, abandoned branches) → agent docs. Synthesize **vision pillars** V-01… (one-line user promises, cited `[source]` or `[elevated]`); conflicts → most ambitious coherent version + an Open Question. Then **elevate** as a world-class architect/designer per `references/design-excellence.md`. Record every pillar's evidence files in `meta/vision-sources.json` and stamp with `$UVP drift --update`.

End P1 by assembling the **G1 packet** — the detailed vision audit the user will actually read: per pillar its promise, tag, evidence trail, and "perfection means"; elevations and conflicts highlighted; non-goals; open questions. This is a presentation, not a data dump — the user must be able to spot a *missing* dream at a glance.

### G1 — VISION COMPLETENESS + APPROVAL GATE (blocking, two rounds)
**Round 1 — "What's missing?"** Present the G1 packet, then explicitly ask: *"This is the biggest vision I could reconstruct and elevate. What's missing? What did you always want this product to be that appears nowhere here?"* (AskUserQuestion works well: one question for missing vision — options like "Nothing missing" plus themed prompts, with Other for free text — alongside the ballot below.) Everything the user contributes becomes a first-class pillar tagged **`[user]`**: formalize it (one-line promise, "perfection means", module impact), append it to `00-VISION.md`, and register it `status: approved, origin: user` — user-stated pillars need no ballot and are exempt from drift (empty `sources` list in `meta/vision-sources.json`).

**Round 2 — ballot.** Approve/veto per elevated/conflicted pillar; `[source]` pillars listed for confirmation. Write the full outcome to `meta/vision.json` — every pillar with `status: approved|vetoed` and `origin: source|elevated|user`, plus `non_goals` — and record both rounds in pipeline-state.

The validator then enforces this gate's outcome mechanically for the rest of the plan's life: tasks referencing vetoed pillars are **errors**, and any approved pillar with **zero tasks** is flagged ("vision not incorporated into the tasklists" — info in pilot, warning in full, so `[user]` additions can never silently fail to reach the modular tasklists). Downstream, treat `[user]` pillars exactly like the rest: P2 audits current state against them, P3 gives them gaps, P6 inventories them, P7 decomposes them. **No generation before this gate.** If the user is unreachable in an autonomous run: stop, deliver the G1 packet, state that P2+ awaits the missing-vision round and sign-off.

### P2 — Current-state audit → `01-CURRENT-STATE.md`
Audit every pillar and quality dimension: features (absent/stub/partial/solid/polished), architecture boundaries, tests, telemetry/SRS (silent failures are findings), design system, a11y, i18n (count hardcoded strings), performance, docs, CI gates, release readiness. Graphify first (module → project → global); cite everything; tag `[verified]`/`[inferred]` per non-negotiable #3.

### P3 — Gap register → `02-GAP-ANALYSIS.md`
Pillars × audit → `G-<NN>` gaps with severity, affected modules, blocked pillars. The register is the coverage contract: P7 is not done until every gap is fully decomposed.

### P4 — Module map + architecture → `03-TARGET-ARCHITECTURE.md` + `modules.json`
Target module map extending `sma.gen3.json` ownership. Write `modules.json` per `references/sma-gen3-spec.md`: ownership globs, real gate commands, `hot_paths`, **`allowed_deps`** (architecture dependency directions become hard DAG constraints), `product.media_class` (per `references/media-pipeline.md`), `product.platforms` (enables per-platform template fan-out), and `sma.control_plane`/`project_id` (enables the `claim --lease` bridge). If the repo lacks Gen3 tooling, run `$UVP gen3-draft` — the M0 bootstrap task ships a ready-to-adapt `sma.gen3.json` draft, not just an instruction. **G2 (light gate):** confirm module map, media classification, platform list, and milestone ladder with the user.

### P5 — Strategy docs → `04`–`08`
Per `references/ultravision-structure.md`: design language, media plan (style-bible-first) or reasoned N/A, i18n plan, performance ladder with named baseline device and budgets, milestone definitions-of-done + release trains.

### P6 — Inventories → `inventories/*.json`
Coverage is decided here. First run the mechanical extractor: `python3 <skill>/scripts/extract_inventory.py <repo>` — it proposes components/screens/endpoints/entities/assets into `inventories/proposed/` with evidence and auto-assigned modules. Then **curate**: verify, add what extraction can't see (from the vision: planned-but-absent surfaces), assign milestones and vision/gap refs, move into `inventories/` as `<module>.<type>.json` (one file per module×type — collision-free parallel writes). Fan out one subagent per module (waves ≤8) for curation and vision-driven additions; apply the `module`-type inventory to every module (baseline tasks). What no template fits goes to P7 bespoke, never force-fitted.

### G3 — VOLUME GATE (pilot mode, or any projected count over ~5,000)
Present to the user: the `$UVP expand --dry-run` projection (task volume, tier distribution, estimated effort, template drift) plus — in pilot — the pilot module's actual tasks as the granularity sample. The user approves volume and granularity (optionally setting `calibration.complexity_shift` from the sample) before full expansion. Record the decision and projected count in pipeline-state.

### P7 — Task generation
1. `$UVP expand` — the mechanical cross-product. Fix reported problems; re-run (idempotent).
2. **Bespoke tasks** for what templates can't express: hot-path/bootstrap (M0), i18n foundation, style bible, migrations, signature clever-UI mechanisms, one-off engineering. Templated tasks that need foundation deps get them via item-level `depends_on` in the inventory (attached to entry steps automatically). Fan out per module — each subagent appends only to its own `tasks/<module>.jsonl` (same schema, slug IDs, rubric scoring, `spec_hash` optional for hand-written records). Controller writes the shared-hot-path module's file. After each module batch: plain `$UVP validate` (errors must be zero; warnings accumulate to P8) + checkpoint the cursor **before** starting the next batch.
3. Write each module's `_MODULE.md` charter.
4. **Coverage check against the gap register**: every G-xx fully decomposed (tasks exist and trace back via `gaps:[]`). Uncovered gap = P7 not done.

### P8 — Validation (self-audit)
`$UVP validate --strict` until clean; then once with `--pedantic` and review the lints (near-duplicate titles = padding check; unordered co-edit risks = worktree conflict check). `$UVP topo` — waves and critical path recorded.

### P8.5 — Adversarial completeness (the right to say "every")
Fan out one skeptic subagent per module with the vision, gap register, and that module's task list, prompted to **refute completeness**: name concrete work that stands between current state and the approved pillars but appears in no task. Real findings become inventory items or bespoke tasks (back to P7 for that module); non-findings are recorded. Two consecutive clean skeptic rounds per module → the plan may claim exhaustiveness. Budget-scale the panel (1 round for small repos, 2+ for flagship).

### P9 — Render + honest handover
`$UVP render`. Hand-write `meta/index-notes.md`: execution guide (parallel lanes now, `dispatch` ceiling for the repo's Gen3 maturity, hot-path ordering, paid-batch approval status), SMA-P1..P3 attestations, and **Known plan gaps**. Re-render. Final claim cites validator PASS, stats.json totals, G1/G2/G3 approvals, and the P8.5 skeptic outcome.

## Refresh mode (idempotent re-runs)

Never restart from scratch: `$UVP drift` first — changed vision sources reopen G1 for the delta. Re-audit reality; mark completed work via `complete`/`verify` with evidence; `obsolete` dead rationale (never delete); update inventories; `$UVP expand` (`--dry-run` first to review drift, `--update-spec` only when templates changed intentionally); append new bespoke tasks; P8→P9. `migrate --rehash` accepts deliberate hand-edits.

## Executing from an existing .UltraVision (any agent, any session)

The folder is the plan of record. Controller: `$UVP dispatch --ceiling <Gen3 maturity>` → hand each agent slot its module queue. Agent: `$UVP next --module <yours> --tier <your strength> [--critical]` → `claim --lease` (where SMA tooling exists — a lease conflict means back off, per Gen3) → work under normal lanes/gates → `complete --evidence-cmd "<the task's gate>"` (must pass; auditable) → controller `verify`. Never hand-edit `tasks/*.jsonl` or generated views; never burn a fable-tier model on C1 tasks or delegate C5 to haiku. Paid tasks need the milestone batch approved first. Periodically: `$UVP report` (velocity/ETA), `audit-claims` (spot-check honesty), `featmap` (propose SFM rows for delivered pillars), `render` after meaningful progress. Reality drifted → refresh mode, not hand-surgery.

## Reference files (read when the phase needs them)

- `references/sma-gen3-spec.md` — bundled SMA spec, compliance checklist SMA-C1..C10, modules.json contract. Read at P0.
- `references/task-schema.md` — record schema, deterministic IDs, rubric, inventory/template/composition/platform/calibration mechanics. Read before P6/P7.
- `references/ultravision-structure.md` — folder tree, document templates, charter, pipeline-state and meta files.
- `references/design-excellence.md` — UX/UI bar, i18n readiness, performance ladder. Read at P1 (elevation) and P5.
- `references/media-pipeline.md` — visual/utility heuristic, tool routing, style-bible-first rules. Read at P4/P5.
- `schema/task.schema.json`, `templates/*.json` — machine contracts consumed by `uvp`; project overrides in `.UltraVision/templates/`.
