# Capsule

A capsule is the smallest runnable Sweetspot brick: one erasable-TypeScript entry point and one or more declarative fixtures.

Adapt `module.sweetspot.json`, implement `src/index.ts`, and keep `fixtures/run.json` aligned with the public behavior. The entry point must default-export a function (a named `run` export is also accepted) that receives each fixture's `inputs` and returns its `expected_outputs`, synchronously or asynchronously.

Run it from the SMARCH repository:

```bash
node tools/sma-brick-run.mjs path/to/capsule
```

Read `CONSTRAINTS.md` before adding imports, environment variables, or files.
