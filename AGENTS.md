# Repo Agent Workflow

- Complete each requested task end-to-end and push the task-scoped changes by default unless the user explicitly says not to push.
- Stage only the files required for the current task. Never include unrelated dirty worktree changes in a commit.
- Verify locally first when practical.
- If a task needs to be tested live on Netlify, run the required deploy and any necessary migrations as part of the task.
- If a live deploy or migration is blocked by missing credentials, permissions, or provider state, report the blocker clearly.

## Quiet Dirty-Tree Discipline (mandatory)

- Agents clean as they work: delete scratch output they created, commit verified task-scoped work in narrow batches, and release leases with `end:edit`.
- Do not paste a full unrelated dirty tree into user-facing status. Report dirty state as counts and ownership buckets: `own`, `unrelated`, `overlap/blocker`.
- List file names only for files owned by the current task or files that block/conflict with it. For unrelated dirty work, use one compact line such as: `unrelated dirty work exists: 6 files, 0 untracked; left untouched`.
- `start:edit` saves a local dirty baseline automatically and `end:edit` prints the matching delta plus `cleanup ok` or `cleanup required`. If cleanup is required, commit task-scoped files, delete scratch output, or explicitly classify the handoff before final integration. For old sessions or unleased audits, run `npm run dirty:save -- --project <id>` at task start and `npm run dirty:delta -- --project <id>` before progress/final status.
- For strict integration closeout, pass `--require-cleanup-ok` to `end:edit`; it exits before releasing the lease when the task added or changed dirty paths. Use this for controller-owned merge/release work and any agent that is expected to end clean.
- Use `npm run controller:snapshot:quiet -- --project <id>` or `npm run controller:snapshot -- --project <id> --dirty-limit 0` for normal status. Use `--dirty-limit <n>` or `--dirty-full` only for controller audits.
- A dirty tree is not an excuse to stop. Continue when the dirty files are unrelated; stop only when they overlap your intended files, a lease is held, or integration would be unsafe.

## Status Reporting Standard (checkbox lists — REQUIRED)

Every progress/checkpoint/summary report to the user MUST present done vs. open
work as a checkbox list — ✅ done, ⬜ open, 🔄 currently in flight. One line per
item; group by area when the list is long; supporting detail goes below the
list, never inside it. Tables and prose paragraphs are not a substitute — the
done/open split must be scannable at a glance. Applies to every agent, every
session, every project that consumes this SMA workflow.

## SMA Gen3 Collision Reporting (mandatory)

- Before editing an SMA brick/module, use `npm run start:edit -- --project <id> --brick <id> --intent "..."` so the lease and `edit_planned` event are recorded together.
- For edits inside `~/DEV/SMARCH`, use `--project sma` and a clear control-plane brick id, for example `sma-gen3-ci-control-plane` or `sma-graphify-control-plane`.
- Before broad SMA control-plane reads, prefer `npm run graphify:query:self -- -- "question"`; refresh the local code-only graph with `npm run graphify:refresh:self` when missing or stale.
- If `start:edit` fails because the brick/resource is already leased, do not keep editing the same surface. The tool records `conflict_detected`; back off, choose another module, or wait for a handoff.
- If you discover overlap outside `start:edit` (dirty file overlap, shared hot path, regen/global write, graph/global state contention), run `npm run conflict -- report --project <id> --brick <id> --intent "..." --resolution-plan "..."`.
- When the conflict is resolved, run `npm run conflict -- resolve --project <id> --brick <id> --intent "..." --decision "..."`.
- Controllers check unresolved project collisions with `npm run conflict:check -- --project <id> --strict` before integration or handoff.
- Controllers check unclaimed dirty work with `npm run controller:dirty-check -- --project <id>` or `npm run controller:snapshot -- --project <id> --dirty-strict`. A `DIRTY-UNLEASED` project must be claimed with `start:edit`, cleaned, or conflict-reported before integration.
- Treat `active-dirty-scope` controller warnings as pre-integration blockers until explained: the project has active leases, but some dirty ownership groups do not appear covered by those lease intents. Claim the uncovered groups, split the work, clean them, or file a conflict report before merging.
- Dirty controller actions use the primary `Command` as the fastest safe claim path for the top dirty ownership group. The JSON/Markdown handoff also includes `inspect` and `conflict` alternatives; use them instead of dumping full dirty paths into chat.
- For large dirty projects, use the generated `parallel_claims` list to dispatch separate agents to separate ownership buckets. Do not assign two agents the same `dirty-*` brick unless a conflict report and handoff decision exist.
- Controllers observe the whole portfolio with `npm run controller:sweep`. It prints only ranked action items: unresolved conflicts, dirty-unleased projects, graph gaps, and active leases. Use `npm run controller:sweep:write` to persist the queue to `handoffs/controller-actions.generated.json` and `.md`.
- `npm run ci:gen3` includes the strict unresolved-conflict gate and the strict dirty-claim gate, and must serialize its scan phase through the `registry-regen:global-modules` lease; do not integrate while it reports blocked projects, `DIRTY-UNLEASED`, or a registry lease is active.
- For controller visibility after project-local changes, use `npm run portfolio:refresh -- --project <id> --changed-file <path>` when the changed files are known. Code-only files skip scanning, `.smarch/agent-context/**` and conflict logs refresh state/dashboard only, and manifests/config/package/build/deploy surfaces still force the project scan through `registry-regen:portfolio-projects`. Use `npm run portfolio:refresh -- --project <id>` when the changed files are unknown; bare project refreshes reuse a fresh project registry briefly so old sessions do not start back-to-back full scans. Use `npm run portfolio:refresh` without `--project` only for broad portfolio changes; it debounces `scan + state + dashboard`, waits for active registry scans, and reuses their output instead of starting duplicate full scans. `npm run scan:safe` is also debounced for old sessions. Use `npm run scan:safe:force` or `npm run portfolio:refresh:force` only when a controller explicitly needs a full scan now.
- For a fast live read before assigning agents, run `npm run controller:snapshot:quiet -- --project <id>` or `npm run controller:snapshot -- --json --dirty-limit 0`.
- For machine-readable module graph status, use `npm run graphify:check:modules -- --project <id> --strict --summary-json`; full `--json` is controller-audit only because it prints every module row.
- Force-acquire is allowed only with an explicit human/controller reason and a prior conflict report.

