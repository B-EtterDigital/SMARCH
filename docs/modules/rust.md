# Rust module tour

This tour explains the static `smarch-core` kernel for repository walking, hashing, and similarity work. Rust maintainers and registry integrators need it before changing kernel behavior or its command contract. Read it when a task moves performance-sensitive scanning into the native layer. Remember that the binary must preserve deterministic output across supported platforms.

## Purpose

The Rust module supplies a dependency-free native kernel that the registry can call for bounded performance work. The target architecture gives the module no internal dependencies.

## Owned files

- `rust-core/**`

## Gates

Run Rust formatting, tests, and release builds for supported targets, then run the project source-size gate and strict module Graphify summary. Compare native output with the JavaScript contract when replacing an existing path.

## How to work here

Keep the command interface narrow, deterministic, and backward compatible. Do not move orchestration or policy decisions into the kernel.
