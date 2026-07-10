# Module: dash
- ownership: tools/sma-wiki*.mjs, tools/sma-gen3-dashboard.mjs, tools/sma-dashboard-server.mjs, tools/sma-brick-wall-lego.mjs …
- lane-default: single-module · allowed_deps: schemas, reg, coord, graph, ci
- gates: node tools/sma-gen3-dashboard.mjs --selftest
- graph: graphify-out/modules/dash/graphify-out/graph.json (bootstrap via UV-DA-dash-graph baseline task)
- hot-path borders: package.json, schemas/**, .github/workflows/**, tsconfig.json, README.md, AGENTS.md, sma.gen3.json
- how to work here: uvp next --module dash --tier <yours>; claim --lease → work under Gen3 lanes → complete --evidence-cmd "<gate>"
- SMOA note: executors receive fully-specified packets; design-defining dash work is Fable-implemented or Fable-design-spec'd only.
