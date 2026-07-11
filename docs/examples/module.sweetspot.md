# Walkthrough of `module.sweetspot.json`

This walkthrough explains how the example module manifest describes one reusable brick. Brick authors and reviewers need it when they create or audit a `module.sweetspot.json` file. Read it beside the [checked-in example](../../examples/module.sweetspot.json) before copying the shape into a project. Remember that each field should describe the source code and evidence that exist now, not the state a maintainer hopes to reach.

## Example at a glance

The example declares `acme-studio.ssi.guard`, a candidate [SSI](../GLOSSARY.md#ssi) Guard at version `0.1.0`. It owns a small set of user-interface guard files, exposes guard and feature-gate interfaces, and identifies project adapters for feature flags, tiers, and observability. The manifest classifies the brick as medium risk because authenticated user state may control feature access.

## Top-level fields

| Field | What it records | How to read the example |
| --- | --- | --- |
| `schema_version` | Manifest contract version | Selects version `1.0.0` of the module format. |
| `brick` | Stable identity and lifecycle state | Names the guard, version, implementation languages, frameworks, and domains. |
| `hierarchy` | Place in the project structure | Declares the brick level, containing group, and component policy. |
| `source` | Origin and owned source locations | Points to the source project, repository revision, and paths. |
| `owner` | Accountable maintainers | Names the primary owner, team, and reviewers. |
| `boundaries` | Ownership and allowed behavior | Separates owned, public, and private paths and declares forbidden imports and permitted side effects. |
| `classification` | Data sensitivity and risk | Records the data classes the brick handles and the resulting risk level. |
| `sweetspot` | Gate results | Stores status, score, evidence, or notes for each Sweetspot proof gate. |
| `interfaces` | Public contract and adapters | Lists the public surface, required project adapters, allowed dependencies, and forbidden dependencies. |
| `security` | Access, environment, and vulnerability state | Declares row-access relevance, environment variables, and finding counts. |
| `supply_chain` | Dependency and license evidence | Records dependencies, licenses, checksums, and a software-bill-of-materials path. |
| `quality` | Maintainability and executable checks | Captures code size, budget, test commands, and verification results. |
| `clone` | Reuse procedure | Names adaptation points, install steps, readiness, and known traps. |
| `provenance` | Creator and review trail | Records human and model contributions, reviews, and the source chain. |

## Check the contract in order

Confirm the `brick.id`, source paths, and `boundaries.owned_paths` first. Review `interfaces` and `security` next because they expose hidden project assumptions that can make a clone unsafe. Finish with gate evidence, verification commands, clone instructions, and provenance before accepting the manifest into a registry.

## Validate the example

Run `node tools/sma-validate.ts --manifest examples/module.sweetspot.json` from the repository root. The command checks the manifest shape, but reviewers still need to compare paths, commands, scores, and evidence with the source project. Update the manifest whenever those facts change.

