# Capsule constraints

The fixture runner enforces these rules mechanically:

1. `src/index.ts` is the capsule's single entry point and must exist.
2. `fixtures/run.json` is mandatory, must contain at least one named fixture, and every fixture must declare both `inputs` and `expected_outputs`.
3. The entry module must default-export a function or export a function named `run`.
4. Source imports must stay inside `src/`. Absolute paths, file URLs, network URLs, and relative paths that escape `src/` are rejected.
5. Bare imports, including npm packages and Node built-ins, are rejected unless their exact specifier appears in `module.sweetspot.json` under `interfaces.ports`. There are no implicit dependencies.
6. Only source files below `src/` are scanned for static imports, re-exports, dynamic imports, and CommonJS `require()` calls.
7. Each fixture runs in a child Node process with the capsule as its working directory and a 30-second timeout.
8. The child environment is cleared. Only variables named by `security.env.variables` are copied from the runner environment.
9. Network access is denied by default. `--allow-net` is the explicit per-run opt-in.
10. On Node runtimes with the permission model, filesystem reads are jailed to the capsule directory and filesystem writes are denied. Capsule trees containing symbolic links are rejected so links cannot escape the jail.
11. On older Node runtimes without compatible permission flags, the runner warns that filesystem enforcement is limited to import-specifier checks, environment clearing, default `fetch` denial, and symlink rejection. That fallback is not an OS sandbox.
12. Fixture outputs must be JSON-serializable and deeply equal `expected_outputs`; every fixture emits one JSON `PASS` or `FAIL` result.

Keep the TypeScript erasable: types may be stripped, but runtime TypeScript features that require transformation are outside this tier.
