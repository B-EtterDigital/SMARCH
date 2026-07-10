# Your first [capsule](../GLOSSARY.md#capsule)

## Why this matters

Small experiments are easier to trust when their code, rules, and examples
travel together. A capsule gives you that tiny, runnable package, so another
creator can understand the idea without first exploring an entire project.

## The idea

A capsule is a very small [brick](../GLOSSARY.md#brick) with one entry file and
at least one fixture. The entry file is the code file the runner starts; a
fixture is a saved example that supplies an input and records the output that
should come back. Think of the capsule as a lunchbox, the entry file as the
sandwich, and the fixture as the note that says what you packed. If the note
and the lunch disagree, the runner tells you.

The capsule also carries a [manifest](../GLOSSARY.md#manifest), written in JSON,
a plain-text format for structured data. It states the capsule's identity and
boundaries. The runner checks those constraints before it runs the fixture,
which makes the example useful as an executable [gate](../GLOSSARY.md#gate),
not just a hopeful code sample.

## Try it

Run this block from the SMARCH folder. It regenerates the safe fixture
portfolio, copies the shipped capsule template into the `acme-desktop`
practice project, runs its fixture, and then prints the important pieces.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
CAPSULE_PATH="$SMARCH_FIXTURE_PORTFOLIO/acme-desktop/src/modules/hello-capsule"
export CAPSULE_PATH
cd "$SMARCH_DIR"

npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO"
mkdir -p "$CAPSULE_PATH"
cp -R "$SMARCH_DIR/templates/capsule/." "$CAPSULE_PATH/"

node tools/sma-brick-run.mjs "$CAPSULE_PATH"

node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const root = process.env.CAPSULE_PATH;
const manifest = JSON.parse(fs.readFileSync(path.join(root, "module.sweetspot.json"), "utf8"));
const fixtureFile = JSON.parse(fs.readFileSync(path.join(root, "fixtures", "run.json"), "utf8"));
const fixture = fixtureFile.fixtures[0];

console.log(`Capsule: ${manifest.brick.id}`);
console.log(`Entry: ${manifest.boundaries.public_paths[0]}`);
console.log(`Fixture: ${fixture.name}`);
console.log(`Expected message: ${fixture.expected_outputs.message}`);
NODE
```

Expected output includes:

```text
"project_count": 3
"brick_count": 40
{"fixture":"identity","status":"PASS"}
Capsule: example.capsule
Entry: src/index.ts
Fixture: identity
Expected message: capsule ready
```

`PASS` means the entry file returned exactly the output recorded by the
fixture. The practice capsule does not use the network, write files, or import
extra packages, so its boundary stays pleasantly tiny.

## What you just did

You made a runnable capsule inside a generated practice project, inspected its
contract, and proved its first example. More importantly, you now have a small
place where an idea and its proof can grow together without surprise luggage.

## Where to go next

Return to the [lesson path](START_HERE.md#the-lesson-path) and continue with
lesson 11, The graph, asking questions. You will let SMARCH map code
relationships and answer a question without reading every file by hand.
