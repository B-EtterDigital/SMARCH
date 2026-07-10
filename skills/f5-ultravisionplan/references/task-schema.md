# Task Schema, Deterministic IDs, Complexity Rubric, Volume Mechanics

The plan's tasks are **data**: JSONL records in `.UltraVision/tasks/<module>.jsonl`, one object per line, formal contract in `schema/task.schema.json`, mechanically enforced by `uvp validate`. Markdown under `tasklists/` is a generated view — never the truth.

## The record (fields that matter most)

```json
{"id":"UV-CORE-session-rotate-resilience","title":"Timeout/retry/idempotency semantics for session rotation",
 "description":"Define and implement timeout budget, retry/backoff policy, and idempotency for the rotate endpoint in src/core/session/rotate.ts; document the decision in code.",
 "module":"core","domain":"backend","lane":"single-module","milestone":"M1",
 "complexity":"C3","model_tier":"sonnet","status":"todo",
 "depends_on":["UV-CORE-session-rotate-impl"],"vision":["V-03"],"gaps":["G-01"],
 "acceptance_criteria":["duplicate delivery does not corrupt state","timeout path returns typed error within budget"],
 "gates":["pnpm typecheck:core","pnpm test:core"],"files_touched":["src/core/session/rotate.ts"],
 "paid":[],"prompt":null,"est_minutes":45,
 "template":"api-endpoint@1#resilience","inventory_ref":"api-endpoint/session-rotate",
 "claimed_by":null,"claimed_at":null,"evidence":null,"obsolete_reason":null}
```

Required: `id, title, description, module, domain, lane, milestone, complexity, model_tier, status, acceptance_criteria, gates`. `description` must be self-contained — a fresh agent with only this record plus the module charter can execute it. `acceptance_criteria` must be verifiable, not feelings. `gates` are real project commands.

Enums — domain: backend, frontend, design, ux, media, i18n, a11y, perf, test, docs, infra, telemetry, security, data, api, release. lane: single-module, multi-module, shared-hot-path, unmapped. status: todo → claimed → done → verified; obsolete (with reason) any time. paid: higgsfield, fal, elevenlabs (non-empty ⇒ `prompt` required and execution needs explicit user approval).

**v2 state/integrity fields** (stamped by tooling, upgraded via `uvp migrate`): `schema_version` (current 2); `spec_hash` (16-hex digest of spec fields — validate flags out-of-band hand edits, `expand --dry-run` flags template drift, `migrate --rehash` accepts deliberate edits); `platform` (set by per-platform fan-out); `lease` (SMA brick lease held via `claim --lease`); `verified_by` (verifier ≠ executor). `evidence` may be a string (textual proof) or the structured object recorded by `complete --evidence-cmd` — `{cmd, exit, ts, output_sha256, output_tail}` — which `uvp audit-claims` can re-run to spot-check claims honesty.

## Deterministic IDs (permanent contracts)

```
UV-<MODULECODE>-<item-slug>-<step-slug>     templated (expansion computes it)
UV-<MODULECODE>-<area-slug>-<task-slug>     bespoke  (you compute it the same way)
```

Same inventory item + same template step ⇒ same ID, every run — that is what makes re-expansion idempotent and refresh-safe. Never renumber, never reuse, never delete; retire with `uvp obsolete <id> --reason`. Statuses/evidence always survive re-expansion (`expand` preserves them; `--update-spec` refreshes only spec fields).

## Complexity rubric (objective, not vibes)

Score four dimensions 0–3; the sum picks the tier. Templates ship calibrated defaults — you score only bespoke tasks and overrides.

| Dimension | 0 | 3 |
| --- | --- | --- |
| context | none beyond the record | must understand several modules' internals |
| ambiguity | fully specified | requires design decisions |
| blast_radius | one file | cross-module / shared hot path |
| risk | cosmetic if wrong | data loss, security, release-blocking |

Sum 0–2 → **C1** (haiku) · 3–4 → **C2** (sonnet) · 5–7 → **C3** (sonnet) · 8–10 → **C4** (opus) · 11–12 → **C5** (fable + controller review).

Rules: torn between tiers → pick higher. A C4/C5 that decomposes into C2/C3s **should be decomposed** — C5s must be rare and irreducible. Media generation is usually C2: the creative judgment was spent writing the prompt at plan time. Record `complexity_scores` when overriding a template default. Default `est_minutes`: C1=15, C2=30, C3=60, C4=120, C5=240.

