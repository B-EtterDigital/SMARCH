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
