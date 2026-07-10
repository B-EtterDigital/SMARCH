# Module: smoa
- ownership: tools/sma-codex*.mjs, tools/lib/codex-runner.mjs, tools/lib/workforce/**, tools/sma-smoa-token-summary.mjs
- lane-default: single-module · allowed_deps: schemas, reg, ci
- gates: node tools/sma-codex-profile.mjs selftest
- graph: graphify-out/modules/smoa/graphify-out/graph.json (bootstrap via UV-SM-smoa-graph baseline task)
- hot-path borders: package.json, schemas/**, .github/workflows/**, tsconfig.json, README.md, AGENTS.md, sma.gen3.json
- how to work here: uvp next --module smoa --tier <yours>; claim --lease → work under Gen3 lanes → complete --evidence-cmd "<gate>"
- SMOA note: executors receive fully-specified packets; design-defining dash work is Fable-implemented or Fable-design-spec'd only.
