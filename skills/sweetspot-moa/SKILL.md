---
name: sweetspot-moa
description: Sweetspot MoA (SMOA) — SMA's opt-in multi-model orchestration layer (Mixture of Agents, not MoE). Claude (Fable, current session) plans, gates, and arbitrates at xhigh under SMA Gen3; the execution workforce is Codex CLI agents at xhigh ONLY (default model gpt-5.6-sol, configurable; max 10 concurrent), working in parallel and brutally cross-reviewing each other with evidence-forced verdicts. Workflows run autonomously — do not ask before fan-out — but the workforce constraint is absolute; Claude models never implement as workforce. Fable-only reservations: core planning and the how-we-achieve-the-goal strategy are never delegated, and all frontend/UI/UX design decisions are Fable's own (highest design standards; codex may implement frontend but only from Fable's embedded design_spec and instructions). Every run owes a per-agent token summary at delivery (API USD, share of recent spend, est. saved vs single-model solo runs). STRICT OPT-IN — activate only when the user literally writes SMOA, Sweetspot MoA, /smoa, "run in SMOA mode", SMOA ensemble, or SMOA-max in the current session (legacy alias SMOE resolves here). Never activate on task size, difficulty, or similarity.
---

# Sweetspot MoA (SMOA)

## What This Is (And Is Not)

SMOA is a **Mixture of Agents** (orchestration around several separate
models), not Mixture of Experts (expert routing inside one model). The old
working name SMOE was a misnomer; the token still resolves here (see Aliases).

Lineage, so future agents don't re-derive it: Sakana Fugu (learned
orchestrator — the intelligence lives in the aggregation layer, naive
averaging regresses to the mean), OpenRouter Fusion (panel → judge →
synthesizer returning consensus / contradictions / blind spots instead of a
merge), Hermes MoA (published reference pairing beats either model alone).
See `docs/INFLUENCES.md` for source links and SMARCH's specific adaptations.

## Hard Activation Rules — No Exceptions

1. **Literal-token opt-in.** SMOA activates only when the user writes one of
   the trigger tokens in the current session: `SMOA`, `Sweetspot MoA`,
   `/smoa`, `run in SMOA mode`, `SMOA ensemble`, `SMOA-max` (or legacy
   `SMOE`). A hard task, a big task, a task that "would benefit" — none of
   these are triggers. Asking the user "want this in SMOA mode?" is allowed;
   silently activating is a protocol violation.
2. **Codex-only workforce, autonomous, capped at 10** (standing rule). Multi-agent fan-out runs autonomously — never ask before
   dispatching; independent work must keep working. The workforce constraint
   is absolute: implementation agents are Codex `gpt-5.6-sol` at xhigh via
   `codex exec` exclusively, **max 10 concurrent**. Claude models never serve as fan-out workforce: no Claude
   subagent implementers, no Claude Workflow fleets. Claude (Fable, the
   orchestrating session) is planner, arbiter, and Gen3 gatekeeper only. The
   Opus 4.8 second-executor role from the SMOA v1 design is **disabled**;
   re-enable only on an explicit user ask ("SMOA with opus").
3. **Opus 4.8 workforce fallback — codex-unavailable escalation** (standing rule). When the codex workforce becomes unreachable *mid-run or at
   dispatch* — quota exhausted (`ERROR: You've hit your usage limit`), auth
   failure, or CLI missing — the run is NOT dead. Do this, in order:
   (a) **report the block to the user honestly** (which agents failed, why,
   and when codex resets if the error states it); (b) if the user authorizes
   Opus as the workforce (either the standing "SMOA with opus" ask OR a
   direct "use opus instead of codex" in the session), **switch the execution
   workforce to Opus 4.8 executors** — dispatched as `Agent` subagents with
   `model: opus`, one fully-specified packet each, same disjoint-lane +
   adversarial-cross-review contract as codex. Opus executors implement; the
   Fable/Opus orchestrating session still plans, gates, and arbitrates and
   never implements as workforce. This is the sanctioned fallback — it keeps
   big-batch throughput alive when codex is down. Still **never** silently
   substitute without the report; the "ask before fallback" step is the
   report itself, and an explicit user directive satisfies it. When codex
   quota resets, prefer codex again (cheaper, separate budget) unless the user
   says otherwise. Arbiter-self-review is the last resort only when neither a
   second codex nor a second Opus executor is reachable (see Termination).

