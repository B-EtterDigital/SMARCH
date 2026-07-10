# Module: gates
- ownership: tools/sma-rule-gate.mjs, tools/sma-scope-drift.mjs, tools/sma-security-gate.mjs, tools/sma-license-gate.mjs …
- lane-default: single-module · allowed_deps: schemas, ci
- gates: npm run gate:all
- graph: graphify-out/modules/gates/graphify-out/graph.json (bootstrap via UV-GA-gates-graph baseline task)
- hot-path borders: package.json, schemas/**, .github/workflows/**, tsconfig.json, README.md, AGENTS.md, sma.gen3.json
- how to work here: uvp next --module gates --tier <yours>; claim --lease → work under Gen3 lanes → complete --evidence-cmd "<gate>"
- SMOA note: executors receive fully-specified packets; design-defining dash work is Fable-implemented or Fable-design-spec'd only.
