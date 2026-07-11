# Tree-sitter extraction spike

Decision: **GO as an augmentation, not a replacement.** Tree-sitter should become the syntax front end for JavaScript, TypeScript, TSX, and Python, while the existing Graphify projection remains responsible for stable semantic nodes, containment, cross-file identity, and query-compatible edge labels.

## Fixture benchmark

Measured 2026-07-11 on `tools/evals/fixtures/portfolio` (40 JS/TS/Python source files, 128,243 bytes). Graphify also scanned 46 manifest/data files, so its semantic counts are deliberately smaller and not one-to-one with raw syntax-tree counts.

| Extractor | Files considered | Nodes | Edges | Call edges / precision | Runtime | Install weight |
|---|---:|---:|---:|---|---:|---:|
| Current Graphify AST projection (`graphify extract --no-cluster`) | 86 code/data | 136 | 93 | 0 call edges; precision n/a | 4.624 s | existing install |
| tree-sitter WASM grammars (JS/TS/TSX/Python) | 40 source | 25,341 named syntax nodes | 25,301 parent edges | 73 call expressions; 71 had a structurally resolvable callee (97.3% syntax-precision proxy) | 0.438 s | 50,924 KiB |

The call figure is a parser-level proxy, not proof of cross-file symbol resolution. Tree-sitter precisely identifies call-expression shapes; a follow-up mapper must resolve those callees to Graphify node IDs and measure precision/recall against a hand-labelled sample before enabling call edges by default.

## Reasoning

- The raw parse was about 10.6 times faster than the current complete projection run on this fixture.
- JS/TS/Python grammar coverage removes regex ambiguity and exposes calls that the current fixture projection omits.
- Raw syntax trees are far too detailed for the public graph; replacing Graphify would inflate 136 useful nodes to more than 25,000 syntax nodes and break query semantics.
- The WASM runtime plus broad grammar pack adds roughly 49.7 MiB. Production should ship only the four required grammars or download them as an optional extractor pack.

Follow-up integration should enter through refresh mode: parse changed source files with pinned WASM grammars, project only declarations/imports/calls into the existing graph schema, preserve stable IDs, add a hand-labelled call-edge evaluation set, and fall back to the current extractor when a grammar is unavailable.
