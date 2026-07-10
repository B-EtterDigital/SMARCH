# Brick Template

Copy `module.sweetspot.json` into the root of a reusable module and adapt it.

Required next steps:

1. Fill source project, repository, commit, and paths.
2. Declare public API and adapter points.
3. Declare data classes.
4. Declare env vars and RLS/storage requirements.
5. Add test commands and verification events.
6. Record human, agent, model, and tool provenance.
7. Run:

```bash
node ~/DEV/SMARCH/tools/sma-validate.mjs --manifest module.sweetspot.json
```

