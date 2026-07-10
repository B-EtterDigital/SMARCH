# Module: rust
- ownership: rust-core/**
- lane-default: single-module · allowed_deps: reg
- gates: cargo test --manifest-path rust-core/Cargo.toml
- graph: graphify-out/modules/rust/graphify-out/graph.json (bootstrap via UV-RS-rust-graph baseline task)
- hot-path borders: package.json, schemas/**, .github/workflows/**, tsconfig.json, README.md, AGENTS.md, sma.gen3.json
- how to work here: uvp next --module rust --tier <yours>; claim --lease → work under Gen3 lanes → complete --evidence-cmd "<gate>"
- SMOA note: executors receive fully-specified packets; design-defining dash work is Fable-implemented or Fable-design-spec'd only.
