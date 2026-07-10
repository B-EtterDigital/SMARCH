# Module: mcp
- ownership: tools/mcp/**
- lane-default: single-module · allowed_deps: schemas, reg, prov, ci, evals
- gates: node tools/mcp/selftest.mjs
- graph: graphify-out/modules/mcp/graphify-out/graph.json (bootstrap via UV-MC-mcp-graph baseline task)
- hot-path borders: package.json, schemas/**, .github/workflows/**, tsconfig.json, README.md, AGENTS.md, sma.gen3.json
- how to work here: uvp next --module mcp --tier <yours>; claim --lease → work under Gen3 lanes → complete --evidence-cmd "<gate>"
- SMOA note: executors receive fully-specified packets; design-defining dash work is Fable-implemented or Fable-design-spec'd only.
