# Module: coord
- ownership: tools/sma-lease.mjs, tools/sma-context*.mjs, tools/sma-conflict.mjs, tools/sma-merge.mjs …
- lane-default: single-module · allowed_deps: schemas, ci
- gates: npm run gen3:selftest
- graph: graphify-out/modules/coord/graphify-out/graph.json (bootstrap via UV-CO-coord-graph baseline task)
- hot-path borders: package.json, schemas/**, .github/workflows/**, tsconfig.json, README.md, AGENTS.md, sma.gen3.json
- how to work here: uvp next --module coord --tier <yours>; claim --lease → work under Gen3 lanes → complete --evidence-cmd "<gate>"
- SMOA note: executors receive fully-specified packets; design-defining dash work is Fable-implemented or Fable-design-spec'd only.
