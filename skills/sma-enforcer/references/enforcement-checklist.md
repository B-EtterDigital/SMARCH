# Enforcement Checklist

For every brick:

- `module.sweetspot.json` exists.
- `brick.status` is honest.
- `source.paths` points to real code.
- source commit or archive hash is recorded.
- public API and adapters are declared.
- data classes are declared.
- env vars are scoped.
- RLS/storage policy is complete when required.
- test commands are listed.
- verification events are not all skipped.
- vulnerability findings are current.
- model/human/tool provenance exists.
- clone steps and known traps are useful.

For canonical bricks:

- score >= 90
- no high or critical findings
- review event exists
- source attestation exists
- clone readiness is `copy_ready` or approved `guided`
- no file over 600 lines
- required env/RLS contracts complete

