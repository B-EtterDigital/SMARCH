# Glossary safari

## Why this matters

New tools are much friendlier when their strange little words stop being
strange. This safari teaches you how to follow SMARCH's vocabulary through a
real practice result, one clue at a time, without memorizing the whole manual.

*Made with love for creators of all kind.*

## The idea

The [glossary](../GLOSSARY.md) is a page of short definitions. You can use it
like a field guide: spot an unfamiliar word in a command result, look it up,
then return with enough context to keep exploring.

Our route has four stops. A [registry](../GLOSSARY.md#registry) is a searchable
inventory of reusable code. Each reusable unit is a
[brick](../GLOSSARY.md#brick). A brick's
[manifest](../GLOSSARY.md#manifest) is the structured file that explains its
identity and rules. A [gate](../GLOSSARY.md#gate) is a command that proves a
required check passes.

Think of a nature guide finding an animal in a park index, turning to its field
card, and checking the note about how to observe it safely. Registry, brick,
manifest, and gate are the software version of those four clues.

You will explore the **fixture portfolio**, a small collection of safe practice
projects at `tools/evals/fixtures/portfolio`. A generated registry file is
written only to the lesson's temporary folder.

You do not need to memorize the four terms before running the exercise. Keep
this page open, follow one printed line at a time, and use each link as your
field guide when a word feels slippery.

## Try it

Run this block from the SMARCH folder. The first command rebuilds the practice
projects. The second scans them and writes a registry in a temporary folder.
The final command reads that file and prints one short safari trail. JSON is a
plain-text format for structured information; the script handles it for you.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
SMARCH_LESSON_TMP="${SMARCH_LESSON_TMP:-$(mktemp -d)}"
SAFARI_REGISTRY="$SMARCH_LESSON_TMP/glossary-safari-registry.json"
export SAFARI_REGISTRY
cd "$SMARCH_DIR"

npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO" >/dev/null
node tools/sma-scan.ts \
  --root "$SMARCH_FIXTURE_PORTFOLIO" \
  --out "$SAFARI_REGISTRY" \
  --json >/dev/null

node --input-type=module <<'NODE'
import fs from "node:fs";

const registry = JSON.parse(fs.readFileSync(process.env.SAFARI_REGISTRY, "utf8"));
const brick = registry.bricks.find((item) => item.id === "acme-desktop.activity-feed");

if (!brick) throw new Error("The Activity Feed practice brick was not found.");

console.log(`Registry projects: ${registry.projects.length}`);
console.log(`Registry bricks: ${registry.count}`);
console.log(`Brick: ${brick.id}`);
console.log(`Manifest: ${brick.manifest_path.endsWith("module.sweetspot.json") ? "found" : "missing"}`);
console.log(`Gate command: ${brick.test_commands[0]}`);
NODE
```

Expected output:

```text
Registry projects: 3
Registry bricks: 40
Brick: acme-desktop.activity-feed
Manifest: found
Gate command: node --check src/modules/*/index.mjs
```

> **Stuck? This is normal.** The two setup commands hide their usual progress
> output, so the terminal may be quiet for a moment. Wait for the five safari
> lines. If none appear, re-run the whole block so the temporary registry is
> created before the final script reads it.

## What you just did

You scanned three practice projects into one registry, selected the Activity
Feed brick, found its manifest, and read its first gate command. More
importantly, you followed four unfamiliar words as a connected trail instead
of treating them as a vocabulary test.

When another SMARCH result mentions a [lease](../GLOSSARY.md#lease), a
[provenance seal](../GLOSSARY.md#provenance-seal), or a
[conflict report](../GLOSSARY.md#conflict-report), use the same move: open the
glossary, read one definition, then return to the task. Tiny loops beat heroic
memorization.

## Check your understanding

1. A scan result contains an unfamiliar word. What is the safari move?

   <details><summary>Answer</summary>

   Look up that one word in the glossary, return to the result, and continue
   with the extra context. You do not need to memorize the whole glossary.

   </details>

2. How do the registry, brick, and manifest relate in this exercise?

   <details><summary>Answer</summary>

   The registry inventories bricks, and each brick's manifest describes its
   identity and rules.

   </details>

3. Why is the printed gate command more useful than merely seeing that the
   manifest exists?

   <details><summary>Answer</summary>

   The manifest identifies the brick, while the gate command tells you how a
   required check can actually be proved.

   </details>

## Where to go next

[← Previous: 15, MCP, connect your agent](15-mcp-connect-your-agent.md) ·
[Lesson path](START_HERE.md#the-lesson-path) ·
[Next: 17, Reading the plan with `uvp` →](17-reading-the-plan-uvp.md)
