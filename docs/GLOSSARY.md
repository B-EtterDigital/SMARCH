# Glossary

Use this page when a SMARCH command, manifest, or agent handoff uses a term you
do not recognize. Start with the task below, then follow the link to the exact
definition. Each term stands on its own.

## Find the term for your task

- **Package or reuse code:** [brick](#brick), [manifest](#manifest), [registry](#registry), [canonical](#canonical), [capsule](#capsule).
- **Prove that code is ready:** [gate](#gate), [SSA-v2](#ssa-v2), [SSI](#ssi), [SSTF](#sstf), [SPE](#spe), [SRS](#srs), [SVA](#sva), [SRLS](#srls), [SEV](#sev), [SSC](#ssc), [provenance seal](#provenance-seal), [license lattice](#license-lattice).
- **Coordinate agents safely:** [Gen3](#gen3), [lease](#lease), [agent-context](#agent-context), [conflict report](#conflict-report).
- **Use an optional workflow:** [SUP](#sup), [SMOA](#smoa), [SFF](#sff).

## Run the core checks

Run these examples from the SMARCH repository root. They inspect coordination
state, list unresolved conflicts, and verify the provenance and license
mechanisms without starting a server:

```bash
npm run controller:snapshot:quiet -- --project sma
npm run conflict:summary
npm run provenance:selftest
```

## Agent-context

Agent-context is the append-only record of why an agent changed a brick: its intent, decisions, rejected alternatives, touched surface, and handoff. The record lives under `.smarch/agent-context/` so the next agent can recover the reasoning instead of reconstructing it from a diff.

## Brick

A brick is the smallest reusable unit of code with a stable contract: owned boundaries, a public interface, required gates, provenance, and clone or update rules. A component or module becomes a brick when it carries that contract; the registry then ranks bricks from candidate toward canonical as verification and reuse evidence accumulate.

## Canonical

Canonical means the preferred brick or build for new projects. It is a promotion backed by repeated successful use, passing gates, and an empty or explicitly resolved backlog; it is evidence of readiness, not a claim that the code looks good.

## Capsule

A capsule is the planned constraint-first brick tier: a tightly bounded scaffold that can be created, run in a sandboxed fixture, and inspected with its gates passing by construction. Capsule commands and templates are on the roadmap, so treat the term as a target capability until that tier ships.

## Conflict report

A conflict report is the structured record created when two agents, dirty paths, leases, or shared resources collide. It names the affected project and brick, the blocked intent, and a resolution plan; the blocked agent backs off until the conflict is resolved or explicitly handed over.

## Gate

A gate is an executable proof that must pass before a brick, build, or change can advance. Tests, security checks, database-access checks, performance budgets, and provenance verification are gates; a non-zero result blocks promotion or integration instead of turning uncertainty into a success claim.

## Gen3

Gen3 is SMA's multi-agent coordination layer. It maps module ownership, classifies work into safe lanes, gives agents graphs and leases, records context and conflicts, and runs the required gates; separate modules can move in parallel while shared hot paths stay serialized.

## Lease

A lease is a time-limited exclusive claim on a brick or shared resource. `start:edit` acquires it before a change, and `end:edit` records the outcome and releases it; if another live lease already covers the same surface, the new agent reports the conflict and backs off.

## License lattice

The license lattice is the rule system that calculates a build's effective openness, visibility, and license from all of its bricks. The most restrictive source wins, so a build cannot be published as more open, more visible, or more permissively licensed than the code it contains.

## Manifest

A manifest is the machine-readable metadata file that tells SMARCH what a brick or build is and how it may be used. It records identity, boundaries, interfaces, gates, security, provenance, licensing, and clone or update rules so tools and agents do not have to infer the contract from source code.

## Provenance seal

A provenance seal is a tamper-evident hash chain over a brick's creator history, anchored to a fingerprint of its source. It exposes reordered or removed history and source drift; an optional Ed25519 signature also prevents someone from rewriting the whole ledger and recomputing an unsigned chain.

## Registry

The registry is the searchable inventory of discovered bricks, builds, releases, and their evidence. Scanners populate it from projects and manifests so people and agents can compare candidates, trace provenance, and choose a verified reusable unit instead of searching repositories by hand.

## SEV

SEV is the environment-and-secret-hygiene gate. It requires each brick to declare its environment variables, scope, required environments, forbidden exposure, and placeholder policy, then checks that secrets do not leak into client bundles, logs, examples, or generated docs.

## SFF

SFF, Sweetspot Frontend-Fix, is the explicit opt-in design-excellence workflow for frontend work. It requires the design skill stack, rejects known generic patterns, verifies the result with screenshots, and writes `.sff/DESIGN-LOCK.md`; once that lock exists, every later frontend edit must follow it.

## SMOA

SMOA, Sweetspot MoA (Mixture of Agents), is the explicit opt-in orchestration layer for using several models under one evidence contract. The planner-gatekeeper owns decisions and leases, while separate Codex executors implement bounded packets and cross-review one another without weakening Gen3 gates.

## SPE

SPE is the performance-proof gate. A brick declares measurable limits for the costs it can create—such as requests, latency, memory, bundle size, DOM weight, and N+1 behavior—and supplies evidence that it stays inside those limits.

## SRLS

SRLS, the Sweetspot RLS Standard, is the database-and-storage-access gate for Supabase and Postgres bricks. It documents tables, operations, actors, row-level-security policies, storage policies, RPC security, and negative cross-user or cross-tenant tests so portable code does not carry hidden access assumptions.

## SRS

SRS is the observability-proof contract. It requires stable error codes, privacy-safe diagnostics, degradation paths, and incident breadcrumbs so a real failure is visible and actionable instead of being silently caught or reported as success.

## SSA-v2

SSA-v2 is SMA's base security and architecture boundary. It favors minimum responsible code, treats the frontend as untrusted, keeps privileged operations behind explicit server boundaries, scopes data access, limits dependencies, and accepts current evidence over confident claims.

## SSC

SSC, Sweetspot Supply Chain and Provenance, records where a brick came from and whether its inputs can be trusted. It covers source paths and commits, copy lineage, dependencies and licenses, vulnerability status, checksums, and the humans, agents, models, and tools that touched the brick.

## SSI

SSI is the failure-isolation and access-gating contract. It keeps a brick from taking down its host by requiring safe loading and fallback behavior, and it makes feature, tier, authentication, or authorization access explicit where those gates apply.

## SSTF

SSTF is the testing-proof contract. It requires executable coverage for expected behavior, edge cases, service contracts, security regressions, and clone adapters so a copied brick arrives with proof of what it does and where it can fail.

## SUP

SUP, Sweetspot Ultra Plan, is SMA's explicit opt-in maximum-granularity planning layer. It reconstructs the full product vision, audits the current state, and stores the remaining work as dependency-aware, machine-readable `.UltraVision/` tasks that agents claim and complete through the `uvp` tool.

## SVA

SVA, Sweetspot Vulnerability Audit, turns security review into a repeatable gate. It covers secrets, client bundles, dangerous code patterns, dependency vulnerabilities, authorization failures, and relevant web attack classes; high or critical findings block canonical promotion.
