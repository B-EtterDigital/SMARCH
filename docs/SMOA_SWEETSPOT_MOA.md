# [SMOA](GLOSSARY.md#smoa) — Sweetspot MoA

This guide defines the opt-in multi-agent execution model for Sweetspot work. Orchestrators, implementers, and reviewers need it before they join a SMOA run. Read it when a request uses the SMOA trigger or when you receive a worker packet from an active run. Remember that SMOA changes who performs the work while the Gen3 proof and collision rules stay in force.

SMOA is SMA's opt-in multi-model orchestration layer: a **Mixture of Agents**
(orchestration around several separate models — not MoE, which is expert
routing inside one model). Claude (Fable) plans, arbitrates, and holds every
Gen3 gate at xhigh; the execution workforce is Codex models only, working in
parallel and cross-reviewing each other under an evidence-forced contract.

Reference implementation: `skills/sweetspot-moa/SKILL.md` (installed at
`~/.claude/skills/sweetspot-moa/`).

## Opt-in rule (important)

SMOA never runs automatically. It activates only when the user literally
writes `SMOA`, `Sweetspot MoA`, `/smoa`, `run in SMOA mode`, `SMOA ensemble`,
or `SMOA-max` in the current session (legacy alias `SMOE` resolves here).
Task size, difficulty, or similarity to past SMOA runs are not triggers.
Asking the user is allowed; silent activation is a protocol violation.

Standing rule (an initial ask-before-any-workflow rule was
rescinded the same day — it broke autonomous work):

- **Workflows run autonomously; the workforce is codex-only, capped at 10.**
  Never ask before fan-out. Implementation agents are Codex GPT-5.5 family
  at xhigh via `codex exec`, exclusively, max 10 concurrent. Claude models
  never serve as fan-out implementers — Claude is planner / arbiter /
  gatekeeper. The Opus 4.8 second-executor role from the SMOA v1 design is
  disabled; only an explicit user ask ("SMOA with opus") re-enables it.

## Fable-only reservations (standing rules)

- **Planning:** goal interpretation, the how-we-achieve-it strategy,
  architecture/approach decisions, task decomposition, and acceptance
  criteria are Fable's own work — never delegated. Executors get fully
  specified packets, never open questions; they may propose alternatives in
  review, but deciding is Fable's alone.
- **Frontend design:** every design decision — anything shaping what users
  see or feel (layout, styling, components, typography, motion, UX flows,
  design systems) — is Fable's own, made at xhigh under the design skill
  stack (`design-taste-frontend` / `frontend-design` + project design
  skills) to the highest UI/UX standard. Codex may implement frontend, but
  only from a Fable-authored `design_spec` embedded in the packet — zero
  design decisions belong to the executor; a design gap goes back to Fable,
  never gets filled by codex. Fable keeps design-defining surfaces for
  itself and verifies every rendered result against its spec at the gate;
  codex cross-review of frontend covers correctness/security only.

## Roles and effort

- Planner / arbiter / gatekeeper: Fable 5 (orchestrating session), xhigh,
always under `$sma-gen3`; [SUP](GLOSSARY.md#sup) is plan-of-record when `.UltraVision/` exists.
- Executors A/B: two `gpt-5.5` instances via `codex exec`, headless, effort
  xhigh always (standing rule), max 10 concurrent; opt down to high only on an
  explicit user request. ChatGPT-subscription auth exposes no codex model
  variants — `gpt-5.5` is the workforce model, always.
- `SMOA-max` now simply names the default (everything xhigh).

## How executing agents consume SMOA

- **SPLIT (default):** planner partitions tasks along Gen3 module ownership;
  each executor implements its disjoint set and reviews the other's diff.
- **ENSEMBLE (`SMOA ensemble`):** both implement the same task in isolated
  worktrees; the planner judges, picks the winner, grafts the runner-up's
  better parts. Reserve for C5 / shared hot paths / correctness-critical.
- Dispatch is one JSON handoff packet per `codex exec` call: task id,
  objective, acceptance criteria (from SUP checklist steps when present),
  scope files, forbidden surfaces (other leases + shared hot paths),
  evidence required, effort tier. Packets without acceptance criteria must
  not be sent.
- Cross-review is symmetric and anti-rubber-stamp: non-empty `tests_run` or
  the review itself is rejected; findings need `file:line`; style nits and
  praise-first openings are banned; max 2 review rounds, then the planner
  arbitrates at xhigh — final.

## Token summary at delivery (mandatory)

Every SMOA run ends with a per-agent token table — planner plus every codex
agent: model, effort, calls, tokens in/out, API cost (USD), % of Fable
7-day spend, % of all-models 7-day spend. Produce it with the bundled tool
(`node tools/sma-smoa-token-summary.ts --claude-session <session.jsonl>
--codex-since <ISO>`), which computes everything exactly from primary local
sources (Claude Code + codex session logs) priced by the pinned
`skills/sweetspot-moa/model-prices.json`. acme-tracker is a cross-check only
(its store append-duplicates on sync and its price table is stale as of
2026-07-02). Anything unpriced is marked `unavailable — <reason>` — never
guessed, never omitted. A missing table blocks completion.

Below the table, two required savings lines: tokens offloaded to codex
(exact) with estimated USD saved vs running the same work **Fable-5 solo**
and vs **Opus 4.8 solo** (offloaded tokens × baseline API pricing − actual
codex cost, labeled `est.`).

## Gen3 compatibility rules

- The orchestrator holds all leases (`start:edit`/`end:edit`), runs all
  gates, writes all telemetry, and makes all commits. Executors never touch
  the Gen3 control plane.
- Executor unreachable → stop and report; ask before any fallback. No silent
  single-model fallback, no silent Claude-workforce substitution.
- FEATMAP updates land in the same commit as the feature change; the planner
  verifies at the gate.
- **SMOA changes who executes, never how work is gated.**

## Where the full specification lives

`skills/sweetspot-moa/SKILL.md` — activation rules, role table, effort
calibration, packet schema, cross-review contract, termination rules,
aliases (`SMOE` → `SMOA`).

<!-- docs-i18n: key=docs.smoa-sweetspot-moa; source=en; media=media/{locale}/smoa-sweetspot-moa/ -->