## Inventories (what makes 100k tasks real)

`inventories/<module>.<type>.json` — one file per module×type so parallel writers never collide (`uvp` reads all `inventories/*.json`; only the `type` field matters):

```json
{"type": "ui-component",
 "items": [
   {"slug": "hud-speed", "name": "HUD speed readout", "module": "ui", "milestone": "M1",
    "path": "src/ui/hud.js", "vision": ["V-02"], "gaps": ["G-03"],
    "evidence": "01-CURRENT-STATE.md audit / src/ui/hud.js:3",
    "depends_on": ["UV-SHELL-i18n-foundation-impl"],
    "skip_steps": ["motion"],
    "overrides": {"impl": {"complexity": "C4"}},
    "vars": {}}
 ]}
```

- Every item cites provenance twice: `vision`/`gaps` (traceability, enforced) and `evidence` (where the item came from — an audit finding, architecture doc, or extractor hit `file:line`). An inventory item that traces to nothing is padding.
- Item-level `depends_on` (full task IDs) attaches foundation dependencies to the item's entry steps (steps without sibling deps); later steps inherit them transitively. This is how templated tasks depend on bespoke foundations (i18n layer, app shell) — respecting `allowed_deps` directions.
- `skip_steps` drops template steps that genuinely don't apply (rare — prefer keeping the quality steps).
- `overrides` adjusts complexity/milestone/est per step; `vars` feeds extra template variables (media items: `tool`, `prompt`, `format`, `budget`, `style_ref`).
- Enumerate exhaustively per the audit and target architecture: if the perfected product has 300 components, the inventory has 300 items — that, times the template, is the honest path to volume.

## Templates (bundled quality machinery)

`templates/*.json` in the skill (project overrides in `.UltraVision/templates/` win on the same `applies_to`): ui-component, screen, api-endpoint, data-entity, locale, media-asset, module-baseline, cli-command, background-job, notification, settings-entry, analytics-event, game-level, e2e-journey, doc-page. Each step carries domain, default complexity, est, `{var}`-interpolated title/description/criteria, gates (`{module_gates}` splices the module's real commands from `modules.json`), sibling deps (`#step`), and `milestone_min` for polish-tier steps. Add a new template when ≥3 inventory items would share the same step list — otherwise write bespoke tasks.

**Composition (`$ref`).** `templates/_common.json` is a step library (`"library": true`). A template step `{"$ref": "telemetry", "depends_on": ["#impl"]}` inherits the shared step and overrides fields wholesale. Shared quality steps live once — they cannot drift apart between templates.

**Platform axis.** Declare `product.platforms` (e.g. `["web", "desktop"]`) in `modules.json`. A step with `"per_platform": true` fans out one task per platform (`<step>-<platform>` slug, `platform` field set, `{platform}` available in text); a step with `"platforms": ["web"]` applies only when the product targets it. No platforms declared → single tasks, no suffix.

**Calibration.** After a pilot, record correction factors instead of editing thousands of tasks: `product.calibration.complexity_shift` (whole product) and per-module `calibration.complexity_shift` shift template *default* complexities by ±N tiers (clamped C1..C5, model tier follows). Item-level `overrides` always win.

## Bespoke tasks (the non-mechanical remainder)

Hot-path/bootstrap (M0), i18n foundation, style bible, migrations, signature clever-UI mechanisms, one-off engineering. Written directly into `tasks/<module>.jsonl` (append, one JSON object per line, sorted order restored by the next `uvp` write). Same schema, same rubric, deterministic slug IDs, `template: null`, real `vision`/`gaps` refs. One writer per module file — the controller owns the shared-hot-path module's file.

## Writing rules that survive scale

- One concern per task; "X and also refactor Y" is two records.
- `depends_on` = real blockers only; thematic ordering belongs to milestones. False deps serialize parallelizable work.
- Cross-module deps must follow `modules.json.allowed_deps` (validator rejects forbidden directions). Prefer depending on a shared contract task (types/API in the hot-path module) over another module's internals.
- Titles unambiguous among 100,000 siblings; descriptions name files, functions, behaviors — never "as discussed" or "improve X".
