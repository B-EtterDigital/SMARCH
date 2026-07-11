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

You do not need to know how to write JavaScript or JSON for this exercise. The
commands create a copy inside the generated practice portfolio, and the short
script only reads back the template's name, entry file, and saved example.

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

> **Stuck? This is normal.** If `cp` says it cannot find the template, you are
> probably not in the SMARCH folder. Run `pwd`; then `cd` to the folder that
> contains `package.json` and try the whole block again. Re-running it is safe.

## What you just did

You made a runnable capsule inside a generated practice project, inspected its
contract, and proved its first example. More importantly, you now have a small
place where an idea and its proof can grow together without surprise luggage.

## Check your understanding

1. The capsule runs, but its returned message differs from the fixture. What
   should you trust first: the `PASS` label or the mismatch?

   <details><summary>Answer</summary>

   Trust the mismatch. The fixture records the expected output, so the runner
   should not report `PASS` until the entry file and fixture agree.

   </details>

2. Why is the manifest more useful than a folder name alone?

   <details><summary>Answer</summary>

   It states the capsule's identity and boundaries in a form the runner can
   check before executing the fixture.

   </details>

3. You want to try a risky network call. Does it belong in this tiny practice
   capsule unchanged?

   <details><summary>Answer</summary>

   No. This capsule deliberately has no network boundary. Keep the experiment
   inside its declared boundaries or make a separately reviewed capsule whose
   manifest honestly declares the new capability.

   </details>

## Where to go next

[← Previous: 09, Conflicts are normal](09-conflicts-are-normal.md) ·
[Lesson path](START_HERE.md#the-lesson-path) ·
[Next: 11, The graph, asking questions →](11-the-graph-asking-questions.md)
