# SPL — Sweetspot Process Lease

Agents leave processes behind. SPL gives every process a lease, watches for the ones whose lease died or that no agent ever claimed, and lets you reclaim them safely and on the record — so a weaker machine running many agents stays healthy instead of drowning in orphans.

SPL is the public, generic process-side twin of the SMA brick lease. Every registered process is identified by `{pid, start_token, lease_id, agent, label, registered_at}`. A PID alone is never an identity: `start_token` is platform-opaque and is checked again immediately before every signal.

## The three authority tiers

- `ACTIVE`: registered and its lease is live. Protected; SPL never reaps it.
- `EXPIRED`: registered, still alive, and its lease is dead. The default `sma spl reap` target.
- `ORPHAN?`: unregistered AI-agent candidate matching every safety condition. Always visible, but requires explicit `--adopt-orphans` before it can become a reap target.

Registered processes that no longer exist or whose PID was reused are shown as `DEAD` and are never signalled.

An `ORPHAN?` candidate must match a signature in `registry/spl-agents.json`, be absent from the SPL registry, have PID 1 or an expired registered process as parent, exceed `--min-age` (600 seconds by default), and be outside SPL's entire current/orchestrator ancestry. Signatures are configuration data and users may extend the registry without changing code.

## Operator flow

```bash
sma spl register --lease "$SMA_ACTIVE_LEASE_ID" --pid "$PID" --label "indexer"
sma spl list
sma spl doctor
sma spl reap                         # dry-run
sma spl reap --kill                  # EXPIRED only
sma spl reap --adopt-orphans --kill  # explicit authority for ORPHAN?
```

`start:edit` also accepts `--register-pid` and optional `--register-label`. Releasing or explicitly expiring the associated lease appends an SPL unregister record automatically.

## Reap safety and audit

Dry-run is always the default; `--kill` is required to signal. Reaping re-reads the start token immediately before SIGTERM, waits `--grace` seconds (8 by default), and uses SIGKILL only if the same process identity remains alive. PID 1, the current process, and every orchestrator ancestor are hard-excluded. Orphan adoption additionally refuses a process that has acquired any live non-init parent.

Every signal and outcome is appended to the `spl-process-lifecycle` context log with actor, PID, start token, tier, and reason. SPL is an audited intervention path, never a blind `pkill`.

## Machine health

`sma spl doctor` reports the process budget, tier counts, and estimated reclaimable resident memory and accumulated CPU time. `sma spl budget` reports cores, load, available memory, swap use, pressure, and a conservative recommended agent count. This makes the register → work → automatic unregister lifecycle practical on an 8-core or otherwise constrained machine.

## Platform support

The release adapter is Linux-only and uses `/proc`. The platform contract is already additive: macOS can supply `ps -o lstart=` identity/liveness and Windows can supply PowerShell `StartTime`, while preserving the same tiers and platform-specific parent checks. Until those adapters ship, Darwin and Win32 fail with typed `SPL_PLATFORM_UNSUPPORTED` and this documentation pointer.
