# Reading the [brick wall](../GLOSSARY.md#registry)

## Why this matters

A [registry](../GLOSSARY.md#registry) can hold the facts you need while still
feeling like a wall of text. The brick wall turns those records into a page you
can search and filter. You can see which pieces belong to each project and how
ready each one is for reuse without reading a large data file.

*Made with love for creators of all kind.*

## The idea

The brick wall is a visual view of a registry. Each card represents one
[brick](../GLOSSARY.md#brick), and each project gets its own shelf. A status is
the brick's current reuse stage: [canonical](../GLOSSARY.md#canonical) marks a
preferred choice, `candidate` marks a brick under assessment, and
`project_bound` marks a brick that still belongs to its current project.

Think of the wall as a parts board above a maker's bench. You can count the
parts, group them by kit, and read each label before choosing one to pick up.

## Try it

Run this block from the SMARCH folder. It builds a fresh registry from the
practice projects, creates a self-contained web page, and prints the project
groups you should see on that page.

> **Stuck? This is normal.** The command creates an HTML file; it does not open
> a browser for you. Copy the path printed after `Open this file in your
> browser:` into your browser's address bar. If the page is blank, rerun the
> whole block and use the newly printed path.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
SMARCH_LESSON_TMP="${SMARCH_LESSON_TMP:-$(mktemp -d)}"
SMARCH_FIXTURE_REGISTRY="$SMARCH_LESSON_TMP/lesson-03.registry.json"
SMARCH_BRICK_WALL="$SMARCH_LESSON_TMP/brick-wall.html"
export SMARCH_FIXTURE_REGISTRY SMARCH_BRICK_WALL
cd "$SMARCH_DIR"

npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO"
node tools/sma-scan.mjs \
  --root "$SMARCH_FIXTURE_PORTFOLIO" \
  --out "$SMARCH_FIXTURE_REGISTRY"
node tools/sma-brick-wall-lego.mjs \
  --registry "$SMARCH_FIXTURE_REGISTRY" \
  --out "$SMARCH_BRICK_WALL"

node --input-type=module <<'NODE'
import fs from "node:fs";

const registry = JSON.parse(fs.readFileSync(process.env.SMARCH_FIXTURE_REGISTRY, "utf8"));
const projectCounts = new Map();
const statusCounts = new Map();

for (const brick of registry.bricks) {
  projectCounts.set(brick.project, (projectCounts.get(brick.project) || 0) + 1);
  statusCounts.set(brick.status, (statusCounts.get(brick.status) || 0) + 1);
}

console.log("Projects on the wall:");
for (const [project, count] of [...projectCounts].sort()) {
  console.log(`- ${project}: ${count}`);
}
console.log("Statuses on the wall:");
for (const [status, count] of [...statusCounts].sort()) {
  console.log(`- ${status}: ${count}`);
}
console.log(`Open this file in your browser: ${process.env.SMARCH_BRICK_WALL}`);
NODE
```

Expected output includes:

```text
"bricks": 40
"canonical": 0
"candidate": 0
Projects on the wall:
- acme-cms: 13
- acme-desktop: 14
- acme-studio: 13
Statuses on the wall:
- project_bound: 40
Open this file in your browser: .../brick-wall.html
```

The zero counts tell you that the practice bricks have not reached candidate or
canonical status. The project counts add up to 40, which matches the scan.
Open the printed file path in a browser to search the cards and switch between
project shelves.

## What you just did

You converted the registry into one web page, checked the total against the
scan, and grouped the cards by project and status. The wall gave you a quick
map while the registry kept the full machine-readable facts underneath it.

## Check your understanding

1. The wall shows 40 `project_bound` bricks and zero canonical bricks. Does
   that mean the wall failed?

<details>
<summary>Show answer</summary>

No. Those counts describe the practice data: all 40 bricks still belong to
their projects and none has been promoted as a preferred choice.

</details>

2. When would you use the wall instead of reading the registry file directly?

<details>
<summary>Show answer</summary>

Use the wall when you want to search, filter, or compare cards and project
shelves visually. The registry remains the fuller machine-readable record.

</details>

3. How can you quickly check that no project shelf is missing bricks?

<details>
<summary>Show answer</summary>

Add the three project counts. They total 40, matching the number reported by
the scan.

</details>

## Where to go next

- **Previous:** [02: Your first scan](02-your-first-scan.md)
- **Next:** [04: Manifests explained](04-manifests-explained.md)

Next, you will read more of the contract behind one brick card.
