# Capsule runtime contract

The runner has two modes:

- Default mode uses every compatible isolation capability it detects. Missing capabilities produce one warning and the run continues with the fallback limits below.
- `--strict-sandbox` refuses to run unless the current Node executable proves that it has the permission model, synchronous `module.registerHooks()`, and permission-scoped network control. Capability probes are authoritative; version numbers are documentation, not the detection mechanism.

`--allow-net` is the only runner option that grants network access. Strict mode passes Node's `--allow-net` only after the network permission probe succeeds.

## Enforced guarantees

| Guarantee | Enforcement mechanism | Node-version floor |
| --- | --- | --- |
| `src/index.ts` exists; fixtures are named and declare `inputs` plus `expected_outputs` | Parent-process manifest and fixture validation before execution | All supported Node versions |
| Literal imports, re-exports, `import()` calls, and `require()` calls receive actionable early errors when they escape `src/` or omit a declared port | Regex source scan | All supported Node versions; fast feedback only, not a security boundary. Computed specifiers can evade this scan |
| Runtime imports stay below `src/`; absolute paths and `file:`, `data:`, `http:`, and `https:` URLs are denied; bare specifiers must exactly match `interfaces.ports` | In-thread synchronous `module.registerHooks()` resolver | Added in Node 22.15.0 and 23.5.0; capability-probed. Required by `--strict-sandbox` |
| Filesystem reads are limited to the capsule and its private runtime temp directory | Node permission model with explicit `--allow-fs-read` grants | Permission model added in Node 20.0.0; stable in 22.13.0 and 23.5.0; capability-probed |
| Filesystem writes are limited to a newly created private runtime temp directory, exposed as `TMPDIR`, `TMP`, and `TEMP` | Node permission model with only `--allow-fs-write=<private-temp>` | Permission model added in Node 20.0.0; capability-probed |
| Child processes and worker threads are denied | Node permission model; the runner never passes `--allow-child-process` or `--allow-worker` | Permission model added in Node 20.0.0; capability-probed |
| Network APIs are denied unless `--allow-net` is present | Node permission model without/with `--allow-net`; `fetch` is also replaced with a deny function when network is off | `--allow-net` is standard in Node 25.0.0; compatible backports are accepted only when both deny and grant probes pass. Required by `--strict-sandbox` |
| `process.binding()` and `process._linkedBinding()` probes fail | Non-configurable runtime guards installed before the capsule entry module loads | Same capability floor as synchronous resolver hooks; defense in depth, not a permission-model guarantee |
| Capsule-provided symbolic links are rejected before any fixture runs | Recursive parent-process directory inspection | All supported Node versions |
| The child receives only declared host variables plus runner-owned private-temp variables | Explicit child `env` object; the host environment is not inherited | All supported Node versions |
| Each fixture is terminated after 30 seconds and must return JSON deeply equal to `expected_outputs` | Parent-process timer, result marker protocol, and deep comparison | All supported Node versions |

## Fallback limits

Without `--strict-sandbox`, the runner remains usable on older or partially capable Node runtimes, but its warning is part of the result contract:

- Without the permission model, filesystem, child-process, worker, and low-level network restrictions are not enforced. The source scan, environment clearing, `fetch` guard, timeout, and symlink rejection still apply.
- Without synchronous resolver hooks, computed specifiers and `data:` imports are not runtime-filtered. Filesystem permissions can still stop out-of-jail file loads, but the regex scan is not a substitute for the resolver hook.
- Without permission-scoped network control, only global `fetch` is denied. Declared low-level networking modules are not contained.
- Passing `--allow-net` on a runtime without compatible network permissions follows that runtime's legacy network behavior and emits a warning.

## Threat boundary

This is a deterministic fixture runner, not an OS sandbox for hostile code. Node documents its permission model as a seat belt for trusted code and explicitly states that malicious code may bypass it. Existing file descriptors, Node/V8 defects, same-user OS signaling, and other runtime or kernel side channels are outside this contract. Use a container, VM, separate OS user, and platform sandboxing when executing untrusted capsules.

Keep TypeScript erasable: type annotations may be stripped, but runtime TypeScript features that require transformation are outside this tier.
