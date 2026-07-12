# SMA Tools

## Scanner

Scan all projects for brick manifests:

```bash
node tools/sma-scan.mjs \
  --root $SMA_PROJECTS_ROOT \
  --out registry/global-modules.generated.json \
  --check
```

The scanner indexes `module.sweetspot.json` files, records validation health, and derives a product-facing `feature_cluster` for each brick. It does not approve canonical status.

## Validator

Validate manifests:

```bash
node tools/sma-validate.mjs \
  --registry registry/global-modules.generated.json
```

## Manifest Bootstrap

Create first-pass project-bound manifests from scanner candidates:

```bash
node tools/sma-bootstrap-manifests.mjs \
  --registry scans/acme-studio/latest.registry.json \
  --write
```

The bootstrapper writes `module.sweetspot.json` files, `.sweetspot/project.json`, `.sweetspot/modules.json`, and a copy of the scan that produced the candidate list. It does not mark anything canonical.

## Security Gate

Run lightweight secret/env checks:

```bash
node tools/sma-security-gate.mjs \
  --root /path/to/project
```

## Wiki And Course Generator

Generate the user-facing wiki and single-page course:

```bash
node tools/sma-wiki.mjs \
  --registry registry/global-modules.generated.json \
  --out wiki
```

This creates:

- `wiki/BRICK_CATALOG.generated.md`
- `wiki/PROJECT_HEALTH.generated.md`
- `wiki/DASHBOARD.generated.html`
- `wiki/BRICK_WALL.generated.html`
- `wiki/FEATURE_CLUSTERS.generated.html`
- `wiki/bricks/<brick-id>.md`
- `wiki/projects/<project-id>.md`
- `wiki/courses/sma-brick-course.generated.html`

## Registry Merge

Merge several project scans into one SMA-level all-project registry:

```bash
node tools/sma-merge-registries.mjs \
  --registry acme-studio=scans/acme-studio/latest.registry.json \
  --registry acme-factory=scans/acme-factory/latest.registry.json \
  --registry acme-desktop=scans/acme-desktop/latest.registry.json \
  --out scans/all-projects/latest.registry.json
```

The merger normalizes project ids at the SMA layer so old manifest source names such as `workspace-root` do not collapse different projects into one dashboard card.

## Dashboard Server

Serve the generated dashboard and enable folder browsing plus scan triggers:

```bash
node tools/sma-dashboard-server.mjs \
  --wiki scans/acme-studio/wiki \
  --scans scans \
  --allow-root ~/Projects \
  --port 4777
```

Static HTML mode is read-only. Scan triggers require the local dashboard server because browsers cannot execute local Node tools from a file URL.

The dashboard has two project actions:

- `Run Scan`: read-only inventory and wiki generation.
- `First-Time Setup`: scan, bootstrap missing manifests as `project_bound`, rescan, generate wiki/dashboard, run security gate, and write project-local `.sweetspot` reports.

## Project Init

Prepare a new project before coding starts:

```bash
node tools/sma-init-project.mjs \
  --target /path/to/new-project \
  --project-id my-project \
  --name "My Project" \
  --platform all \
  --mode new
```

Prepare an existing project for refactor:

```bash
node tools/sma-init-project.mjs \
  --target /path/to/existing-project \
  --project-id existing-project \
  --platform all \
  --mode existing
```

## Agent Skill Installer

Install SMA skills:

```bash
node tools/install-agent-skills.ts \
  --target /path/to/project \
  --platform all
```