## Token accounting + backlog (mandatory)

Read [docs/TOKEN_ACCOUNTING_AND_BACKLOG.md](docs/TOKEN_ACCOUNTING_AND_BACKLOG.md) before doing any of the following:

- **Cloning a brick or build into a project** → run `tools/sma-reuse-receipt.mjs --write` after the copy. Pass `--infra-tokens` (your best estimate of the tokens this session spent integrating the bricks) and `--backlog-id` for every imperfection you opened.
- **Leaving a gate at `partial` or `missing`** (typecheck disabled, RLS missing, env contract drift, scanner warning unfixed in code you touched) → run `tools/sma-backlog.mjs add` with the appropriate `--kind` and `--severity`. Link via `--reuse-receipt-id` if it stems from inheritance.
- **Promoting a brick** (`candidate → verified` or `verified → canonical`) → backlog must be empty for the brick (or every entry marked `wontfix` with a written rationale). All gates must be `passing`.
- **Estimating savings** for a stakeholder report → run `tools/sma-token-count.mjs --root <project> --write` first; the per-brick numbers go in `<root>/.smarch/token-counts.generated.json`. Don't gut-feel.

If you can't fix something in-session, open the backlog entry. The cost is logged and recoverable; silent debt is not.

## Update propagation (source → dependents)

Read [docs/UPDATE_PROPAGATION.md](docs/UPDATE_PROPAGATION.md) before bumping a source brick that other projects depend on.

- **After every brick version bump:** run `tools/sma-dependents-index.mjs --write` then `tools/sma-propagate.mjs --source-brick <id> --release ... --apply`.
- **Locked dependents** (`evidence_kind: import-lock`) receive an actionable update plan at `<target>/.smarch/update-plan-*.json`.
- **Fork dependents** (`evidence_kind: reuse-receipt`) receive a notify-only stub at `<target>/.smarch/incoming-updates/`. Auto-applying upstream changes to a fork is forbidden — open a backlog entry in the dependent project instead.
- A source brick can declare `brick.replication.policy` in its manifest to opt into stronger automation (`track-canonical` + `auto_pr_on_minor`).

## SFM — Sweetspot Feature Map (mandatory, from project start)

Every SMA project carries a `/FEATMAP` folder at the repo root: the
**Sweetspot Feature Map**. A look into this folder must show, nicely
presented and described, every feature of every module of the complete
application. Reference implementation: `acme-desktop/FEATMAP/`.

- **Structure:** `FEATMAP/README.md` (rules), `FEATMAP/APP.md`
  (application-wide features + module index), one `FEATMAP/<MODULE>.md`
  per module with a feature table: `Feature | What it does | Status
  (live/beta/alpha/planned) | Code`.
- **Enforced from the start:** scaffolding a new SMA project creates
  `/FEATMAP` before the first feature lands. A feature that is not
  registered in FEATMAP does not exist.
- **Every agent updates it:** any task that adds, changes, or removes a
  feature updates the matching register **in the same commit**. Removed
  features move to the file's `Retired` section with the date.
