# Skills module tour

This tour explains agent skills, installation tooling, and plugin packaging. Skill authors and maintainers need it before changing how agents discover or execute a workflow. Read it when a task adds a skill, revises its contract, or changes installation. Remember that a skill must state its trigger, scope, proof requirements, and safe fallback.

## Purpose

The skills module packages reusable agent instructions around documented Sweetspot workflows. It depends on the docs module for the source contracts those skills apply.

## Owned files

- `skills/**`
- `agent-skills/**`
- `tools/install-agent-skills.mjs`
- `.claude-plugin/**`

## Gates

Run the affected skill's self-test or fixture, installation smoke, source-size gate, and strict module Graphify summary. Verify that the trigger does not activate outside its documented scope.

The configured module gate is `node tools/install-agent-skills.mjs --check`. Query the module graph with `npm run graphify:query -- --project sma --module skills -- "<question>"`; its generated graph lives under `graphify-out/modules/skills/`.

## How to work here

Keep the workflow source in one place and make installed copies reproducible. Update documentation first when a skill would otherwise invent a missing product or process rule.
