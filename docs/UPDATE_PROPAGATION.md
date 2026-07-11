# Update Propagation — source-side fan-out

This guide explains how a released source brick reaches projects that import or copy it. Brick maintainers and release operators need it before they bump a version or respond to an incoming update. Read it when cutting a release, refreshing the dependents index, or applying propagation. Remember that locked imports receive update plans, while copied forks receive notices and must be updated by their owners.

The pull-side flow (`sma-clone` → `import-lock` → `sma-update-plan`) was already in place. This document covers the new push-side flow added in commit `01ad274`.

## First observed end-to-end propagation (2026-04-29)

To prove the protocol, modcap was bumped 0.1.0 → 0.2.0 in acme-desktop with an
additive change (commit `032257d11`, added `getAnnotationCounts` utility).

```bash
# 1. Cut release
node tools/sma-release.ts --manifest <acme-desktop-v1>/web/src/modules/modcap/module.sweetspot.json \
  --version 0.2.0 --status published \
  --search-root ~/DEV/Projects/acme-desktop
# → releases/acme-desktop.frontend-module.web-src-modules-modcap.e049040a/0.2.0.json

# 2. Refresh dependents
node tools/sma-dependents-index.ts --write
# → 1 source brick, 1 link: acme-lang (reuse-receipt fork)

# 3. Apply propagation
node tools/sma-propagate.ts \
  --source-brick "acme-desktop.frontend-module.web-src-modules-modcap.e049040a" \
  --release releases/.../0.2.0.json --apply
# → notify-only stub written to acme-lang/.smarch/incoming-updates/...
# → fan-out report at SMA/registry/propagation/<brick>/<ts>.json
```

**Downstream behavior (correct):** acme-lang's next agent saw the stub, opened
backlog entry `acme-lang-006` (severity: low, kind: dependency_drift) tracking
the upstream change and the decision to either cherry-pick or close as
`wontfix`. Because acme-lang's modcap is a deliberate fork (canvas reskinned
from annotation grid → vocabulary cards via tldraw v3), the upstream
`getAnnotationCounts` utility is not relevant; the entry is queued to close
`wontfix` after Phase 2 reskin lands.

This is the protocol working as designed: source ships, dependents are
notified, forks decide explicitly. No silent overwrite, no missed update.

## The two protocol layers

```
┌──────────────────────────────────────────────────────────────────┐
│  PULL-side (existing, untouched)                                 │
│   sma-clone     → writes <target>/.smarch/import-lock.json       │
│   sma-update-plan → reads import-lock + release artifact, plans  │
│                                                                  │
│  Authority: TARGET asks "is there an upgrade for me?"            │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  PUSH-side (new, additive)                                       │
│   sma-dependents-index → walks all projects, builds inverted     │
│                          index at registry/dependents.generated  │
│                          .json. Reads import-locks + reuse-      │
│                          receipts + brick provenance.            │
│                                                                  │
│   sma-propagate        → for a given source brick (or commit     │
│                          range), enumerates dependents and       │
│                          either runs sma-update-plan against     │
│                          locked targets or drops a notify-only   │
│                          stub for reuse-receipt forks.           │
│                                                                  │
│  Authority: SOURCE pushes "I shipped a new version, fan out."    │
└──────────────────────────────────────────────────────────────────┘
```

The two layers share the **release artifact** (`releases/<brick>/<version>.json`) as the thing being propagated.

## Three classes of dependents

Discovered by `sma-dependents-index` from three signal sources, ranked by authority:

| Evidence kind | Where it comes from | Auto-update? |
|---|---|---|
| `import-lock` | `<target>/.smarch/import-lock.json` (formal `sma-clone`) | Yes, with `--apply` |
| `reuse-receipt` | `<target>/.smarch/reuse-receipts/*.json` (manual copy + receipt) | **No** — notify-only stub |
| `provenance-source-chain` | brick manifest `provenance.source_chain[*].project` | Notify-only (legacy fallback) |