- Entries are user-facing claims backed by working code — concrete,
  short, honest, in the product's voice.

## SUP — Sweetspot Ultra Plan (optional, explicit-trigger only)

SUP is the opt-in maximum-granularity planning layer: full vision
reconstruction plus an exhaustive, machine-readable task decomposition in a
repo-root `.UltraVision/` folder. Read [docs/SUP_SWEETSPOT_ULTRA_PLAN.md](docs/SUP_SWEETSPOT_ULTRA_PLAN.md)
before touching one.

- **Never runs automatically.** Trigger only on explicit user request ("SUP",
  "plan to perfection") or via the F5-UltraVisionPlan skill
  (`/f5-ultravisionplan`). A missing `.UltraVision/` folder is not a gap.
- **When present, it is the plan of record:** pick work with `uvp next`,
  claim/complete/verify through the `uvp` tool with real evidence, never
  hand-edit `tasks/*.jsonl` or generated views.
- Execution of SUP tasks follows normal Gen3 lanes, leases, gates, and
  telemetry proof — SUP changes what is planned, never how work is gated.

## SMOA — Sweetspot MoA (optional, explicit-trigger only, codex-only workforce)

SMOA is the opt-in multi-model orchestration layer (Mixture of Agents):
Claude (Fable) plans, arbitrates, and holds every Gen3 gate at xhigh; Codex
`gpt-5.5` agents via `codex exec` are the only execution workforce
(ChatGPT auth exposes no codex model variants), cross-reviewing each other
under an evidence-forced contract.
Read [docs/SMOA_SWEETSPOT_MOA.md](docs/SMOA_SWEETSPOT_MOA.md) before running one.

- **Never runs automatically.** Trigger only on the literal tokens `SMOA`,
  `Sweetspot MoA`, `/smoa`, `run in SMOA mode`, `SMOA ensemble`, `SMOA-max`
  (legacy `SMOE` resolves here). Difficulty or task size is not a trigger.
- **Autonomous fan-out, codex-only workforce, max 10 concurrent** (user
  rule, 2026-07-02; an earlier ask-first rule from the same day was
  rescinded — it broke independent work). Never ask before dispatching;
  implementers are Codex GPT-5.5 agents at xhigh via `codex exec` only.
  Claude models never serve as fan-out implementers; the Opus
  second-executor from SMOA v1 is disabled unless the user explicitly asks
  ("SMOA with opus").
- **Fable-only reservations** (standing rules). Core planning —
  goal interpretation, how-we-achieve-it strategy, architecture, task
  decomposition, acceptance criteria — is never delegated. All frontend
  design decisions (anything changing what users see or feel) are Fable's
  own, made at xhigh under the design skill stack to the highest UI/UX
  standard; codex may implement frontend but only from a Fable-authored
  `design_spec` in the packet, and Fable verifies the rendered result at
  the gate. Codex cross-review of frontend covers correctness/security only.
- **Token summary at delivery (mandatory).** Every SMOA run ends with a
  per-agent table: model, tokens in/out, API cost (USD), % of Fable 7-day
  spend, % of all-models 7-day spend, plus two savings lines: exact tokens
  offloaded to codex with est. USD saved vs Fable-5 solo and vs Opus 4.8
  solo. Produce it with `node tools/sma-smoa-token-summary.mjs` (primary
  local logs + pinned `skills/sweetspot-moa/model-prices.json`; mark
  anything unpriced `unavailable — <reason>` rather than guessing). A
  missing table blocks completion.
- The orchestrator holds all leases, gates, telemetry, and commits;
  executors never touch the Gen3 control plane. SMOA changes **who
  executes**, never how work is gated.

## SFF — Sweetspot Frontend-Fix (optional, explicit-trigger only; lock binds everyone)

SFF is the opt-in design-excellence layer: Fable designs with its full
design skill stack force-loaded, the empirically-known AI-slop tells are
hard-banned, delivery requires Playwright screenshot verification, and the
result is recorded in a repo `.sff/DESIGN-LOCK.md`. Read
[docs/SFF_SWEETSPOT_FRONTEND_FIX.md](docs/SFF_SWEETSPOT_FRONTEND_FIX.md)
before running one.

- Triggers only on literal `SFF` / `/sff` / `Sweetspot Frontend-Fix` /
  `frontend fix`. Never self-triggers.
- **Exception that binds every agent:** when `.sff/DESIGN-LOCK.md` exists,
  any agent editing frontend surfaces must read it and match it. LOCKED
  lines change only via Fable re-running SFF on explicit user request.
  "Improving" the design outside SFF is a violation.
- `.sff/` is a shared hot path: lease and serialize edits.
- Under SMOA, frontend `design_spec`s derive from the lock.
