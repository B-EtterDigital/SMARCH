# Influences and Credits

SMARCH grew from practical work and from ideas shared openly by other builders. This page records the clearest parts of that lineage and the specific lessons we carried forward.

## Pierre / code.storage, diffs.com, and trees.software

[Code Storage](https://code.storage/changelog/introducing-code-storage), [diffs.com](https://diffs.com/), and [trees.software](https://trees.software/) are Pierre Computer Company tools for code storage, diff display, and file-tree display.

SMARCH borrowed the `installRelease(id, version)` API shape for `sma-store`, so a brick release is addressed by identity and version. Its Gen-3 wiki loads the published diffs.com and trees.software renderer packages from their CDNs and calls their documented APIs; SMARCH deliberately does not reimplement either renderer (rendering falls back gracefully when the packages are unavailable).

## Sakana Fugu

[Sakana Fugu](https://sakana.ai/fugu-beta/) is a learned multi-agent orchestration system that coordinates a pool of models.

SMOA learned from Fugu that much of a multi-agent system's intelligence can live in the aggregation layer. Selecting, coordinating, and combining agents matters more than treating their outputs as a simple average.

## OpenRouter Fusion

[OpenRouter Fusion](https://openrouter.ai/docs/guides/features/plugins/fusion) is a multi-model analysis workflow built around a panel, a judge, and a final synthesizer.

SMOA borrowed that separation of responsibilities. Its synthesis contract preserves consensus, contradictions, and blind spots instead of flattening every response into one undifferentiated merge.

## Hermes MoA

[Hermes MoA](https://hermes-agent.nousresearch.com/docs/user-guide/features/mixture-of-agents) is Nous Research's mixture-of-agents provider for combining reference models with an acting aggregator.

Its published HermesBench result showed that the paired configuration could outperform either participating model alone. That evidence helped shape SMOA's use of deliberate model pairing and cross-review.

Sakana Fugu, OpenRouter Fusion, and Hermes MoA are the direct orchestration lineage for SMOA.

## Entire

[Entire](https://docs.entire.io/overview) is a system of record for preserving the context behind agent-assisted code changes.

Its emphasis on preserving why, not only what changed, informed SMARCH's append-only agent-context layer. SMARCH records intent, decisions, rejected alternatives, and handoffs so later agents can recover the reasoning behind a change.

## Zed

[Zed's parallel-agent work](https://zed.dev/parallel-agents) brings multiple agent threads into one editor and makes their concurrent work visible.

Zed helped sharpen SMARCH's framing of the multi-agent coordination gap: running several agents is easier than keeping their ownership, in-flight intent, and collisions understandable. SMARCH addresses that gap with leases, agent-context records, conflict reports, and controller views.

## Theo Browne / t3.gg and Lakebed

[Theo Browne](https://t3.gg/) is a developer and public commentator on agent-assisted software, and [Lakebed](https://docs.lakebed.dev/) is an adjacent constraint-first, agent-native runtime for small full-stack applications called capsules.

Theo's commentary helped sharpen the public description of the Gen-3 coordination gap. Lakebed's tightly bounded capsule model inspired the capsule-grade brick tier on SMARCH's roadmap (planned, not yet shipped — see `.UltraVision/`), while remaining a separate project with a different runtime scope.

## Superpowers by Jesse Vincent

[Superpowers](https://github.com/obra/superpowers) by Jesse Vincent is a software-development methodology distributed as composable skills for coding agents.

It demonstrated that engineering methodology can be packaged and shared through agent skills rather than left as informal prompting advice. SMARCH's skill layer follows that distribution path for its own workflows and controls.

## GSD by Lex Christopherson

[GSD, or Get Shit Done](https://github.com/gsd-build/get-shit-done), by Lex Christopherson is a spec-driven planning and execution system for coding agents.

Its approach to durable specifications, phased plans, and context recovery is part of the planning lineage behind SUP and UltraVision. SMARCH applies that lineage within its own brick, gate, lease, and evidence model.

## tree-sitter

[tree-sitter](https://tree-sitter.github.io/tree-sitter/) is a parser generator and incremental parsing library commonly used for syntax-tree extraction.

SMARCH uses tree-sitter as a term of art when discussing AST extraction, but it is not integrated today. The planned benchmark and go/no-go evaluation are recorded in the [UltraVision quality and release plan](../.UltraVision/08-QUALITY-RELEASE-PLAN.md).

## GraphRAG

[GraphRAG](https://github.com/microsoft/graphrag) is Microsoft's graph-based retrieval pattern for extracting structured knowledge and using it to support retrieval-augmented generation.

Graphify follows the broader graph-retrieval pattern and emits a plain nodes/links/edges JSON graph usable as input to graph-retrieval pipelines. That is a loose interoperability gesture, not compatibility with Microsoft GraphRAG's knowledge-model tables or Parquet outputs, and not a claim that SMARCH embeds GraphRAG.

## SLSA, in-toto, SPDX, and CycloneDX

[SLSA](https://slsa.dev/), [in-toto](https://in-toto.io/), [SPDX](https://spdx.dev/), and [CycloneDX](https://cyclonedx.org/) are supply-chain security, provenance, and software bill-of-materials standards.

SMARCH's `sma-attest*` toolchain emits minimal hand-built documents in these formats (in-toto Statement v1, SLSA Provenance v1, SPDX 2.3, CycloneDX 1.5) and verifies selected required fields — deliberate small-surface adoption, not full-spec validation or certified tooling.

## NASA

[NASA](https://www.nasa.gov/reference/systems-engineering-handbook/) is the United States civil space agency, whose engineering guidance includes disciplined systems thinking and verification practices.

SMARCH draws inspiration from fault isolation and checklist discipline. This is explicitly not a certification claim, and the project's [public positioning rules](./PUBLIC_POSITIONING.md) prohibit language such as "NASA-grade" except when explaining inspiration rather than certification.

## AGENTS.md standard

[AGENTS.md](https://github.com/openai/agents.md) is an OpenAI-originated, open repository convention for giving coding agents project-specific instructions.

SMARCH adopts the convention as the predictable entry point for agent guidance. Project rules can therefore travel with the repository and be read by tools that support the standard.

If we missed an influence or described one incompletely, please open a pull request so we can correct the record.
