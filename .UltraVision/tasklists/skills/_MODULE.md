# Module: skills
- ownership: skills/**, agent-skills/**, tools/install-agent-skills.mjs, .claude-plugin/**
- lane-default: single-module · allowed_deps: docs, ci
- gates: node tools/install-agent-skills.mjs --check
- graph: graphify-out/modules/skills/graphify-out/graph.json (bootstrap via UV-SK-skills-graph baseline task)
- hot-path borders: package.json, schemas/**, .github/workflows/**, tsconfig.json, README.md, AGENTS.md, sma.gen3.json
- how to work here: uvp next --module skills --tier <yours>; claim --lease → work under Gen3 lanes → complete --evidence-cmd "<gate>"
- SMOA note: executors receive fully-specified packets; design-defining dash work is Fable-implemented or Fable-design-spec'd only.
