---
name: sma-enforcer
description: Enforce Sweetspot Modular Architecture in a project by scanning for bricks, validating module.sweetspot.json manifests, reporting brick health/status/provenance, running SMA security and canonical gates, regenerating the brick wiki, AND coordinating multi-agent work via leases and the agent-context log. Use when asked to apply SMA, audit SMA compliance, identify reusable bricks, check canonical readiness, prepare multi-agent work, or enforce SSA/SSI/SSTF/SPE/SRS/SVA/SRLS/SEV gates.
---

# SMA Enforcer

Use this skill when a project should follow Sweetspot Modular Architecture.

## Default Workflow

1. **Acquire a lease** for any brick or regen target you intend to edit (see Lease Protocol).
2. Scan the project for brick manifests.
3. Validate each manifest.
4. Report project health: brick count, statuses, scores, errors, warnings, provenance.
5. Run security gates when requested or before release.
6. Regenerate the wiki (only after acquiring a `wiki-regen` lease).
7. **Append to the agent-context log** for every meaningful action with structured intent and decision.
8. **Release leases** when work is done. Do not orphan leases — release them or rely on TTL expiry.
9. Do not promote any brick to canonical unless validation and governance rules pass.

## Lease Protocol — multi-agent collision avoidance

Before editing a brick, regenerating a generated artifact, or modifying an import-lock, acquire a lease.

```bash
# Edit a brick
node ~/DEV/SMARCH/tools/sma-lease.mjs acquire \
  --resource-kind brick \
  --resource <brick_id> \
  --agent <agent_id> \
  --intent "what you are about to do" \
  --ttl 600

# Regenerate the wiki / dashboard / brick-wall
node ~/DEV/SMARCH/tools/sma-lease.mjs acquire \
  --resource-kind wiki-regen \
  --resource wiki/all-projects \
  --agent <agent_id> \
  --intent "regenerate after brick X promotion"

# Check whether a resource is held before queueing work
node ~/DEV/SMARCH/tools/sma-lease.mjs status \
  --resource-kind brick --resource <brick_id>
# exit 0 = free, 10 = held by other, 11 = held by self
```

Renew long jobs with `sma-lease.mjs renew --lease <id>`. Release on completion with `release --lease <id>`. If a lease has truly lapsed and the prior agent is gone, use `force-acquire --reason "..."` — the registry records the displacement.

**When in doubt, acquire.** A held lease costs nothing for the right agent and prevents the wrong outcome for everyone else.

## Agent-Context Protocol — preserve the why

Every meaningful agent action on a brick should append an event to that brick's
agent-context log. This is the durable "why" that survives across sessions and
agents — the Entire-shaped layer that git does not give you.

```bash
node ~/DEV/SMARCH/tools/sma-context.mjs append \
  --project <project_id> \
  --brick <brick_id> \
  --kind edit_applied \
  --intent "what you are doing" \
  --decision "why this approach" \
  --rejected "alt::reason" \
  --linked-backlog <backlog_id> \
  --lease <lease_id> \
  --file <path>...
```

Required for every edit: `--kind`, `--intent`. Strongly encouraged: `--decision`,
`--lease`, `--linked-backlog` when applicable.

Read prior intent before starting:

```bash
node ~/DEV/SMARCH/tools/sma-context.mjs summarize \
  --project <project_id> --brick <brick_id>
```

## Merge Protocol — when chains diverge

If two agents edited the same brick in separate sessions (lease lapsed, manual
override, push from a second machine), generate a merge proposal that surfaces
the *intents* in addition to the file changes:

```bash
node ~/DEV/SMARCH/tools/sma-merge.mjs propose \
  --project <project_id> --brick <brick_id> --write
```

Then resolve with one of `accepted_a`, `accepted_b`, `manual_merge`,
`discarded_a`, `discarded_b`, `fork`. Resolution is recorded for audit.

## Release Store — install by id+version

Once a release artifact exists at `releases/<brick>/<version>.json`, install it
into a target project by id and version (no manual path tracking required):

```bash
node ~/DEV/SMARCH/tools/sma-store.mjs install \
  --brick <brick_id> --version <v> --target <project_path> --write
```

This is the local Pierre-shape primitive. Hosted variant deferred.

## Validation Commands

Scan:

