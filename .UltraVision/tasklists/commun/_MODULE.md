# Module: commun
- ownership: docs/community/**, tools/sma-submit.mjs, .github/ISSUE_TEMPLATE/**, .github/DISCUSSION_TEMPLATE/**
- lane-default: single-module · allowed_deps: schemas, reg, prov, gates, ci
- gates: npm run source:size:gate
- graph: graphify-out/modules/commun/graphify-out/graph.json (bootstrap via UV-CM-commun-graph baseline task)
- hot-path borders: package.json, schemas/**, .github/workflows/**, tsconfig.json, README.md, AGENTS.md, sma.gen3.json
- how to work here: uvp next --module commun --tier <yours>; claim --lease → work under Gen3 lanes → complete --evidence-cmd "<gate>"
- SMOA note: executors receive fully-specified packets; design-defining dash work is Fable-implemented or Fable-design-spec'd only.
