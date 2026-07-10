# SMA Gates — `sma-rule-gate` and `sma-scope-drift`

Two enforcement layers between a curated build and promotion. Both follow
the same pattern: read a `build.sweetspot.json` manifest, check the manifest
against the underlying project source, refuse to promote on blocking findings.

Adapted from two ideas worth stealing (see session log 2026-05-12):

- **"Rules in pipeline, not in docs"** — rules that live in markdown get
  routed around. Gates that exit non-zero stop the bad path.
- **"Scope-reduction detection"** — when a manifest declares capabilities
  the implementation no longer delivers, *something* notices before customers do.

## `sma-rule-gate.mjs`

Runs the SSA-v2 rules against the source paths declared in a manifest.

```bash
node tools/sma-rule-gate.mjs --manifest builds/<project>/<slug>.build.sweetspot.json
node tools/sma-rule-gate.mjs --all
npm run gate:rules
```

Current rule registry (extend `RULES` array to add more):

| id | severity | what it checks |
|---|---|---|
| `R1.no-prod-console-log` | block | no `console.log()` in production source (excludes `scripts/`, loggers, tests, JSDoc examples) |
| `R8.no-hex-outside-tokens` | warn | hex color literals only in theme/token/data files |
| `SS8.no-select-star` | block | no `select('*')` in production query code |
| `source-paths-exist` | block | every `source.paths[]` entry resolves on disk |

Severity meaning: `block` exits non-zero (refuses promotion), `warn` reports
but allows promotion. Severities are reclassifiable in the registry.

## `sma-scope-drift.mjs`

Diffs declared-vs-realized for each manifest:

```bash
node tools/sma-scope-drift.mjs --manifest builds/<project>/<slug>.build.sweetspot.json
node tools/sma-scope-drift.mjs --all
npm run gate:scope
```

Buckets checked:

| declared in manifest | realized check |
|---|---|
| `source.paths[]` | path exists on disk |
| `composition.brick_refs[].path` | path exists on disk |
| `interfaces.entrypoints[]` / `api_endpoints[]` | `POST /functions/v1/X` → `supabase/functions/X` exists |
| `interfaces.commands[]` | `supabase functions serve X` → `supabase/functions/X` exists |
| `interfaces.ui_surfaces[]` | string-grep heuristic across source (best-effort) |

`ui_surfaces` is intentionally a loose heuristic — string match across the
declared source paths. False negatives are possible; treat as "investigate"
rather than "definitely missing."

## `sma-license-gate.mjs` — the license lattice

Enforces the monotonic rule: **a build can never be declared more open, more
visible, or more permissively licensed than the bricks it is composed from.**
For each build it resolves the component bricks against
`registry/license-ledger.generated.json`, computes the openness/visibility
MEET, and blocks any escalation. See `docs/PROVENANCE_SEAL_LICENSE_LATTICE.md`.

```bash
node tools/sma-license-gate.mjs            # report
node tools/sma-license-gate.mjs --gate     # exit non-zero on escalation
node tools/sma-license-gate.mjs --strict   # theft-risk copies also block
npm run gate:license
```

| finding | severity | meaning |
|---|---|---|
| `VISIBILITY_ESCALATION` | block | build more visible than its least-visible brick |
| `OPENNESS_ESCALATION` | block | build more open than the meet of its bricks |
| `CLOSED_SOURCE_PUBLISH` | block | publishable to community/public but derives from closed/unlicensed bricks |
| `COPYLEFT_UNDECLARED` | block | copyleft component not honored by the declared license |
| `THEFT_IN_COMPOSITION` | warn (block under `--strict`) | component is a cross-project copy with a different author |
| `UNRESOLVED_COMPONENT` | warn | component not in the ledger — treated as closed (fail-safe); refresh with `provenance:ledger` |

## `sma-provenance-verify.mjs` — tamper detection

Recomputes every brick's provenance **seal** from
`registry/provenance-ledger.generated.json` (created_by + touched_by anchored to
the content fingerprint) and verifies signatures. Any edited author, reordered
history, source drift, or signature break fails the gate.

```bash
node tools/sma-provenance-verify.mjs
node tools/sma-provenance-verify.mjs --gate
node tools/sma-provenance-verify.mjs --recheck-source   # also compare live source to the sealed anchor
npm run provenance:verify
```

The ledgers are produced by `npm run provenance:ledger`
(`tools/sma-provenance-ledger.mjs`) — run it periodically like `scan`. The
gates verify against the **committed** ledgers.

## Project root resolution

Both source-aware gates delegate to the canonical resolver at
`tools/lib/project-paths.mjs::resolveProjectRoot(projectId)`. That resolver:

1. Looks up the `PROJECT_PATH_OVERRIDES` map first (e.g. `acme-desktop` →
   `acme-desktop`, `acme-studio` → `acme-studio-workspace/acme-studio`).
2. Falls back to a direct exact match under `PROJECTS_ROOT`.
3. Falls back to a case-insensitive scan.
4. Returns `null` if nothing resolves — in which case source-aware rules
   are reported as `skipped` (not failed), so external-only bricks
   (e.g. `acme-lang`) don't poison the baseline.

**To register a new project** (e.g. give `acme-lang` a local checkout):
edit the `PROJECT_PATH_OVERRIDES` map in `tools/lib/project-paths.mjs`.
That single source of truth is shared with `sma-stats`, `sma-seed`, and
the backfill tools, so adding it once propagates everywhere.

## Known caveats / exceptions

- **Hex literals inside server-rendered HTML in supabase functions** —
  e.g. `workos-auth-callback/index.ts` embeds a `<style>` block with
  inline colors for a one-off success/loading page. Rule 8 targets
  component chrome that should consume design tokens; a standalone
  server HTML response has no token system to consume from. The gate
  currently flags these as `warn` rather than `block`, which is the
  intended behavior — treat them as documented exceptions, not work
  items.

## Composing them

```bash
npm run gate:all          # rules + scope-drift, both --warn-only via CI
npm run gate:promote      # gates, then build:promote — gates block promote
```

For first-pass adoption, both run under `--warn-only` inside `sma-ci.mjs`
so existing CI doesn't break. Drop `--warn-only` once the baseline is clean.

## Reports

Each gate writes a JSON report under `security/`:

- `security/rule-gate.generated.json`
- `security/scope-drift.generated.json`
- `security/license-gate.generated.json` (license lattice)
- `registry/provenance-ledger.generated.json` / `registry/license-ledger.generated.json` / `security/brick-fingerprints.generated.json` (ledgers)

These are stable artifacts. Diff them across commits to see what a change
fixed or broke.

## Exit codes

```
0  no blocking findings
1  one or more blocking findings (gate refuses promotion)
2  configuration / IO error
```

## What to NOT add to these gates

These are intentionally narrow. Resist:

- Style/lint rules — those belong to the underlying project's linter.
- Performance heuristics — too noisy at the manifest level.
- Anything that needs a running app — that's `verification.smoke_commands`.
- Anything that needs to interpret semantic meaning of code — these are
  grep-and-existence checks, not type-aware analysis. Keep them fast and
  predictable.