## Roles

| Role | Model | Effort | Surface |
|---|---|---|---|
| Planner / Arbiter / Gatekeeper | Fable 5 (current session) | xhigh | Claude Code, always under `$sma-gen3`; SUP plan-of-record when `.UltraVision/` exists |
| Executor A (implement + review) | GPT-5.6 Sol | xhigh | `codex exec`, headless |
| Executor B (implement + review) | GPT-5.6 Sol | xhigh | `codex exec`, headless |

A and B differ by assignment and review lens, not by model. Configure the
workforce model id for your codex auth (some auth modes expose base model
ids only); default `gpt-5.6-sol`.

The A/B pairing scales out to more codex agents on larger runs — same models,
same contract, **never more than 10 concurrent**. Both roles implement AND
review — the review is symmetric; no model is privileged. The planner never
implements backend/logic work while SMOA is active; it plans, dispatches,
arbitrates, and runs every Gen3 gate itself. **The one exception is
frontend — see Frontend Reservation.**

## Planning Reservation (Fable-Only)

Core planning is **never delegated** (standing rule): goal
interpretation, vision, the how-we-achieve-it strategy, architecture and
approach decisions, task decomposition, and acceptance criteria are Fable's
own work at xhigh — not codex's, not a subagent's. Executors receive fully
specified packets; a packet that asks the executor to decide the approach
("figure out how to…", "choose an architecture…") is a protocol violation.
Executors may propose better approaches in review findings; deciding is
Fable's alone.

## Frontend Design Authority (Fable-Only)

Fable 5 is the strongest frontend-design model available; every design
decision is its own work, finished to the highest UI/UX standard out there
(standing rule). Codex **may implement** frontend — but only from
Fable's design and instructions, never from its own design judgment.

