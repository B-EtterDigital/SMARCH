# Contributing to SMARCH

SMARCH is the global control plane of the Sweetspot Modular Architecture.
Contributions follow the same rules the framework enforces on bricks.

## Setup

```bash
git clone https://github.com/B-EtterDigital/SMARCH.git
cd SMARCH && npm install
npm run check   # syntax + selftests + source-size gate — must pass clean
```

## Ground Rules

- **Minimum responsible code.** No bloat, no pointless abstractions, no
  dependency creep. New runtime dependencies need a strong justification.
- **One concern per commit.** Never bundle unrelated changes.
- **No machine-specific paths.** All path resolution goes through
  `tools/lib/sma-paths.mjs` (`SMA_ROOT`, `SMA_DEV_ROOT`, `SMA_PROJECTS_ROOT`)
  and `tools/lib/portfolio-config.mjs`. Hardcoded absolute paths are rejected.
- **No real project data.** Examples, fixtures, and docs use the fictional
  `acme-*` portfolio. Never commit scan output, registries, or wiki output
  generated from real codebases.
- **No secrets, ever.** Placeholders only. `.env` files are gitignored;
  `.gitleaks.toml` and the pre-commit hook enforce this.
- **Source-size cap.** `npm run source:size:gate` blocks oversized files; do
  not bump `tools/source-size-baseline.json` without a debt note.

## Adding a Tool

1. Put it in `tools/` as `sma-<name>.mjs`; shared logic goes in `tools/lib/`.
2. Resolve paths via `sma-paths.mjs`; accept `--root`/`--project` flags for
   anything portfolio-facing.
3. Add an npm script in `package.json`, a selftest where behavior is
   non-trivial, and a row in `tools/README.md`.

## Adding or Changing a Schema

Schemas in `schemas/` are contracts. Additive changes bump the minor schema
version; breaking changes need a migration note in `docs/` and support in
`sma-validate.mjs`.

## Docs

Framework docs live in `docs/`. Keep the public vocabulary small: brick,
manifest, gate, registry, canonical.

## Security

See [SECURITY.md](SECURITY.md). Never publish exploit details before a fix.

## License

By contributing you agree your contributions are licensed under Apache-2.0.
