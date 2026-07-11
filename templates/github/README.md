# GitHub workflow template

This guide explains the reusable GitHub Actions workflow for Sweetspot verification. Repository maintainers and release engineers need it before installing or updating the template. Read it when bootstrapping CI or comparing a project workflow with the canonical checks. Remember to preserve least-privilege permissions and every required fail-closed gate.

## Included template

- `sma-ci.yml` runs the baseline Sweetspot checks in GitHub Actions.

## Use

Copy `sma-ci.yml` into the target repository's `.github/workflows/` directory and adapt only documented project commands or runtime versions. Keep secrets in provider-managed storage and reference them through the workflow environment.

## Verification

Validate the workflow syntax, inspect its permissions, and run the matching checks locally before pushing. Use a real pull request run as the final proof when credentials and provider access are available.
