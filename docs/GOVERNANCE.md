<!-- docs-i18n: key=docs.governance; source=en; media=media/{locale}/governance/ -->
# Governance

This guide defines who may promote, demote, or reject bricks and builds in the Sweetspot registry. Maintainers and reviewers need it whenever they make a lifecycle decision. Read it before approving canonical status, recording an exception, or responding to failed evidence. Remember that registry quality depends on documented rejection and demotion decisions as much as promotion.

SMA needs rejection rules. Without rejection rules, the registry becomes a junk drawer.

## Status Lifecycle

```
experimental -> project_bound -> candidate -> canonical
                  |              |
                  v              v
               variant        duplicate
                  |
                  v
                legacy
```

Status meanings:

- `experimental`: idea or early implementation.
- `project_bound`: useful, but tied to one project.
- `variant`: valid alternate implementation with clear tradeoffs.
- `duplicate`: same job as another brick, not preferred.
- `legacy`: retained for reference, not new work.
- `candidate`: near reusable, missing limited proof.
- `canonical`: preferred option for new work.

## Promotion To Canonical

Canonical status requires:

- score 90 or higher
- no high or critical vulnerability findings
- clone readiness `copy_ready` or approved `guided`
- source commit or archive hash
- at least one review event
- tests documented and current
- env contract complete when env vars exist
- RLS/storage matrix complete when data access exists
- no files over 600 lines except generated/vendor files
- known traps documented

Any hard blocker overrides a high score.

## Demotion

Demote a canonical brick when:

- a high or critical finding appears
- a better canonical replacement exists
- clone attempts repeatedly fail
- dependencies become unmaintained or vulnerable
- source/provenance cannot be trusted
- project assumptions are discovered but not documented

Demotion statuses:

- `variant` for a still-valid alternate
- `project_bound` for code that works only in its original project
- `legacy` for reference only
- `duplicate` for replaced copies

## Review Roles

| Role | Responsibility |
|------|----------------|
| Architect | Boundary, public API, adapter shape |
| Security | secrets, authz, RLS, env, vulnerability checks |
| Tester | [STF](GLOSSARY.md#stf) coverage and regression confidence |
| Performance | [SPE](GLOSSARY.md#spe) thresholds and N+1 risk |
| Release | SSRA readiness and deployment risk |
| Registry Maintainer | canonicalization evidence, duplicate clusters, metadata quality |

One person can hold multiple roles in small projects, but the role must still be recorded.

## Decision Records

Use a review record for canonical promotion, demotion, or dispute:

```
reviews/
  YYYY-MM-DD-brick-id-decision.md
```

Include:

- decision
- evidence
- rejected alternatives
- open risks
- next review date

## Duplicate Policy

Duplicates are allowed only when labeled.

Every duplicate group needs:

- canonical candidate
- reason each variant exists
- reason each duplicate is not preferred
- migration note when users should switch

## Fresh-Eyes Rule

SMA explicitly allows cross-industry thinking and unconventional patterns.

The bar is not "does this look traditional?"

The bar is:

- Is the boundary explicit?
- Can another project copy it safely?
- Are security assumptions declared?
- Are failure modes isolated?
- Are tests and checks attached?
- Is provenance recorded?

New philosophy is welcome. Unverifiable claims are not.
