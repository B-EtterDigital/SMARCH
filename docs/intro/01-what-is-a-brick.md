# What is a [brick](../GLOSSARY.md#brick)?

## Why this matters

Large projects can feel like one giant machine with no safe place to begin.
[SMARCH](../GLOSSARY.md) gives each useful piece a name, a job, and a list of
files that belong to it. You get a clear starting point instead of a treasure
hunt through folders.

*Made with love for creators of all kind.*

## The idea

A brick is a small, bounded piece of code with one clear job. A brick also
carries a [manifest](../GLOSSARY.md#manifest), which is a
plain-text record of its name, location, public files, checks, and reuse rules.

Think of a brick as a labeled drawer in a workshop. The code is the tool inside
the drawer. The manifest is the label that tells you what the tool does, where
it belongs, and what to check before lending it to a friend.

## Try it

Run this block from the SMARCH folder, the one that contains `package.json`.
The first command regenerates three safe practice projects under
`tools/evals/fixtures/portfolio`. The second command reads one manifest and
prints a few useful fields.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
cd "$SMARCH_DIR"

npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO"

MANIFEST_PATH="$SMARCH_FIXTURE_PORTFOLIO/acme-desktop/src/modules/activity-feed/module.sweetspot.json"
export MANIFEST_PATH
node --input-type=module <<'NODE'
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync(process.env.MANIFEST_PATH, "utf8"));
console.log(`Brick: ${manifest.brick.id}`);
console.log(`Name: ${manifest.brick.name}`);
console.log(`Kind: ${manifest.brick.kind}`);
console.log(`Status: ${manifest.brick.status}`);
console.log(`Public file: ${manifest.boundaries.public_paths[0]}`);
NODE
```

Expected output includes:

```text
"project_count": 3
"brick_count": 40
Brick: acme-desktop.activity-feed
Name: Activity Feed
Kind: module
Status: project_bound
Public file: src/modules/activity-feed/index.mjs
```

`Kind: module` says this brick is a bounded part of a project.
`Status: project_bound` says the brick belongs to its current project and has
not been promoted as a preferred reusable choice.

## What you just did

You rebuilt the practice projects, opened the Activity Feed brick's manifest,
and read its identity and public boundary. You did not need to inspect its
source code to learn its job or find the file other code may use.

## Where to go next

Continue to [02: Your first scan](02-your-first-scan.md). You will ask SMARCH to
find all 40 manifests and collect them into one searchable inventory.
