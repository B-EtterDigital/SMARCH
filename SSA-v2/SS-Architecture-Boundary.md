# [SSA-v2](../docs/GLOSSARY.md#ssa-v2) — Sweetspot Security & Architecture Boundary v2

This document defines the base security and architecture boundary every brick is
held to. Engineers and reviewers need it before they design a data flow, add a
dependency, or expose an operation. Read it during implementation, before
release, and again after any change that moves a trust boundary. Remember that a
boundary is only real if it is enforced by a gate, not by a convention — an
unenforced rule is an opinion, and SSA-v2 does not ship opinions.

## Purpose

SSA-v2 is the floor. It is the smallest set of non-negotiable security and
architecture rules a brick must satisfy before any other pillar's score counts.
It exists so that "it works" can never be mistaken for "it is safe," and so that
an AI agent extending the codebase inherits the boundary instead of re-deriving
it (usually wrong) each time.

The five commitments:

1. **Minimum responsible code** — the least code that fully meets the
   requirement, no speculative surface. Every added line is attack surface and
   maintenance debt; unused capability is a liability, not a feature.
2. **The frontend is untrusted** — treat every value that originates in or
   passes through the client as adversarial. Validation, authorization, and
   secrets live on the server side of the boundary, never in the renderer.
3. **Privileged operations sit behind explicit server boundaries** — data
   mutation, secret access, and cross-tenant reads flow through edge
   functions / RPCs with their own authorization, never through a direct
   client query.
4. **Data access is scoped** — read and write exactly the rows and columns the
   operation needs. No `select(*)`, no unscoped list endpoints, no "we'll
   filter it in the UI."
5. **Evidence over claims** — a boundary is asserted only with the proof that
   backs it (a test, a policy, a gate result). "It's fine" is not a boundary.

## SSA-v2 in the Sweetspot ecosystem

- **[SSI](../docs/GLOSSARY.md#ssi)** → SSA-v2 draws the trust boundary; SSI keeps
  a failure on one side of it from taking down the host on the other.
- **[SRLS](../docs/GLOSSARY.md#srls)** → SSA-v2's "scope data access" rule is
  proven concretely by the row-level-security / storage matrix SRLS declares.
- **[SEV](../docs/GLOSSARY.md#sev)** → the environment and secret contract that
  keeps privileged material behind the server boundary SSA-v2 defines.
- **[SPE](../docs/GLOSSARY.md#spe)** → performance may never justify crossing the
  boundary; SPE and SSA-v2 agree that no `select(*)` and no client-side secret
  is an acceptable optimization.
- **[STF-v1](../docs/GLOSSARY.md#stf)** → every boundary rule that can regress
  gets an executable security-regression test so the boundary is proven, not
  promised.

## What a reviewer checks

- No privileged operation reachable without passing an explicit server-side
  authorization check.
- No secret, key, or service credential present in client-shipped code or
  config.
- No unscoped data read or write; every query names its columns and constrains
  its rows.
- Dependency additions justified — each new dependency is responsible code with
  a reason, a license, and a provenance trail.
- Claims backed by evidence: the PR points to the test, policy, or gate that
  enforces each boundary it asserts.

## Scoring

SSA-v2 is worth **15 points** of brick quality and the bar is **90+**. A brick
that fails the boundary does not become registry-grade no matter how well it
scores elsewhere — the boundary is a floor, not an average. Boundary violations
are correctness defects, not style nits.
