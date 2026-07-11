<!-- docs-i18n: key=docs.community.showcase; source=en; media=../media/{locale}/community-showcase/ -->
# Community showcase

The showcase is the evidence-backed catalog of community bricks that have completed submission review. Use this guide to prepare a showcase entry or review a proposed one. A passing local demo is useful evidence, but it does not make a brick approved, canonical, or endorsed by SMARCH.

## What belongs here

A showcase entry must point to a real registered brick and a reviewed submission digest. It should answer four questions without requiring a reviewer to inspect the source first:

1. What problem does the brick solve?
2. What is the smallest working example?
3. Which gates and runtime evidence support the claim?
4. Which limits or host assumptions remain?

Do not submit concept art, roadmap-only capabilities, private customer data, unreproducible screenshots, or claims that exceed the registry status.

## Prepare the evidence

Start with the gated intake flow in [Community brick submissions](ONBOARDING.md). Package and verify the exact brick revision:

```bash
node /path/to/SMARCH/tools/sma-submit.mjs \
  --root . \
  --brick path/to/brick \
  --out submissions

node /path/to/SMARCH/tools/sma-submit.mjs \
  --verify submissions/<brick>-<version>-<timestamp>.tar.gz
```

Keep the printed archive digest. The showcase entry must refer to the digest approved by the curator; changing the archive restarts review.

## Write the entry

Use this structure:

```markdown
## Brick name

One sentence describing the user outcome.

- Registry id: `example.brick`
- Version: `1.2.3`
- Status: `candidate`
- Submission: link to the reviewed issue
- Bundle digest: `sha256:...`
- Proof: links to fixtures, gate report, and runtime evidence
- Limits: host requirements and known exclusions
```

Keep screenshots optional and evidentiary. Store each image in the locale-specific media root declared at the top of this page, keep captions in Markdown, and never bake explanatory text into the image. A translated page can then replace the image without changing the entry key.

## Review rules

The curator checks that:

- the registry identity, version, status, and digest match the approved bundle;
- the example is reproducible from public-safe inputs;
- every visual claim has a readable caption and linked runtime or gate evidence;
- limitations are visible beside the claim;
- license and attribution are explicit;
- no private data, secrets, customer names, or misleading badges appear.

An entry is removed or corrected when its referenced release is withdrawn, its evidence expires, or its claim no longer matches the registered brick. The showcase is a view of current evidence, not a permanent award.

## Current availability

The submission packager and curator workflow exist today. A hosted public showcase is an M3 target and is not live in this repository yet. Until that surface ships, reviewed entries should remain attached to their submission and registry records rather than being presented as a live catalog.
