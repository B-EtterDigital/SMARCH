# SMA command reference

This is the complete annotated reference for every command returned by
`node tools/sma.mjs list`. The commands are grouped by the owner in
`sma.gen3.json`. Run every example from the SMARCH repository root.

[SMA](GLOSSARY.md) commands use the repository-local
[command-line interface (CLI)](GLOSSARY.md):

```bash
node tools/sma.mjs list
```

## Fixture portfolio

Examples that use `$SMA_DEMO_*` operate on a disposable copy of the evaluation
portfolio. Prepare it once per shell:

```bash
export SMA_DEMO_ROOT="${TMPDIR:-/tmp}/sma-command-reference"
export SMA_DEMO_PORTFOLIO="$SMA_DEMO_ROOT/portfolio"
export SMA_DEMO_REGISTRY="$SMA_DEMO_ROOT/registry.json"
export SMA_DEMO_STATE="$SMA_DEMO_ROOT/state.json"
export SMA_DEMO_MANIFEST="$SMA_DEMO_PORTFOLIO/acme-cms/src/modules/approval-flow/module.sweetspot.json"

rm -rf "$SMA_DEMO_ROOT"
mkdir -p "$SMA_DEMO_ROOT"
cp -R tools/evals/fixtures/portfolio "$SMA_DEMO_PORTFOLIO"
node tools/sma.mjs scan --root "$SMA_DEMO_PORTFOLIO" --out "$SMA_DEMO_REGISTRY"
node tools/sma.mjs state --registry "$SMA_DEMO_REGISTRY" --out "$SMA_DEMO_STATE"
```

Examples ending in `--help` are deliberate: those commands otherwise require
a live lease, dispatch, release ledger, or write global control-plane state.
The example still exercises the real router and the command's argument parser
without changing the checkout.

## Capsule, submission, MCP, and evaluation commands

### `mcp-serve`

Serve the local SMARCH registry over MCP stdio. `--check` loads every MCP tool
module and reports whether the optional MCP SDK is available; a successful
module check can report `ready: false` until the SDK is installed. While the
server is running, stdout is reserved exclusively for MCP JSON-RPC.

```bash
node tools/sma.mjs mcp-serve --check --json
node tools/sma.mjs mcp-serve --verbose
```

Flags: `--check`, `--json` (check mode only), `--quiet`, `--verbose`, `--help`.
Exit codes: `0` success, `2` usage, `3` missing optional SDK while serving,
`4` invalid tool modules, and `1` runtime failure. The only transport is stdio.

### `brick-new`

Create a runnable capsule by copying the canonical `templates/capsule` files
and replacing the manifest identity, name, source project, and provenance.

```bash
node tools/sma.mjs brick-new --id acme.identity --directory /tmp/acme-identity --json
```

Required flags: `--id`, `--directory`. Optional flags: `--name`, `--force`,
`--json`, `--quiet`, `--verbose`, `--help`. Exit codes: `0` success, `2` usage,
`3` destination exists, `4` template or creation failure. `--force` removes
only the explicitly requested destination before recreating it.

### `brick-run`

Run every fixture in a capsule's `fixtures/run.json` against `src/index.ts`.
Each stdout line is a JSON fixture result; real failures also emit structured
telemetry on stderr. Default isolation uses all capabilities detected in the
current Node runtime, while `--strict-sandbox` refuses incomplete isolation.

```bash
node tools/sma.mjs brick-run templates/capsule --json
node tools/sma.mjs brick-run --strict-sandbox templates/capsule
```

Flags: `--capsule <directory>` or one positional directory,
`--strict-sandbox`, `--allow-net`, `--json`, `--quiet`, `--verbose`,
`--selftest`, `--help`. Exit codes: `0` pass, `2` usage, `3` missing input,
`4` invalid input or fixture failure, `1` runtime failure. The default runner
is a deterministic fixture harness, not an OS sandbox for hostile code.

### `brick-inspect`

Read a capsule manifest, report its declared `quality.verification` gates, and
execute its real fixtures through `brick-run`.

```bash
node tools/sma.mjs brick-inspect templates/capsule --json
```

Flags: `--capsule <directory>` or one positional directory, `--json`,
`--quiet`, `--verbose`, `--help`. Exit codes: `0` passing, `2` usage,
`3` missing or invalid manifest, `4` fixture runner/failure. Inspection uses
the runner's default sandbox mode; use `brick-run --strict-sandbox` separately
when strict isolation proof is required.

### `submit`

