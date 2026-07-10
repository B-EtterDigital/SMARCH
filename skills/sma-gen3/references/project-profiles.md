# SMA Gen3 Project Profiles

This skill is universal. Profiles are command hints, not separate skills.

> The profiles below describe a **fictional example portfolio** (`acme-*`).
> Replace them with profiles for your own projects; keep the same shape.

## Generic Modular SMA Repo

Detection:
- `package.json`, `.github/workflows`, `AGENTS.md`, `CLAUDE.md`, module folders, docs/plans, docs/compliance.
- If `sma.gen3.json` is missing, start with bootstrap rather than assuming Acme Desktop commands.

Global SMA root:
- `~/DEV/SMARCH`

Minimum portable scripts:
- `sma:gen3`
- `sma:gen3:json`
- `sma:gen3:check`
- module Graphify check/refresh commands or `~/DEV/SMARCH` wrapper usage
- project telemetry audit
- project release/SMA gate

Hot paths to map in every repo:
- package/dependency files,
- CI workflow files,
- app shell/router/layout,
- auth/session/entitlements,
- telemetry/SRS or equivalent,
- agent instruction files,
- build/release/deploy files,
- native/platform code.

Portfolio refresh from `~/DEV/SMARCH`:
- `npm run scan:safe`
- `npm run state:safe`
- `npm run gen3:dashboard`
- `npm run ci:gen3`
- `npm run stats:summary -- --since 7d`

Refresh after module/manifests/build/release/agent-rule changes or before reporting portfolio numbers. Use leases; do not regenerate global artifacts concurrently.

Mandatory module Graphify from `~/DEV/SMARCH`:
- `npm run graphify:check:modules -- --project <project-id> --strict`
- `npm run graphify:refresh:modules -- --project <project-id> --global`
- `npm run graphify:refresh:modules -- --project <project-id> --missing-only --limit 25 --global`
- `npm run graphify:query -- --project <project-id> --module <module-id> -- "question"`

Graph strategy:
- Module graphs are mandatory for module agents.
- Project graphs are for shared hot paths and cross-module joins.
- The global graph is for portfolio/cross-project discovery, not daily module work.

## Acme Desktop

Classification:
- `pnpm sma:gen3 -- --changed-file <path>`
- `pnpm sma:gen3:json`
- `pnpm sma:gen3:check`

Core gates:
- `pnpm typecheck:js`
- `pnpm run srs:audit`
- `pnpm run sma:release-gate`
- `pnpm sma:graphify:modules:check`
- `git diff --check`

Focused Gen3 tests:
- `node --test scripts/__tests__/sma-gen3-control-plane.test.mjs`
- `pnpm run test:scripts`

Module gates from current Acme Desktop config:
- MODCHAT: `pnpm typecheck:modchat`, `pnpm sma:claims:strict:json`
- MODCAP: `pnpm typecheck:modcap`, `pnpm sma:modcap-evidence`
- MODDIC: `pnpm typecheck:main`, `pnpm test:0000testing:moddic-reliability`
- MODLINK: `pnpm typecheck:modlink`, `pnpm verify:modlink-release-proof`
- MODTRACK: `pnpm typecheck:modtrack`, `pnpm sma:claims:strict:json`
- MODVIRAL: `pnpm jest src/renderer/modules/modviral/__tests__ --runInBand`, `pnpm sma:claims:strict:json`
- MODBRO: `pnpm jest src/renderer/modules/modbro/__tests__ --runInBand`, `pnpm sma:check:strict:json`
- MODCODE: `pnpm modcode:sync:audit:json`, `pnpm typecheck:main`
- SUPABASE: `pnpm sma:supabase-evidence`, `pnpm test:scripts`

SRS maintenance:
- `pnpm run srs:audit`
- `pnpm run srs:audit:strict`
- `pnpm srs:coverage`
- `pnpm srs:guardian`
- `pnpm srs:autopilot:strict`
- `pnpm srs:autopilot:status`

## Acme Suite / ACME-STUDIO

Known roots:
- `~/DEV/Projects/acme-studio-workspace`
- `~/DEV/Projects/acme-studio-workspace/acme-studio`

Bootstrap notes:
- Inspect root `AGENTS.md` and `CLAUDE.md` first.
- Treat the app shell, package files, CI workflows, stream/preview/release branches, and AI instruction docs as shared hot paths until mapped.
- If project commands differ, add a project-local profile doc or comments in `sma.gen3.json`; do not fork this skill.

## Acme Factory

Known root:
- `~/DEV/Projects/acme-factory`

Bootstrap notes:
- Inspect `CLAUDE.md`, `acme-factory_ai_instructions.md`, package scripts, `.github/workflows`, and module directories before planning.
- Treat architecture docs, package files, server/client boundary, CI workflows, and AI instruction docs as shared hot paths until mapped.
- If project commands differ, add a project-local profile doc or comments in `sma.gen3.json`; do not fork this skill.

## Hook Health

Codex:
- `jq . ~/.codex/hooks.json`
- `codex plugin list`

Claude:
- `jq . ~/.claude/settings.json ~/.claude/settings.local.json`

After hook edits, run a harmless command that includes realistic shell syntax and a nested agent smoke if startup behavior changed.

## Cost Policy

Default is free-local-first. Do not enable Blacksmith, Depot, Nx Cloud, or other paid acceleration without an explicit user request.
