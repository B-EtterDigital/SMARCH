# [SAIL](GLOSSARY.md#sail) — Sweetspot App Instance Lease

Parallel agents testing a desktop app repeat the same three failures: they spawn an instance and forget it, they hesitate to touch a running instance because it might be a colleague's live test lane, and they overrun the machine because a cap written in prose is not a mechanism. SAIL replaces those habits with a pooled checkout: a hard per-project cap (1–4 instances), a strict FIFO queue, warm reuse when the build fingerprint matches, and recycling when it does not. Agent tools and human controllers use it through `sma sail`; read this before wiring an app-under-test into parallel agent testing. Remember that user-launched instances are structurally out of SAIL's reach — the pool only ever touches instances in its own registry.

SAIL is the app-instance twin of SPL (`docs/SPL_SWEETSPOT_PROCESS_LEASE.md`): SPL governs process lifetimes, SAIL governs which agent may drive which running app instance and when a warm instance is handed to the next agent in line.

## The model

An instance is `{instance_id, project, pid, start_token, port, cdp, fingerprint, state, dirty, generation}` plus checkout bookkeeping (schema: `schemas/sail-instances.schema.json`). A PID alone is never an identity — the SPL start-token contract applies before every signal.

- **Build fingerprint** makes reuse safe. `--build auto` hashes the project's git HEAD, working-tree drift, and the configured `fingerprint_paths` artifact manifests (e.g. `dist/`). An idle instance is handed out only on an exact match; agents that just rebuilt therefore never receive a stale instance. `--discriminator` separates setups that would otherwise hash alike.
- **States:** `LAUNCHING → IDLE ⇄ LEASED → RETIRING`, with an orthogonal `dirty` flag.
- **Dirty** means "the next tester must not inherit this state." It is set explicitly (`release --dirty`), implicitly (a checkout [lease](GLOSSARY.md#lease) expired — the agent vanished mid-test, so state is unknown), and dirty instances are always recycled (retire + fresh launch), never reused. Hygiene by disposal; durable state such as an authenticated profile lives outside the instance.
- **Generation** is a monotonic per-instance checkout counter — the fencing token. `sma sail check --lease <id>` exits non-zero the moment a checkout stops being live, so a zombie agent (lease expired, instance re-issued) stops steering instead of clicking into the next agent's test.

## Acquire, in strict priority order

1. **Reuse** — an `IDLE`, clean instance with a matching fingerprint is checked out as-is: the queued agent inherits the very instance the previous agent tested on, already booted.
2. **Launch** — below the cap, a fresh instance starts from the project's launch recipe, is SPL-registered, and must answer its CDP readiness probe before it is handed out.
3. **Recycle** — at the cap, an idle dirty or stale-build instance is retired (SIGTERM with start-token re-check, grace, SIGKILL) and replaced.
4. **Queue** — everything is leased: the request becomes a FIFO ticket with its own TTL. `--wait <s>` blocks until served or timeout (exit 12); without `--wait`, exit 13 says "queue or come back." Newcomers never barge past tickets.

The declared cap is additionally clamped by the SPL machine budget (`sma spl budget`), so a loaded machine shrinks its pools; set `budget_clamp: false` per project to opt out (hermetic selftests do).

## Two leases and the SPL registration

Every pooled instance is covered by ordinary, auditable leases in the shared registry:

- `app-instance` — the agent's checkout. TTL'd and renewable; expiry marks the instance dirty.
- `app-instance-pool` — the pool's ownership of the instance process. SPL registration hangs off this lease, so `sma spl list` shows every pooled instance and its HUD keeper, and an abandoned pool decays into SPL's `EXPIRED` tier where `sma spl reap` reclaims it. No orphan story is added; the existing one closes over app instances.

## Operator flow

```bash
sma sail acquire --project myapp --build auto --intent "smoke the settings modal" --json
# → {"instance_id":"…","lease_id":"…","generation":3,"port":41913,"cdp":"http://127.0.0.1:41913",…}
sma sail check   --lease <lease_id>          # fencing: exit 0 live, 10 stale
sma sail renew   --lease <lease_id>
sma sail release --lease <lease_id> --verdict pass
sma sail release --lease <lease_id> --dirty --note "changed provider settings"
sma sail list
sma sail doctor                              # budget, caps, per-instance RSS, queue
sma sail reap                                # dry-run; --kill retires idle-expired instances
sma sail reap --all --kill                   # drain every idle instance
sma sail selftest                            # hermetic end-to-end proof (fake instances)
```

Projects are configuration data in `registry/sail-projects.json` — launch `argv`/`env` templates with `{PORT}` substitution, `cwd`, readiness path, optional `post_launch` steps with `{PID}` (window-manager rules and similar), TTLs, cap, `fingerprint_paths`, and HUD options. Users extend the registry without changing code, the same philosophy as `registry/spl-agents.json`.

## The test HUD

The human watching the screen cannot tell which agent is driving which window, so every leased instance carries a toast pinned to its top-right corner: agent, intent, a steering/observing pulse, how long the checkout has run, and how many agents are waiting. A × collapses it to a dot (the user's choice, persisted across reloads and agent handoffs; agents never collapse it).

The HUD is owned by the pool, not by the driving agent: a keeper process per instance (SPL-registered under the pool lease) holds a persistent CDP session, injects `tools/lib/sail-hud-bootstrap.js`, re-injects on every page load — `Page.addScriptToEvaluateOnNewDocument` registrations die with their CDP session, so one-shot injection cannot survive reloads — and re-renders whenever the registry changes.

By construction the HUD cannot interfere with the agents: it renders in a closed shadow root (locators and XPath do not pierce it), the host is `aria-hidden` (absent from accessibility snapshots), `pointer-events: none` everywhere except the collapse dot (clicks pass through), and drivers can hide it around evidence captures:

```bash
sma sail hud-inject --port 41913 --action screenshot --out proof.png     # HUD auto-hidden
sma sail hud-inject --port 41913 --action screenshot --with-hud --out ui.png
sma sail hud --instance <id> --phase observing --note "waiting for transcript finals"
```

`hud-inject` also works against any CDP-debuggable app that is not pool-managed — useful for ad-hoc lanes.

## Verified end to end

`sma sail selftest` builds a hermetic pool (temp registries, fake CDP instances, deterministic cap 2) and proves the contract on every run — it is part of `npm run gen3:selftest`:

- two launches fill the pool; a third acquire is refused with exit 13;
- a queued agent receives the releasing agent's exact instance (same `instance_id`) on a fingerprint match;
- a new fingerprint recycles a stale-build instance instead of reusing it;
- a dirty release forces a recycle; the fencing check rejects the released lease;
- reap honors idle TTLs in dry-run and `--all --kill` drains to zero instances.

The HUD path was additionally proven against real Chromium over CDP (expanded, collapsed, hidden-during-capture, and keeper-survives-reload screenshots), with the session-scoped injection gotcha captured above.

## Boundaries

- Steering is raw CDP by design: Playwright cannot attach to an already-running Electron app (upstream: "not planned"), and `connectOverCDP` loses main-process access. SAIL brokers the CDP endpoint; drivers speak CDP.
- Electron ≥ 30 ignores a bare `--remote-debugging-port` CLI switch; the app must enable it internally (`app.commandLine.appendSwitch`), typically behind an environment variable your launch recipe sets.
- SAIL never touches instances it did not launch. Adopting foreign instances is deliberately out of scope; SPL's orphan flow (`--adopt-orphans`) remains the explicit-authority path for those.
