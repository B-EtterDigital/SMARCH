# Contributing your first [brick](../GLOSSARY.md#brick)

## Why this matters

Useful code becomes much easier to share when its purpose and boundaries travel
with it. Make your first contribution small, honest, and easy for the next
creator to understand.

*Made with love for creators of all kind.*

## The idea

A brick is a focused piece of code with one clear job. Its
[manifest](../GLOSSARY.md#manifest) is the machine-readable note that names the
brick, lists the files it owns, and records which checks still need proof.

Think of contributing a brick like adding a new cartridge to a workshop robot
workshop. The code is the cartridge. The manifest is its label: what it does,
where it fits, and whether somebody has tested it yet. A label that says “not
tested yet” is useful; a shiny label that guesses is not.

The [scanner](../GLOSSARY.md#registry) calls a code folder without a manifest an
“unmanifested [candidate](../GLOSSARY.md#brick).” Here, *candidate* means “this
looks like it could become a brick.” The bootstrap tool creates a starter
manifest with the safe [`project_bound`](../GLOSSARY.md#manifest) status,
meaning the new brick still belongs to this practice project. Later evidence
must support promotion to [canonical](../GLOSSARY.md#canonical), the preferred
choice for reuse.

## Try it

Run this block from the SMARCH folder. It regenerates
`tools/evals/fixtures/portfolio`, copies the `acme-desktop` fixture into a
temporary practice folder, and adds a tiny `hello-creator` module there. Your
checked-in fixture files stay unchanged.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
SMARCH_LESSON_TMP="${SMARCH_LESSON_TMP:-$(mktemp -d)}"
PRACTICE_PROJECT="$SMARCH_LESSON_TMP/lesson-13-project"
BEFORE_REGISTRY="$SMARCH_LESSON_TMP/lesson-13-before.registry.json"
AFTER_REGISTRY="$SMARCH_LESSON_TMP/lesson-13-after.registry.json"
export PRACTICE_PROJECT AFTER_REGISTRY
cd "$SMARCH_DIR"

npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO"
rm -rf "$PRACTICE_PROJECT"
cp -R "$SMARCH_FIXTURE_PORTFOLIO/acme-desktop" "$PRACTICE_PROJECT"

node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const moduleDir = path.join(process.env.PRACTICE_PROJECT, "src/modules/hello-creator");
fs.mkdirSync(moduleDir, { recursive: true });
fs.writeFileSync(
  path.join(moduleDir, "index.mjs"),
  'export function helloCreator(name) { return "Hello, " + name + "!"; }\n',
);
NODE

node tools/sma-scan.mjs \
  --root "$PRACTICE_PROJECT" \
  --project-id acme-desktop \
  --out "$BEFORE_REGISTRY"

node tools/sma-bootstrap-manifests.mjs \
  --registry "$BEFORE_REGISTRY" \
  --root "$PRACTICE_PROJECT" \
  --owner "Lesson Creator" \
  --team "Learning Lab" \
  --write

node tools/sma-scan.mjs \
  --root "$PRACTICE_PROJECT" \
  --project-id acme-desktop \
  --out "$AFTER_REGISTRY"

node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const registry = JSON.parse(fs.readFileSync(process.env.AFTER_REGISTRY, "utf8"));
const brick = registry.bricks.find((entry) =>
  entry.source_paths.includes("src/modules/hello-creator")
);
const manifestPath = path.join(
  process.env.PRACTICE_PROJECT,
  "src/modules/hello-creator/module.sweetspot.json",
);

console.log("Manifest created: " + (fs.existsSync(manifestPath) ? "yes" : "no"));
console.log("Registered brick: " + brick.id);
console.log("Status: " + brick.status);
console.log("Health: " + brick.health.status);
NODE
```

Expected output includes:

```text
"project_count": 3
"brick_count": 40
SMA scan complete: 14 manifest brick(s), 1 unmanifested candidate(s) ...
"candidates": 1
"written": 1
SMA scan complete: 15 manifest brick(s), 0 unmanifested candidate(s) ...
Manifest created: yes
Registered brick: acme-desktop.frontend-module.src-modules-hello-creator.b6c71aca
Status: project_bound
Health: warn
```

`Health: warn` is a helpful result. The starter manifest records that source
history and test evidence still need attention. Your brand-new cartridge has
not flown to Mars yet.

## What you just did

You wrote one tiny module, let the scanner discover it, generated its starter
manifest, and scanned again to prove the new brick entered the
[registry](../GLOSSARY.md#registry). The brick now has a stable identity and an
honest starting status, while the remaining proof is still visible.

## Where to go next

Continue to [14: Canonical, the registry story](14-canonical-the-registry-story.md).
You will see why the registry keeps new bricks project-bound and how it decides
what deserves to become a preferred reusable choice.
