# Brick Template

This guide explains the files and placeholders used to start a portable Sweetspot brick. Brick authors and project integrators need it before copying or adapting this template. Read it when you create the manifest and again before you publish the brick for reuse. Remember to replace every placeholder with evidence that matches the brick's real source, ports, and gates.

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
node tools/sma-validate.mjs --manifest module.sweetspot.json
```
