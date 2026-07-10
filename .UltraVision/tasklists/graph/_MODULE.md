# Module: graph
- ownership: tools/sma-graphify.mjs, tools/sma-graph-packets.mjs
- lane-default: single-module · allowed_deps: schemas, reg, ci, smoa
- gates: node tools/sma-graphify.mjs selftest
- graph: graphify-out/modules/graph/graphify-out/graph.json (bootstrap via UV-GR-graph-graph baseline task)
- hot-path borders: package.json, schemas/**, .github/workflows/**, tsconfig.json, README.md, AGENTS.md, sma.gen3.json
- how to work here: uvp next --module graph --tier <yours>; claim --lease → work under Gen3 lanes → complete --evidence-cmd "<gate>"
- SMOA note: executors receive fully-specified packets; design-defining dash work is Fable-implemented or Fable-design-spec'd only.
