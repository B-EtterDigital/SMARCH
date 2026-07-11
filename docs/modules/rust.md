# Rust module tour

This tour describes the optional static `smarch-core` kernel for repository walking, hashing, similarity, and provenance Merkle work. The Node scanner remains authoritative and falls back transparently when the binary is missing or disabled. Native output is deterministic across supported platforms.

## Purpose

The Rust module owns bounded, policy-free compute: parallel ignore-aware manifest discovery, XXH3/SHA-256 hashing, source similarity, and domain-separated Merkle roots/proofs. Scanner policy and registry assembly stay in Node.

## Owned files

- `rust-core/**`

## Gates

Run `cargo fmt --manifest-path rust-core/Cargo.toml --check`, `cargo test --manifest-path rust-core/Cargo.toml`, and `cargo build --release --manifest-path rust-core/Cargo.toml`. Run `npx tsc --noEmit` after adapter changes. Protocol and cross-language requirements are documented in `rust-core/PROTOCOL.md`.

## How to work here

Keep the command interface narrow, deterministic, and backward compatible. Do not move orchestration or policy decisions into the kernel. Set `SMA_CORE_BIN=/path/to/smarch-core` to use a downloaded binary, put `smarch-core` on `PATH`, or set `SMA_CORE=off` to force Node. `SMA_CORE=required` converts adapter/protocol failures into hard errors.

Release builds target `x86_64-unknown-linux-gnu` (`smarch-core-linux-x64`) and `aarch64-apple-darwin` (`smarch-core-darwin-arm64`). CI owns cross-platform artifact attachment; locally, `cargo build --release --manifest-path rust-core/Cargo.toml` produces the host binary at `rust-core/target/release/smarch-core`.
