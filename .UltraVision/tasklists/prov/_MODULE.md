# Module: prov
- ownership: tools/sma-attest*.mjs, tools/sma-provenance-*.mjs, tools/sma-anchor.mjs, tools/lib/merkle*.mjs …
- lane-default: single-module · allowed_deps: schemas, ci
- gates: npm run provenance:selftest
- graph: graphify-out/modules/prov/graphify-out/graph.json (bootstrap via UV-PR-prov-graph baseline task)
- hot-path borders: package.json, schemas/**, .github/workflows/**, tsconfig.json, README.md, AGENTS.md, sma.gen3.json
- how to work here: uvp next --module prov --tier <yours>; claim --lease → work under Gen3 lanes → complete --evidence-cmd "<gate>"
- SMOA note: executors receive fully-specified packets; design-defining dash work is Fable-implemented or Fable-design-spec'd only.
