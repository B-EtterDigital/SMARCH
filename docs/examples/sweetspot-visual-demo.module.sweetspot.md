# Walkthrough of `sweetspot-visual-demo.module.sweetspot.json`

This walkthrough explains the manifest for the optional Sweetspot Visual Demo module. Project owners and proof-tool maintainers need it when they adopt or review a visual walkthrough workflow. Read it beside the [checked-in example](../../examples/sweetspot-visual-demo.module.sweetspot.json) before connecting capture tools or publishing proof artifacts. Remember that visual proof must stay replayable, reviewable, and safe for the data visible on screen.

## Example at a glance

The example declares `sweetspot.svd.visual-demo`, a candidate documentation-and-manifest module at version `0.1.0`. It owns the visual-demo contract and its example manifest, while implementation-specific capture tools remain adapters. The high-risk classification reflects the chance that screenshots or recordings contain private or personally identifiable data.

## Top-level fields

| Field | What it records | How to read the example |
| --- | --- | --- |
| `schema_version` | Manifest contract version | Selects version `1.0.0` of the module format. |
| `brick` | Stable identity and lifecycle state | Names the optional visual-demo module, version, languages, and domains. |
| `hierarchy` | Place in the architecture | Declares a brick in the optional-modules group with manifest-backed components. |
| `source` | Origin and integrity | Points to the contract document and records its archive hash. |
| `owner` | Accountable maintainers | Names the primary owner, team, and reviewers. |
| `boundaries` | Owned paths and permitted effects | Allows local proof artifacts and galleries while forbidding secret capture and unsafe publication. |
| `classification` | Data sensitivity and risk | Records public, private, and personally identifiable data exposure as high risk. |
| `sweetspot` | Gate results | Captures the evidence and remaining release-readiness work for the optional module. |
| `interfaces` | Proof outputs and adapters | Defines artifact manifests, claim ledgers, galleries, capture drivers, and publication adapters. |
| `security` | Access and vulnerability state | Records database relevance, environment requirements, and finding counts. |
| `supply_chain` | Dependency and integrity evidence | Records licenses and the checksum for the source contract. |
| `quality` | Proof quality and validation | Adds visible-state, screenshot-quality, and claim-to-artifact checks to the normal quality fields. |
| `clone` | Adoption procedure | Lists adapters, install steps, and traps such as occluded evidence or unsafe retention. |
| `provenance` | Creator and review trail | Records the decisions, rejected alternatives, verification, and source chain. |

## Review a visual-proof adoption

Start with `boundaries` and `classification` to decide where artifacts may be written and which data must be redacted. Map each `interfaces.adapter` entry to the target project's approved runtime, then follow `clone.install_steps` to define the first scripted flow. Do not promote the module until numbered claims point to visible results and the release packet accounts for privacy, retention, and publication scope.

## Validate the example

Run `node tools/sma-validate.ts --manifest examples/sweetspot-visual-demo.module.sweetspot.json` from the repository root. The checked-in verification proves the candidate manifest shape; a project adoption needs fresh runtime proof from its own capture and gallery implementation.
