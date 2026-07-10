# Module: evals
- ownership: tools/evals/**
- lane-default: single-module · allowed_deps: schemas, coord, smoa, ci
- gates: node tools/evals/run.mjs --selftest
- graph: graphify-out/modules/evals/graphify-out/graph.json (bootstrap via UV-EV-evals-graph baseline task)
- hot-path borders: package.json, schemas/**, .github/workflows/**, tsconfig.json, README.md, AGENTS.md, sma.gen3.json
- how to work here: uvp next --module evals --tier <yours>; claim --lease → work under Gen3 lanes → complete --evidence-cmd "<gate>"
- SMOA note: executors receive fully-specified packets; design-defining dash work is Fable-implemented or Fable-design-spec'd only.
