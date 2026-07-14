# SAIL — Sweetspot App Instance Lease

| Feature | What it does | Status | Code |
| --- | --- | --- | --- |
| Pool registry + FIFO queue | Stores pooled instances and serves waiting checkout tickets in strict arrival order | live | `tools/lib/sail-registry.ts` |
| Fingerprint-matched acquire | Reuses a clean matching build, launches below the cap, recycles dirty or stale instances, then queues without bypass | live | `tools/sma-sail.ts` |
| Two-lease model + SPL registration | Separates agent checkout from pool process ownership and registers pooled instances with SPL | live | `tools/sma-sail.ts` |
| Fencing generation + check | Advances a per-instance checkout generation and rejects stale leases before steering | live | `tools/sma-sail.ts` |
| Test HUD overlay | Renders the in-window test HUD in a closed shadow root that stays outside agent locators | live | `tools/lib/sail-hud-bootstrap.js` |
| HUD keeper CDP session | Holds a persistent pool-owned CDP session and re-injects the HUD across page loads | live | `tools/lib/sail-hud.ts` |
| Machine-budget cap clamp | Clamps each project's declared pool cap against the live SPL machine budget | live | `tools/lib/sail-registry.ts` |
| Hermetic selftest | Proves launch, reuse, recycle, fencing, queue, and reap behavior with isolated fake instances | live | `tools/sma-sail.ts` |
