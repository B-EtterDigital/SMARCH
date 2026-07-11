# CI module tour

This tour explains the repository automation that runs checks on commits and pull requests. Maintainers and release engineers need it before changing workflow, leak scanning, TypeScript, or pre-commit configuration. Read it when a task changes automated verification or runner behavior. Remember that CI changes affect every module and require serialized review.

## Purpose

The CI module owns shared automation surfaces, including GitHub Actions and repository-wide tool configuration. The target architecture classifies it as a shared hot path with no module dependencies.

## Owned files

- `.github/**`
- `.gitleaks.toml`
- `.pre-commit-config.yaml`
- `tsconfig.json`

## Gates

Run the changed workflow locally where tooling permits, then run `npm run ci:gen3` and the source-size gate. Confirm that secret scanning and required checks still fail closed.

## How to work here

Serialize edits under one lease, keep workflow permissions narrow, and avoid mixing product changes into the same patch. Record provider or credential blockers when a live runner path cannot be exercised.
