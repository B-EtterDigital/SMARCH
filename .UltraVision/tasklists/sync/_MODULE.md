# Module: sync
- ownership: tools/sma-sync-public.mjs, docs/SYNC_RUNBOOK.md
- lane-default: single-module · allowed_deps: gates, reg, ci
- gates: node tools/sma-sync-public.mjs --selftest
- graph: graphify-out/modules/sync/graphify-out/graph.json (bootstrap via UV-SY-sync-graph baseline task)
- hot-path borders: package.json, schemas/**, .github/workflows/**, tsconfig.json, README.md, AGENTS.md, sma.gen3.json
- how to work here: uvp next --module sync --tier <yours>; claim --lease → work under Gen3 lanes → complete --evidence-cmd "<gate>"
- SMOA note: executors receive fully-specified packets; design-defining dash work is Fable-implemented or Fable-design-spec'd only.