- **Design test:** anything that shapes what users see or feel — layout,
  styling, components, typography, color, motion/animation, UX flows,
  design systems, visual accessibility — is a design decision, and design
  decisions are Fable's alone, made at xhigh under the installed design
  skill stack (`design-taste-frontend` / `frontend-design` plus
  project-specific design skills and the project's design system).
- **SFF integration:** the `sweetspot-frontend-fix` skill (optional SMA
  layer) governs how Fable authors design specs when triggered — and when
  the repo has `.sff/DESIGN-LOCK.md`, every frontend `design_spec` MUST
  derive from that lock and embed its excerpt + the SFF anti-slop
  blacklist. Codex reviews code against the lock; Fable reviews rendered
  screenshots against it.
- **Delegated frontend needs a design spec:** a frontend packet must embed
  Fable's full `design_spec` — layout and hierarchy, design tokens
  (type/spacing/color), component states, motion specs, responsive and
  accessibility behavior — plus the instruction that zero design decisions
  belong to the executor. A frontend packet without a `design_spec` must
  not be sent; an executor filling a design gap itself is a protocol
  violation (it must return the question to Fable instead).
- **Fable may still implement directly:** for design-defining surfaces
  (hero, design system foundations, signature interactions) Fable keeps the
  implementation itself when fidelity matters more than parallelism; that
  work appears as its own `Fable (frontend exec)` row in the delivery token
  table.
- **Design gate:** at delivery Fable verifies the rendered result against
  its design spec and the design-skill standards — codex cross-review
  covers correctness and security only. Generic, templated, AI-slop output
  fails the gate by definition, even when every test passes.

## Effort Calibration

- Planner: **xhigh always.** It is one call path and planning rewards depth.
- Executors: **xhigh always** (standing rule; codex is a separate token
  budget from Claude). Opt down to
  high only when the user explicitly asks for a cheaper run.
- `SMOA-max` is retained as a trigger token; it now simply names the default
  (everything xhigh). Never self-select a lower tier.
- When axes conflict on anything that ships: **intelligence > taste > cost.**
  Judge the output, not the price tag — if a delivered result doesn't meet
  the bar, redoing it stronger costs less than shipping mediocre work.

## Concurrency Cap

**Hard cap: 10 concurrent codex agents** (standing rule). Queue
excess tasks and dispatch as slots free up; never widen the pool to go
faster. The cap counts every live `codex exec` process the orchestrator has
spawned, implement and review calls alike.

## Modes

- **SPLIT (default).** The planner authors design specs for every frontend
  task first (see Frontend Design Authority), keeps design-defining
  surfaces for itself, then partitions the rest into disjoint sets along
  Gen3 module ownership (never split one module's files across executors).
  A implements set 1, B implements set 2; each reviews the other's diff
  under the cross-review contract.
- **ENSEMBLE** (trigger: `SMOA ensemble`). Both executors implement the same
  task independently in isolated worktrees; the planner judges at xhigh,
  picks the winner, and grafts the runner-up's genuinely better parts.
  Reserve for C5, shared-hot-path, or correctness-critical work — it costs
  double by construction.

## Dispatch — Handoff Packet

One JSON packet per `codex exec` invocation:

```json
{
  "task_id": "…",
  "mode": "SPLIT | ENSEMBLE",
  "objective": "…",
  "acceptance_criteria": ["…"],
  "scope_files": ["…"],
  "forbidden_surfaces": ["…"],
  "constraints": ["…"],
  "evidence_required": ["tests", "typecheck", "runtime proof"],
  "design_spec": "REQUIRED for frontend tasks — Fable's full design: layout, tokens, states, motion, responsive + a11y behavior; omit for non-frontend",
  "effort": "xhigh",
  "review_round": 0
}
```

- `acceptance_criteria` come from the SUP checklist steps when
  `.UltraVision/` exists; otherwise the planner writes them before dispatch.
  A packet without acceptance criteria must not be sent.
- `forbidden_surfaces` = files under other leases plus Gen3 shared hot paths.
- Canonical invocation goes through the workforce abstraction. It preserves the
  same model, effort, schema, sandbox, timeout, token-accounting, and retry
  semantics across Codex, Claude CLI, and OpenCode:

```bash
node --input-type=module -e '
  import { dispatch } from "./tools/lib/workforce/contract.mjs";
  import fs from "node:fs";
  const packet = JSON.parse(fs.readFileSync("packet.json", "utf8"));
  const result = await dispatch(packet, {
    backend: "codex", model: "gpt-5.6-sol", effort: "xhigh",
    schema: "handback.schema.json", readOnly: false
  });
  console.log(JSON.stringify(result));
'
```

- The raw Codex CLI equivalent remains documented for debugging flag drift
  (codex-cli 0.142.4 at install time; check `codex exec --help`, never guess):

```bash
# implementers: write access, schema-checked hand-back
codex exec --yolo -m gpt-5.6-sol \
  -c model_reasoning_effort=xhigh \
  --output-schema handback.schema.json "$(cat packet.json)"

# reviewers: READ-ONLY sandbox — reviewers never write
codex exec -s read-only -m gpt-5.6-sol \
  -c model_reasoning_effort=xhigh \
  --output-schema review.schema.json "$(cat review-packet.json)"
```

- **Never orphan an executor.** Wrap every dispatched `codex exec` in SPL so a
  killed or crashed orchestrator can never leave codex trees behind:
  `sma spl-exec --lease auto --label "<task-id>" -- codex exec …`. The child
  registers against a lease and auto-unregisters on exit; if the wrapper dies
  uncleanly, `sma spl reap` reclaims it. Before a fan-out, size the wave with
  `sma spl doctor` (recommended_agents) — the workforce cap must respect it.
- **Dispatch DETACHED, never as a plain harness background task** (root-caused
  2026-07-14). Orchestrating harnesses (Claude Code included) stop running
  background tasks when a new user message arrives mid-run, and `codex exec`
  reads stdin and exits 0 silently — mid-turn, no signal — when that stdin
  pipe closes. The result looks like a mystery kill: clean exit code, empty
  hand-back, session log ending mid-tool-call. Launch the wrapped executor in
  its own session with stdin severed and a done-marker, then watch the marker
  with a DISPOSABLE waiter (losing the waiter loses nothing):

  ```bash
  setsid bash -c 'sma spl-exec --lease auto --label "<task-id>" -- \
    codex exec --yolo -m <model> -c model_reasoning_effort=xhigh \
    --output-schema handback.schema.json "$(cat packet.json)" \
    > <task>.handback.json 2> <task>.log < /dev/null; \
    echo "exit=$?" > <task>.done' < /dev/null &
  until [ -f <task>.done ]; do sleep 10; done   # disposable; re-arm freely
  ```

  A 0-byte hand-back with exit 0 is the stdin-EOF signature — treat it as
  dispatch-infrastructure failure and re-dispatch; never misread it as the
  executor refusing the task.

- Model id rule: some codex auth modes (e.g. ChatGPT-subscription) expose
  base model ids only — fused ids like `gpt-5.6-sol-xhigh` are rejected
  (400). Always split model (`-m gpt-5.6-sol`) and effort
  (`-c model_reasoning_effort=xhigh`). `--yolo` is mandatory for implementer
  lanes; reviewers stay read-only. If the configured id is unavailable, fall
  back to the base family id (e.g. `gpt-5.5`).
- Use `codex exec resume <SESSION_ID> "<fix instructions>"` for round-2 fixes
  so the implementer keeps its session context instead of paying re-context.
  Always pass the explicit session id from the implement log's header —
  `--last` races other concurrent codex sessions on the same machine.
- `codex review` (non-interactive review subcommand) and the official
  `codex-plugin-cc` plugin (`/codex:adversarial-review`, `/codex:rescue`,
  background `/codex:status` · `/codex:result` · `/codex:cancel`) are
  preferred surfaces for the review lane when installed — the adversarial
  review mode matches this skill's anti-rubber-stamp contract natively.
- In Workflow-tool runs (the `model:` param only takes Claude models), a
  thin `sonnet`/`effort: low` wrapper agent that composes the packet, runs
  `codex exec` via Bash, and returns the hand-back is sanctioned dispatch
  plumbing — it is not workforce and must never write code itself.
- The orchestrator holds all Gen3 leases (`start:edit`/`end:edit`), runs all
  gates, and writes all telemetry. Executors never touch the Gen3 control
  plane, never commit, never push.

## Cross-Review Contract (Anti-Rubber-Stamp)

Two models agreeing without evidence is worse than one model — you pay double
for false confidence. Reviewer output must be exactly:

```json
{
  "verdict": "APPROVE | APPROVE_WITH_FIXES | REJECT",
  "tests_run": ["<command> → <actual result>"],
  "findings": [{ "file": "…", "line": 0, "severity": "…", "issue": "…", "fix": "…" }],
  "missed_requirements": ["…"],
  "would_ship": true
}
```

- `tests_run` empty or "not run" → the review itself is REJECTED and redone.
- Findings without `file:line` are discarded unread.
- Style nits are banned. Correctness, security, and missed acceptance
  criteria only.
- Sycophancy ban: a review may not open with praise; line one is the verdict.
- Symmetric: every implemented diff gets reviewed by the other executor.

## Termination Rules (Hard)

- **Max 2 review rounds per task.** Still disagreeing after round 2 → the
  planner arbitrates at xhigh; its decision is final. No infinite ping-pong.
- Executor unreachable (codex CLI missing, auth failure, quota) → **stop and
  report** to the user first (never a silent substitution). Then take the
  **Opus 4.8 workforce fallback** (Activation Rule 3) if the user has
  authorized Opus as workforce ("SMOA with opus" or "use opus instead of
  codex"); the report + explicit directive together satisfy the ask-before-
  fallback bar. If a *reviewer* (not implementer) is the unreachable one and
  no second executor of either model can run the cross-review, the planner
  performs an **arbiter self-review** — but with a genuine adversarial mindset
  (hunt the failure mode the author's own tests missed, as a real second pair
  of eyes would) and it says so in the delivery. Never silently skip review.
- Every SMOA run ends with the planner's own gate pass: Gen3 lanes,
  telemetry/SRS audit, FEATMAP updates, claims-and-completion evidence —
  identical to any Gen3 work. **SMOA changes who executes, never how work is
  gated.**

## Token Summary At Delivery (Mandatory)

Every SMOA run owes the user a per-agent token summary at delivery. A
missing summary blocks the claims-and-completion gate — the run is not done
without it. One row per agent (planner plus every codex agent spawned) and a
run-total row:

| Agent | Model | Effort | Calls | Tokens in/out | API cost (USD) | % Fable 7-day | % all models 7-day |
|---|---|---|---|---|---|---|---|

Mechanics — run the bundled tool; do not hand-compute:

```bash
node tools/sma-smoa-token-summary.mjs \
  --claude-session ~/.claude/projects/<project-dir>/<session-id>.jsonl \
  --codex-since <ISO timestamp of first dispatch>   # add --json for machines
```

- **Primary sources, all local:** planner tokens from the Claude Code
  session log (per-message `usage`, deduped by request id); codex tokens
  from `~/.codex/sessions/**` (last cumulative `total_token_usage` per
  session); 7-day denominators computed exactly from the same logs.
- **Prices** are pinned in `skills/sweetspot-moa/model-prices.json` (dated,
  sourced). Costs are *imputed at published API rates* — subscription-billed
  usage is not API-billed; say so in the delivery note. Unpriced models are
  excluded from denominators and flagged; fix by updating the prices file,
  never by guessing.
- **Third-party spend trackers are NOT a primary source** for this table —
  local session logs are ground truth. Use trackers as a cross-check only,
  and expect their sync paths to inflate or lag.
- **Fail loudly, never guess:** anything the tool cannot price prints
  `unavailable — <reason>`. Never omit the table, never fabricate a number.

Below the table, two savings lines are required — what the run avoided by
not executing solo on a Claude model:

```
Saved vs Fable-5 solo:   <offloaded tokens> Fable tokens avoided | est. $<X> saved
Saved vs Opus 4.8 solo:  <offloaded tokens> Opus tokens avoided  | est. $<Y> saved
```

- Offloaded tokens = the exact sum of all codex-agent tokens (these never
  touched the Claude budget — this number is real, not estimated).
- Est. USD saved = offloaded tokens × the baseline model's published API
  pricing − actual codex cost. Label it `est.` — a solo model would not use
  the identical token volume. Baseline pricing from published API rates
  (spend trackers as cross-check); if a baseline is unpriced, that line reads
  `unavailable — <reason>`, never a guess.

## Gen3 Integration

- When `.UltraVision/` exists it is the work queue: pick with `uvp next`,
  claim/complete/verify through `uvp` with the executors' evidence attached.
  C1–C3 tasks may batch several per packet; C4/C5 ship one task per packet.
- Any feature-affecting task updates `/FEATMAP` in the same commit — the
  packet instructs the executor; the planner verifies at the gate.
- Dirty-tree discipline, collision reporting, and lease rules from AGENTS.md
  bind the orchestrator unchanged.

## Aliases

`SMOE` → `SMOA` (pre-rename token; treat as a full trigger so muscle memory
never silently degrades a run to single-model). `Sweetspot MoE` → same.

## Rule History

An early "no workflow execution without asking — ever" rule was rescinded —
it broke autonomous work. Current law: fan-out is autonomous; the workforce
is codex xhigh only (default model `gpt-5.6-sol`), capped at 10.
