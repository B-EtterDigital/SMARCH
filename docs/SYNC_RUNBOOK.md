# Public Sync Runbook

Use this checklist when publishing the private SMARCH tree or cutting a public
release. The sync is dry-run by default and writes only after both leak gates
pass.

## Sync the public tree

1. Preview the exact add, change, and remove set:

   ```bash
   node tools/sma-sync-public.mjs --from <private-root> --to <public-root> --config <config> --json
   ```

2. Review the preview, then apply it:

   ```bash
   node tools/sma-sync-public.mjs --from <private-root> --to <public-root> --config <config> --write
   ```

The write path stages complete top-level entries beside the target, swaps each
entry with filesystem renames, and records a sibling rollback journal. If the
process stops between entry swaps, the next `--write` run rolls back the
interrupted transaction before applying the new sync. A dry-run refuses to
inspect a partially applied target and asks for that recovery write first.

## Release-train checklist

- Run `node tools/gen-public-ledger.mjs` after the release contents are final.
- Review and stage `registry/public-ledger.generated.json` with the release.
- Run `npm run ledger:verify`; a mismatch means the generated ledger is stale
  and the release must stop.
- Run `npm run provenance:selftest` and the remaining release gates.
- Run the public sync preview, review its file list, then run the write command.
- Confirm the public checkout is clean and contains no sync rollback journal.

CI must run `npm run ledger:verify` as a non-writing verification step. The
package-script integration request for that command is:

```json
{"ledger:verify":"node tools/gen-public-ledger.mjs --verify"}
```

<!-- docs-i18n: key=docs.sync-runbook; source=en; media=media/{locale}/sync-runbook/ -->
