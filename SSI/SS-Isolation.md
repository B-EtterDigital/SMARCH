# [SSI](../docs/GLOSSARY.md#ssi) — Sweetspot Isolation & Access Gates

This document defines how a brick isolates its own failures and gates its own
access so it can never take down the surface that hosts it. Engineers need it
before they mount a brick into a shell, add a runtime path that can throw, or
put a capability behind a tier or permission. Read it while wiring loading and
error states, and again before claiming a brick is safe to embed. Remember that
isolation is a property of the boundary between a brick and its host — a brick
that renders perfectly in isolation but white-screens its host on failure has
no SSI.

## Purpose

SSI is the failure-isolation and access-gating contract. Where
[SSA-v2](../docs/GLOSSARY.md#ssa-v2) draws the trust boundary, SSI makes that
boundary survivable: a brick that errors, loads slowly, or is accessed by an
unauthorized user degrades locally and predictably instead of cascading. It is
what lets many independently-authored bricks share one runtime safely.

## The three isolation layers

- **L1 — Safe loading.** Every brick loads without blocking or breaking its
  host. Heavy work is lazy/deferred; a slow or failed load shows a bounded
  fallback (skeleton, empty state, retry), never a hung or blank host.
- **L2 — Failure isolation.** Every brick is wrapped by an error boundary that
  routes the failure to the observability facade
  ([SRS](../docs/GLOSSARY.md#srs)) and renders a contained fallback. A thrown
  render, a rejected promise, or a bad prop takes down the brick, not the page.
- **L3 — Access gating.** Feature, tier, authentication, and authorization gates
  are explicit and evaluated before the gated capability is reachable — in the
  UI for affordance and, for anything privileged, again behind the SSA-v2
  server boundary. The client gate is convenience; the server gate is truth.

## SSI in the Sweetspot ecosystem

- **[SSA-v2](../docs/GLOSSARY.md#ssa-v2)** → SSA-v2 defines the boundary; SSI
  keeps a failure on one side from crossing to the other. Client-side access
  gates (L3) are affordance only — the real gate is SSA-v2's server boundary.
- **[SRS](../docs/GLOSSARY.md#srs)** → every isolated failure (L2) reports
  through the observability facade with area, severity, and context. A silent
  catch is an SSI defect: isolation without a report hides the failure it
  contained.
- **[SPE](../docs/GLOSSARY.md#spe)** → isolation must not degrade performance;
  lazy loading and error boundaries are measured on the same path they protect.
- **[STF-v1](../docs/GLOSSARY.md#stf)** → the fallback path, the error boundary,
  and each access gate are exercised by tests, so isolation is proven under the
  failure it claims to survive.

## What a reviewer checks

- The brick renders a bounded fallback for its loading, empty, and error states
  — no blank host, no infinite spinner.
- An error boundary wraps the brick and routes to SRS; there is no silent catch
  and no swallowed promise rejection.
- Every tier / auth / feature gate is explicit, and every *privileged* one is
  re-checked behind the server boundary, never enforced by the client alone.
- A thrown error inside the brick, injected in a test, degrades the brick and
  leaves the host interactive.

## Scoring

SSI is worth **10 points** of brick quality, with a bar of **90+ when UI or
runtime isolation applies**. Where a brick has no runtime surface to isolate,
SSI is documented as non-applicable rather than silently skipped — an
unexamined isolation claim is not a passing one.
