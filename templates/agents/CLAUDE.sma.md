# SMA Enforcement

This project uses Sweetspot Modular Architecture.

Claude Code rules:

- Treat reusable modules as bricks.
- Add or update `module.sweetspot.json` when creating or changing a reusable brick.
- Keep files near the 400-line target and below the 600-line hard limit unless a manifest exception explains why.
- Preserve SSI isolation: lazy safety, error boundary, fallback, and feature/tier/auth gates where relevant.
- Never place service-role keys, provider secrets, or private credentials in client code.
- Record model/agent/human provenance for material changes.
- Copy bricks; do not move source bricks out of their project.
- Run the SMA checks before claiming a brick is ready.

Useful commands:

```bash
node ~/DEV/SMARCH/tools/sma-scan.mjs --root . --out .sweetspot/scans/latest.registry.json --check
node ~/DEV/SMARCH/tools/sma-validate.mjs --registry .sweetspot/scans/latest.registry.json
node ~/DEV/SMARCH/tools/sma-security-gate.mjs --root .
```
