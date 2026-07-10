# Module: capsule
- ownership: templates/capsule/**, tools/sma-brick-new.mjs, tools/sma-brick-run.mjs, tools/sma-brick-inspect.mjs
- lane-default: single-module · allowed_deps: schemas, reg, gates, ci
- gates: node tools/sma-brick-run.mjs --selftest
- graph: graphify-out/modules/capsule/graphify-out/graph.json (bootstrap via UV-CP-capsule-graph baseline task)
- hot-path borders: package.json, schemas/**, .github/workflows/**, tsconfig.json, README.md, AGENTS.md, sma.gen3.json
- how to work here: uvp next --module capsule --tier <yours>; claim --lease → work under Gen3 lanes → complete --evidence-cmd "<gate>"
- SMOA note: executors receive fully-specified packets; design-defining dash work is Fable-implemented or Fable-design-spec'd only.
