---
name: sma-course-builder
description: Generate or update user-facing Sweetspot Modular Architecture wiki pages, brick catalog pages, onboarding lessons, and single-page HTML courses from SMA manifests, registries, and source snippets. Use when asked to teach SMA, explain bricks/modules to new users, make a module wiki, turn a Sweetspot project into a course, or create codebase-to-course style learning material for SMA.
---

# SMA Course Builder

Use this skill to create human learning material from SMA data.

## Workflow

1. Find the registry or manifests:
   - global registry: `~/DEV/SMARCH/registry/global-modules.generated.json`
   - brick manifests: `module.sweetspot.json`
   - project indexes: `.sweetspot/modules.json`
2. Generate or update wiki pages:
   - `wiki/BRICK_CATALOG.generated.md`
   - `wiki/bricks/<brick-id>.md`
3. Generate or update the course:
   - `wiki/courses/sma-brick-course.generated.html`
4. Add teaching notes only where the manifest is too thin.
5. Do not promote a brick to canonical from course material alone.

## Commands

Generate the wiki and course from the current global registry:

```bash
node ~/DEV/SMARCH/tools/sma-wiki.mjs \
  --registry ~/DEV/SMARCH/registry/global-modules.generated.json \
  --out ~/DEV/SMARCH/wiki
```

Refresh the registry first:

```bash
node ~/DEV/SMARCH/tools/sma-scan.mjs \
  --root ~/DEV/Projects \
  --out ~/DEV/SMARCH/registry/global-modules.generated.json
```

## Teaching Rules

- Teach the lifecycle before the acronyms: find, inspect, copy, adapt, test, record provenance.
- Use real manifest/source facts. Mark missing metadata clearly.
- Translate code and metadata into practical decisions.
- Quizzes should test what to do next, not vocabulary.
- Keep model provenance factual. Do not imply a model name proves quality.
- Treat imported external learning systems as inspiration unless license and integration are approved.

## References

- Read `references/wiki-page-contract.md` before writing a manual brick page.
- Read `references/course-pattern.md` before making a course or lesson path.

