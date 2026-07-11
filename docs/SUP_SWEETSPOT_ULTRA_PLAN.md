# [SUP](GLOSSARY.md#sup) — Sweetspot Ultra Plan

This guide defines the opt-in planning layer that turns a product vision into a tracked UltraVision task graph. Planners, controllers, and executing agents need it when a request activates SUP or a repository already uses an UltraVision plan of record. Read it before creating, claiming, verifying, or closing plan tasks. Remember to update task state through the plan tooling and never by editing generated task records by hand.

SUP is the optional, maximum-granularity planning layer of SMA. Where normal
Gen3 work plans just enough to move a lane safely, SUP reconstructs a project's
full vision, audits the current state, and decomposes the entire gap into
atomic, complexity-rated, machine-readable tasks — up to 100k+ when the gap is
real — grouped by module ownership so Gen3 agents can execute them in parallel.

SUP is the planning sibling of SFM: SFM registers what *exists*, SUP registers
everything that still stands between the current state and the perfected vision.

## Opt-in rule (important)

SUP is **never** part of normal SMA development. It runs only when:

1. the user explicitly asks for it ("SUP", "Sweetspot Ultra Plan", "plan to
   perfection", "full vision plan"), or
2. the **F5-UltraVisionPlan** skill is invoked (`/f5-ultravisionplan`,
   installed at `~/.claude/skills/f5-ultravisionplan/`), which is the reference
   implementation of SUP.

Agents must not spontaneously generate `.UltraVision/` folders, and must not
treat the absence of one as a gap to fix.

## Artifacts (plan of record)

A SUP-planned repo carries `.UltraVision/` at the repo root:

| Artifact | Meaning |
| --- | --- |
| `00-VISION.md` … `08-QUALITY-RELEASE-PLAN.md` | Vision pillars (V-xx), audit, gap register (G-xx), target architecture, design language, media/i18n/perf plans, milestone tiers M0..Mn with definition-of-done |
| `modules.json` | Module map mirroring `sma.gen3.json` ownership: id, code, gates, lane default, `allowed_deps` (permitted cross-module dependency directions) |
| `inventories/*.json` | Enumerations (screens, components, endpoints, entities, locales, assets…) that drive mechanical task expansion |
| `tasks/<module>.jsonl` | **Source of truth.** One task per line; deterministic permanent IDs `UV-<CODE>-<item>-<step>`; complexity C1–C5 mapped to model tiers (C1 haiku → C5 fable + review) |
| `tasklists/**` | Generated human-readable views + hand-written `_MODULE.md` charters — never hand-edit generated files |
| `meta/` | stats, validation report, topo/critical path, journal, waivers, pipeline state |

## How executing agents consume SUP

The skill bundles the `uvp` tool (`scripts/uvp.py`) — the consumer contract:

- Controller: `uvp dispatch --ceiling <N>` emits a wave manifest (per-module agent slots ordered by critical-chain weight; hot-path queue serialized) → `meta/wave.json`.
- Agent: `uvp next --module <id> --tier <haiku|sonnet|opus|fable> [--critical]` — ready tasks (deps satisfied), pre-filtered for delegation by model strength.
- `uvp claim <id> --agent <name> [--lease]` → work → `uvp complete <id> --evidence-cmd "<the task's gate>"` (command must exit 0; recorded as structured, re-runnable evidence) → controller `uvp verify <id>`.
  `--lease` bridges the SMA lease protocol automatically: it runs `start:edit` for brick `uv-<module>` (aborting on conflict, per Gen3 back-off rules) and `complete` releases via `end:edit`. Configure in the plan's `modules.json`: `"sma": {"control_plane": "~/DEV/SMARCH", "project_id": "<id>"}`.
- Honesty tooling: `uvp audit-claims` re-runs sampled done tasks' evidence commands; `uvp report` gives velocity/ETA from the journal; `uvp drift` detects when the vision's source files changed since approval; `uvp featmap` proposes SFM rows for fully delivered pillars.
- `uvp validate --strict` must pass before any completion claim about the plan; `uvp render` refreshes views and INDEX.
- Status changes go through the tool (lock-serialized, journaled), never by hand-editing JSONL or markdown views.

## Portfolio visibility

`npm run sup:status` (from this repo) rolls up every registered project's
`.UltraVision/meta/` into `wiki/sup/SUP_STATUS.generated.md`. Register
SUP-planned repos in `wiki/sup/projects.json`:
`{ "projects": [ { "id": "acme-factory", "root": "/abs/path" } ] }`.

## Gen3 compatibility rules

- Task grouping mirrors `sma.gen3.json` module ownership; `shared-hot-path`
  tasks are serialized exactly like any hot-path work.
- `modules.json.allowed_deps` turns architecture direction rules into hard DAG
  constraints — `uvp validate` rejects task dependencies along forbidden edges.
- SUP planning itself is docs-lane, single-owner work: take a project lease on
  brick `ultravision-plan` before generating or refreshing.
- Executing SUP tasks follows normal Gen3 lanes, leases, gates, telemetry/[SRS](GLOSSARY.md#srs)
  proof rules, and claims discipline. SUP changes *what* is planned, never *how*
  work is gated.
- Paid services (Higgsfield/Fal/ElevenLabs media tasks, paid CI) stay opt-in:
  such tasks carry a `paid` flag and run only on explicit user approval.

## Where the full specification lives

The F5-UltraVisionPlan skill is the normative SUP implementation: task schema,
complexity rubric, inventory×template mechanics, checklist templates, the
bundled Gen3 compliance checklist, and the `uvp` tool. Update that skill —
not per-project forks — when SUP evolves.
