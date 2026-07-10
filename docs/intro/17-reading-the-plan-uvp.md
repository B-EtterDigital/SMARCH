# Reading the plan with `uvp`

## Why this matters

A large project plan can look like a wall of chores until you know which clues
to read first. SMARCH keeps its long plan machine-readable—organized so a
program can read it—so creators and coding agents, programs that help change
code, can agree on what is ready, what is waiting, and what counts as proof.

*Made with love for creators of all kind.*

## The idea

[SUP](../GLOSSARY.md#sup), short for Sweetspot Ultra Plan, stores a detailed
plan in the `.UltraVision` folder. A **task** is one small unit of planned work.
Its **status** says where the work is now, its **dependencies** name tasks that
must finish first, and its [gates](../GLOSSARY.md#gate) name the commands that
must pass before the work is accepted.

Think of the plan as a nerdy railway board. Each task is a train, dependencies
are the tracks it needs to arrive, status is the light beside it, and gates are
the final ticket checks. You do not need to read every train on the board; you
need the next useful row.

The `uvp` helper reads that plan and can show ready tasks. It lives at
`~/.claude/skills/f5-ultravisionplan/scripts/uvp.py` when the SUP skill—a
folder of reusable workflow instructions—is installed. Reading is safe;
commands such as `claim`, `complete`, and `verify` change plan state and belong
to an active agent workflow, not this lesson.

## Try it

Run this block from the SMARCH folder. It rebuilds the **fixture portfolio**, a
small collection of safe practice projects at
`tools/evals/fixtures/portfolio`, copies the **committed snapshot**—the version
saved in Git—of `.UltraVision` into a temporary folder, and reads lesson 17's
task. It also tries the read-only `uvp next` command when the optional helper is
installed. Nothing in the real plan is changed.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
SMARCH_LESSON_TMP="${SMARCH_LESSON_TMP:-$(mktemp -d)}"
PLAN_COPY="$SMARCH_LESSON_TMP/committed-plan"
UVP="$HOME/.claude/skills/f5-ultravisionplan/scripts/uvp.py"
export PLAN_COPY SMARCH_FIXTURE_PORTFOLIO
cd "$SMARCH_DIR"

npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO" >/dev/null
mkdir -p "$PLAN_COPY"
git archive HEAD .UltraVision | tar -x -C "$PLAN_COPY"

node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const planFile = path.join(process.env.PLAN_COPY, ".UltraVision/tasks/docs.jsonl");
const tasks = fs.readFileSync(planFile, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const task = tasks.find((item) => item.id === "UV-DO-lesson-17-reading-the-plan-uvp-draft");
const fixtureReady = fs.existsSync(path.join(
  process.env.SMARCH_FIXTURE_PORTFOLIO,
  "acme-desktop/.smarch/project.json"
));

if (!task) throw new Error("Lesson 17 is missing from the committed plan.");

console.log(`Practice portfolio ready: ${fixtureReady ? "yes" : "no"}`);
console.log(`Task: ${task.title}`);
console.log(`Status: ${task.status}`);
console.log(`Dependencies: ${task.depends_on.length}`);
console.log(`Gate: ${task.gates[0]}`);
NODE

if [ -f "$UVP" ]; then
  python3 "$UVP" --root "$PLAN_COPY/.UltraVision" next \
    --module docs --limit 1 >/dev/null
  echo "Optional uvp read: completed"
else
  echo "Optional uvp read: skipped (SUP skill is not installed)"
fi
```

Expected output includes:

```text
Practice portfolio ready: yes
Task: Write lesson: reading the plan uvp
Status: ...
Dependencies: 0
Gate: npm run source:size:gate
```

The status value changes as agents work: you may see `todo`, `claimed`, `done`,
or `verified`. That movement is the plan doing its job, not broken output.

The last line is either `Optional uvp read: completed` or a friendly `skipped`
message. Skipping is normal for readers without the SUP skill. If you only want
to see the command shape, the read-only form is:

```text
python3 ~/.claude/skills/f5-ultravisionplan/scripts/uvp.py --root .UltraVision next --module docs --limit 1
```

## What you just did

You found one task in the committed plan and read its title, status,
dependencies, and required gate. The zero dependencies explain that this draft
does not need another task to finish first. The status tells whether it is
waiting, being worked on, completed, or independently checked.

You also learned the important boundary: `uvp next` reads what is ready, while
state-changing commands belong to the agent that has permission and a safe
coordination claim.

## Where to go next

Continue with lesson 18, Your first agent swarm. You will watch two practice
agents ask for the same tiny job and let the coordination tools settle the
race without drama.