Package a community brick for curator intake. Packaging validates the
manifest, runs `gate:all` and `gate:leaks`, creates a deterministic archive,
and verifies it before reporting success. Verification mode rechecks an
existing archive without packaging source.

```bash
node tools/sma.mjs submit --brick ./my-brick --root . --json
node tools/sma.mjs submit --verify submissions/brick.tar.gz --json
```

Flags: `--brick`, `--root`, `--manifest`, `--out`, `--verify`, `--json`,
`--quiet`, `--verbose`, `--selftest`, `--help`. Exit codes: `0` success,
`2` usage, `3` missing input, `4` validation/gate failure, `1` runtime failure.
Packaging requires git, tar, and both root-project gate scripts.

### `sync-public`

Stage a filtered private-to-public tree sync, run the built-in leak gate plus
gitleaks, and apply atomically only with `--write`. Dry-run is the default.

```bash
node tools/sma.mjs sync-public --from . --to ../public --json
node tools/sma.mjs sync-public --from . --to ../public --write
```

Required flags: `--from`, `--to`. Optional flags: `--config`, `--write`,
`--allow-no-gitleaks`, `--json`, `--quiet`, `--verbose`, `--selftest`,
`--help`. Exit codes: `0` success, `2` usage/config, `1` leak/security block,
`3` missing source, `4` apply/recovery failure. A write requires gitleaks
unless the operator explicitly passes `--allow-no-gitleaks`.

### `evals-run`

Run the fixture snapshot, lesson curriculum, and clean plugin-profile quality
gates serially. `--only` isolates one gate for diagnosis; JSON mode returns a
single report object while stderr retains structured failure telemetry.

```bash
node tools/sma.mjs evals-run --json
node tools/sma.mjs evals-run --only fixture-snapshot --verbose
```

Flags: `--only <fixture-snapshot|lesson-curriculum|plugin-clean-profile>`,
`--json`, `--quiet`, `--verbose`, `--selftest`, `--help`. Exit codes: `0` all
pass, `2` usage, `4` evaluation failure, `1` runner failure. Checks are
serial and can take several minutes.

## Coordination (`coord`)

### `conflict`

