# Conflicts are normal

## Why this matters

When several people or coding agents—programs that read instructions and help
change code—share a project, occasionally they reach for the same code. That is
normal coordination information, not a personal failure. A clear record turns
“uh-oh” into an ordinary handoff.

*Made with love for creators of all kind.*

## The idea

A [conflict report](../GLOSSARY.md#conflict-report) is a small, structured note
that names the work that collided and the plan for resolving it. A **collision**
means two workers want the same [brick](../GLOSSARY.md#brick), file, or shared
tool at the same time. The blocked worker records the conflict and backs
off—stops before changing that surface—until the current holder finishes or
hands it over. A **strict check** is a command that refuses to report success
while any conflict remains open.

Think of two trains arriving at one stretch of single-track railway. The
signal does not accuse either driver. It records which train waits, which track
is shared, and when the route becomes clear.

You will create and resolve a practice conflict for Slug Service inside the
**fixture portfolio**, a collection of small practice projects at
`tools/evals/fixtures/portfolio`. As in lesson 08, a temporary **sandbox**—an
isolated practice folder—keeps the report away from real project records.

## Try it

Run this block from the SMARCH folder. It records a pretend overlap, proves the
strict check blocks while the conflict is open, records the handoff, and proves
the check becomes clear. `--json` asks each command for a machine-readable
record, which the final few lines turn into a friendly summary.

> **Stuck? This is normal.** The strict check is supposed to return a failure
> while the practice conflict is open. The `if` block catches that result and
> continues. Run the full block; running only the strict check will stop at the
> exact safety boundary this lesson is demonstrating.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
SMARCH_LESSON_TMP="${SMARCH_LESSON_TMP:-$(mktemp -d)}"
SMARCH_LESSON_SANDBOX="$SMARCH_LESSON_TMP/smarch-sandbox"
cd "$SMARCH_DIR"

if [ ! -f "$SMARCH_FIXTURE_PORTFOLIO/acme-cms/src/modules/slug-service/module.sweetspot.json" ]; then
  npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO"
fi

mkdir -p "$SMARCH_LESSON_SANDBOX"
cp -R "$SMARCH_DIR/tools" "$SMARCH_LESSON_SANDBOX/tools"
PRACTICE_FILE="$SMARCH_FIXTURE_PORTFOLIO/acme-cms/src/modules/slug-service/index.mjs"
REPORT_RECORD="$SMARCH_LESSON_SANDBOX/report.json"
OPEN_RECORD="$SMARCH_LESSON_SANDBOX/open.json"
RESOLVE_RECORD="$SMARCH_LESSON_SANDBOX/resolve.json"
CLEAR_RECORD="$SMARCH_LESSON_SANDBOX/clear.json"
export SMA_AGENT="lesson-reader" SMA_SESSION_ID="lesson-09"

node "$SMARCH_LESSON_SANDBOX/tools/sma-conflict.ts" report \
  --project sma \
  --brick acme-cms.slug-service \
  --intent "edit the fixture slug service" \
  --resource-kind brick \
  --resource acme-cms.slug-service \
  --blocked-agent lesson-reader \
  --holder-agent another-agent \
  --resolution-plan "wait for a handoff, then retry" \
  --file "$PRACTICE_FILE" \
  --json > "$REPORT_RECORD"

if node "$SMARCH_LESSON_SANDBOX/tools/sma-conflict.ts" check \
  --project sma \
  --brick acme-cms.slug-service \
  --strict \
  --json > "$OPEN_RECORD"; then
  echo "Unexpected: the open conflict did not block"
  exit 1
else
  STRICT_BLOCKED=yes
fi

node "$SMARCH_LESSON_SANDBOX/tools/sma-conflict.ts" resolve \
  --project sma \
  --brick acme-cms.slug-service \
  --intent "fixture handoff received" \
  --decision "another-agent finished; lesson-reader may continue" \
  --file "$PRACTICE_FILE" \
  --json > "$RESOLVE_RECORD"

node "$SMARCH_LESSON_SANDBOX/tools/sma-conflict.ts" check \
  --project sma \
  --brick acme-cms.slug-service \
  --strict \
  --json > "$CLEAR_RECORD"

export STRICT_BLOCKED
node -e '
const report = require(process.argv[1]);
const open = require(process.argv[2]);
const resolved = require(process.argv[3]);
const clear = require(process.argv[4]);
console.log(`Conflict recorded: ${report.event.kind}`);
console.log(`Open conflicts before handoff: ${open.open_conflicts}`);
console.log(`Strict check blocked: ${process.env.STRICT_BLOCKED}`);
console.log(`Conflict resolved: ${resolved.kind}`);
console.log(`Open conflicts after handoff: ${clear.open_conflicts}`);
console.log(`Final status: ${clear.status}`);
' "$REPORT_RECORD" "$OPEN_RECORD" "$RESOLVE_RECORD" "$CLEAR_RECORD"
```

Expected output:

```text
Conflict recorded: conflict_detected
Open conflicts before handoff: 1
Strict check blocked: yes
Conflict resolved: conflict_resolved
Open conflicts after handoff: 0
Final status: clear
```

## What you just did

You wrote down who was blocked, what fixture brick was shared, and how the
workers planned to proceed. The strict check returned a non-zero result—a
command result that means “stop”—while the report was open. After the pretend
handoff, you resolved the report and the same check passed.

This is the healthy loop: detect, record, back off, coordinate, resolve, then
continue. The report preserves useful history without making the collision
dramatic.

## Check your understanding

1. You discover another worker needs the same brick. Is the conflict report
   evidence that either worker did something wrong?

<details>
<summary>Show answer</summary>

No. It is normal coordination information. The report makes the overlap and
resolution plan visible before edits collide.

</details>

2. Why should the blocked worker back off after recording the conflict?

<details>
<summary>Show answer</summary>

Continuing would risk changing the same surface at the same time. Backing off
preserves both workers' progress until a handoff is agreed.

</details>

3. When should the strict check become successful again?

<details>
<summary>Show answer</summary>

After the workers coordinate, record the decision, and resolve every open
conflict for that scope.

</details>

## Where to go next

- **Previous:** [08: Leases, working alongside agents](08-leases-working-alongside-agents.md)
- **Next:** [10: Your first capsule](10-your-first-capsule.md)

You now know how to inspect a brick, scan a portfolio, read its proof, reuse it
with provenance, coordinate through leases, and handle collisions without
panic. That is a solid little toolkit for the next experiment.
