# Code Quality — the dogma, enforced

This document is the standard the gates enforce. It is not aspirational: every
rule below has a command, and `npm run gate:quality` fails when any of them
does. A rule without a gate is an opinion; we don't ship opinions.

## The doctrine

1. **Strict types, no exceptions.** `tsconfig.json` runs `strict: true`.
   `@ts-expect-error` requires a reason comment and is budgeted (tracked
   count may only go down). Bare `@ts-ignore` never lands.
2. **Type-aware linting.** ESLint flat config with `typescript-eslint`
   `strictTypeChecked` + `stylisticTypeChecked`. The rules that matter most
   here are the async ones (`no-floating-promises`,
   `no-misused-promises`) — an agent-maintained codebase dies quietly
   without them.
3. **Small units.** Files ≤ 1,900 lines (source-size gate), functions ≤ 60
   lines, cyclomatic complexity ≤ 15 (lint-enforced). Decompose, don't
   grow.
4. **No dead weight.** `knip` fails the gate on unused exports, files, and
   dependencies. `jscpd` fails it past 3% duplication. "Minimum responsible
   code" is measured, not felt.
5. **Errors are typed and actionable.** Every thrown error carries
   `{code, area, message, hint}` (see `tools/lib/errors`). Expected
   failures print structured guidance, never stack traces. Silent catches
   are lint-banned.
6. **Tests prove behavior.** `tools/lib` holds a `c8` line-coverage floor
   (ratcheted, never lowered). New fixes ship failing-first tests — the test
   exists in the diff *before* the fix makes it pass.
7. **Evidence at task granularity.** A completed task journals the evidence
   command that proves *that task*, not a generic lint run. (`uvp
   audit-claims` re-runs samples; dilution is a defect.)
8. **Rust holds the same bar.** `cargo clippy -- -D warnings` + `cargo test`
   in the gate once `rust-core` graduates from scaffold.

## The gate

```bash
npm run gate:quality   # tsc(strict) + eslint + knip + jscpd + coverage floor
```

Wired into `npm run check` and CI. The ratchet file
(`tools/quality-ratchet.json`) records the current budgets
(`ts-expect-error` count, coverage floor, duplication ceiling); budgets only
tighten.

## Why this hard line

SMARCH's thesis is that AI-swarm codebases stay maintainable only under
mechanical discipline. This repo is the reference implementation of its own
claim — if the dogma doesn't hold here, it holds nowhere.
