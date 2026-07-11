# Good-first-issue pipeline

This guide helps maintainers turn small UltraVision tasks into kind, bounded issues for first-time contributors. A `haiku` task is a candidate for a human-beginner-sized issue; it is not automatically safe to publish until its dependencies and file scope are checked.

## Label taxonomy

Every published beginner issue uses `good first issue` plus enough labels to make ownership and risk visible.

| Label | Use |
| --- | --- |
| `good first issue` | Small, explained, dependency-ready work with a named reviewer |
| `area:docs` | Documentation-only work |
| `area:test` | Fixture, evaluation, or regression-test work |
| `area:dashboard` | Dashboard API or component work |
| `type:telemetry` | Error reporting, health signals, or evidence capture |
| `type:i18n` | String extraction or locale-readiness work |
| `blocked` | A seed exists, but one or more prerequisites are not done |
| `help wanted` | Maintainers are ready to support an external contributor |

Do not use `good first issue` for shared hot paths, migrations, security-policy changes, release operations, or tasks whose acceptance criteria require private infrastructure.

## Mint an issue from an UltraVision task

1. Select a task whose latest record is `todo` and whose tier is `haiku`.
2. Confirm every `depends_on` task is `done`. If not, keep the item in the seed pool and label any tracking issue `blocked`.
3. Re-read the current code and replace planner shorthand with a plain-language outcome.
4. Name the files a contributor may edit and the files they must not edit.
5. Copy the task's acceptance criteria, then add one exact local verification command.
6. Add a short “why this matters” paragraph and a reviewer contact.
7. Put the UltraVision ID in the issue body as `Plan task: <id>`.
8. Close or update the issue if the task is claimed, completed, superseded, or its dependencies change.

The issue should be solvable without access to `.UltraVision/`; the plan ID is traceability, not a prerequisite for contribution.

## Issue template

```text
Why this matters
<one user-facing paragraph>

Scope
- You may edit: <paths>
- Please do not edit: <paths>

Done when
- [ ] <acceptance criterion>
- [ ] <verification command and expected result>

Plan task: UV-...
Reviewer: @...
```

## Seed pool from open C1 work

The following records were open `todo` tasks at the time this page was written and were classified `haiku`. They are examples to re-check, not promises that their dependencies are ready today.

| UltraVision ID | Candidate issue | Suggested labels |
| --- | --- | --- |
| `UV-DA-dash-api-conflicts-docs` | Document the dashboard conflicts API | `good first issue`, `area:docs`, `area:dashboard` |
| `UV-DA-dash-api-conflicts-telemetry` | Add telemetry for the dashboard conflicts API | `good first issue`, `area:dashboard`, `type:telemetry` |
| `UV-DA-dash-api-events-sse-docs` | Document the dashboard events SSE API | `good first issue`, `area:docs`, `area:dashboard` |
| `UV-DA-dash-api-events-sse-telemetry` | Add telemetry for dashboard event streaming | `good first issue`, `area:dashboard`, `type:telemetry` |
| `UV-DA-dash-api-graph-docs` | Document the dashboard graph API | `good first issue`, `area:docs`, `area:dashboard` |
| `UV-DA-dash-api-graph-telemetry` | Add telemetry for the dashboard graph API | `good first issue`, `area:dashboard`, `type:telemetry` |
| `UV-DA-dash-api-leases-docs` | Document the dashboard leases API | `good first issue`, `area:docs`, `area:dashboard` |
| `UV-DA-dash-api-leases-telemetry` | Add telemetry for the dashboard leases API | `good first issue`, `area:dashboard`, `type:telemetry` |
| `UV-DA-dash-api-registry-docs` | Document the dashboard registry API | `good first issue`, `area:docs`, `area:dashboard` |
| `UV-DA-dash-api-registry-telemetry` | Add telemetry for the dashboard registry API | `good first issue`, `area:dashboard`, `type:telemetry` |

Before publishing any seed, query its current record, verify its prerequisites, and confirm that no agent already holds the same module. If none are dependency-ready, publish none; an honest empty beginner queue is better than a misleading one.

<!-- docs-i18n: key=docs.community.good-first-issues; source=en; media=../media/{locale}/community-good-first-issues/ -->
