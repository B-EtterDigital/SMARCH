# Module: schemas
- ownership: schemas/**, tools/lib/schema-types/**
- lane-default: shared-hot-path · allowed_deps: —
- gates: npm run validate:gen3 -- all
- graph: graphify-out/modules/schemas/graphify-out/graph.json (bootstrap via UV-SC-schemas-graph baseline task)
- hot-path borders: package.json, schemas/**, .github/workflows/**, tsconfig.json, README.md, AGENTS.md, sma.gen3.json
- how to work here: uvp next --module schemas --tier <yours>; claim --lease → work under Gen3 lanes → complete --evidence-cmd "<gate>"
- SMOA note: executors receive fully-specified packets; design-defining dash work is Fable-implemented or Fable-design-spec'd only.
