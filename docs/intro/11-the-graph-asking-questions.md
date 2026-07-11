# The [code graph](../GLOSSARY.md#gen3): asking questions

## Why this matters

A new codebase can feel like a library after someone shuffled every page.
A code graph gives you a map of the relationships, so you can ask a focused
question before opening a heroic number of files.

## The idea

A code graph is a map made from nodes and edges. A node is one named thing,
such as a function or file; an edge is a relationship between two things,
such as “this function calls that one.” Think of a subway map: stations are
nodes, tracks are edges, and your question chooses the useful part of the map.

[Graphify](../GLOSSARY.md#gen3) is the local tool SMARCH uses to build and ask
questions of that map. In this lesson it reads only the generated fixture
portfolio: no external AI service is needed, and the real project graph stays
untouched.

You do not need graph theory for this lesson. The refresh command builds the
map; the query command reads it. Your job is only to notice which source path
the answer recommends.

## Try it

Run this block from the SMARCH folder. It regenerates the fixture portfolio,
builds a local graph for the `acme-desktop` practice project, and asks where
the Activity Feed [brick](../GLOSSARY.md#brick) is implemented.
The query checks nearby relationships before distant ones; its output calls
that method breadth-first search, shortened to `BFS`.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
PRACTICE_PROJECT="$SMARCH_FIXTURE_PORTFOLIO/acme-desktop"
cd "$SMARCH_DIR"

npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO"

node tools/sma-graphify.ts refresh \
  --project-root "$PRACTICE_PROJECT" \
  --no-cluster \
  --timeout-seconds 120

node tools/sma-graphify.ts query \
  --project-root "$PRACTICE_PROJECT" \
  --budget 900 \
  -- "Where is Activity Feed implemented?"
```

Expected output includes:

```text
local code-only graph: ... nodes, ... edges
OK graphify ready for acme-desktop
Traversal: BFS depth=2
NODE activityFeedSummary() [src=src/modules/activity-feed/index.mjs ...]
NODE activityFeedRecord() [src=src/modules/activity-feed/index.mjs ...]
```

The query starts at its best matching nodes, then checks their nearest
relationships before wandering farther away. The important beginner clue is
`src=...`; it points to the source file worth opening next.

> **Stuck? This is normal.** Building the graph can take longer than the other
> lessons. If it reaches the 120-second timeout, run the full block once more.
> The fixture project is small, and a second refresh can reuse local setup.

## What you just did

You turned a practice project into a relationship map and used a plain-language
question to find two Activity Feed functions. The graph narrowed the search;
the source file remains the truth you would inspect before changing code.

## Check your understanding

1. The graph names an Activity Feed file. Is that enough evidence to edit it
   immediately?

   <details><summary>Answer</summary>

   No. The graph narrows the search; the source file remains the truth to read
   before making a change.

   </details>

2. Why does the query check nearby relationships before distant ones?

   <details><summary>Answer</summary>

   Nearby nodes are more likely to explain the best text matches. Breadth-first
   search explores those close relationships before wandering farther away.

   </details>

3. What is the most useful beginner clue in a graph result, and what do you do
   with it?

   <details><summary>Answer</summary>

   The `src=...` path. Open that source file next and confirm what the graph
   suggested.

   </details>

## Where to go next

[← Previous: 10, Your first capsule](10-your-first-capsule.md) ·
[Lesson path](START_HERE.md#the-lesson-path) ·
[Next: 12, Agents and skills setup →](12-agents-and-skills-setup.md)
