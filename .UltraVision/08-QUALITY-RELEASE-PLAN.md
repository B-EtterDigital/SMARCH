# 08 — Quality & Release Plan

## Milestone ladder (G2-approved) with definitions of done

### M0 — Foundation ("trust + plumbing")
Done when: `.github/workflows/ci.yml` runs check+gitleaks+leak-grep+`tsc
--noEmit` on every PR; `tsconfig.json` with `checkJs` lands and the existing
`.mjs` tree passes; `docs/INFLUENCES.md` published and linked from README;
`sma.gen3.json` adopted (gen3-draft); Graphify source→graph staleness check
shipped; `sma sync-public` tool replicates the export pipeline mechanically;
all 17 module graphs bootstrapped; every module has its baseline tasks
verified.

### M1 — The new face (MVP)
Done when: Graphify embedding index + semantic re-rank + `global query` ship
behind local-first defaults; MCP server alpha exposes search/trust/doctor/
why-blocked/installRelease with a Server Card and passes its selftest against
the fixture portfolio; README is demo-first with the vhs-scripted demo
committed and the 5-minute quickstart CI-verified; ambient auto-lease hooks
ship (explicit mode retained); TS wave 1 done (schema-derived types +
tools/lib converted, gates green).

### M2 — Beta
Done when: capsule tier ships (`sma brick new/run/inspect`,
gates-pass-by-construction proof on a fixture capsule); GraphRAG community
summaries + tree-sitter extraction land; workforce abstraction powers SMOA
with codex as default backend; skills install as a Claude plugin in one
command; TS migration complete for all tools (waves 2–3); community
submission lane documented + first gated submission processed; bench gate in
CI.

### M3 — 1.0
Done when: `smarch-core` Rust kernel passes parity tests against the node
scanner on the fixture portfolio and ships as a release binary; eval harness
runs seeded skill/workflow evals with trend reports; web dashboard
(Blueprint Ledger) self-hosts with lease board, conflict strip, brick wall;
monetization lane documented end-to-end (commercial tags → entitlement check
at clone); oversized-file splits done; showcase live.

### M4+ — Vision-complete
Federation research, hosted dashboard deployment, cloud lease research —
tasks exist as research spikes only.

## Testing strategy per layer

- Every new tool ships a `--selftest` (the 17-selftest discipline extends);
  `npm run check` stays the one-command gate.
- New TS modules get unit tests (`node --test`) at conversion time.
- Fixture portfolio (`tools/evals/fixtures/acme-*`) is the e2e surface for
  scan/registry/MCP/capsule tests — public-safe by construction.
- Eval harness (M3) scores agent-facing behavior (skills, packets) on seeded
  runs; regressions are release-blocking for skills.

## Telemetry/SRS

Framework CLIs: structured error lines (area, severity, hint) on stderr — no
silent catches (audited at TS conversion of each file). Dashboard: an
SRS-equivalent client reporter from its first commit. `sma-smoa-token-summary`
remains the run-accounting surface.

## Release trains (shared hot paths)

Changes to `package.json`, `schemas/**`, `.github/workflows/**`, `tsconfig`,
`README.md`, `AGENTS.md`, `sma.gen3.json` batch through the controller lane:
one owner, `gate:all` + full check before merge; never two agents in a train.

## Release-ready definition (any milestone)

`npm run check` green · `tsc --noEmit` clean · gitleaks clean ·
zero-leak grep clean · `uvp validate --strict` clean · module graphs fresh ·
`git status` clean on main · dual-repo sync executed (V-15).
