# Enforcement

SMA is only credible when checks can fail.

## Tooling

| Tool | Purpose |
|------|---------|
| `tools/sma-scan.mjs` | Find brick manifests and generate global registry |
| `tools/sma-validate.mjs` | Validate manifests and enforce canonical blockers |
| `tools/sma-score.mjs` | Recalculate weighted score from gate scores |
| `tools/sma-security-gate.mjs` | Lightweight secret/env exposure gate |
| `tools/sma-wiki.mjs` | Generate user-facing wiki and course |
| `tools/sma-ci.mjs` | Run scan, validation, and wiki generation together |
| `tools/install-agent-skills.mjs` | Install SMA skills for Claude Code, Codex, and OpenCode |

## Recommended CI

```bash
node ~/DEV/SMARCH/tools/sma-ci.mjs \
  --root ~/DEV/Projects \
  --registry ~/DEV/SMARCH/registry/global-modules.generated.json \
  --wiki ~/DEV/SMARCH/wiki
```

Local pre-commit config is available in `.pre-commit-config.yaml`.

## Hard Blockers

These fail validation for canonical bricks:

- score below 90
- high or critical vulnerability findings
- missing source commit or archive hash
- missing review event
- clone readiness `blocked` or `manual_only`
- required RLS not complete
- required env contract not complete
- file over 600 lines
- gate status `missing` or `blocked`

## Warnings

These do not block non-canonical bricks but should be fixed:

- missing model verification evidence
- score differs strongly from weighted gate score
- missing code budget or bloated status
- no public API declared
- no adapter points declared
- source commit missing
- no test commands
- skipped verification
- private data class with no explanation of why RLS is not required

## Score Is Not A Waiver

Scores rank bricks. They do not excuse missing security.

A brick with score 96 and a critical finding is blocked.

A brick with score 92 and no review event is not canonical.
