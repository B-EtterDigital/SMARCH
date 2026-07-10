# Manifests explained

## Why this matters

Code can work perfectly and still be hard to understand or reuse safely. A
manifest gives people and tools the same small set of facts about a piece of
code, so nobody has to guess who owns it, where its edges are, or how ready it
is to travel.

*Made with love for creators of all kind.*

## The idea

A [manifest](../GLOSSARY.md#manifest) is a plain-text contract for a
[brick](../GLOSSARY.md#brick). “Contract” does not mean scary legal paperwork
here. It means a record with agreed fields that both humans and programs can
read.

Think of a manifest as the card tucked into a board-game box. The card names
the game, says who looks after it, lists what belongs in the box, and explains
what to check before sharing it. The code is the game; the manifest keeps the
important facts attached to it.

The fields you will read are:

- **identity** — the brick's unique name and version;
- **owner** — the person or team responsible for it;
- **owned path** — the folder the brick is allowed to treat as its own;
- **public path** — the file other code is allowed to use; and
- **clone readiness** — how much guidance is needed before copying the brick.

## Try it

Run this block from the SMARCH folder. It regenerates the safe practice
portfolio—the folder containing three demo projects—then reads one manifest.
JSON is the text format used by this manifest; `JSON.parse` turns that text into
fields the short Node.js program can print.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
MANIFEST_PATH="$SMARCH_FIXTURE_PORTFOLIO/acme-desktop/src/modules/activity-feed/module.sweetspot.json"
export MANIFEST_PATH
cd "$SMARCH_DIR"

npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO"

node --input-type=module <<'NODE'
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync(process.env.MANIFEST_PATH, "utf8"));
console.log(`Identity: ${manifest.brick.id}`);
console.log(`Version: ${manifest.brick.version}`);
console.log(`Owner: ${manifest.owner.team}`);
console.log(`Owns: ${manifest.boundaries.owned_paths[0]}`);
console.log(`Public file: ${manifest.boundaries.public_paths[0]}`);
console.log(`Clone readiness: ${manifest.clone.readiness}`);
NODE
```

Expected output includes:

```text
"project_count": 3
"brick_count": 40
Identity: acme-desktop.activity-feed
Version: 1.0.0-fixture
Owner: SMA Evaluation
Owns: src/modules/activity-feed/**
Public file: src/modules/activity-feed/index.mjs
Clone readiness: guided
```

The `**` at the end of the owned path means “everything inside this folder.”
`guided` means the brick may be copied, but the person doing it should follow
the instructions stored with the manifest.

## What you just did

You used a tiny program to ask one manifest six practical questions. Without
reading the source code, you found the brick's identity, responsible team,
boundary, public entry file, and reuse guidance. That is why manifests are
useful: important promises become visible and checkable.

## Where to go next

Continue to [05: Gates, what blocks and why](05-gates-what-blocks-and-why.md).
You will use one of those checkable promises to see a safety stop happen on
purpose—and then watch the same check pass on a smaller brick.