Rationale: `reuse-receipt` and `provenance-source-chain` represent *forks by intent* (the agent or human chose to copy and own). Auto-applying upstream changes to a fork is a foot-gun. Source projects can opt-in to stronger automation by setting `brick.replication.policy = "track-canonical"` in their manifest, but it doesn't override the dependent's own choice.

## Replication policy (optional, source-declared)

In a source brick's `module.sweetspot.json`:

```json
{
  "brick": {
    "id": "acme-desktop.web-src-modules-modcap",
    "version": "0.3.0",
    "replication": {
      "policy": "track-canonical",
      "auto_pr_on_minor": true,
      "auto_pr_on_patch": true,
      "deprecation_window_days": 30,
      "notify_owners": ["@sma-operator"]
    }
  }
}
```

`sma-propagate` reads this; without a policy it defaults to `manual` (notify-only).

## Standard fan-out flow

After bumping a source brick:

```bash
# 1. Cut a release artifact for the new version
node tools/sma-release.ts --manifest <source>/module.sweetspot.json

# 2. Refresh the dependents index
node tools/sma-dependents-index.ts --write

# 3. Dry-run propagation to see who'd be affected
node tools/sma-propagate.ts --source-brick <id> --release releases/<brick>/<version>.json

# 4. Apply: writes update plans for locked targets,
#          drops notify-only stubs for forked targets.
node tools/sma-propagate.ts --source-brick <id> --release releases/<brick>/<version>.json --apply
```

Or, for "everything that changed since we last shipped":

```bash
node tools/sma-propagate.ts --since <last-deploy-sha> --source-project acme-desktop --apply
```

## What lands where after `--apply`

```
~/DEV/SMARCH/registry/propagation/<brick>/<ts>.json
   ↑ fan-out report: which dependents got plans, which got notifications

<target_root>/.smarch/incoming-updates/<brick>-<ts>.json
   ↑ stub the dependent's next agent reads. Suggests: "run sma-update-plan"
     (locked targets) or "diff vs source HEAD and decide" (forks).

<target_root>/.smarch/update-plan-<brick>-<ts>.json   (locked targets only)
   ↑ machine-readable plan from sma-update-plan; the agent runs the upgrade.
```

No source files change in any dependent project until a human or agent
acts on the stub. The stub is purely advisory.

## Backlog integration

When `sma-propagate --apply` writes a stub for a `reuse-receipt` dependent, the
recommended follow-up is to open a backlog entry in that dependent's project:

```bash
node tools/sma-backlog.ts add --project <dependent> \
  --kind dependency_drift --severity medium \
  --title "upstream <brick> shipped <version>; review fork divergence" \
  --reuse-receipt-id <id>
```

The next agent finds it via `sma-backlog.mjs list --project <dependent>` and decides whether to upstream-track or close as `wontfix` (fork is intentional).

## CI cron (recommended)

```bash
# Nightly: rebuild the dependents index + backlog aggregate
0 3 * * * node ~/DEV/SMARCH/tools/sma-dependents-index.ts --write
0 3 * * * node ~/DEV/SMARCH/tools/sma-backlog.ts aggregate
0 3 * * * node ~/DEV/SMARCH/tools/sma-token-count.ts --root <each_project> --write
```

## Why this is non-breaking

- New schemas: `dependents-index.schema.json` is generated artifact only.
- New tools: `sma-dependents-index.mjs` and `sma-propagate.mjs` are additive.
- The `brick.replication` field is **optional** — existing manifests stay valid.
- `sma-clone.mjs`, `sma-update-plan.mjs`, `sma-import-verify.mjs` are unchanged.
- `--apply` only writes new files (`.smarch/incoming-updates/*` and `.smarch/update-plan-*.json`); it never modifies source files in any dependent.

<!-- docs-i18n: key=docs.update-propagation; source=en; media=media/{locale}/update-propagation/ -->
