# Leases: working alongside agents

## Why this matters

Two helpers can both be excellent and still overwrite each other when they
edit the same code at the same time. A small coordination step lets people and
coding agents—programs that read instructions and help change code—move quickly
without turning shared work into a guessing game.

*Made with love for creators of all kind.*

## The idea

A [lease](../GLOSSARY.md#lease) is a time-limited claim that says one worker is
using a [brick](../GLOSSARY.md#brick) right now. Before a coding agent edits,
the `start:edit` command creates the lease and records the plan. When the work
is finished, `end:edit` records what happened and releases the lease.

Think of the lease as the light outside a tiny recording studio. Light on:
someone is working, so check with them before entering. Light off: the room is
available. The light expires after a limited time so an abandoned session does
not reserve the room forever.

You will practice on Activity Feed inside the **fixture portfolio**, a
collection of small practice projects at `tools/evals/fixtures/portfolio`.
The commands copy SMARCH's coordination tools into a temporary **sandbox**, an
isolated practice folder, so this lesson cannot claim a real project lease.

## Try it

Run this block from the SMARCH folder. It acquires a practice lease, records
the edit plan, finishes without changing the fixture, and confirms that no
practice lease remains. `--json` asks each tool for a machine-readable record.
`--no-dirty-delta` skips the changed-file comparison, and
`--no-preflight-tldr` skips the short project-status summary; both are useful
only because this practice happens inside a disposable sandbox. The
`SMA_AGENT` and `SMA_SESSION_ID` labels identify the practice worker and its
practice session.

> **Stuck? This is normal.** A lease can refuse to start when someone else
> already holds the same practice resource. That refusal protects their work.
> Wait for the holder to finish, or use a fresh temporary lesson folder; do not
> force the claim.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
SMARCH_LESSON_TMP="${SMARCH_LESSON_TMP:-$(mktemp -d)}"
SMARCH_LESSON_SANDBOX="$SMARCH_LESSON_TMP/smarch-sandbox"
cd "$SMARCH_DIR"

if [ ! -f "$SMARCH_FIXTURE_PORTFOLIO/acme-desktop/src/modules/activity-feed/module.sweetspot.json" ]; then
  npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO"
fi

mkdir -p "$SMARCH_LESSON_SANDBOX"
cp -R "$SMARCH_DIR/tools" "$SMARCH_LESSON_SANDBOX/tools"
PRACTICE_FILE="$SMARCH_FIXTURE_PORTFOLIO/acme-desktop/src/modules/activity-feed/index.mjs"
START_RECORD="$SMARCH_LESSON_SANDBOX/start.json"
END_RECORD="$SMARCH_LESSON_SANDBOX/end.json"
ACTIVE_RECORD="$SMARCH_LESSON_SANDBOX/active.json"
export SMA_AGENT="lesson-reader" SMA_SESSION_ID="lesson-08"

node "$SMARCH_LESSON_SANDBOX/tools/sma-start-edit.mjs" \
  --project sma \
  --brick acme-desktop.activity-feed \
  --intent "practice a safe fixture edit" \
  --file "$PRACTICE_FILE" \
  --json > "$START_RECORD"

LEASE_ID="$(node -e 'const x=require(process.argv[1]); process.stdout.write(x.lease.lease_id)' "$START_RECORD")"
node -e '
const x = require(process.argv[1]);
console.log(`Lease acquired: ${x.lease.resource_id}`);
console.log(`Edit plan recorded: ${x.context_event.kind === "edit_planned" ? "yes" : "no"}`);
' "$START_RECORD"

node "$SMARCH_LESSON_SANDBOX/tools/sma-end-edit.mjs" \
  --lease "$LEASE_ID" \
  --project sma \
  --brick acme-desktop.activity-feed \
  --intent "finished the fixture practice" \
  --file "$PRACTICE_FILE" \
  --no-dirty-delta \
  --no-preflight-tldr \
  --json > "$END_RECORD"

node "$SMARCH_LESSON_SANDBOX/tools/sma-lease.mjs" list --json > "$ACTIVE_RECORD"
node -e '
const ended = require(process.argv[1]);
const active = require(process.argv[2]);
console.log(`Lease released: ${ended.released ? "yes" : "no"}`);
console.log(`Work recorded: ${ended.context_event.kind}`);
console.log(`Active leases after finish: ${active.length}`);
' "$END_RECORD" "$ACTIVE_RECORD"
```

Expected output:

```text
Lease acquired: acme-desktop.activity-feed
Edit plan recorded: yes
Lease released: yes
Work recorded: edit_applied
Active leases after finish: 0
```

## What you just did

You announced an intent before editing, received an exclusive practice claim,
and attached that claim to one fixture brick. You then recorded the finished
work and released the claim. Another agent could now start safely instead of
guessing whether your work was still in progress.

In a real SMARCH task, the normal finish command also checks which files
changed and prints a short project-status summary.

## Check your understanding

1. Another worker already holds the brick lease. Should you force your edit
   through because your change is small?

<details>
<summary>Show answer</summary>

No. Back off and coordinate with the holder. The lease exists to prevent two
good changes from overwriting each other.

</details>

2. Why does a lease expire instead of lasting forever?

<details>
<summary>Show answer</summary>

Expiration prevents an abandoned session from reserving the brick forever.

</details>

3. What makes `end:edit` more than an “unlock” command?

<details>
<summary>Show answer</summary>

It records what happened before releasing the lease. In a real task it also
checks changed files and prints project status.

</details>

## Where to go next

- **Previous:** [07: Provenance and seals](07-provenance-and-seals.md)
- **Next:** [09: Conflicts are normal](09-conflicts-are-normal.md)

Next, you will record a collision, pause politely, and clear the record after
a handoff.
