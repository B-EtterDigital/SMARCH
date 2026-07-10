# Your first clone

## Why this matters

Reusing working code can save days, but a mystery copy creates new questions:
Where did it come from? What was copied? What still needs adapting? A guided
clone keeps those answers beside the copied code.

*Made with love for creators of all kind.*

## The idea

A clone is a copy of a [brick](../GLOSSARY.md#brick) placed into another
project. SMARCH reads the brick's [manifest](../GLOSSARY.md#manifest), copies
only the declared files, and writes an import record plus a checklist. The
import record says what arrived and where it came from; the checklist says
what a human still needs to review.

Think of cloning as borrowing a seedling from a careful gardener. You receive
the plant, its name tag, a note naming the original garden, and instructions
for helping it settle into new soil. Copying the leaves alone would be faster
for one minute and confusing for much longer.

The scanner first builds a [registry](../GLOSSARY.md#registry), which is the
inventory the clone command searches. The resulting source history supports a
[provenance seal](../GLOSSARY.md#provenance-seal): a checkable link back to the
source facts used during the copy.

## Try it

Run this block from the SMARCH folder. It regenerates and scans the practice
portfolio, then copies Activity Feed into a separate target folder. By default,
that folder is `~/DEV/smarch-first-clone`; the automated lesson runner uses a
temporary folder instead.

`--write` tells the command to make the copy instead of previewing it.
`--allow-closed` bypasses a safety check that normally stops restricted code
from being copied. It is appropriate here only because these generated
fixtures are synthetic and public-safe; do not use it for real source without
an authorized review.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
SMARCH_LESSON_TMP="${SMARCH_LESSON_TMP:-$(mktemp -d)}"
SMARCH_FIXTURE_REGISTRY="$SMARCH_LESSON_TMP/lesson-06.registry.json"
SMARCH_CLONE_TARGET="${SMARCH_CLONE_TARGET:-$HOME/DEV/smarch-first-clone}"
export SMARCH_CLONE_TARGET
cd "$SMARCH_DIR"

npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO"
node tools/sma-scan.mjs \
  --root "$SMARCH_FIXTURE_PORTFOLIO" \
  --out "$SMARCH_FIXTURE_REGISTRY"

mkdir -p "$SMARCH_CLONE_TARGET"
node tools/sma-clone.mjs \
  --registry "$SMARCH_FIXTURE_REGISTRY" \
  --brick acme-desktop.activity-feed \
  --target "$SMARCH_CLONE_TARGET" \
  --write \
  --allow-closed

node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const target = process.env.SMARCH_CLONE_TARGET;
const importsPath = path.join(target, ".smarch", "imports.json");
const imports = JSON.parse(fs.readFileSync(importsPath, "utf8"));
const record = imports.imports[0];
const sourcePath = path.join(target, "src", "modules", "activity-feed", "index.mjs");
const checklistPath = path.join(target, record.checklist_path);

console.log(`Copied source: ${fs.existsSync(sourcePath) ? "yes" : "no"}`);
console.log(`Recorded brick: ${record.artifact_id}`);
console.log(`Install status: ${record.status}`);
console.log(`Checklist exists: ${fs.existsSync(checklistPath) ? "yes" : "no"}`);
NODE
```

Expected output includes:

```text
SMA scan complete: 40 manifest brick(s)
"dry_run": false
"brick": "acme-desktop.activity-feed"
"next_step": "Open ... to finish integration."
Copied source: yes
Recorded brick: acme-desktop.activity-feed
Install status: installed
Checklist exists: yes
```

## What you just did

You created a fresh inventory, selected one brick by its unique name, and made
a real copy. The target now contains the source file, its manifest, an import
record, and a review checklist. “Installed” means the files were placed and
recorded; it does not mean the checklist can be skipped.

Open the printed checklist before adapting the clone:

```text
~/DEV/smarch-first-clone/.sweetspot/clones/acme-desktop-activity-feed.md
```

## Where to go next

Return to the [lesson path](START_HERE.md#the-lesson-path) and continue with
lesson 07, Provenance and seals. You will inspect how SMARCH proves where a
brick came from and notices when that history no longer matches.
