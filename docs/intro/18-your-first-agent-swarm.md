# Your first agent swarm

## Why this matters

Several coding agents—programs that help change code—can finish separate jobs
quickly, but shared work needs traffic signals. This lesson makes the collision
visible on purpose, so the safe behavior feels ordinary before it happens in a
real project.

*Made with love for creators of all kind.*

## The idea

A **swarm** is a group of coding agents working toward the same larger goal.
[Gen3](../GLOSSARY.md#gen3) is the coordination layer in Sweetspot Modular
Architecture, shortened to SMA. Before an agent edits a shared
[brick](../GLOSSARY.md#brick), it asks for a [lease](../GLOSSARY.md#lease), a
time-limited exclusive claim. If another agent already has the lease, the
second agent stops and a [conflict report](../GLOSSARY.md#conflict-report)
records the overlap.

Think of two cheerful robots reaching for one soldering iron. One gets the
iron; the other sees the “in use” light, writes down what it needed, and works
on something else. The wait is not wasted motion. It is how the robots avoid
turning one clean circuit into two half-finished circuits.

`SMA_AGENT` is a label that identifies a worker to the real lease command. You
will give two practice workers different labels and let them race for Activity
Feed inside the fixture portfolio at `tools/evals/fixtures/portfolio`. The
coordination files live in a temporary sandbox, so no real project lease is
created.

The block uses ordinary shell job control: `&` starts each practice agent in
the background, and `wait` collects its result. You do not need to predict
which color wins. The lesson checks only that exactly one does.

## Try it

Run this block from the SMARCH folder. Two background commands start close
together; “background” means the terminal's command-running program lets both
commands run without waiting for the first one to finish. Exactly one should
receive the lease. The other should return a non-zero result, which means the
command correctly stopped. The `--json` option saves structured records for
the later lines to read. The winner then releases the practice lease.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
SMARCH_LESSON_TMP="${SMARCH_LESSON_TMP:-$(mktemp -d)}"
SMARCH_LESSON_SANDBOX="$SMARCH_LESSON_TMP/smarch-sandbox"
PRACTICE_FILE="$SMARCH_FIXTURE_PORTFOLIO/acme-desktop/src/modules/activity-feed/index.mjs"
cd "$SMARCH_DIR"

npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO" >/dev/null
mkdir -p "$SMARCH_LESSON_SANDBOX"
cp -R "$SMARCH_DIR/tools" "$SMARCH_LESSON_SANDBOX/tools"

(
  SMA_AGENT="swarm-blue" SMA_SESSION_ID="lesson-18-blue" \
    node "$SMARCH_LESSON_SANDBOX/tools/sma-start-edit.ts" \
      --project sma \
      --brick acme-desktop.activity-feed \
      --intent "blue agent tries the fixture brick" \
      --file "$PRACTICE_FILE" \
      --no-dirty-baseline \
      --json > "$SMARCH_LESSON_SANDBOX/blue.json" \
      2> "$SMARCH_LESSON_SANDBOX/blue.err"
) &
BLUE_PID=$!

(
  SMA_AGENT="swarm-gold" SMA_SESSION_ID="lesson-18-gold" \
    node "$SMARCH_LESSON_SANDBOX/tools/sma-start-edit.ts" \
      --project sma \
      --brick acme-desktop.activity-feed \
      --intent "gold agent tries the fixture brick" \
      --file "$PRACTICE_FILE" \
      --no-dirty-baseline \
      --json > "$SMARCH_LESSON_SANDBOX/gold.json" \
      2> "$SMARCH_LESSON_SANDBOX/gold.err"
) &
GOLD_PID=$!

set +e
wait "$BLUE_PID"
BLUE_STATUS=$?
wait "$GOLD_PID"
GOLD_STATUS=$?
set -e

if [ "$BLUE_STATUS" -eq 0 ] && [ "$GOLD_STATUS" -ne 0 ]; then
  WINNER="swarm-blue"
  WINNER_SESSION="lesson-18-blue"
  WINNER_RECORD="$SMARCH_LESSON_SANDBOX/blue.json"
elif [ "$GOLD_STATUS" -eq 0 ] && [ "$BLUE_STATUS" -ne 0 ]; then
  WINNER="swarm-gold"
  WINNER_SESSION="lesson-18-gold"
  WINNER_RECORD="$SMARCH_LESSON_SANDBOX/gold.json"
else
  echo "Unexpected race result: blue=$BLUE_STATUS gold=$GOLD_STATUS"
  exit 1
fi

LEASE_ID="$(node -e 'const x=require(process.argv[1]); process.stdout.write(x.lease.lease_id)' "$WINNER_RECORD")"
CONTEXT_LOG="$SMARCH_LESSON_SANDBOX/.smarch/agent-context/acme-desktop.activity-feed.ndjson"
CONFLICT_RECORDED="$(node -e '
const fs = require("node:fs");
const events = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
process.stdout.write(events.some((event) => event.kind === "conflict_detected") ? "yes" : "no");
' "$CONTEXT_LOG")"

SMA_AGENT="$WINNER" SMA_SESSION_ID="$WINNER_SESSION" \
  node "$SMARCH_LESSON_SANDBOX/tools/sma-end-edit.ts" \
    --lease "$LEASE_ID" \
    --project sma \
    --brick acme-desktop.activity-feed \
    --intent "finished the swarm fixture practice" \
    --file "$PRACTICE_FILE" \
    --no-dirty-delta \
    --no-preflight-tldr \
    --json > "$SMARCH_LESSON_SANDBOX/end.json"

node "$SMARCH_LESSON_SANDBOX/tools/sma-lease.ts" list --json \
  > "$SMARCH_LESSON_SANDBOX/active.json"

export BLUE_STATUS GOLD_STATUS CONFLICT_RECORDED
node -e '
const active = require(process.argv[1]);
const oneWon = [process.env.BLUE_STATUS, process.env.GOLD_STATUS]
  .filter((status) => status === "0").length === 1;
console.log("Agents: swarm-blue + swarm-gold");
console.log(`Exactly one lease won: ${oneWon ? "yes" : "no"}`);
console.log(`Other start blocked: ${oneWon ? "yes" : "no"}`);
console.log(`Conflict recorded: ${process.env.CONFLICT_RECORDED}`);
console.log(`Active leases after finish: ${active.length}`);
' "$SMARCH_LESSON_SANDBOX/active.json"
```

Expected output:

```text
Agents: swarm-blue + swarm-gold
Exactly one lease won: yes
Other start blocked: yes
Conflict recorded: yes
Active leases after finish: 0
```

> **Stuck? This is normal.** The winning color can change from run to run. That
> is expected. Focus on `Exactly one lease won: yes`, `Conflict recorded: yes`,
> and `Active leases after finish: 0`; together they prove the race stayed safe.

## What you just did

You started two real `start:edit` commands with different agent identities and
the same fixture brick. One command acquired the lease. The other stopped,
recorded the conflict, and left the shared surface alone. Finally, the winner
finished and released the lease, leaving the practice sandbox ready for the
next run.

That small collision is the lesson: a useful swarm is not a crowd editing the
same file. It is a coordinated group whose members can notice overlap, back
off, and keep the project trustworthy.

## Check your understanding

1. Both agents want the same brick. What is the safe result?

   <details><summary>Answer</summary>

   Exactly one acquires the lease. The other stops, records the overlap, and
   leaves the shared brick alone.

   </details>

2. Why is the losing agent's non-zero result good news in this exercise?

   <details><summary>Answer</summary>

   It proves the coordination command blocked overlapping work instead of
   allowing both agents to edit the same surface.

   </details>

3. How should a swarm become faster without weakening ownership?

   <details><summary>Answer</summary>

   Split work across separate bricks so agents can proceed independently, and
   keep leases for the shared surfaces that cannot be split.

   </details>

## Where to go next

[← Previous: 17, Reading the plan with `uvp`](17-reading-the-plan-uvp.md) ·
[Lesson path](START_HERE.md#the-lesson-path) · End of the beginner lane
