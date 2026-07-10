# Module: docs
- ownership: docs/**, README.md, CONTRIBUTING.md, SECURITY.md …
- lane-default: single-module · allowed_deps: evals
- gates: npm run source:size:gate
- graph: graphify-out/modules/docs/graphify-out/graph.json (bootstrap via UV-DO-docs-graph baseline task)
- hot-path borders: package.json, schemas/**, .github/workflows/**, tsconfig.json, README.md, AGENTS.md, sma.gen3.json
- how to work here: uvp next --module docs --tier <yours>; claim --lease → work under Gen3 lanes → complete --evidence-cmd "<gate>"
- SMOA note: executors receive fully-specified packets; design-defining dash work is Fable-implemented or Fable-design-spec'd only.
