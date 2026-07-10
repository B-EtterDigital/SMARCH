# Module: reg
- ownership: tools/sma-scan.mjs, tools/sma-state.mjs, tools/sma-merge-registries.mjs, tools/sma-store.mjs …
- lane-default: single-module · allowed_deps: schemas, prov, gates, rust, ci
- gates: npm run check
- graph: graphify-out/modules/reg/graphify-out/graph.json (bootstrap via UV-RG-reg-graph baseline task)
- hot-path borders: package.json, schemas/**, .github/workflows/**, tsconfig.json, README.md, AGENTS.md, sma.gen3.json
- how to work here: uvp next --module reg --tier <yours>; claim --lease → work under Gen3 lanes → complete --evidence-cmd "<gate>"
- SMOA note: executors receive fully-specified packets; design-defining dash work is Fable-implemented or Fable-design-spec'd only.
