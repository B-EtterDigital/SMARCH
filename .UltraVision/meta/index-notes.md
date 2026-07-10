# Execution guide (hand-written, included into INDEX.md)

## How to run this plan

- Orchestration: SMOA — Fable plans/gates/arbitrates and holds every lease;
  codex `gpt-5.6-sol` at **high** effort is the only implementation workforce
  (user directive 2026-07-10), max 10 concurrent. Packets are fully explicit;
  executors decide nothing.
- Parallel lanes NOW (disjoint ownership): coord, prov, reg, gates, graph,
  mcp, capsule, smoa, dash, skills, docs, evals, commun, rust, sync — up to
  10 at once. `schemas` and `ci` are shared-hot-path: one owner, release-train.
- Dispatch ceiling: 10 (SMOA cap; also matches this repo's Gen3 maturity —
  full control plane + leases, no merge queue yet).
- Ordering: M0 first (139 tasks — trust + plumbing). Foundation deps are
  wired via `depends_on`; use `uvp next --module <m> --critical` for the
  deepest chains. Hot-path npm-script/README changes come back to the
  orchestrator as `npm_script_requests`, never executor-applied.
- Paid batches: none exist (`paid_tasks: 0`, utility media class).

## SMA attestations

- SMA-P1: plan generation held lease `ultravision-plan` (project sma);
  wave-1 execution holds five `*-m0-lane` bricks. No concurrent generation.
- SMA-P2: Graphify graphs were absent at planning (fresh repo) — recorded as
  per-module `graph` baseline tasks (M0); audit used direct reads instead.
- SMA-P3: every completion claim cites `uvp validate` output and
  `complete --evidence-cmd` structured evidence; `audit-claims` re-runs
  sampled gates.

## Known plan gaps (stated plainly)

- P8.5 round 2 pending: groups 2 (graph/mcp/capsule/smoa/reg/rust) and
  3 (dash/docs/skills/evals/commun) owe a clean skeptic round after the 12
  round-1 findings are fixed; group 1 round-1 was a weak-clean (skeptic
  returned an empty finding rather than an explicit clean verdict).
- The G1 open questions OQ-1..3 run on defaults (commit .UltraVision
  publicly; accept MCP SDK dep isolated to tools/mcp; embeddings local-first)
  — reversible, flagged here for the owner.
- tree-sitter integration is gated on the M2 spike's go/no-go — the plan
  deliberately does not pre-commit to it.
- Wave-1 integration debt: lane-d's staleness feature pushed
  tools/sma-graphify.mjs over the 1,900-line cap — integration requires
  extraction into tools/lib (baseline bumps are not accepted for new work).
