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
  `tools/lib/sma-paths.ts` (`SMA_ROOT`, `SMA_DEV_ROOT`, `SMA_PROJECTS_ROOT`)
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

## Your first contribution in 30 minutes

1. Fork `B-EtterDigital/SMARCH`, then clone your fork and install the repo:

   ```bash
   git clone https://github.com/<your-user>/SMARCH.git
   cd SMARCH
   npm install
   npm run check
   ```

2. Pick an open
   [`good first issue`](https://github.com/B-EtterDigital/SMARCH/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).
   Comment on the issue before starting so another contributor knows it is in
   flight. Ask through the
   [`question` route](https://github.com/B-EtterDigital/SMARCH/issues/new?labels=question&title=Question%3A+)
   if the scope is unclear.
3. Make the smallest change that solves the issue. Keep one concern per commit,
   update the relevant docs or tests, and run `npm run check` again.
4. Push your branch and open a pull request that links the issue. State what
   changed, which evidence you ran, and any limit you could not verify.

Review here is kind and evidence-based. Expect questions about behavior,
boundaries, tests, security, or reproducibility—not performances of cleverness.
Address the evidence, keep unrelated changes out, and add a follow-up commit
rather than rewriting someone else's work.

After merge, your commit remains part of the repository's provenance. If your
work adds or corrects an intellectual influence, update
[INFLUENCES.md](docs/INFLUENCES.md) in the same pull request so the credit travels
with the code.

By participating, you agree to follow our
[Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). For questions,
bugs, and private vulnerability reports, see [SUPPORT.md](SUPPORT.md).

## License

By contributing you agree your contributions are licensed under Apache-2.0.
