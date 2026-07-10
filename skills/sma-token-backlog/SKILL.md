---
name: sma-token-backlog
description: Run the SMA token-accounting + backlog + update-propagation workflow. Use whenever you clone bricks between projects, leave a gate at partial/missing, bump a source brick others depend on, or see a stub in .smarch/incoming-updates/.
---

# SMA Token Accounting + Backlog + Update Propagation

Read these in order:

1. [~/DEV/SMARCH/docs/TOKEN_ACCOUNTING_AND_BACKLOG.md](../../docs/TOKEN_ACCOUNTING_AND_BACKLOG.md)
2. [~/DEV/SMARCH/docs/UPDATE_PROPAGATION.md](../../docs/UPDATE_PROPAGATION.md)

## When to invoke

| Situation | Tool to run |
|---|---|
| Just cloned bricks into a project | `sma-reuse-receipt.mjs --write` |
| Need per-brick token estimates | `sma-token-count.mjs --root <p> --write` |
| Leaving a gate `partial` or `missing` | `sma-backlog.mjs add` |
| Reviewing project debt | `sma-backlog.mjs list --project <p>` or `stats` |
| Promoting a brick | Verify backlog empty: `sma-backlog.mjs list --project <p> --status open` |
| **Bumped a source brick others depend on** | `sma-dependents-index.mjs --write` then `sma-propagate.mjs --source-brick <id> --release ... --apply` |
| **Want to know who depends on a brick** | `sma-dependents-index.mjs --source-brick <id>` |
| **Saw a stub at `.smarch/incoming-updates/`** | Read the stub. If `evidence_kind: import-lock`, run `sma-update-plan`. If `evidence_kind: reuse-receipt`, open a backlog entry — never auto-apply to a fork. |

## Required after every clone

```bash
node ~/DEV/SMARCH/tools/sma-token-count.mjs --root <target> --write
node ~/DEV/SMARCH/tools/sma-reuse-receipt.mjs \
  --target <target> --target-project <id> --source-project <src> --source-commit <sha> \
  --item <pkg/path>:source=<src/path>:kind=brick \
  --infra-tokens <est> --backlog-id <id>... --write
node ~/DEV/SMARCH/tools/sma-backlog.mjs add --project <id> --kind ... --severity ... --title "..."
node ~/DEV/SMARCH/tools/sma-dependents-index.mjs --write   # source project now sees this dependent
```

## Required after a source brick version bump

```bash
node ~/DEV/SMARCH/tools/sma-release.mjs --manifest <source>/module.sweetspot.json
node ~/DEV/SMARCH/tools/sma-dependents-index.mjs --write
node ~/DEV/SMARCH/tools/sma-propagate.mjs --source-brick <id> --release releases/<brick>/<version>.json
# review dry-run, then:
node ~/DEV/SMARCH/tools/sma-propagate.mjs --source-brick <id> --release releases/<brick>/<version>.json --apply
```

## Output paths

- `<project>/.smarch/token-counts.generated.json`
- `<project>/.smarch/reuse-receipts/*.json`
- `<project>/.smarch/backlog.json`
- `<project>/.smarch/incoming-updates/<brick>-<ts>.json` (push-side stubs)
- `<project>/.smarch/update-plan-<brick>-<ts>.json` (locked targets only)
- `~/DEV/SMARCH/registry/backlog.generated.json`
- `~/DEV/SMARCH/registry/dependents.generated.json`
- `~/DEV/SMARCH/registry/propagation/<brick>/<ts>.json`

## Don'ts

- Don't gut-estimate savings; use the tools.
- Don't disable a typecheck or skip a test without opening a backlog entry.
- Don't promote with open `blocker`/`high` backlog entries.
- **Don't auto-apply** upstream changes to a `reuse-receipt` dependent. Open a backlog entry instead — it's a fork by intent.
- Don't propagate without first refreshing `sma-dependents-index.mjs --write`. Stale indices push to the wrong targets.
