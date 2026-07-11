<!-- docs-i18n: key=docs.mcp-server; source=en; media=media/{locale}/mcp-server/ -->
# SMARCH registry MCP server

`node tools/mcp/server.mjs` exposes the local SMARCH registry over MCP stdio.
The client that launches the process is the authentication boundary: the server
opens no port and inherits only that process's filesystem permissions. Read-only
tools declare `registry:read`; `release-install` declares `release:install` and
re-checks every declared and computed write path against the requested target.
The server grants only `registry:read` by default. Launch it with
`SMARCH_MCP_CAPABILITIES=registry:read,release:install` when the parent process
is authorized to invoke the write tool; undeclared capabilities fail before the
handler runs.

## Tool contract

| Tool | Effect | Required capability | Input | Result |
|---|---|---|---|---|
| `brick-get` | Read-only, idempotent | `registry:read` | Required `brick` id, name, or path fragment | One bounded brick record with normalized trust fields |
| `brick-search` | Read-only, idempotent | `registry:read` | Optional `query`, exact `project`, `kind`, and `status`; `limit` 1-100 (default 20) | Ranked, bounded brick summaries and registry snapshot time |
| `brick-trust` | Read-only, idempotent | `registry:read` | Required `brick` id, name, or path fragment | Trust, health, verification, clone-readiness, and data-class details |
| `build-list` | Read-only, idempotent | `registry:read` | Optional exact `project`; `limit` 1-100 (default 20) | Readiness-ranked curated builds, bounded to `limit` |
| `registry-doctor` | Read-only, idempotent | `registry:read` | Empty object | Snapshot paths/times, totals, validation, trust, build, and scanner health |
| `registry-why-blocked` | Read-only, idempotent | `registry:read` | `query` string; optional `type`: `auto`, `brick`, `build`, or `project` | Matched target, readiness, blocker codes, and evidence details |
| `release-install` | Filesystem write when `write=true`; idempotent for the same release/target | `release:install` | `brick`, exact `version`, `target`; optional `write` and `force` booleans | Store install plan/result after artifact and computed-write containment checks |
| `server-card` | Read-only, idempotent | `registry:read` | Empty object | Server identity, transport, repository, capabilities, and tool names |

All schemas deny unknown properties. Invalid types, missing fields, empty
identifiers, and unsupported enum values return `MCP_INVALID_INPUT` without
echoing arbitrary payloads. Diagnostic arrays, object breadth, nesting, and
strings are capped so corrupt or unusually large snapshots cannot create an
unbounded response. Search and build lists enforce a hard maximum of 100
results. These tools do not issue network requests or retry. Read-only calls have a
500 ms timeout. Release installation has a 10 s process-local timeout and does
not retry because a retry could repeat filesystem work.

## Errors and telemetry

Errors use the MCP error result shape:

```json
{"error":{"code":"MCP_INVALID_INPUT","message":"Invalid input for registry-why-blocked","details":{"field":"type","expectation":"one of: auto, brick, build, project"}}}
```

Expected codes are `MCP_INVALID_INPUT`, `MCP_CAPABILITY_REQUIRED`, `MCP_BRICK_NOT_FOUND`, `MCP_TARGET_NOT_FOUND`,
`MCP_REGISTRY_MISSING`, `MCP_RELEASE_INSTALL_REFUSED`, `MCP_TIMEOUT`, and
`MCP_INTERNAL_ERROR`. Unexpected dependency messages are replaced with the safe
`MCP_INTERNAL_ERROR` text. Failures write one structured JSON event to stderr
with `area`, `severity`, `event`, `code`, and `duration_ms`; request arguments
are never logged.

## Examples

```json
{"name":"brick-get","arguments":{"brick":"acme-cms.approval-flow"}}
{"name":"brick-search","arguments":{"query":"approval","project":"acme-cms","limit":20}}
{"name":"brick-trust","arguments":{"brick":"acme-cms.approval-flow"}}
{"name":"build-list","arguments":{"project":"acme-cms","limit":20}}
{"name":"registry-doctor","arguments":{}}
{"name":"registry-why-blocked","arguments":{"query":"acme-cms.approval-flow","type":"brick"}}
{"name":"release-install","arguments":{"brick":"approval-flow","version":"1.0.0","target":"/workspace/app","write":false}}
{"name":"server-card","arguments":{}}
```

Run `node tools/mcp/selftest.mjs` for direct handler, failure-injection,
containment, latency, and real SDK stdio coverage.
