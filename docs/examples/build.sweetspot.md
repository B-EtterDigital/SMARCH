# Walkthrough of `build.sweetspot.json`

This walkthrough explains how the example build manifest describes a reusable capability assembled from several bricks. Build authors and reviewers need it when they create or evaluate a `build.sweetspot.json` file. Read it beside the [checked-in example](../../examples/build.sweetspot.json) before adapting that example to a real project. Remember that the manifest records a build contract and its evidence; it does not prove the underlying capability by itself.

## Example at a glance

The example declares `acme-studio.build.ai-image-generation.capability`, a candidate image-generation build at version `0.1.0`. It composes request orchestration, provider access, post-processing, storage, and controlled asset delivery into one pipeline. Its private visibility and high-risk classification reflect the prompts, generated assets, and provider metadata handled by the flow.

## Top-level fields

| Field | What it records | How to read the example |
| --- | --- | --- |
| `schema_version` | Manifest contract version | Selects version `1.0.0` of the build format. |
| `build` | Stable identity and lifecycle state | Names a candidate capability build, its runtime mix, visibility, stability, and trust tier. |
| `source` | Origin and constituent source paths | Points back to the source project and identifies the bricks from which the build was derived. |
| `owner` | Accountable maintainers | Names the primary owner, team, and reviewers. |
| `composition` | Required bricks and execution topology | Orders brick roles and maps the request-to-asset flow, optional pieces, alternatives, and shared contracts. |
| `classification` | Data sensitivity and risk | Marks private creative inputs and provider metadata as high risk. |
| `sweetspot` | Gate results | Records status, scores, evidence, and notes for each Sweetspot proof gate. |
| `interfaces` | Consumer-facing integration points | Lists entry points, user surfaces, events, endpoints, and commands. |
| `contracts` | Runtime assumptions | Declares environment, data, authorization, row access, network, and performance requirements. |
| `verification` | Executable proof | Lists fixture targets, smoke commands, integration targets, and collected evidence. |
| `clone` | Reuse procedure | Explains supported targets, file mapping, installation, checks, rollback, and known traps. |
| `upgrade` | Change and migration policy | Defines compatibility, migration hooks, replacement rules, and breaking-change signals. |
| `publishing` | Distribution boundary | Records publishability, redaction, license, exposed documentation, and excluded assets. |
| `economics` | Measured reuse costs | Stores estimates for prompt savings, clone time, update time, and maintenance load. |
| `provenance` | Creator and review trail | Records who created, changed, and reviewed the build and where it came from. |

## Follow the composition

Start with `composition.brick_refs` to see which bricks are required and the role each one plays. Then follow `composition.flows[].steps` in ascending `order`; each step names its inputs, outputs, and responsible brick. Treat `optional_bricks` and `alternatives` as explicit variation points rather than hidden fallback behavior.

## Review the evidence

Compare the build status with `verification.status`, the gate entries under `sweetspot`, and the source commit. A candidate may contain useful evidence while still lacking the proof required for promotion. Validate the manifest with `node tools/sma-validate.mjs --manifest examples/build.sweetspot.json`, then run the smoke and integration commands against the real source project before changing its lifecycle state.

