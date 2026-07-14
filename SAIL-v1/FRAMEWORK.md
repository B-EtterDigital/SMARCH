# SWEETSPOT APP INSTANCE LEASE V1 ([SAIL](../docs/GLOSSARY.md#sail))

This document defines the SAIL pooling architecture, its design decisions, and the prior art each mechanism is grounded in. Engineers and agent-tool authors need it when they wire a new app-under-test into parallel agent testing or extend the pool's policies. Read it together with the operational spec at [docs/SAIL_SWEETSPOT_APP_INSTANCE_LEASE.md](../docs/SAIL_SWEETSPOT_APP_INSTANCE_LEASE.md) before changing pool semantics. Remember that every policy here exists to answer one of two questions: "may I touch this instance?" and "what is that agent doing in my window?"

**A lease-fenced, fingerprint-matched instance pool for app-under-test surfaces, with a human-facing test HUD**

Created: July 2026 | Engine: `tools/sma-sail.ts` + `tools/lib/sail-registry.ts` + `tools/lib/sail-hud.ts`

---

## 1. THE PROBLEM

Parallel agents on a desktop-app project (Electron and friends) collide on a scarce, expensive resource: running instances of the app itself. Three failure modes recur:

1. **Orphaning** — an agent spawns an instance for a test, finishes or dies, and the instance sits there consuming memory until a human notices.
2. **Lane uncertainty** — a second agent sees a running instance and cannot tell whether it is a colleague's live test lane, an orphan, or the user's own session. Careful agents launch a redundant instance; bold agents steal a lane mid-test.
3. **Prose caps** — "never more than 3 instances" written in a project's agent instructions is enforced by `pgrep` counting and log-staleness guesses, which is to say: not enforced.

The [Gen3](../docs/GLOSSARY.md#gen3) answer to collision-prone shared surfaces is the [lease](../docs/GLOSSARY.md#lease); SPL extended it to processes. SAIL extends it to app instances as *test surfaces*, adding the two things neither layer has: capacity management with queueing, and compatibility matching so a warm instance can be handed to the next agent safely.

## 2. DESIGN DECISIONS AND THEIR PRIOR ART

Each mechanism composes a pattern proven elsewhere; none is speculative.

| Mechanism | Design | Prior art |
| --- | --- | --- |
| Capacity | Hard cap 1–4 per project, clamped further by live machine budget | Selenium Grid slot model; SPL `budget` |
| Queue | Strict FIFO tickets with their own TTL; newcomers never barge | Selenium Grid new-session queue (front-of-queue retry, request TTL, fast-fail for unsatisfiable requests) |
| Compatibility | Exact build-fingerprint match (git HEAD + tree drift + artifact manifests), user discriminator escape hatch | Testcontainers reuse-hash (config-hash reuse, with its dynamic-value and under-coverage lessons) |
| Checkout | TTL'd lease renewed by activity; expiry = abandoned = dirty | DeviceFarmer/OpenSTF device leases (renewed by every wire message); Gray & Cheriton leases |
| Hygiene | Dirty → recycle, never scrub; durable identity (auth profile) externalized | Playwright fresh-contexts-because-cleanup-is-impossible; Browserbase Contexts; OpenSTF's admitted-incomplete device scrub as the cautionary tale |
| Validate-on-handout | CDP readiness probe + process-identity re-check before every handout | HikariCP test-on-borrow with freshness bypass |
| Fencing | Monotonic per-instance generation + `sail check` at the driver | Chubby sequencers; Kubernetes `leaseTransitions`; Kleppmann's fencing-token argument that lease expiry alone is never safe |
| Reclamation | Pool lease feeds SPL registration; abandoned pools decay into SPL's reapable tier | Testcontainers' Ryuk reaper (liveness = a connection, cleanup by label) |

The 2025–26 agent-infrastructure survey that grounded these choices found no shipped equivalent: MCP browser brokers document the collision and offer isolation rather than queueing, cloud agent-browser platforms lease remote sessions rather than local app instances, and the one direct upstream feature request for agent resource leasing was closed unplanned. SAIL fills that gap.

## 3. THE STATE MACHINE

```
            acquire(launch)                acquire(reuse, fingerprint match)
  ∅ ──────────► LAUNCHING ──ready──► IDLE ─────────────────────► LEASED
                    │                 ▲  │                          │
              ready-timeout           │  │ dirty / stale-build      │ release
                    ▼                 │  ▼   (at cap)               ▼
                  killed              │ RETIRING ──► ∅           IDLE (dirty if --dirty
                                      └──────────────────────────┘  or checkout expired)
```

Invariants:

- A `LEASED` instance is never signalled, never re-issued, never reaped.
- A dirty instance is never handed out; it can only retire.
- Every transition is recorded twice: in the pool registry's bounded event log and, for the load-bearing ones, as `sail_instance_event` records in the agent-context log (schema: `schemas/agent-context-event.schema.json`).
- Registry mutations happen under a cross-process lock with stale-lock takeover; decisions (reuse/launch/recycle/queue) are computed inside the same critical section that commits them.

## 4. THE TEST HUD

Presence, not telemetry: the HUD answers "who is in this window and why" for the human, in the window itself, without existing for the agents.

- **Ownership** — the pool runs one keeper per instance (SPL-registered), holding a persistent CDP session. Agents update intent/phase through the registry; the keeper renders. This survives agent handoffs and crashes, and mirrors how Cypress and Browserbase keep the watch surface structurally outside the automated page.
- **Persistence** — `Page.addScriptToEvaluateOnNewDocument` registrations are session-scoped (verified empirically): when the injector disconnects, reloads lose the HUD. Hence a keeper, not a one-shot injector.
- **Non-interference** — closed shadow root (invisible to locators), `aria-hidden` host (absent from a11y snapshots), `pointer-events: none` except a ≤16 px collapse target, no focusable elements, no key listeners, hide-around-capture for screenshots. The collapse state belongs to the user alone and persists in the app's localStorage.
- **Placement on Wayland** — the HUD lives inside the app's own window precisely because compositor-side alternatives fail there: always-on-top and window positioning are unavailable to a separate overlay window, and layer-shell surfaces anchor to the screen, not to the app window.

## 5. EXTENDING SAIL

- **New project** — add an entry to `registry/sail-projects.json` (configuration, not code): launch template, readiness path, TTLs, cap, fingerprint paths, HUD offset. The engine needs no changes.
- **New steer driver** — treat the checkout receipt as the contract: connect to `cdp`, renew via `sail renew` (or wrap commands so activity renews), gate command batches on `sail check`, release with an honest `--dirty` verdict.
- **New policies** — recycling by `leases_served`/instance age (jittered, HikariCP-style) hangs off fields the registry already tracks; priority tickets would extend the queue records. Keep every new policy answerable to the two questions at the top of this document.
