# Your first [scan](../GLOSSARY.md#registry)

## Why this matters

You can inspect one brick by opening one manifest, but a group of projects can
hold hundreds of them. A scan finds those records for you and counts problems
that deserve a closer look. You can learn what exists before choosing where to
work.

*Made with love for creators of all kind.*

## The idea

A scan searches for [manifests](../GLOSSARY.md#manifest) without changing them.
The scanner collects what it finds in a
[registry](../GLOSSARY.md#registry), a searchable inventory of
[bricks](../GLOSSARY.md#brick) and their evidence. A warning is a note worth
checking; it does not stop this practice
scan from finishing.

Picture a librarian walking through three small rooms. The librarian reads
each book label, writes one catalog entry per book, and notes any damaged
covers. The scan does the same kind of inventory work for code.

## Try it

Run this block from the SMARCH folder. It regenerates the practice projects,
scans their manifests, and writes the registry to a temporary folder so your
working files stay tidy.

> **Stuck? This is normal.** A warning count is not the same as a failed scan.
> In this practice portfolio, `Warnings: 3` is the expected result. If the
> command itself stops, return to the SMARCH folder and rerun the full block so
> the fixtures are rebuilt first.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
SMARCH_LESSON_TMP="${SMARCH_LESSON_TMP:-$(mktemp -d)}"
SMARCH_FIXTURE_REGISTRY="$SMARCH_LESSON_TMP/lesson-02.registry.json"
export SMARCH_FIXTURE_REGISTRY
cd "$SMARCH_DIR"

npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO"
node tools/sma-scan.ts \
  --root "$SMARCH_FIXTURE_PORTFOLIO" \
  --out "$SMARCH_FIXTURE_REGISTRY"

node --input-type=module <<'NODE'
import fs from "node:fs";

const registry = JSON.parse(fs.readFileSync(process.env.SMARCH_FIXTURE_REGISTRY, "utf8"));
const projects = new Set(registry.bricks.map((brick) => brick.project));
console.log(`Projects: ${projects.size}`);
console.log(`Bricks: ${registry.bricks.length}`);
console.log(`Warnings: ${registry.validation_warning_count}`);
NODE
```

Expected output includes:

```text
SMA scan complete: 40 manifest brick(s), ... 3 warning(s) ...
Wrote .../lesson-02.registry.json
Projects: 3
Bricks: 40
Warnings: 3
```

The practice projects include three planted warnings. They give later lessons
something real to investigate, so their presence means the exercise worked.

## What you just did

You asked the scanner to search three practice projects. It found 40 brick
manifests, kept their details in one registry file, and reported three warnings
without changing the project code.

## Check your understanding

1. The scan finishes with three warnings. Should you throw away the registry?

<details>
<summary>Show answer</summary>

No. The registry is still useful. A warning asks for closer inspection; it
does not mean this practice scan failed.

</details>

2. Why scan instead of opening every manifest one by one?

<details>
<summary>Show answer</summary>

A scan finds the manifests across several projects and gathers their facts in
one searchable registry, so you can see the whole inventory before choosing
where to work.

</details>

3. What evidence tells you the scan did not edit the practice bricks?

<details>
<summary>Show answer</summary>

The scanner reads manifests and writes a separate registry file. Its job is
inventory, not source editing.

</details>

## Where to go next

- **Previous:** [01: What is a brick?](01-what-is-a-brick.md)
- **Next:** [03: Reading the brick wall](03-reading-the-brick-wall.md)

Next, you will turn the registry into a visual catalog and learn what its
first numbers mean.
