# [Canonical](../GLOSSARY.md#canonical): the registry story

## Why this matters

A green check beside one file cannot make it the best choice for each project.
SMARCH keeps readiness claims in one visible place so a creator or an agent can
tell the difference between “exists” and “preferred.”

*Made with love for creators of all kind.*

## The idea

The [registry](../GLOSSARY.md#registry) is a searchable inventory of
[bricks](../GLOSSARY.md#brick) and their current evidence. A
[`project_bound`](../GLOSSARY.md#manifest) brick belongs to the project where
the scanner found it. A [candidate](../GLOSSARY.md#brick) is a brick under
review for wider reuse. A canonical brick is the preferred reusable choice
because repeated checks and use support that status.

Picture a community seed library. A new seed packet can enter the catalog
on day one. Growers record healthy harvests in different gardens before they
choose the library's preferred variety. The catalog keeps those records beside
the seed packet.

SMARCH tells that story with [manifests](../GLOSSARY.md#manifest), executable
[gates](../GLOSSARY.md#gate), and a
[canonicalization report](../GLOSSARY.md#canonical). *Canonicalization* means
the evidence-led process of choosing a preferred brick. The report says
whether the portfolio is ready for that work and names the evidence still
missing. Only a separate promotion step can change a brick's status.

## Try it

Run this block from the SMARCH folder. It rebuilds and scans
`tools/evals/fixtures/portfolio`, then asks the real canonicalization helper to
summarize the practice registry. Everything it writes lives in the lesson's
temporary folder.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
SMARCH_LESSON_TMP="${SMARCH_LESSON_TMP:-$(mktemp -d)}"
SMARCH_FIXTURE_REGISTRY="$SMARCH_LESSON_TMP/lesson-14.registry.json"
export SMARCH_FIXTURE_REGISTRY
cd "$SMARCH_DIR"

npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO"
node tools/sma-scan.mjs \
  --root "$SMARCH_FIXTURE_PORTFOLIO" \
  --out "$SMARCH_FIXTURE_REGISTRY"

node --input-type=module <<'NODE'
import fs from "node:fs";
import { buildCanonicalizationReport } from "./tools/sma-canonicalization.mjs";

const registry = JSON.parse(
  fs.readFileSync(process.env.SMARCH_FIXTURE_REGISTRY, "utf8"),
);
const report = buildCanonicalizationReport(registry);
const counts = registry.bricks.reduce((all, brick) => {
  all[brick.status] = (all[brick.status] || 0) + 1;
  return all;
}, {});

console.log("Registry bricks: " + registry.bricks.length);
console.log("Project-bound: " + (counts.project_bound || 0));
console.log("Candidate: " + (counts.candidate || 0));
console.log("Canonical: " + (counts.canonical || 0));
console.log(
  "Portfolio ready to canonicalize: " +
    (report.project_canonicalization_ready ? "yes" : "no"),
);
console.log("Next bottleneck: " + report.bottleneck_mode);
console.log(
  "Reasons: " + report.reasons.map((reason) => reason.code).join(", "),
);
NODE
```

Expected output includes:

```text
"project_count": 3
"brick_count": 40
SMA scan complete: 40 manifest brick(s) ...
Registry bricks: 40
Project-bound: 40
Candidate: 0
Canonical: 0
Portfolio ready to canonicalize: no
Next bottleneck: balanced
Reasons: not_enough_recurrent_build_families
```

`balanced` means no single category of cleanup or promotion work dominates the
whole practice portfolio. `not_enough_recurrent_build_families` means the
scanner has not seen enough families of related builds to recommend a broad
canonicalization push. The long label is nerdy on purpose: a tool or agent can
act on it without guessing what “not ready” meant.

## What you just did

You built a registry from three fixture projects, counted each readiness
status, and asked for the next canonicalization decision. The report answered
“not yet” and named a specific reason. The helper left all 40 bricks
project-bound because the fixture evidence did not support promotion.

## Where to go next

Continue to [15: MCP, connect your agent](15-mcp-connect-your-agent.md). You
will give an agent a safe doorway into this same registry so it can search the
evidence instead of scraping files by hand.
