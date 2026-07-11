# Token Accounting + Backlog (standard SMA workflow)

This document defines how Sweetspot records reuse savings, integration effort, and work left incomplete. Implementers, reviewers, and project owners need it when they copy a brick, defer a gate, promote a brick, or report token savings. Read it before the relevant action so the receipt or backlog entry is created in the same work session. Remember that unrecorded debt and guessed savings are not valid project evidence.

This is mandatory for every SMA-clone, every brick promotion, and every session that leaves a brick less-than-perfect. It exists so:

1. The value of reuse is **measurable** (tokens saved, wall-clock saved).
2. The cost of imperfection is **tracked**, not silently absorbed by future agents.
3. Future estimates get more accurate as receipts accumulate.

## The three tools

### `tools/sma-token-count.mjs`
Estimates generation tokens per brick or build. Default heuristic: chars / 3.7 for TS-like files, chars / 3.5 for JSON/Markdown/SQL. Multiplier 3.8× for "realistic regenerate cost" (direct + iteration + design discussion). `--method=tiktoken` requests BPE counts when the optional `tiktoken` package is installed; otherwise the tool warns and falls back to the heuristic.

```bash
node tools/sma-token-count.mjs --root /path/to/project --write
# writes <root>/.smarch/token-counts.generated.json
```

### `tools/sma-reuse-receipt.mjs`
After cloning bricks from one project to another, write a receipt:

```bash
node tools/sma-reuse-receipt.mjs \
  --target /path/to/target_project \
  --target-project acme-lang \
  --source-project acme-desktop \
  --source-commit 9810778b7c... \
  --item packages/modcap:source=web/src/modules/modcap:kind=brick \
  --infra-tokens 6500 \
  --backlog-id acme-lang-001 \
  --backlog-id acme-lang-002 \
  --write
```

Writes `<target>/.smarch/reuse-receipts/<source>-<sha>-<ts>.json` per the
`reuse-receipt.schema.json`. Net savings = `tokens_saved_estimate.upper - infrastructure_cost_tokens`.

### `tools/sma-backlog.mjs`
Per-project backlog at `<root>/.smarch/backlog.json`, global aggregate at
`~/DEV/SMARCH/registry/backlog.generated.json`.

```bash
# Open an entry
node tools/sma-backlog.mjs add --project acme-lang \
  --title "modcap typecheck disabled" \
  --kind typecheck_disabled --severity high \
  --package packages/modcap \
  --blocks-promotion-to canonical \
  --effort 3 --cost-tokens 12000 \
  --reuse-receipt-id <id>

# List / filter
node tools/sma-backlog.mjs list --project acme-lang
node tools/sma-backlog.mjs list --severity blocker --status open

# Close
node tools/sma-backlog.mjs close --project acme-lang --id acme-lang-001 \
  --resolution "Ported missing types from acme-desktop-v1 src/renderer; typecheck re-enabled in commit abc123"

# Rebuild global aggregate (run in CI nightly)
node tools/sma-backlog.mjs aggregate
```

## When entries are mandatory

Open a backlog entry whenever you:

- **Disable a gate**: typecheck, lint, test, RLS, env contract.
  → `kind: typecheck_disabled` / `test_missing` / `rls_missing` / `env_undeclared`.
- **Inherit a brick that isn't gate-clean** (any SMA gate at `partial` or `missing`).
  → Link via `linked_to.reuse_receipt_id`.
- **Leave a scanner warning unfixed** when the warning is in code you touched.
- **Couple platform-specific code** into a brick that should be portable.
  → `kind: platform_coupling`.
- **Take on a dependency drift** (Konva instead of tldraw, etc.).
  → `kind: dependency_drift`.
- **Skip writing tests** for a service you implemented.
  → `kind: test_missing`.

If you can't fix it in-session, open a ticket. The cost is logged; future-you (or future-agent) finds it via `sma-backlog.mjs list`.

## When the workflow runs

| Trigger | Required steps |
|---|---|
| `sma-clone.mjs` invocation | Clone writes import/provenance records and a checklist; then run `sma-reuse-receipt.mjs --write` explicitly for token accounting |
| Manual copy of bricks | Run `sma-reuse-receipt.mjs` manually with `--item` per copy |
| Promotion: `candidate → verified` | Process requirement: backlog must be empty for the brick, or every remaining entry must be closed with a written rationale; the backlog CLI records this debt but does not make every promotion tool enforce it automatically |
| Promotion: `verified → canonical` | Process requirement: backlog must be empty and all gates must be `passing`; verify both before promotion |
| Scheduled accounting, when configured | Run `sma-token-count.mjs --write` per project, then `sma-backlog.mjs aggregate`; this repository does not currently ship a nightly workflow for it |
| Backlog review | Use `node tools/sma-backlog.mjs stats` and inspect `registry/backlog.generated.json`; the current state generator does not embed token/backlog summaries |

## Estimate calibration

The default 3.8× multiplier comes from observing 4 Claude Code Opus 4.7 sessions Jan-Apr 2026:

| Session | LOC produced | Static tokens | Billed tokens (Anthropic invoice) | Multiplier |
|---|---|---|---|---|
| Acme Studio refactor (2026-02) | 1,840 | 14,950 | 56,800 | 3.8× |
| Acme CMS migration (2026-03) | 980 | 7,980 | 31,400 | 3.9× |
| Acme Desktop module split (2026-03) | 3,200 | 26,100 | 95,200 | 3.7× |
| acme-lang phase 0 (2026-04) | 2,890 | 22,400 | ~85k (this run) | 3.8× est |

Recalibrate the multiplier in `sma-token-count.mjs` when you have ≥ 5 calibration sessions for a given model. Track per-model in a future `model-multipliers.json`.

## What goes in a brick manifest

Every `module.sweetspot.json` should carry token estimates as part of `quality.code_budget`:

```json
{
  "quality": {
    "code_budget": {
      "feature_lines": 2894,
      "file_count": 13,
      "static_tokens_estimate": 22400,
      "realistic_regenerate_tokens_estimate": 85120,
      "estimate_method": "heuristic@3.8x",
      "last_estimated_at": "2026-04-29T12:00:00Z"
    }
  }
}
```

`tools/sma-refresh-manifest-budgets.mjs` (already exists) should be extended to populate these fields from `.smarch/token-counts.generated.json`.

## Reading the global state

```bash
# Top reuse savings across the portfolio:
jq '.entries | sort_by(-.estimates.tokens_saved_estimate.upper) | .[0:5]' \
  ~/DEV/SMARCH/registry/reuse-receipts.generated.json

# Top backlog debt (high-severity open items):
jq '.entries | map(select(.severity == "high" or .severity == "blocker") | select(.status == "open"))' \
  ~/DEV/SMARCH/registry/backlog.generated.json

# Cost-of-cleanup (sum estimated_token_cost for open entries):
jq '[.entries[] | select(.status == "open") | .estimated_token_cost // 0] | add' \
  ~/DEV/SMARCH/registry/backlog.generated.json
```

## The standard, in one paragraph

When you clone a brick, write a receipt. When you leave anything imperfect, open a backlog entry. When you promote, both must be clean. When you measure, use real LOC × 3.8× tokens, not gut feel. Calibrate the multiplier against actual Anthropic invoices every five sessions.
