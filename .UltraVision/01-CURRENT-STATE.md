# 01 — Current State

## Snapshot
- Date: 2026-07-10 · commit `56a3a09` (initial open-source release) + working tree
- Method: full-session deep audit by the orchestrator (Fable 5) plus two
  read-only audit agents (privacy audit; Graphify/attribution audit), all
  claims cited `path:line`. Graphs: none yet in this repo (G-01 covers it) —
  audit used direct reads, `grep`, selftests, and gitleaks.
- Confidence: everything below is `[verified]` unless tagged `[inferred]`.

## Module inventory

| Module (target name) | Ownership today | Maturity | Evidence |
|---|---|---|---|
| gen3-coordination | tools/sma-{lease,context*,conflict,merge,start-edit,end-edit,controller-*,dirty-*,parallel-preflight,cleanup-packets}.mjs | **polished** — the moat | 9 selftests pass (`npm run gen3:selftest`); `sma-lease.mjs list` runtime-verified |
| provenance | tools/sma-{attest*,provenance-*,anchor}.mjs, tools/lib/{merkle,license-*,provenance-seal,attestation,export-*}* | **polished** | 8 provenance/lattice selftests pass; in-toto/SLSA/SPDX/CycloneDX in sma-attest-verify.mjs:30-105 |
| registry-core | tools/sma-{scan,state,merge-registries,store,store-remote,clone,release*,publish*,promote,doctor,why-blocked}.mjs | **solid** | scan is 4,732 lines of heuristics (source-size-baseline.json); env-driven paths landed today (tools/lib/sma-paths.mjs) |
| gates | tools/sma-{rule-gate,scope-drift,security-gate,license-gate,compliance-gate,source-size-gate}.mjs | **solid** | `npm run check` green; gitleaks clean with allowlisted tooling patterns |
| graphify-bridge | tools/sma-graphify.mjs (1,697 ln), tools/sma-graph-packets.mjs | **partial** | ceilings: substring+IDF query (skill query.md:25); staleness = existence+nodeCount only (sma-graphify.mjs:405-447); no `global query` (1611-1616); 512MB cap skips adds (1276-1294) |
| codex-smoa | tools/sma-codex*.mjs, skills/sweetspot-moa | **partial** | hardwired to codex CLI; model churn requires skill edits (SKILL.md dispatch section) |
| wiki-dashboards | tools/sma-wiki*.mjs, sma-gen3-dashboard.mjs, sma-dashboard-server.mjs | **partial** | generated static HTML only; dashboard-server serves files, no app |
| skills | skills/* (sma-gen3, f5-ultravisionplan, SFF, SMOA, enforcer, course-builder, +) | **solid** | sanitized 2026-07-10; no plugin/marketplace manifest |
| schemas | schemas/*.json (13) | **solid** | brick/build/release/lease/agent-context contracts; no derived types |
| docs | docs/* (39), README, CONTRIBUTING, SECURITY | **solid** | public-positioning honest; no INFLUENCES/credits doc (audit agent: find empty) |
| ci-infra | — | **absent** | no .github/workflows in repo (templates/github holds project templates only) |
| capsule-tier | templates/brick (manifest template only) | **absent** | no runnable scaffold, no `sma brick run/inspect` |
| mcp-server | — | **absent** | registry/store are local CLIs only (tools/sma-store.mjs) |
| evals | tools/sma-seed.mjs (demo), sma-stats.mjs (adoption metrics) | **absent** | no scored regression evals for agent behavior |
| community-monetization | CONTRIBUTING.md; license lattice as foundation | **absent** | no submission lane, showcase, or commercial tier concept |
| rust-core | — | **absent** | no crate |

## Quality dimensions

- **Features:** see module table. The differentiated features (coordination,
  provenance) are the most mature; every G1-elevated pillar is absent/partial.
- **Architecture:** boundaries are clean post-export: shared path resolution in
  tools/lib/sma-paths.mjs + portfolio-config.mjs; no circular lib deps
  observed `[inferred — no dependency-graph tool run yet, see G-01]`.
- **Tests:** 17 selftests wired into `npm run check` (all green). No per-tool
  unit suite; the pre-export test dir belonged to the excluded marketing site.
- **Telemetry/SRS:** framework CLIs report errors to stderr; no structured
  telemetry for the tools themselves. SRS discipline exists as *docs* for
  product repos (SRS/), not instrumentation of SMARCH.
- **Design system:** N/A for a CLI framework; dashboards (V-18) will need one.
- **A11y:** generated dashboards un-audited; becomes real with V-18.
- **i18n:** docs/tools are en-only; acceptable for dev tooling — reasoned N/A
  (no user-facing product surface until V-18).
- **Performance:** un-benchmarked on large portfolios; source-size gate green
  with 2 legacy files (scan 4,732 ln, wiki 4,159 ln) — both block clean TS
  conversion (G-16) and are the Rust-kernel candidates.
- **Docs:** strong (39 framework docs), but acronym-dense beyond the 5-term
  public vocabulary; no demo, no INFLUENCES.
- **CI/gates:** all local (`npm run check`, gitleaks binary in scratchpad —
  not even a committed CI config); zero PR protection.
- **Release readiness:** repo private on GitHub pending owner flip;
  `"private": true` blocks npm; no plugin packaging.

## Strengths worth preserving
1. Zero runtime dependencies; clone → `node tools/x.mjs` → runs. The TS
   migration MUST keep this (erasable syntax + type stripping).
2. The 17-selftest discipline — extend per new module, never regress.
3. Honest positioning (docs/PUBLIC_POSITIONING.md) — the anti-hype voice is a
   brand asset with exactly the audience V-13 targets.
4. Fresh single-commit public history with zero private identifiers (verified
   by zero-leak grep + gitleaks 2026-07-10).
