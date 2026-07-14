# Changelog

All notable changes to SMARCH. Format loosely follows Keep a Changelog;
versions track `package.json`.

## [Unreleased]

### Added
- **SAIL — Sweetspot App Instance Lease** (`sma sail`): pooled,
  fingerprint-matched checkouts of app-under-test instances. A hard 1–4 cap is
  clamped by machine budget; strict FIFO queueing, matching-build warm reuse,
  and dirty/stale recycling keep lanes bounded and compatible. Each pooled
  instance and its in-window test HUD keeper process are SPL-registered. A
  hermetic 9-case selftest is wired into `gen3:selftest`; new lease resource
  kinds are `app-instance` / `app-instance-pool`, and the new context-event kind
  is `sail_instance_event`.
- **SPL — Sweetspot Process Lease** (`sma spl`, `sma spl-exec`): lease-bound
  process lifecycle. Processes live only while their lease lives; orphaned
  agent processes (codex/claude trees, detached watch-loops, `setsid` wrappers)
  are detected across three authority tiers and reaped safely, audited, never a
  blind `pkill`. Cross-platform (Linux/macOS/Windows). Bounded monitors make an
  immortal watch-loop unrepresentable.
- **Private overlay**: mark internal-only files `@sma-private` or list them in
  `registry/private-overlay.json`; the public sync excludes them (exclusion
  beats allowlist) and the leak gate rejects any in a release tree.
- **Gen3 version control**: `sma blame --intent` (lines → intent + evidence),
  `sma merge propose --from-intents` (synthesis from both sides' why).
- **Code-quality dogma** (`docs/CODE_QUALITY.md`): strict TypeScript, type-aware
  ESLint, knip, jscpd, coverage floor — all gate-enforced with a one-way ratchet.
- **Self-hostable dashboard** (Blueprint Ledger): leases, conflicts, brick wall.
- **New-coder intro lane**: 18 CI-verified lessons + orientation.

### Changed
- Entire tool layer migrated to native, zero-build TypeScript (`strict: true`,
  0 errors). Two 4,000-line legacy files decomposed. Lib coverage 10% → ~70%.

### Fixed
- Trust-core hardening from first-party defensive review (attestation anchoring,
  store containment, clone path-traversal, capsule result integrity, atomic
  owner-safe leases, conflict-event identity).
- `bin.sma` pointed at a file removed during the TS migration — `npm link`
  quickstart now works.

## [0.1.0]
- Initial open-source export of the SMA Gen3 framework: brick contract, registry
  with rejection gates, provenance seals + license lattice, Gen3 multi-agent
  coordination (leases, agent-context, conflict reports), MCP server, agent skills.
