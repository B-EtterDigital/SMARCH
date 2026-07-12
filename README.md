# SMARCH — Sweetspot Modular Architecture (SMA Gen3)

**A module contract and multi-agent control plane for AI-assisted software teams.**

Every reusable module ("brick") carries its boundaries, security rules, tests,
provenance, and clone instructions — so AI agents (and humans) can reuse code
without turning the repo into a junk drawer.

> This is a battle-tested working model from a year of AI-swarm development,
> not a law of software. The core idea: small reusable bricks with hard
> boundaries and evidence. The registry only matters if bad bricks are
> rejected.

**New here? Start with the bet:** [Why SMARCH](docs/WHY_SMARCH.md) — the case
for where coding is going and the four mechanisms that pay off if it's right.

[![gates](https://github.com/B-EtterDigital/SMARCH/actions/workflows/gates.yml/badge.svg)](https://github.com/B-EtterDigital/SMARCH/actions/workflows/gates.yml)
![license](https://img.shields.io/badge/license-Apache--2.0-blue)
[![site](https://img.shields.io/badge/site-smarch.netlify.app-ffc21f)](https://smarch.netlify.app)

![SMARCH demo: scan a portfolio, read the brick wall, watch two agents collide gracefully](docs/demo/demo.gif)

*Above: a portfolio scanned into bricks, then two agents race for the same
brick — the second gets a conflict report instead of a broken merge. That is
the whole idea. ([re-record it yourself](docs/demo/README.md): `npm run demo:record`)*

**New here — or new to coding?** The [intro lane](docs/intro/START_HERE.md)
takes you from "what even is a module registry" to running your first agent
swarm in 19 short, CI-verified lessons. No prior experience assumed.

## Quickstart (ten minutes)

```bash
git clone https://github.com/B-EtterDigital/SMARCH sma
cd sma && npm install && npm link
sma list                                          # every command
node tools/install-agent-skills.ts --target ~/your-project
```

What lands on your machine: a Node CLI, the CI gates, the scanner, the agent
skills (one command installs them into any project), and a registry that fills
with your own bricks when you point the scanner at your own repos.

## Verify this repo, no trust required

The repo seals its own tools in a public hash-chain ledger
(`registry/public-ledger.generated.json`). Recompute it yourself:

```bash
node tools/gen-public-ledger.mjs   # recompute seals from file bytes + git history
```

Or verify it live in your browser on [smarch.netlify.app](https://smarch.netlify.app#provenance):
the page fetches the raw files and the ledger from GitHub, recomputes every
content hash, anchor, and chain head with WebCrypto, and compares. If history
was edited, the head breaks.

## Version control that answers *why*

`git blame` tells you what changed. SMARCH tells you who intended what, on
whose authority, proven how:

```text
$ sma blame --intent tools/sma-lease.ts --lines 259:262
259-262 | 6f295d2f 2026-07-11 | dev@1f4d06 | implemented atomic owner-safe
        | locking; why: serialize every acquire | node …sma-lease… selftest (exit 0)
```

Every line traces to an intent record, and every intent carries its passing
proof. Merge conflicts get the same treatment: `sma merge propose
--from-intents` reads both sides' *whys* and drafts the synthesis. The full
model — intent, claim, proof, trust, collision as the unit of change — is in
[docs/GEN3_VERSION_CONTROL.md](docs/GEN3_VERSION_CONTROL.md).

## No stale processes (SPL — Sweetspot Process Lease)

Codex, Claude, and every agent runtime spawn deep process trees and orphan
them on restart. SPL gives every process a lease: it lives only while its
lease lives.

```bash
sma spl doctor                 # machine health + reclaimable orphans (Linux/macOS/Windows)
sma spl list                   # ACTIVE (lease live) · EXPIRED (lease dead) · ORPHAN? (unclaimed)
sma spl reap --adopt-orphans   # dry-run; add --kill to reclaim, every action audited
sma spl-exec --lease auto -- codex exec …   # wrap any command so it can never orphan
```

Identity is `pid + start_token` (reuse-safe), rechecked immediately before any
signal; reaps are audited to the context log, never a blind `pkill`. Ships
Linux-first with macOS and Windows adapters. See
[docs/SPL_SWEETSPOT_PROCESS_LEASE.md](docs/SPL_SWEETSPOT_PROCESS_LEASE.md).

## Internal and public, cleanly separated

Add internal-only functionality without ever risking a leak: mark a file
`@sma-private` or list it in `registry/private-overlay.json`. The public sync
excludes those surfaces before copying (exclusion beats allowlist), and the
overlay-aware leak gate rejects any that are force-planted in a release tree —
so forgetting is impossible, not merely discouraged. See
[docs/SYNC_RUNBOOK.md](docs/SYNC_RUNBOOK.md).

## Held to its own dogma

This repo enforces on itself what it preaches — with budgets that can only
tighten ([docs/CODE_QUALITY.md](docs/CODE_QUALITY.md)):

`strict TS: 0 errors` · `eslint (type-aware): 0` · `dead code: 0` ·
`duplication ≤2.35%` · `lib coverage: ratcheting floor` — all gated in CI via
`npm run gate:quality`. A rule without a gate is an opinion; we don't ship
opinions.

## Honest status

Fresh from the forge (day 406 of refinement). The one-command installer is
still being packaged, so today you clone and link. The $5 lifetime scanner
license arrives by email while checkout is built:
[betterdigitalllc@gmail.com](mailto:betterdigitalllc@gmail.com).

## Core Vocabulary

| Term | Meaning |
|---|---|
| **brick** | A small, isolated, reviewable module with an explicit contract |
| **manifest** | `module.sweetspot.json` — the brick's machine-readable contract |
| **gate** | An enforced check (security, scope, size, license, provenance) that blocks promotion |
| **registry** | The index of bricks and builds across your project portfolio |
| **canonical** | The one blessed copy of a capability; everything else is a candidate |

## What Lives Here

| Path | Purpose |
|---|---|
| `tools/` | ~100 CLI tools: scanner, registry, gates, Gen3 multi-agent layer, dashboards |
| `schemas/` | JSON Schemas for brick/build manifests, releases, leases, agent context |
| `docs/` | Architecture, security, governance, playbooks |
| `skills/` | Agent skills: `sma-gen3`, `f5-ultravisionplan` (SUP), `sweetspot-frontend-fix` (SFF), `sweetspot-moa` (SMOA), enforcer, course builder |
| `agent-skills/` | Install instructions for Claude Code, Codex, and OpenCode |
| `examples/` | Example brick and build manifests (fictional `acme-*` portfolio) |
| `templates/` | Files to copy into new projects and modules |
| `SSA-v2/`, `SSI/`, `SPE/`, `SRS/`, `STF-v1/` | The five pillars: security/architecture boundary, isolation, performance, observability, and test-framework source material |

## Pointing it at your own code

```bash
# Where your projects live (defaults to ../Projects next to this repo)
export SMA_PROJECTS_ROOT=$SMA_PROJECTS_ROOT

# Optionally describe priority projects / path overrides
cp registry/portfolio.config.example.json registry/portfolio.config.json

# Index your portfolio, then check global health
npm run scan && npm run doctor
```

All tools resolve paths from `SMA_ROOT`, `SMA_DEV_ROOT`, and
`SMA_PROJECTS_ROOT` environment variables (see `tools/lib/sma-paths.ts`),
falling back to this repo's location.

## The Gen3 Multi-Agent Layer

Gen3 is what makes many agents safe in one portfolio:

- **Leases** (`sma start-edit` / `sma end-edit`) — claim a brick before
  editing; collisions are recorded, not discovered in a merge.
- **Agent context** (`sma context`) — a durable per-brick "why" log; every
  meaningful action preserves intent across sessions.
- **Conflict reports** (`sma conflict`) — divergent intents are surfaced
  from context, not just conflicting bytes.
- **Gates** (`npm run gate:all`) — rule, scope-drift, source-size, compliance,
  license, and provenance gates that block promotion, not just warn.
- **CI** (`npm run ci:gen3`) — the pipeline with strict context, conflict, and
  dirty-claim gating.
- **Controller** (`npm run controller:sweep`) — the ranked portfolio action
  queue for dispatching parallel agents to disjoint ownership buckets.

Read `docs/MULTI_AGENT_OPERATIONS.md` for the operator's guide and
`docs/FRAMEWORK.md` for the underlying model.

## Agent Skills

The optional skill layers (install with
`node tools/install-agent-skills.ts --target /path/to/project --platform all`):

- **`sma-gen3`** — the universal operating standard for modular SMA projects.
- **`f5-ultravisionplan` (SUP)** — repo audit → vision → exhaustive,
  machine-readable task plan in `.UltraVision/`, executed by parallel agents.
- **`sweetspot-frontend-fix` (SFF)** — opt-in design-excellence layer with a
  repo design lock that binds all future agents.
- **`sweetspot-moa` (SMOA)** — opt-in multi-model orchestration: one model
  plans and gates, a separate CLI workforce implements and cross-reviews.

## Minimum Bar

A brick is not registry-grade until these are explicit: minimum responsible
code, SSA-v2 boundary, SSI isolation (when applicable), STF tests, SPE
performance expectations, SRS observability, security audit, RLS/storage
matrix (when data access applies), env and secret contract, provenance
record, and clone instructions.

## Influences

SMARCH stands on named shoulders — Pierre, Sakana Fugu, OpenRouter Fusion,
Hermes MoA, Entire, Zed, Theo/t3.gg & Lakebed, Superpowers, GSD, and the
supply-chain standards it implements. The full credit roll, with what each
one taught us: [docs/INFLUENCES.md](docs/INFLUENCES.md).

## License

Apache-2.0 — see [LICENSE](LICENSE). Copyright 2026 Better Digital LLC.

*Made with love, for creators of all kind.*
