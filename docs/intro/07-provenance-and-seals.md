# Provenance and seals

## Why this matters

Reusable code is easier to trust when you can see where it came from and tell
whether its recorded history still matches. SMARCH keeps those clues
checkable, so creators get credit and future maintainers do not have to guess.

*Made with love for creators of all kind.*

## The idea

A [provenance seal](../GLOSSARY.md#provenance-seal) is a checkable summary of a
[brick's](../GLOSSARY.md#brick) source and creator history. A **content
fingerprint** is a short digital summary calculated from the brick's files. A
**history event** is one recorded action, such as creating or reviewing the
brick. SMARCH links the fingerprint and the ordered events together. If a file
or event changes, checking the old seal exposes the mismatch.

Think of a seal like the tamper strip on a jar, plus a recipe card signed by
every cook. The strip does not stop someone from opening the jar; it makes the
opening visible. In the same way, “tamper-evident” means a change can be
detected, not that change is impossible.

The creator history lives in the brick's
[manifest](../GLOSSARY.md#manifest), the machine-readable file that describes
the brick. You will read that history from SMARCH's safe practice portfolio at
`tools/evals/fixtures/portfolio`. A **fixture portfolio** is a collection of
small practice projects made for repeatable experiments.

## Try it

Run this block from the SMARCH folder. It fingerprints the fixture Slug
Service, seals its recorded creator event, then changes a copy of that event to
prove the check notices. If the practice files are missing, `fixtures:gen`
recreates them first. The real fixture stays unchanged.

```bash
SMARCH_DIR="${SMARCH_DIR:-$PWD}"
SMARCH_FIXTURE_PORTFOLIO="${SMARCH_FIXTURE_PORTFOLIO:-$SMARCH_DIR/tools/evals/fixtures/portfolio}"
cd "$SMARCH_DIR"

if [ ! -f "$SMARCH_FIXTURE_PORTFOLIO/acme-cms/src/modules/slug-service/module.sweetspot.json" ]; then
  npm run fixtures:gen -- --out "$SMARCH_FIXTURE_PORTFOLIO"
fi

export SMARCH_DIR SMARCH_FIXTURE_PORTFOLIO
node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";
const {
  computeSeal,
  fingerprintSource,
  verifySeal
} = await import(`${process.env.SMARCH_DIR}/tools/lib/provenance-seal.mjs`);

const brickRoot = path.join(
  process.env.SMARCH_FIXTURE_PORTFOLIO,
  "acme-cms/src/modules/slug-service"
);
const manifest = JSON.parse(fs.readFileSync(
  path.join(brickRoot, "module.sweetspot.json"),
  "utf8"
));
const brickId = "acme-cms.slug-service";
const events = [
  manifest.provenance.created_by,
  ...manifest.provenance.touched_by,
  ...manifest.provenance.reviewed_by
];
const fingerprint = fingerprintSource(brickRoot);
const seal = computeSeal({
  brick_id: brickId,
  content_hash: fingerprint.content_hash,
  events
});
const originalCheck = verifySeal(seal, {
  brick_id: brickId,
  content_hash: fingerprint.content_hash,
  events
});
const editedEvents = events.map((event, index) => index === 0
  ? { ...event, summary: `${event.summary} changed` }
  : event
);
const editedCheck = verifySeal(seal, {
  brick_id: brickId,
  content_hash: fingerprint.content_hash,
  events: editedEvents
});

console.log(`Brick: ${brickId}`);
console.log(`Files fingerprinted: ${fingerprint.file_count}`);
console.log(`History events sealed: ${seal.chain_length}`);
console.log(`Original history verifies: ${originalCheck.ok ? "yes" : "no"}`);
console.log(`Edited history detected: ${editedCheck.ok ? "no" : "yes"}`);
console.log(`Reason: ${editedCheck.reasons[0]}`);
NODE
```

Expected output includes:

```text
Brick: acme-cms.slug-service
Files fingerprinted: 2
History events sealed: 1
Original history verifies: yes
Edited history detected: yes
Reason: provenance chain head mismatch — history was edited, reordered, or an author was removed
```

## What you just did

You turned the fixture brick's files into a fingerprint, joined that
fingerprint to its creator event, and checked the resulting seal. Then you
edited only an in-memory copy of the history. The second check failed for the
right reason, while every practice file on disk stayed untouched.

A seal answers “does this still match what was sealed?” It does not answer
every trust question by itself. A real project can add a cryptographic
signature—proof made with a private digital key—and an external record for
stronger protection.

## Where to go next

Return to the [lesson path](START_HERE.md#the-lesson-path) and continue with
lesson 08, Leases: working alongside agents. You will make a polite,
time-limited claim before touching a fixture brick, then release it for the
next creator.
