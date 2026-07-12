# SPL — Sweetspot Process Lease

| Feature | What it does | Status | Code |
| --- | --- | --- | --- |
| Process registration | Binds PID plus opaque start identity to a live SMA lease | live | `tools/lib/spl-registry.ts` |
| Three-tier process view | Shows ACTIVE, EXPIRED, and ORPHAN? authority tiers, plus dead identities | live | `tools/sma-spl.ts` |
| Safe audited reap | Dry-runs by default; verifies identity and ancestry before TERM/grace/KILL | live | `tools/sma-spl.ts` |
| Agent orphan discovery | Finds old, reparented, data-signature-matched Codex and Claude candidates | live | `tools/lib/spl-agents.ts` |
| Machine-health doctor | Reports budget, tier counts, and estimated reclaimable RAM/CPU | live | `tools/sma-spl.ts` |
| Cross-platform process safety | Preserves opaque identity and guarded reap behavior on Linux, macOS, and Windows | live | `tools/lib/spl-platform/` |
