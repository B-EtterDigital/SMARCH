# Rust module tour

This tour describes the planned static `smarch-core` kernel for repository walking, hashing, and similarity work. The configured `rust-core/**` target is not present in this checkout yet, so maintainers must treat the module as a bootstrap gap rather than an available runtime. Read it before introducing the kernel or moving performance-sensitive scanning into the native layer. The eventual binary must preserve deterministic output across supported platforms.

## Purpose

The Rust module is reserved for a dependency-free native kernel that the registry can call for bounded performance work. Its target architecture gives the module no internal dependencies, but no Rust source or `Cargo.toml` currently exists.

## Owned files

- `rust-core/**`

## Gates

The configured module gate is `cargo test --manifest-path rust-core/Cargo.toml`. It cannot run until `rust-core/` is bootstrapped. Once present, run Rust formatting, tests, and release builds for supported targets, then run the project source-size gate and strict module Graphify summary. Compare native output with the JavaScript contract when replacing an existing path.

## How to work here

Bootstrap the target and its graph before claiming this module ready. Keep the command interface narrow, deterministic, and backward compatible. Do not move orchestration or policy decisions into the kernel.
