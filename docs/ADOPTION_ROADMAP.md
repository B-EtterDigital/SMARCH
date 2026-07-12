<!-- docs-i18n: key=docs.adoption-roadmap; source=en; media=media/{locale}/adoption-roadmap/ -->
# Adoption Roadmap

This roadmap explains how to introduce Sweetspot Modular Architecture to a project in controlled stages. Project leads and engineers adopting the system should use it before changing repository structure or enforcement. Read it when planning an initial rollout or deciding which proof gate comes next. Remember that each phase should establish working evidence before the team advances.

Use this order to introduce SMA without overwhelming users.

## Phase 1: Inventory

- Scan projects for existing Sweetspot material.
- Add manifests only to obvious reusable bricks.
- Mark most bricks `experimental` or `project_bound`.
- Do not chase canonical status yet.

Exit criteria:

- registry exists
- projects are listed
- first 5-10 candidate bricks have manifests

## Phase 2: Contracts

- Add clone contracts.
- Add env contracts.
- Add RLS matrices where needed.
- Add public API and adapter points.
- Add model/human provenance.

Exit criteria:

- candidates can be evaluated without opening every source file

## Phase 3: Gates

- Add [STF](GLOSSARY.md#stf) tests.
- Add [SVA](GLOSSARY.md#sva) security checks.
- Add [SEV](GLOSSARY.md#sev) env validation.
- Add [SPE](GLOSSARY.md#spe) measurements for UI/perf-heavy bricks.
- Run `node tools/sma.ts validate` in CI.

Exit criteria:

- bad canonical promotions fail automatically

## Phase 4: Canonical Registry

- Promote only the strongest bricks.
- Label duplicates and variants.
- Demote stale bricks.
- Generate wiki pages and courses.

Exit criteria:

- new projects can choose canonical bricks from the wiki

## Phase 5: Metrics

Track:

- clone success rate
- time to integrate a canonical brick
- number of duplicate bricks reduced
- high/critical findings caught pre-release
- agent write conflicts
- files over 600 lines
- broken clone attempts

Exit criteria:

- SMA has evidence, not just belief
