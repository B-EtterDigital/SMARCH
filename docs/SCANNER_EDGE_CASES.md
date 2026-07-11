# Scanner Edge Cases

This reference records repository layouts and naming patterns that can mislead the Sweetspot scanner. Scanner maintainers and project bootstrap owners need it when discovery results look incomplete or inflated. Read it before changing root detection, candidate grouping, archive handling, or component classification. Remember that the scanner should report uncertain structure without promoting it to a trusted brick.

These rules came from bootstrapping Acme Studio as the first full SMA-indexed project.

## Project Root Discovery

Users may pass a container folder, not the real project root.

The scanner must:

- detect nested project roots with `package.json`, `pnpm-workspace.yaml`, or `turbo.json`
- report `scanned_project_roots`
- keep the original `scan_root`
- support `--project-id` when a human wants to force a root

## Archive And Backup Siblings

Large workspaces often contain old deployments, backups, and repair copies beside the active project.

The scanner must skip obvious archive-like folders such as:

- `corrupt-backup`
- `stream_preview_release`
- `fix-push`
- `backup`
- generated collection folders starting with `SSA_SSI_SSTF_SPA_COLLECTION_`

Do not silently merge active and archived code into one registry.

## Candidate Groups Before Candidate Lists

A large monorepo can have hundreds of functions or UI domains.

The scanner must show:

- candidate groups first
- individual candidates second
- hierarchy roles for each candidate

This prevents a 500-item flat list from becoming unusable.

## Components Are Not Bricks By Default

Component folders are useful inventory, but they are not automatically reusable bricks.

The scanner should mark them as `module_candidate` unless a manifest promotes them.

## Bootstrap Is Not Certification

Generated manifests should be `project_bound`.

Bootstrap means:

- the candidate is indexed
- hierarchy is recorded
- provenance is recorded
- security/data assumptions are visible
- promotion work can be tracked

Bootstrap does not mean:

- canonical
- copy-ready
- fully tested
- security-reviewed
- RLS/env complete

## Rescan After Bootstrap

After manifest generation, the next scan should show:

- `unmanifested_count: 0`
- all discovered candidates now in `bricks`
- validation errors at `0`
- validation warnings used as the promotion backlog

If unmanifested candidates remain, the bootstrapper and scanner disagree and the tooling needs to be fixed before moving to the next project.

<!-- docs-i18n: key=docs.scanner-edge-cases; source=en; media=media/{locale}/scanner-edge-cases/ -->
