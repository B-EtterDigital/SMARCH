# 02 — Gap Analysis (coverage contract)

Severity: blocker > major > minor > polish. Every gap must be fully
decomposed into tasks before P7 is done.

### G-01 · Graphify retrieval below state of the art [major]
blocks: V-04 | modules: graphify-bridge | current: substring+IDF query
(query.md:25), existence-only staleness (sma-graphify.mjs:405-447), no global
query (1611-1616), AST-only defaults, 512MB cap-skip, no community summaries
| target: embedding index + semantic re-rank, source→graph staleness in
`check`, `global query` across the union, GraphRAG summaries at query time,
tree-sitter extraction.

### G-02 · No MCP surface [major]
blocks: V-05 | modules: mcp-server | current: local CLIs only | target: MCP
server exposing search/trust/doctor/why-blocked/installRelease + Server Card
at .well-known, README discovery section.

### G-03 · No constraint-first tier [major]
blocks: V-06 | modules: capsule-tier, registry-core | current: manifest
template only | target: capsule scaffold (fixed entries, no arbitrary deps,
runnable fixtures), `sma brick new/run/inspect`, gates-pass-by-construction
verification, capsule promotion fast-lane.

### G-04 · Attribution scattered, no INFLUENCES.md [major]
blocks: V-07 | modules: docs | current: no CREDITS file; Superpowers only as
deprecation (skills/sma-gen3/SKILL.md:166-168); GSD/T3/Lakebed absent; Pierre,
Sakana Fugu, OpenRouter Fusion, Hermes MoA, Entire, Zed scattered in comments
| target: docs/INFLUENCES.md consolidating all lineage, linked from README.

### G-05 · Untyped codebase [blocker for V-08]
blocks: V-08 | modules: ALL tool modules + schemas | current: 147 untyped
.mjs, no tsconfig | target: full phased TS migration (erasable syntax,
zero-build), `tsc --noEmit` gate, schema-derived types.

### G-06 · SMOA hardwired to codex CLI [major]
blocks: V-09 | modules: codex-smoa | current: dispatch commands inline in
skill; sma-codex*.mjs codex-only | target: workforce-backend abstraction
(one dispatch contract; codex/opencode/claude-p adapters).

### G-07 · No public CI [blocker for V-10]
blocks: V-10 | modules: ci-infra | current: none | target: GitHub Actions —
check suite + gitleaks + private-identifier leak grep + tsc gate on every PR.

### G-08 · No agent-performance evals [major]
blocks: V-11 | modules: evals | current: seed demo + adoption stats only |
target: seeded, scored regression evals for skills/workflows with trend
reports.

### G-09 · No plugin packaging [major]
blocks: V-12 | modules: skills | current: install script only | target:
Claude plugin/marketplace manifest bundling the skills; one-command install.

### G-10 · DX below magnetism bar [major]
blocks: V-13 | modules: docs, registry-core | current: README rewritten but
no demo, no verified 5-minute quickstart, acronym wall in docs | target:
demo-first README (recorded scan→wall→collision demo), quickstart CI-verified
on a fixture portfolio, acronyms behind progressive disclosure.

### G-11 · Coordination ceremony is manual [major]
blocks: V-14 | modules: gen3-coordination | current: agents must run
start:edit/end:edit explicitly; only a pre-commit context-check hook exists |
target: ambient hooks (auto-lease on first write, auto-context stamps),
zero-ritual default with explicit mode retained.

### G-12 · No dual-repo sync tooling [major]
blocks: V-15 | modules: registry-core (tooling), docs | current: export
conventions live in session memory only | target: `sma sync-public` tool
implementing allowlist + scrub map + leak gates; documented runbook.

### G-13 · No monetization lane [major]
blocks: V-16 | modules: community-monetization, provenance | current: license
lattice exists as foundation | target: commercial license tags in the
lattice, entitlement check at clone, documented paid-brick tier (open core
untouched).

### G-14 · No community lane [major]
blocks: V-17 | modules: community-monetization, docs, ci-infra | current:
CONTRIBUTING only | target: onboarding path, showcase, gated public brick
submission workflow (submission → gates → curator promotion).

### G-15 · Dashboards are static generated HTML [major]
blocks: V-18 | modules: wiki-dashboards | current: sma-dashboard-server
serves files | target: self-hostable web dashboard app (registry, leases,
conflicts, graphs), optional hosted deployment; design language per
04-DESIGN-LANGUAGE.md.

### G-16 · Legacy oversized files block clean TS conversion [minor]
blocks: V-08 | modules: registry-core, wiki-dashboards | current:
sma-scan.mjs 4,732 ln; sma-wiki.mjs 4,159 ln (source-size-baseline.json) |
target: split below the 1,900-line cap during their TS conversion; scan hot
path is the Rust-kernel candidate.

### G-17 · No Rust core kernel [minor]
blocks: V-08 | modules: rust-core | current: none | target: `smarch-core`
crate (scan walk, hashing/merkle, similarity) behind a Node adapter; single
static binary release lane (M3).

## Coverage matrix (pillars × gaps)

| Pillar | Gaps |
|---|---|
| V-01 | (foundation — regression-guarded via G-07 CI) |
| V-02 | G-11 |
| V-03 | G-13 (extends lattice) |
| V-04 | G-01 |
| V-05 | G-02 |
| V-06 | G-03 |
| V-07 | G-04 |
| V-08 | G-05, G-16, G-17 |
| V-09 | G-06 |
| V-10 | G-07 |
| V-11 | G-08 |
| V-12 | G-09 |
| V-13 | G-10 |
| V-14 | G-11 |
| V-15 | G-12 |
| V-16 | G-13 |
| V-17 | G-14 |
| V-18 | G-15 |

### G-18 · No beginner path [major]
blocks: V-19 | modules: docs, evals, ci | current: docs assume experienced
operators | target: walkable 18-lesson intro lane, CI-verified, welcoming.

### G-19 · Codebase under-explained for newcomers [major]
blocks: V-20 | modules: all | current: sparse headers, unexplained acronyms
| target: WHY headers everywhere, explained doc intros, doc-lint gate keeps it.

| V-19 | G-18 |
| V-20 | G-19 |
