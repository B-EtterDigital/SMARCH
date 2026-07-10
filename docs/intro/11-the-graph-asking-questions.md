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

node tools/sma-graphify.mjs refresh \
  --project-root "$PRACTICE_PROJECT" \
  --no-cluster \
  --timeout-seconds 120

node tools/sma-graphify.mjs query \
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

## What you just did

You turned a practice project into a relationship map and used a plain-language
question to find two Activity Feed functions. The graph narrowed the search;
the source file remains the truth you would inspect before changing code.

## Where to go next

Return to the [lesson path](START_HERE.md#the-lesson-path) and continue with
lesson 12, Agents and skills setup. You will give a coding agent the local
instructions and reusable workflows it needs to follow the same map and rules.
