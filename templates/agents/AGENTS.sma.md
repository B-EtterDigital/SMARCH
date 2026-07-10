# SMA Enforcement

This project uses Sweetspot Modular Architecture.

Rules:

- Treat reusable modules as bricks.
- Add or update `module.sweetspot.json` when creating or changing a reusable brick.
- Run `node ~/DEV/SMARCH/tools/sma-validate.mjs --manifest path/to/module.sweetspot.json` after manifest edits.
- Do not mark a brick `canonical` unless SMA validation passes and a review event exists.
- Record model/agent/human provenance for material changes.
- Copy bricks; do not move source bricks out of their project.
- Keep agent write sets narrow and document handoffs.

Useful commands:

```bash
node ~/DEV/SMARCH/tools/sma-scan.mjs --root . --out .sweetspot/scans/latest.registry.json --check
node ~/DEV/SMARCH/tools/sma-security-gate.mjs --root .
node ~/DEV/SMARCH/tools/sma-wiki.mjs --registry .sweetspot/scans/latest.registry.json --out .sweetspot/wiki
```
