# Bundled SMA Gen3 Spec (condensed) + Mechanical Compliance Checklist

SUP plans must be 100% SMA Gen3 compliant. A fresh instance cannot be assumed
to know SMA, so this file bundles the operating rules the plan depends on.

**Spec resolution order — and fail-loudly rule:**
1. The project's own `sma.gen3.json` + repo agent docs (AGENTS.md/CLAUDE.md) — always authoritative for module names, gates, commands.
2. The `$sma-gen3` skill, if installed (`~/.claude/skills/sma-gen3/`), and the global control plane at `$SMARCH_DIR` (SUP registration: `docs/SUP_SWEETSPOT_ULTRA_PLAN.md`).
3. This bundled condensation.

If (1) is missing, the plan's M0 milestone MUST contain the Gen3 bootstrap tasks (below). If you cannot read this file or reconcile the sources, **stop and say so — never improvise "SMA-ish" structure.**

## The Gen3 model (what the plan must respect)

- **Module ownership**: `sma.gen3.json` declares which paths each module owns. Module-local work is the fast lane; parallel agents are safe only on disjoint owned path sets, in isolated worktrees/branches, with one controller integrating.
- **Lanes**: `single-module` (fast, parallelizable), `multi-module` (split by module where practical; affected gates before completion), `shared-hot-path` (ONE active owner, merge-queue/release-train thinking), `unmapped` (single-agent until mapped).
- **Hot paths** (always treated as shared): package/dependency files, CI workflows, app shell/router/layout, auth/session/entitlements, telemetry/SRS core, agent instruction files, build/release/deploy, native/platform code, shared data schemas.
- **Telemetry/SRS**: agent-maintainability requires actionable telemetry — every real error captured/breadcrumbed with area+severity+context; no silent catches, no ignored promise failures, no fake success. Unit tests prove code paths, not product claims: final claims need runtime/backend/device proof or a stated blocker.
- **Graphify retrieval**: module graphs are the daily work surface; query the most local graph before broad reads (module → project → global). Missing graphs are bootstrap gaps.
- **Claims discipline**: before "done" — `git status --short --branch`, Gen3 classification, lane gates, telemetry audit, real proof or stated blocker.
- **Leases/conflicts**: claim a brick before editing (`start:edit`), report every collision, never force-acquire silently. SUP planning itself claims brick `ultravision-plan`.
- **Cost policy**: `paidServicesEnabledByDefault: false`. Paid acceleration and paid generation (Higgsfield/Fal/ElevenLabs) run only on explicit user approval.
- **Parallel ceilings**: ~5 agents (runner swap only), 8–12 (affected CI + worktrees), 15–25 (full Gen3 control plane + merge queue), 30+ only after hot shared files are structurally reduced.

## Gen3 bootstrap (M0 tasks when `sma.gen3.json` is missing)

1. Map modules from folders/scripts/CI/docs; map hot paths (list above).
2. Create `sma.gen3.json` with `paidServicesEnabledByDefault: false`.
3. Adapt the Gen3 classifier + tests; add `sma:gen3`, `sma:gen3:json`, `sma:gen3:check` scripts.
4. Wire Gen3 validation into release gates; anchor rules in repo agent docs.
5. Refresh module Graphify graphs; register with `$SMARCH_DIR` (`npm run scan:safe`, `state:safe`, `gen3:dashboard`).

## Mechanical compliance checklist

"100% SMA compliant" is checked, not asserted. `uvp validate --strict` enforces
the mechanical items; the planner attests the procedural ones in INDEX notes.

| ID | Rule | Enforcement |
| --- | --- | --- |
| SMA-C1 | Task grouping mirrors module ownership: task lives in `tasks/<module>.jsonl`, ID carries that module's code | `uvp validate` error |
| SMA-C2 | Every task declares a lane from the Gen3 enum | error |
| SMA-C3 | A task whose `files_touched` hits a declared hot path (`modules.json.hot_paths`) has lane `shared-hot-path` | error |
| SMA-C4 | `single-module` tasks touch only their module's ownership globs | warning (fails `--strict`) |
| SMA-C5 | Cross-module task deps respect `modules.json` per-module `allowed_deps` (architecture dependency directions become hard DAG constraints) | error |
| SMA-C6 | Dependency graph is acyclic; `uvp topo` exports waves + critical path | error |
| SMA-C7 | Paid tasks carry `paid` + ready-to-run `prompt`; utility-class products (`product.media_class: "utility"`) carry no media/paid tasks without a written waiver | error |
| SMA-C8 | `done`/`verified` require `evidence`; `obsolete` requires `obsolete_reason` | error |
| SMA-C9 | Coverage matrix: every module × {test, telemetry, a11y, i18n, perf, docs, security} has tasks or a reasoned waiver in `meta/waivers.json` | warning (fails `--strict`) |
| SMA-C10 | Every module has charter + baseline tasks (module-baseline template applied to every entry in `modules.json`) | planner attests; coverage matrix backs it |
| SMA-P1 | Plan generation held the `ultravision-plan` lease (where lease tooling exists); no concurrent generation | procedural |
| SMA-P2 | Graphify graphs used/refreshed, or their absence recorded as M0 tasks | procedural |
| SMA-P3 | Completion claims cite `uvp validate` results and real evidence, never estimates | procedural |

## modules.json contract (the plan's Gen3 binding)

```json
{
  "product": { "media_class": "visual|utility", "rationale": "one sentence" },
  "hot_paths": ["package.json", ".github/workflows/**", "src/shell/**"],
  "modules": [
    {
      "id": "core", "code": "CORE",
      "ownership": ["src/core/**"],
      "gates": ["pnpm typecheck:core", "pnpm test:core"],
      "lane_default": "single-module",
      "allowed_deps": ["shared-hot-path"],
      "graph": "graphify-out/modules/core/graph.json"
    }
  ]
}
```

- Derive `modules`/`ownership` from `sma.gen3.json` when it exists (target-state additions go to 03-TARGET-ARCHITECTURE.md and become shared-hot-path tasks). For repos without one, `uvp gen3-draft` emits a ready-to-adapt draft from modules.json — adopting it is the M0 shared-hot-path task.
- `allowed_deps` lists the modules each module MAY depend on. Derive from the architecture's dependency directions; most modules should list the shared/hot-path module. Omit the key only when the architecture genuinely allows unrestricted edges.
- `product.media_class` implements the media-pipeline detection rule mechanically; `product.platforms` drives per-platform template fan-out; `product.calibration`/per-module `calibration` hold pilot-derived complexity shifts.
- Optional `"sma": {"control_plane": "$SMARCH_DIR", "project_id": "<id>"}` enables the lease bridge: `uvp claim --lease` runs `start:edit` for brick `uv-<module>` (aborting on conflict, per Gen3 back-off rules) and `uvp complete` releases it via `end:edit`. Portfolio visibility: `npm run sup:status` in the control plane rolls up every registered project's `.UltraVision/meta/stats.json`.
