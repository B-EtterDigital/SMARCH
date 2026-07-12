# Changelog

All notable changes to SMARCH. Format loosely follows Keep a Changelog;
versions track `package.json`.

## [Unreleased]

### Added
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
