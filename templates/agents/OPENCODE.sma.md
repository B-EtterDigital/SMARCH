# SMA Enforcement

This project uses Sweetspot Modular Architecture.

OpenCode rules:

- Treat reusable modules as bricks.
- Add or update `module.sweetspot.json` when creating or changing a reusable brick.
- Keep agent write sets narrow and document handoffs.
- Keep files near the 400-line target and below the 600-line hard limit unless a manifest exception explains why.
- Preserve SSA-v2 boundaries: no frontend secrets, no direct privileged clients, explicit data contracts.
- Preserve SSI isolation for runtime/UI surfaces.
- Run security, validation, and registry checks before promoting a brick.
- Copy bricks; do not move source bricks out of their project.

Useful commands:

```bash
node ~/DEV/SMARCH/tools/sma-scan.mjs --root . --out .sweetspot/scans/latest.registry.json --check
node ~/DEV/SMARCH/tools/sma-security-gate.mjs --root .
node ~/DEV/SMARCH/tools/sma-wiki.mjs --registry .sweetspot/scans/latest.registry.json --out .sweetspot/wiki
```
