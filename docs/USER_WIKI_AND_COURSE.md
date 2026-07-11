# User Wiki And Course Layer

This guide defines the wiki pages and course materials that teach people how to evaluate, reuse, and maintain Sweetspot bricks. Documentation authors, course builders, and registry maintainers need it when they turn registry data into human-facing learning material. Read it before generating a brick page or changing the learner path. Remember that the wiki answers immediate trust and reuse questions, while the course teaches the lifecycle in sequence.

SMA needs two learning surfaces:

1. A brick wiki for lookup.
2. A course path for onboarding.

The wiki answers: "What is this brick, can I trust it, and how do I copy it?"

The course answers: "How do I think in Sweetspot bricks?"

## Why This Exists

The registry is for machines and advanced agents. New users need a different surface:

- plain explanations
- visual flows
- code translated into human meaning
- concrete clone paths
- quizzes that test decisions, not memorized acronyms
- warnings where mistakes usually happen

The external `codebase-to-course` idea is a strong pattern: generate a single-page course from real code, with code/plain-English translations, visuals, quizzes, glossary, and offline HTML. SMA should use that pattern, but make it registry-driven.

Reference: https://github.com/zarazhangrui/codebase-to-course

## Three Outputs

| Output | Audience | Source | Format |
|--------|----------|--------|--------|
| Brick Wiki | builders, agents, reviewers | `module.sweetspot.json` + source snippets | Markdown + optional HTML |
| Learning Course | new users | canonical bricks + framework docs | single-page HTML |
| Agent Lesson Pack | AI agents | manifests + gates + examples | compact Markdown references |

## Brick Wiki Page Contract

Every brick wiki page should include:

- name and one-line purpose
- status: canonical, candidate, variant, etc.
- copy readiness
- trust score
- code budget / bloat status
- data classes
- security gates
- model/human/tool provenance
- public API
- dependencies
- clone steps
- known traps
- real code snippet links
- tests to run
- "when to use this" and "when not to use this"

## Course Path

New users should learn in this order:

1. What a brick is.
2. Why small files and isolation help AI teams.
3. How [SSA-v2](GLOSSARY.md#ssa-v2) protects secrets and data boundaries.
4. How [SSI](GLOSSARY.md#ssi) prevents one broken module from taking down the app.
5. How [SSTF](GLOSSARY.md#sstf), [SPE](GLOSSARY.md#spe), [SRS](GLOSSARY.md#srs), and security gates prove the brick.
6. How to read a brick manifest.
7. How to copy a brick safely.
8. How model provenance helps trace changes.
9. How to promote a brick to canonical.

## Generated Course Style

Use the useful parts of codebase-to-course:

- single self-contained HTML output
- no build step for the learner
- real snippets from the source, not fake examples
- code on one side and plain meaning on the other
- decision quizzes
- glossary tooltips
- diagrams for flow and gates

Do not copy another project's code without checking license. Treat it as a pattern unless an explicit import decision is made.

## Elegant Teaching Rule

Do not teach every acronym first.

Teach the lifecycle:

```
Find brick -> inspect trust -> copy -> adapt declared ports -> run gates -> record provenance -> reuse
```

Then reveal the acronyms as the gates behind that lifecycle.