```bash
node ~/DEV/SMARCH/tools/sma-scan.mjs \
  --root . \
  --out .sweetspot/global-modules.generated.json \
  --check
```

Validate:

```bash
node ~/DEV/SMARCH/tools/sma-validate.mjs \
  --registry .sweetspot/global-modules.generated.json
```

Generate wiki (only after acquiring a wiki-regen lease):

```bash
node ~/DEV/SMARCH/tools/sma-wiki.mjs \
  --registry .sweetspot/global-modules.generated.json \
  --out .sweetspot/wiki
```

Run all:

```bash
node ~/DEV/SMARCH/tools/sma-ci.mjs \
  --root . \
  --registry .sweetspot/global-modules.generated.json \
  --wiki .sweetspot/wiki
```

## Enforcement Rules

- **Lease before edit.** Editing a brick or regenerating a generated artifact without an active lease is a protocol violation. The next pass should flag it.
- **Append intent on every action.** A `touch_event` written to `module.sweetspot.json` without a corresponding agent-context event is a weak signal. The provenance schema now supports `intent`, `decision_rationale`, `rejected_alternatives`, `linked_backlog`, `lease_id`, `context_event_ids` — fill them.
- Treat `canonical` as a claim that must be proven.
- Fail canonical bricks with high/critical security findings.
- Fail canonical bricks missing source commit/archive hash, review event, tests, or clone readiness.
- Warn on missing provenance, skipped verification, score drift, and thin metadata.
- Report every warning clearly; do not hide weak spots behind an average score.
- Keep public language simple: brick, manifest, gate, registry, canonical, lease, context.

## Umbrella CLI

All tools below have a short form via the umbrella binary:

```bash
node ~/DEV/SMARCH/tools/sma.mjs <command> [...args]
# or after `npm link` in ~/DEV/SMARCH:
sma <command> [...args]
```

Common shapes:

```bash
sma lease acquire --resource-kind brick --resource <id> --intent "..."
sma context append --project <id> --brick <id> --kind edit_applied --intent "..."
sma context-check check --project <id> [--strict]
sma merge propose --project <id> --brick <id> --write
sma store install --brick <id> --version <v> --target <project>
sma backfill from-git --manifest <path> --commit <sha> --intent-from-message --project <id>
sma doctor [--project <id>]
sma gen3 dashboard
sma list                      # see all available commands
```

## Promotion Gate

`sma-promote.mjs` accepts the new context-gate flags:

- `--context-gate` — warn when a brick about to be promoted has no active lease (by current agent) and no recent agent-context event. Does not block.
- `--strict-context-gate` — same check, but downgrades the brick to `project_bound` with reason `context-gate-failed`.
- `--context-window-minutes <n>` — how recent a context event must be (default 1440).
- `--no-context-gate` — explicit off (the default).

Use `--strict-context-gate` once your team is consistently appending context events. Until then, `--context-gate` (warn-only) tells you what would have been blocked.

## CI integration

```bash
# Warn-only — surfaces gaps without failing
node ~/DEV/SMARCH/tools/sma-ci.mjs --require-context

# Strict — fails the pipeline on missing context
node ~/DEV/SMARCH/tools/sma-ci.mjs --context-strict

# npm script alias
npm run ci:gen3
```

## Federation Hint

If you are running this SMA registry as an instance among others (multi-machine, mirror, or eventually cross-org), set:

```bash
export SMA_REGISTRY_ORIGIN=https://sma.example.local
```

`sma release`, `sma clone`, and `sma-import-verify` will stamp and check `registry_origin` consistently. The schema fields exist on `brick.manifest`, `release`, and `import-lock`. Runtime federation is deferred — this is the identity-portable seam.

## Dashboards

```bash
sma state                       # regenerate snapshot (writes wiki/SMA_STATE.generated.json)
sma gen3 dashboard              # writes wiki/GEN3_DASHBOARD.generated.html
sma doctor                      # text report including the Gen-3 section
```

## References

- Read `references/enforcement-checklist.md` when reviewing a brick.
- Read `references/agent-swarm-rules.md` before assigning multi-agent work.
- Read `~/DEV/SMARCH/docs/MULTI_AGENT_OPERATIONS.md` for the multi-agent and Gen-3 operating model.
- Read `~/DEV/SMARCH/docs/MULTI_AGENT_OPERATIONS.md` for the operator's guide.
