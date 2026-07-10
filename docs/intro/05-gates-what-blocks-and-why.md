# Gates: what blocks and why

## Why this matters

A warning can ask you to look closer, but some problems should stop work from
moving forward. Gates make those stop rules explicit and repeatable. When a
gate blocks, it should tell you what failed so you can fix the cause instead of
poking around in the dark.

*Made with love for creators of all kind.*

## The idea

A [gate](../GLOSSARY.md#gate) is an automated check that returns “pass” or
“fail.” A failed gate uses a non-zero exit code, which is a number a command
returns to say it did not succeed. Other tools can see that number and stop the
next step.

Think of a gate as the height bar beside a tiny roller coaster. It is not angry
with the rider, and it is not grading their personality. It checks one known
limit, explains the mismatch, and keeps the ride safe until the mismatch is
resolved.

This lesson uses the source-size gate. It counts lines in source files and
compares them with a threshold, meaning the exact line count where the gate
starts blocking. The practice portfolio contains one deliberately oversized
file so you can see a real failure without breaking real work.

## Try it

First, run the gate against the `acme-desktop` practice project. The shell
temporarily allows the expected failure to finish, saves its exit code, and
then confirms that the gate blocked for the planned reason.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
cd "$SMARCH_DIR"

npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO"

set +e
GATE_OUTPUT="$(node tools/sma-source-size-gate.mjs \
  --root "$SMARCH_FIXTURE_PORTFOLIO/acme-desktop" \
  --source-root src \
  --no-baseline \
  --gate 2>&1)"
GATE_EXIT=$?
set -e

printf '%s\n' "$GATE_OUTPUT"
if [ "$GATE_EXIT" -ne 4 ]; then
  echo "Expected the source-size gate to exit with 4, got $GATE_EXIT" >&2
  exit 1
fi
echo "Gate exit code: $GATE_EXIT (blocked as expected)"
```

Expected output includes:

```text
SMA source-size gate: failed
threshold: >=1900 lines
violations: 1 (1 new, 0 grown baseline, 0 legacy)
NEW 1908 src/modules/oversized-catalog/index.mjs
Gate exit code: 4 (blocked as expected)
```

`NEW` means the file is not on an approved list of older exceptions. The gate
names the exact file and reports 1,908 lines, so the reason for blocking is not
a mystery.

Now aim the same gate at the much smaller Activity Feed
[brick](../GLOSSARY.md#brick). No rule changes; only the checked folder changes.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
cd "$SMARCH_DIR"

node tools/sma-source-size-gate.mjs \
  --root "$SMARCH_FIXTURE_PORTFOLIO/acme-desktop/src/modules/activity-feed" \
  --source-root . \
  --no-baseline \
  --gate
```

Expected output:

```text
SMA source-size gate: passed
threshold: >=1900 lines
violations: 0 (0 new, 0 grown baseline, 0 legacy)
```

## What you just did

You watched one gate make two evidence-based decisions. It blocked an
oversized practice file with exit code 4, then passed a bounded brick with exit
code 0. Most importantly, the failed output gave you a file, a measured value,
and the rule it crossed—the ingredients needed for a useful fix.

## Where to go next

Continue to [06: Your first clone](06-your-first-clone.md). You will reuse a
practice brick and inspect the records SMARCH leaves behind, while the planted
gate failure stays safely inside the demo portfolio.