Report and resolve [Gen3](GLOSSARY.md#gen3) agent collisions.

```bash
node tools/sma.mjs conflict summary --project sma --limit 5
```

### `context`

Append-only agent-context log.

```bash
node tools/sma.mjs context list-bricks --project sma
```

### `context-check`

[CI](GLOSSARY.md) gate: modified manifests have context.

```bash
node tools/sma.mjs context-check audit --project sma
```

### `context-replay`

Render a brick's log as a story. A replay needs an existing brick log; use the
help path when no prior state is guaranteed.

```bash
node tools/sma.mjs context-replay --help
```

### `controller-snapshot`

Read-only leases/conflicts/graphs/dirty snapshot.

```bash
node tools/sma.mjs controller-snapshot --project sma --no-dirty --no-graphs
```

### `end-edit`

Log `edit_applied` and release a lease. The full mini-sequence creates the
required lease, captures its id, and releases it cleanly.

```bash
example_brick="docs-command-example-$$"
lease_id="$(
  node tools/sma.mjs start-edit \
    --project sma \
    --brick "$example_brick" \
    --intent "Exercise the command reference" \
    --no-dirty-baseline \
    --json |
  node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => console.log(JSON.parse(s).lease.lease_id))'
)"
node tools/sma.mjs end-edit \
  --lease "$lease_id" \
  --project sma \
  --brick "$example_brick" \
  --intent "Exercise the command reference" \
  --no-dirty-delta \
  --no-preflight-tldr
```

### `gen3 dispatch`

Persist a cleanup wave dispatch manifest.

```bash
node tools/sma.mjs gen3 dispatch --help
```

### `gen3 snapshot`

Read-only controller snapshot.

```bash
node tools/sma.mjs gen3 snapshot --project sma --no-dirty --no-graphs
```

### `gen3 status`

Parallel readiness and big-picture [TLDR](GLOSSARY.md).

```bash
node tools/sma.mjs gen3 status --project sma --no-auto-refresh --allow-stale
```

### `lease`

Soft locks on bricks/regen targets.

```bash
node tools/sma.mjs lease list --json
```

### `merge`

Divergence proposals from context chains. Proposal queries require a project
with context history, so the zero-state example uses the parser-safe help path.

```bash
node tools/sma.mjs merge --help
```

### `seed`

Demo: replay recent commits as full edit cycles. Seeding needs a scanned live
project; inspect its dry-run contract before choosing that project.

```bash
node tools/sma.mjs seed --help
```

### `start-edit`

Acquire a lease and log `edit_planned` in one shot. Pair it with `end-edit` so
the runnable example does not leave an active lease.

```bash
example_brick="docs-command-start-example-$$"
lease_id="$(
  node tools/sma.mjs start-edit \
    --project sma \
    --brick "$example_brick" \
    --intent "Exercise start-edit" \
    --no-dirty-baseline \
    --json |
  node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => console.log(JSON.parse(s).lease.lease_id))'
)"
node tools/sma.mjs end-edit \
  --lease "$lease_id" \
  --project sma \
  --brick "$example_brick" \
  --intent "Exercise start-edit" \
  --no-dirty-delta \
  --no-preflight-tldr
```

## Registry and lifecycle (`reg`)

### `backfill`

Add structured-why `touch_event` to a manifest.

```bash
node tools/sma.mjs backfill --help
```

### `backfill-bulk`

Apply hand-written intents to many bricks
([CSV](GLOSSARY.md)/[JSON](GLOSSARY.md)).

```bash
node tools/sma.mjs backfill-bulk --help
```

### `backfill-plan`

Select 500+ bricks-that-matter and write a plan.

```bash
node tools/sma.mjs backfill-plan --help
```

### `backfill-run`

Execute a backfill plan (dry-run by default). A real run consumes the plan
written by `backfill-plan`, so inspect the accepted plan and resume flags first.

```bash
node tools/sma.mjs backfill-run --help
```

### `backfill-summary`

Roll up every backfill batch report.

```bash
node tools/sma.mjs backfill-summary summary --json --include-dry-runs
```

### `backlog`

Per-project backlog of imperfections.

```bash
node tools/sma.mjs backlog stats
```

### `bootstrap-manifests`

Inspect scanner candidates and propose conservative starter manifests. The
command is a dry run unless `--write` is supplied.

```bash
node tools/sma-bootstrap-manifests.ts --help
```

### `clone`

Copy a brick/build into a target project. Search the fixture registry first;
add `--brick`, `--target`, and `--write` only after selecting a result.

```bash
node tools/sma.mjs clone \
  --registry "$SMA_DEMO_REGISTRY" \
  --search approval-flow
```

### `doctor`

Health report (global or `--project`).

```bash
node tools/sma.mjs doctor \
  --registry "$SMA_DEMO_REGISTRY" \
  --state "$SMA_DEMO_STATE" \
  --project acme-cms \
  --top 2
```

### `gen3 observe`

Persist observed cleanup wave outcomes. This consumes an existing dispatch
manifest, so use the help path before selecting `--dispatch` or `latest`.

```bash
node tools/sma.mjs gen3 observe --help
```

### `gen3 refresh`

Queued/debounced scan + state + dashboard refresh.

```bash
node tools/sma.mjs gen3 refresh --help
```

### `gen3 watch`

Live cleanup wave monitor.

```bash
node tools/sma.mjs gen3 watch --help
```

### `portfolio-refresh`

Queued/debounced scan + state + Gen3 dashboard refresh.

```bash
node tools/sma.mjs portfolio-refresh --help
```

### `propagate`

Push a release to dependents. Propagation needs a source brick plus a release
and may write dependent notifications, so the zero-state example is help-only.

```bash
node tools/sma.mjs propagate --help
```

### `release`

Cut a release artifact from a manifest. A real release also requires a current
license ledger; the help path is runnable without weakening that gate.

```bash
node tools/sma.mjs release --help
```

### `scaffold`

Scaffold a manifest from inferred metadata.

```bash
node tools/sma.mjs scaffold --help
```

### `scan`

Scan all projects and regenerate a registry.

```bash
node tools/sma.mjs scan \
  --root "$SMA_DEMO_PORTFOLIO" \
  --out "$SMA_DEMO_REGISTRY"
```

### `state`

Regenerate the state snapshot. It consumes the registry produced by `scan`.

```bash
node tools/sma.mjs scan \
  --root "$SMA_DEMO_PORTFOLIO" \
  --out "$SMA_DEMO_REGISTRY"
node tools/sma.mjs state \
  --registry "$SMA_DEMO_REGISTRY" \
  --out "$SMA_DEMO_STATE"
```

### `stats`

Adoption metrics over time.

```bash
node tools/sma.mjs stats summary --since 7d --project sma --json
```

### `store`

Install releases by id+version.

```bash
node tools/sma.mjs store list-bricks --json
```

### `store-remote`

STUB: hosted release-store (federation). The command does not make network
calls; the health action prints the planned remote-store contract.

```bash
node tools/sma.mjs store-remote health --origin http://127.0.0.1:54321
```

### `touch-backfill`

Alias of `backfill`.

```bash
node tools/sma.mjs touch-backfill --help
```

### `why-blocked`

Explain why a project/brick is blocked.

```bash
node tools/sma.mjs why-blocked \
  --registry "$SMA_DEMO_REGISTRY" \
  --state "$SMA_DEMO_STATE" \
  --project acme-cms \
  --json
```

## Provenance utilities (`prov`)

These focused executables operate on the generated provenance records directly.

### `anchor`

Recompute the current Merkle root and verify it against the persisted anchor
without writing a new anchor.

```bash
node tools/sma-anchor.ts --verify
```

### `attest`

Build a portable verification bundle for every sealed brick. This writes below
`releases/attestations/`.

```bash
node tools/sma-attest.ts --all --json
```

### `attest-verify`

Verify the first generated bundle as an independent recipient would.

```bash
bundle="$(find releases/attestations -mindepth 1 -maxdepth 1 -type d | sort | head -1)"
node tools/sma-attest-verify.ts --dir "$bundle"
```

## Quality gates (`gates`)

### `ci`

Full pipeline (scan, validate, security, wiki). The full pipeline writes its
generated outputs, so the checkout-safe example exercises its real help path.

```bash
node tools/sma.mjs ci --help
```

### `security`

Run the security gate. `--soft` preserves the findings while making this
fixture inspection suitable for a command-reference smoke run.

```bash
node tools/sma.mjs security --root "$SMA_DEMO_PORTFOLIO" --soft --json
```

### `validate`

Validate manifests against schemas.

```bash
node tools/sma.mjs validate --manifest "$SMA_DEMO_MANIFEST"
```

### `validate-gen3`

Schema-validate Gen-3 surfaces.

```bash
node tools/sma.mjs validate-gen3 all --project sma
```

## Dashboards and wiki (`dash`)

### `gen3 dashboard`

Build `wiki/GEN3_DASHBOARD.generated.html`. Building writes a generated
dashboard, so use the help path when only verifying the command contract.

```bash
node tools/sma.mjs gen3 dashboard --help
```

### `gen3 wiki`

Build `wiki/gen3/` diff + tree pages. Listing is read-only and works even when
the fixture output directory has not been built yet.

```bash
node tools/sma.mjs gen3 wiki list --out "$SMA_DEMO_ROOT/wiki-gen3"
```

### `wiki`

Regenerate the brick wiki. This consumes the fixture `scan` and `state`
outputs and writes only below the disposable demo root.

```bash
node tools/sma.mjs wiki \
  --registry "$SMA_DEMO_REGISTRY" \
  --state "$SMA_DEMO_STATE" \
  --out "$SMA_DEMO_ROOT/wiki"
```

## Stand-alone maintenance and self-test tools

These tools are invoked directly because they verify or prepare repository
surfaces outside the routed command set.

### Attestation self-test

Build temporary attestation bundles, verify the valid bundle, and prove that
tampered content and forged inclusion evidence are rejected.

```bash
node tools/lib/attestation-selftest.ts
```

### Export coverage self-test

Confirm every known source exporter still imports and calls the central export
policy, and that unresolved bricks fail closed.

```bash
node tools/lib/export-coverage-selftest.ts
```

### Export guard self-test

Exercise open, internal, closed, and unknown brick outcomes without writing the
real export audit log.

```bash
node tools/lib/export-guard-selftest.ts
```

### Evaluation fixture generator

Inspect the deterministic portfolio generator's output, self-test, and snapshot
update modes without changing fixture data.

```bash
node tools/evals/fixtures/gen.mjs --help
```

### Public ledger generator

Exercise the public provenance-ledger contract without replacing the committed
generated ledger.

```bash
node tools/gen-public-ledger.mjs --selftest
```

### Agent skill installer

Inspect the installer usage and supported target platforms without changing a
project.

```bash
node tools/install-agent-skills.ts --help
```

### License evidence self-test

Scan temporary source trees and verify declared-versus-observed license
mismatch behavior.

```bash
node tools/lib/license-evidence-selftest.ts
```

### License lattice self-test

Verify that composition never becomes more open, visible, or permissive than
its most restrictive component.

```bash
node tools/lib/license-lattice-selftest.ts
```

## Direct tool entry points

These source-level entry points are useful in scripts and when debugging the
router. Each example invokes the real tool directly.

### `tools/sma-similarity-scan.ts`

Scan a bounded set of bricks for cross-project near-duplicates.

```bash
node tools/sma-similarity-scan.ts --limit 1 --json
```

### `tools/sma-smoa-token-summary.ts`

Summarize locally recorded planner and worker token usage.

```bash
node tools/sma-smoa-token-summary.ts --window-days 7 --json
```

### `tools/sma-source-size-gate.ts`

Inspect current source-size violations without enforcing the failing gate exit.

```bash
node tools/sma-source-size-gate.ts --root . --json
```

### `tools/sma-stable-generated-selftest.ts`

Verify that timestamp-only generated-state changes do not rewrite files.

```bash
node tools/sma-stable-generated-selftest.ts
```

### `tools/sma-start-edit.ts`

Inspect the lease-and-context claim contract without acquiring a lease.

```bash
node tools/sma-start-edit.ts --help
```

### `tools/sma-state.ts`

Inspect state-generator inputs and output options.

```bash
node tools/sma-state.ts --help
```

### `tools/sma-stats.ts`

Inspect available adoption summaries, trends, and rankings.

```bash
node tools/sma-stats.ts --help
```

### `tools/sma-store.ts`

Inspect local release-store operations.

```bash
node tools/sma-store.ts --help
```

### `tools/sma-store-remote.ts`

Inspect the non-networked hosted-store stub contract.

```bash
node tools/sma-store-remote.ts --help
```

### `tools/sma-sup-status.ts`

Exercise the empty-registration status path without writing portfolio output.

```bash
node tools/sma-sup-status.ts --roots=
```

### `tools/sma-sync-public.mjs`

Run the private-to-public sync's isolated self-test.

```bash
node tools/sma-sync-public.mjs --selftest
```

### `tools/sma-token-count.ts`

Estimate tokens for one source file without writing a project report.

```bash
node tools/sma-token-count.ts --path tools/sma-token-count.ts
```

### `tools/sma-touch-backfill.ts`

Inspect structured touch-history operations without changing a manifest.

```bash
node tools/sma-touch-backfill.ts --help
```

### `tools/sma-update-plan.ts`

Inspect planner inputs and bounded-output options.

```bash
node tools/sma-update-plan.ts --help
```

### `tools/sma-validate.ts`

Inspect manifest, project-root, and registry validation modes.

```bash
node tools/sma-validate.ts --help
```

### `tools/sma-validate-gen3.ts`

Inspect coordination-artifact validation modes.

```bash
node tools/sma-validate-gen3.ts --help
```

### `tools/sma-wave-monitor.ts`

Inspect the live cleanup-wave report contract.

```bash
node tools/sma-wave-monitor.ts --help
```

### `tools/sma-wave-observe.ts`

Inspect dispatch-observation and persistence options.

```bash
node tools/sma-wave-observe.ts --help
```

### `tools/sma-why-blocked.ts`

Inspect project, brick, and build readiness queries.

```bash
node tools/sma-why-blocked.ts --help
```

### `tools/sma-wiki.ts`

Inspect registry, state, and output-directory options.

```bash
node tools/sma-wiki.ts --help
```

### `tools/sma-wiki-gen3.ts`

List generated release-diff pages without writing them.

```bash
node tools/sma-wiki-gen3.ts list --out "$SMA_DEMO_ROOT/wiki-gen3"
```

### `tools/sma-wiki-html.ts`

Render an empty disposable detailed-wiki root and its master index.

```bash
wiki_html_root="${TMPDIR:-/tmp}/sma-wiki-html-example"
rm -rf "$wiki_html_root"
mkdir -p "$wiki_html_root"
node tools/sma-wiki-html.ts --root "$wiki_html_root"
```

## Direct tool entry points

These lower-level entry points support automation and focused maintenance when
the routed command is not the right boundary. Commands ending in `--help` are
checkout-safe parser smokes; the other examples state when they write output.

### `tools/sma-operator-packet.ts`

Build the compact operator handoff used before opening larger controller views.

```bash
node tools/sma-operator-packet.ts --help
```

### `tools/sma-parallel-preflight.ts`

Check conflicts, leases, graph readiness, and safe parallel launch capacity.

```bash
node tools/sma-parallel-preflight.ts --help
```

### `tools/sma-portfolio-refresh.ts`

Queue and debounce the registry, state, and dashboard refresh chain.

```bash
node tools/sma-portfolio-refresh.ts --help
```

### `tools/sma-portfolio-scan.ts`

Scan selected first-class projects and optionally merge their registry outputs.

```bash
node tools/sma-portfolio-scan.ts --help
```

### `tools/sma-promote.ts`

Recompute brick lifecycle decisions. This empty-input example exercises the
real promotion path without modifying a manifest.

```bash
printf '{"bricks":[]}\n' | node tools/sma-promote.ts \
  --candidates /dev/stdin \
  --dry-run
```

### `tools/sma-propagate.ts`

Plan release fan-out for locked dependents and intentional forks.

```bash
node tools/sma-propagate.ts --help
```

### `tools/sma-provenance-ledger.ts`

Rebuild provenance, fingerprint, and license ledgers. This writes the generated
ledger files under `registry/` and `security/`.

```bash
node tools/sma-provenance-ledger.ts --limit 1 --json
```

### `tools/sma-provenance-summary.ts`

Regenerate the public-safe provenance aggregate under `security/`.

```bash
node tools/sma-provenance-summary.ts
```

### `tools/sma-provenance-verify.ts`

Verify stored provenance chains and print a machine-readable report.

```bash
node tools/sma-provenance-verify.ts --json
```

### `tools/sma-publish.ts`

Prepare a redacted, policy-checked community export bundle.

```bash
node tools/sma-publish.ts --help
```

### `tools/sma-publish-index.ts`

Index local publish bundles without contacting a remote service.

```bash
node tools/sma-publish-index.ts --help
```

### `tools/sma-publish-leaks.ts`

Group export leak blockers into an actionable remediation handoff.

```bash
node tools/sma-publish-leaks.ts --help
```

### `tools/sma-recommend-builds.ts`

Rank reusable builds against a product need.

```bash
node tools/sma-recommend-builds.ts --help
```

### `tools/sma-refresh-manifest-budgets.ts`

Recalculate source-size budgets in selected manifests.

```bash
node tools/sma-refresh-manifest-budgets.ts --help
```

### `tools/sma-release.ts`

Create a versioned release artifact from a brick or build manifest.

```bash
node tools/sma-release.ts --help
```

### `tools/sma-release-drafts.ts`

Explain why curated build releases remain drafts.

```bash
node tools/sma-release-drafts.ts --help
```

### `tools/sma-release-index.ts`

Group release artifacts by identity, version, channel, and status.

```bash
node tools/sma-release-index.ts --help
```

### `tools/sma-repo-queues.ts`

Generate per-project queues for canonicalization work.

```bash
node tools/sma-repo-queues.ts --help
```

### `tools/sma-reuse-receipt.ts`

Record the provenance, savings, integration cost, and debt of copied bricks.

```bash
node tools/sma-reuse-receipt.ts --help
```

### `tools/sma-rule-gate.ts`

Check curated-build source against the declared reusable-source rules.

```bash
node tools/sma-rule-gate.ts --help
```

### `tools/sma-scan.ts`

Discover and validate manifests, then produce a normalized registry.

```bash
node tools/sma-scan.ts --help
```

### `tools/sma-scope-drift.ts`

Compare a curated build's declared surface with its current source tree.

```bash
node tools/sma-scope-drift.ts --help
```

### `tools/sma-score.ts`

Recalculate the weighted reuse-readiness score stored in a manifest.

```bash
node tools/sma-score.ts --manifest "$SMA_DEMO_MANIFEST"
```

### `tools/sma-security-gate.ts`

Scan the disposable fixture portfolio and retain findings without failing the
command-reference smoke.

```bash
node tools/sma-security-gate.ts \
  --root "$SMA_DEMO_PORTFOLIO" \
  --soft \
  --json
```

### `tools/sma-seed.ts`

Preview or commit realistic coordination events derived from recent project work.

```bash
node tools/sma-seed.ts --help
```

## Direct tool entry points

These commands expose the underlying tools directly for debugging, focused
automation, and environments that do not use the top-level command router.

### `sma-context-normalize.mjs`

Preview normalization of legacy agent-context proof records without writing.

```bash
node tools/sma-context-normalize.ts --project sma --dry-run
```

### `sma-context-replay.mjs`

Render one brick's recorded work timeline as text.

```bash
node tools/sma-context-replay.ts --project sma --brick example-brick --format text
```

### `sma-controller-snapshot.mjs`

Read the coordination snapshot for one project without listing dirty paths.

```bash
node tools/sma-controller-snapshot.ts --project sma --dirty-limit 0
```

### `sma-dashboard-server.mjs`

Exercise the dashboard server's startup and authorization policy checks.

```bash
node tools/sma-dashboard-server.ts --selftest
```

### `sma-dependents-index.mjs`

Inspect the dependency-index command contract before a portfolio scan or write.

```bash
node tools/sma-dependents-index.ts --help
```

### `sma-dirty-baseline.mjs`

Inspect baseline and delta commands used to separate task work from existing dirt.

```bash
node tools/sma-dirty-baseline.ts save --help
```

### `sma-doctor.mjs`

Inspect project diagnosis inputs and output modes without requiring generated state.

```bash
node tools/sma-doctor.ts --help
```

### `sma-end-edit.mjs`

Inspect the evidence and cleanup fields required to close a leased edit.

```bash
node tools/sma-end-edit.ts --help
```

### `sma-enrich.mjs`

Preview semantic manifest enrichment for at most one reuse candidate.

```bash
node tools/sma-enrich.ts \
  --candidates registry/global-modules.generated.json \
  --registry registry/global-modules.generated.json \
  --dry-run \
  --limit 1
```

### `sma-filter.mjs`

Score reuse candidates while keeping both generated reports outside the checkout.

```bash
node tools/sma-filter.ts \
  --registry registry/global-modules.generated.json \
  --out /tmp/sma-reuse-candidates.json \
  --all-out /tmp/sma-reuse-scores.json
```

### `sma-gen3-classify.mjs`

Classify one path into its configured module and coordination lane.

```bash
node tools/sma-gen3-classify.mjs --changed-file tools/sma-graphify.ts
```

### `sma-gen3-dashboard.mjs`

Inspect the dashboard builder's project, output, and visibility options.

```bash
node tools/sma-gen3-dashboard.ts --help
```

### `sma-goal-progress.mjs`

Run the deterministic goal-progress fixtures without reading portfolio state.

```bash
node tools/sma-goal-progress.ts --selftest
```

### `sma-graph-packets.mjs`

Inspect the list, show, and claim contract for graph-repair packets.

```bash
node tools/sma-graph-packets.ts --help
```

### `sma-graphify.mjs`

Run the graph wrapper's local fixture checks.

```bash
node tools/sma-graphify.ts selftest
```

### `sma-import-verify.mjs`

Verify import records under the current checkout and emit compact structured output.

```bash
node tools/sma-import-verify.ts --target . --max-checks 25 --compact
```

### `sma-init-project.mjs`

Inspect the project initialization contract without creating a project.

```bash
node tools/sma-init-project.ts --help
```

### `sma-leak-gate.mjs`

Run the leak detector's isolated tracked-file and exception fixtures.

```bash
node tools/sma-leak-gate.mjs --selftest
```

### `sma-lease.mjs`

List active brick leases as structured data without mutating the registry.

```bash
node tools/sma-lease.ts list --resource-kind brick --json
```

### `sma-license-gate.mjs`

Evaluate the current license lattice in report-only mode.

```bash
node tools/sma-license-gate.ts --json
```

### `sma-manifest-scaffold.mjs`

Inspect curated-build repair scaffold inputs without loading generated build state.

```bash
node tools/sma-manifest-scaffold.ts --help
```

### `sma-match.mjs`

Rank reusable bricks for a small product vision.

```bash
node tools/sma-match.ts \
  --registry registry/global-modules.generated.json \
  --vision "local dashboard with project health" \
  --top 5
```

### `sma-merge.mjs`

Inspect merge proposal and resolution commands without requiring a project log.

```bash
node tools/sma-merge.ts --help
```

### `sma-merge-registries.mjs`

Inspect the registry merger's repeatable project and registry input syntax.

```bash
node tools/sma-merge-registries.ts --help
```

### `sma-module-work-packets.mjs`

Inspect module planning, claiming, observation, and watch commands.

```bash
node tools/sma-module-work-packets.ts --help
```

## Direct tool entry points — builds, Codex, and coordination

These lower-level commands support focused build maintenance, semantic
enrichment, and coordination checks. Examples write only to `/tmp` or use a
read-only/help path unless the accompanying text says otherwise.

### `tools/sma-brick-wall-lego.ts`

Render the current brick registry as a self-contained catalog outside the checkout.

```bash
node tools/sma-brick-wall-lego.ts --out /tmp/sma-brick-wall.html
```

### `tools/sma-build-index.ts`

Preview the curated-build index without writing its generated file.

```bash
node tools/sma-build-index.ts --dry-run --stdout
```

### `tools/sma-build-packets.ts`

Preview repair packets for every currently selected curated build.

```bash
node tools/sma-build-packets.ts --dry-run --stdout
```

### `tools/sma-build-promote.ts`

Print the evidence-backed promotion plan without changing build manifests.

```bash
node tools/sma-build-promote.ts --dry-run --stdout
```

### `tools/sma-build-verify.ts`

Inspect verifier inputs, filters, and output controls.

```bash
node tools/sma-build-verify.ts --help
```

### `tools/sma-ci.ts`

Inspect the full gate runner and its strict coordination options.

```bash
node tools/sma-ci.ts --help
```

### `tools/sma-cleanup-packets.ts`

Inspect cleanup packet listing, claiming, dispatch, and freshness controls.

```bash
node tools/sma-cleanup-packets.ts --help
```

### `tools/sma-clone.ts`

Search the registry for cloneable bricks without copying any files.

```bash
node tools/sma-clone.ts --search workos --list
```

### `tools/sma-clone-smoke.ts`

Inspect the cross-project clone smoke-test contract.

```bash
node tools/sma-clone-smoke.ts --help
```

### `tools/sma-codex.ts`

Exercise the shared Codex runner with a minimal response.

```bash
node tools/sma-codex.ts --prompt "Reply with PONG"
```

### `tools/sma-codex-all.ts`

Exercise stage selection without running or writing any pipeline stage.

```bash
node tools/sma-codex-all.ts \
  --skip filter,enrich,connect,tests,promote,wiki,wiki-idx
```

### `tools/sma-codex-connect.ts`

Run the connection pipeline over an empty candidate set and write only to `/tmp`.

```bash
printf '{"bricks":[]}\n' > /tmp/sma-empty-candidates.json
node tools/sma-codex-connect.ts \
  --candidates /tmp/sma-empty-candidates.json \
  --out /tmp/sma-empty-connections.json
```

### `tools/sma-codex-enrich.ts`

Preview semantic enrichment over an empty candidate set.

```bash
printf '{"bricks":[]}\n' > /tmp/sma-empty-candidates.json
node tools/sma-codex-enrich.ts \
  --candidates /tmp/sma-empty-candidates.json \
  --dry-run
```

### `tools/sma-codex-profile.ts`

Inspect startup-audit and reversible profile controls.

```bash
node tools/sma-codex-profile.ts --help
```

### `tools/sma-codex-rank.ts`

Rank reusable builds and bricks for a small product vision.

```bash
node tools/sma-codex-rank.ts \
  --vision "Add an approval workflow" \
  --top 5
```

### `tools/sma-codex-scan-helper.ts`

Exercise uncovered-file discovery against an empty temporary project.

```bash
scan_root="$(mktemp -d)"
node tools/sma-codex-scan-helper.ts \
  --project command-example \
  --root "$scan_root" \
  --out /tmp/sma-scan-long-tail.json
```

### `tools/sma-codex-test.ts`

Preview generated-test work over an empty candidate set.

```bash
printf '{"bricks":[]}\n' > /tmp/sma-empty-candidates.json
node tools/sma-codex-test.ts \
  --candidates /tmp/sma-empty-candidates.json \
  --dry-run
```

### `tools/sma-codex-wiki.ts`

Preview detailed-wiki work over an empty candidate set.

```bash
printf '{"bricks":[]}\n' > /tmp/sma-empty-candidates.json
node tools/sma-codex-wiki.ts \
  --candidates /tmp/sma-empty-candidates.json \
  --out-root /tmp/sma-empty-wiki \
  --dry-run
```

### `tools/sma-codex-wiki-index.ts`

Build empty detailed-wiki indexes entirely under `/tmp`.

```bash
wiki_root="$(mktemp -d)"
node tools/sma-codex-wiki-index.ts --root "$wiki_root"
```

### `tools/sma-compact.ts`

Preview compact-card generation over an empty candidate set.

```bash
printf '{"bricks":[]}\n' > /tmp/sma-empty-candidates.json
node tools/sma-compact.ts \
  --candidates /tmp/sma-empty-candidates.json \
  --out /tmp/sma-empty-brick-cards.jsonl \
  --dry-run
```

### `tools/sma-compliance-gate.ts`

Print the current checkout's legal and safety control scorecard as structured data.

```bash
node tools/sma-compliance-gate.ts --root . --json
```

### `tools/sma-conflict.ts`

Summarize recent unresolved coordination collisions without writing events.

```bash
node tools/sma-conflict.ts summary --project sma --limit 5
```

### `tools/sma-context.ts`

List bricks that have an agent-context event stream.

```bash
node tools/sma-context.ts list-bricks --project sma
```

### `tools/sma-context-check.ts`

Audit lifetime agent-context coverage for the architecture project.

```bash
node tools/sma-context-check.ts audit --project sma
```
