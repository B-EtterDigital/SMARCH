# JSON Schema cases

Every directory maps one file in `schemas/` to a reusable `valid.json` and `invalid.json`. Regenerate deterministic fixtures with `node tools/evals/fixtures/schema-cases/generate.mjs`, then run `node tools/evals/fixtures/schema-cases/selftest.mjs`.

The selftest is dependency-free and intentionally fails if a contract introduces a JSON Schema keyword its validator does not understand. It also injects truncated JSON for every valid case, records bounded integrity telemetry, checks lossless JSON round trips, and benchmarks repeated validation. Invalid cases are constraint violations, not malformed files, so downstream suites can load them normally.
