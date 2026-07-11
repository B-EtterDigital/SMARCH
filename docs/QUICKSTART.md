# SMARCH quickstart

Welcome! In about five minutes, you will check SMARCH, generate a small demo
portfolio, scan its 40 fixture [bricks](GLOSSARY.md#brick), inspect the result,
and clone your first brick into a clean target folder.

You need Git, Node.js, and npm. Run each block in order. The output samples are
shortened to the lines worth looking for, so extra detail is normal.

## 1. Clone SMARCH

Choose another `SMARCH_DIR` if that path already exists.

```bash
SMARCH_REPO="${SMARCH_REPO:-git@github.com:B-EtterDigital/SMARCH.git}"
SMARCH_DIR="${SMARCH_DIR:-$HOME/DEV/SMARCH}"
git clone "$SMARCH_REPO" "$SMARCH_DIR"
```

Expected output includes:

```text
Cloning into '.../SMARCH'...
```

## 2. Install the dependencies

```bash
SMARCH_DIR="${SMARCH_DIR:-$HOME/DEV/SMARCH}"
cd "$SMARCH_DIR"
npm install
npm install --no-save @modelcontextprotocol/sdk
```

Expected output ends with an npm summary similar to:

```text
added ... packages
```

## 3. Check the checkout

This runs the source-size, type, Gen3, and JavaScript syntax [gates](GLOSSARY.md#gate).

```bash
SMARCH_DIR="${SMARCH_DIR:-$HOME/DEV/SMARCH}"
cd "$SMARCH_DIR"
npm run check
```

Expected output includes the individual checks and returns to your prompt
without an error:

```text
> smarch@0.1.0 check
> npm run source:size:gate && npm run typecheck && npm run gen3:selftest ...
```

## 4. Generate the fixture portfolio

The fixtures are deterministic, safe demo projects. Regenerating them gives
you the same portfolio every time.

```bash
SMARCH_DIR="${SMARCH_DIR:-$HOME/DEV/SMARCH}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
cd "$SMARCH_DIR"
npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO"
```

Expected output includes:

```text
"ok": true
"project_count": 3
"brick_count": 40
```

## 5. Scan the fixture portfolio

The scanner discovers each [manifest](GLOSSARY.md#manifest) and writes a local
[registry](GLOSSARY.md#registry). The planted oversized file, environment gap,
and silent catch are intentional learning examples, not setup failures.

```bash
SMARCH_DIR="${SMARCH_DIR:-$HOME/DEV/SMARCH}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
SMARCH_FIXTURE_REGISTRY="${SMARCH_FIXTURE_REGISTRY:-$SMARCH_DIR/scans/quickstart.registry.json}"
cd "$SMARCH_DIR"
node tools/sma-scan.ts --root "$SMARCH_FIXTURE_PORTFOLIO" --out "$SMARCH_FIXTURE_REGISTRY"
```

Expected output includes:

```text
SMA scan complete: 40 manifest brick(s)
Wrote .../quickstart.registry.json
```

## 6. Ask the doctor for a readable summary

The doctor combines the freshly scanned registry with a generated state
snapshot and turns it into a friendly health report.

```bash
SMARCH_DIR="${SMARCH_DIR:-$HOME/DEV/SMARCH}"
SMARCH_FIXTURE_REGISTRY="${SMARCH_FIXTURE_REGISTRY:-$SMARCH_DIR/scans/quickstart.registry.json}"
SMARCH_FIXTURE_STATE="${SMARCH_FIXTURE_STATE:-$SMARCH_DIR/wiki/SMA_STATE.generated.json}"
cd "$SMARCH_DIR"
mkdir -p "$(dirname "$SMARCH_DIR")/Projects"
node tools/sma-state.ts --registry "$SMARCH_FIXTURE_REGISTRY" --out "$SMARCH_FIXTURE_STATE"
npm run doctor -- --registry "$SMARCH_FIXTURE_REGISTRY" --state "$SMARCH_FIXTURE_STATE"
```

Expected output starts with:

```text
SMA Doctor
State: wiki/SMA_STATE.generated.json
Registry: .../quickstart.registry.json
```

## 7. Clone your first fixture brick

This copies the activity-feed brick and writes its provenance and integration
checklist. The target deliberately lives outside the SMARCH checkout so your
working tree stays tidy. `--allow-closed` is appropriate here only because
these generated fixtures are synthetic and public-safe; do not carry that flag
into a real-source clone without an authorized review.

```bash
SMARCH_DIR="${SMARCH_DIR:-$HOME/DEV/SMARCH}"
SMARCH_FIXTURE_REGISTRY="${SMARCH_FIXTURE_REGISTRY:-$SMARCH_DIR/scans/quickstart.registry.json}"
SMARCH_CLONE_TARGET="${SMARCH_CLONE_TARGET:-$HOME/DEV/smarch-first-clone}"
cd "$SMARCH_DIR"
mkdir -p "$SMARCH_CLONE_TARGET"
node tools/sma-provenance-ledger.ts --registry "$SMARCH_FIXTURE_REGISTRY"
node tools/sma-clone.ts --registry "$SMARCH_FIXTURE_REGISTRY" --brick acme-desktop.activity-feed --target "$SMARCH_CLONE_TARGET" --write --allow-closed
```

Expected output includes:

```text
"dry_run": false
"brick": "acme-desktop.activity-feed"
"next_step": "Open ... to finish integration."
```

That is the complete first loop: install, prove, discover, diagnose, and reuse.
When you want the vocabulary behind the output, keep the
[glossary](GLOSSARY.md) nearby—especially [canonical](GLOSSARY.md#canonical),
[provenance seal](GLOSSARY.md#provenance-seal), and [Gen3](GLOSSARY.md#gen3).

<!-- docs-i18n: key=docs.quickstart; source=en; media=media/{locale}/quickstart/ -->
