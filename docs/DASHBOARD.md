<!-- docs-i18n: key=docs.dashboard; source=en; media=media/{locale}/dashboard/ -->
# Dashboards

SMARCH currently provides two local dashboard surfaces plus a read-only SPA API backend: a wiki server for generated project documentation, a generated Gen3 controller dashboard for coordination state, and authenticated live data endpoints. This guide separates those working tools from the planned Blueprint Ledger web product.

## Choose the surface

| Need | Surface | Current command |
| --- | --- | --- |
| Browse a generated wiki | Local wiki server | `npm run dashboard` |
| Inspect leases, conflicts, dirty ownership, graphs, and work slots | Generated Gen3 dashboard | `npm run gen3:dashboard` |
| Read live lease, conflict, registry, and graph data | Authenticated SPA API | `node tools/sma-dashboard-server.mjs` |
| Use the Blueprint Ledger application shell, lease board, conflict strip, or brick wall | Planned M3 web dashboard | Not implemented yet |

## Serve a generated wiki

The package script serves `wiki/` on loopback by default:

```bash
npm run dashboard
```

## Serve the SPA API

The SPA API server requires authentication even on loopback. Configure either
one legacy operator token (all dashboard scopes) or a JSON map of scoped
credentials:

```bash
export SMA_DASHBOARD_AUTH_TOKEN='replace-with-a-long-random-token'
node tools/sma-dashboard-server.mjs --host 127.0.0.1 --port 4777
```

For least-privilege credentials, `SMA_DASHBOARD_AUTH_TOKENS` is a JSON object
whose keys are audit subjects and whose values contain `token` and `scopes`:

```json
{
  "dashboard-reader": {
    "token": "replace-with-a-long-random-token",
    "scopes": [
      "dashboard:leases:read",
      "dashboard:conflicts:read",
      "dashboard:registry:read",
      "dashboard:graph:read",
      "dashboard:events:read"
    ]
  }
}
```

The server denies requests when authentication is not configured. The legacy
token receives `dashboard:*`; scoped credentials are preferred. The API is
read-only, `--unsafe-mutations` is rejected, and a token does not make public
exposure a managed deployment.

## Dashboard API contract

Every request uses `Authorization: Bearer <token>`. JSON responses include
`Cache-Control: no-store` and an `X-Request-ID` header. The event stream uses
`Cache-Control: no-cache, no-transform` and carries its request ID in the ready
event. Result sets are bounded to 500 rows. Unknown query parameters, duplicate
parameters, invalid enum values, and out-of-range limits are rejected rather
than coerced.

| Endpoint | Required scope | Query | Result limit |
| --- | --- | --- | --- |
| `GET /api/leases` | `dashboard:leases:read` | `limit` (default 200) | 500 |
| `GET /api/conflicts` | `dashboard:conflicts:read` | `limit`, `days`, `status=all|open|resolved`, `project` | 500 |
| `GET /api/registry` | `dashboard:registry:read` | `limit`, `project`, `status=all|candidate|verified|canonical|deprecated` | 500 bricks and 500 project summaries |
| `GET /api/graph` | `dashboard:graph:read` | `limit` | 500 modules |
| `GET /api/events` | `dashboard:events:read` | none | 100 replayed events |

Example:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $SMA_DASHBOARD_AUTH_TOKEN" \
  'http://127.0.0.1:4777/api/conflicts?status=open&limit=100'
```

All five endpoints are safe and idempotent to retry. Read endpoints have a
500 ms server timeout; clients may retry `502` and `504` with bounded
exponential backoff and jitter. Do not retry validation, authentication, or
authorization failures until the request or credential changes.

Errors never include stack traces or storage paths:

```json
{
  "error": {
    "code": "DASH_API_FORBIDDEN",
    "message": "The authenticated principal is not authorized for this operation",
    "request_id": "4e0d4035-5d23-4f79-bcbb-c058ca0fd300"
  }
}
```

| Status | Codes |
| --- | --- |
| 400 | `DASH_API_VALIDATION` |
| 401 | `DASH_API_UNAUTHENTICATED` |
| 403 | `DASH_API_FORBIDDEN` |
| 404 | `DASH_API_NOT_FOUND` |
| 405 | `DASH_API_METHOD_NOT_ALLOWED` |
| 502 | `DASH_API_STORAGE` |
| 503 | `DASH_API_AUTH_UNAVAILABLE` |
| 504 | `DASH_API_TIMEOUT` |
| 500 | `DASH_API_INTERNAL` |

### SSE reconnect behavior

`GET /api/events` sends `retry: 3000`, event IDs, a ready event, and a heartbeat
comment every 15 seconds. Browsers reconnect automatically and send
`Last-Event-ID`; the server replays up to the most recent 100 events before
resuming live delivery. A reconnect older than that bounded window receives
the available tail and the next ready event, so clients should refresh the
corresponding read endpoint after any reconnect.

Run the real transport/storage, authorization, failure-injection, SSE, and P95
selftest with:

```bash
node tools/sma-dashboard-server.mjs --selftest
```

## Build the Gen3 controller dashboard

Build the portfolio view:

```bash
npm run gen3:dashboard
```

Build a project-scoped view without overwriting the global file:

```bash
npm run gen3:dashboard -- --project sma
```

The project output defaults to `wiki/projects/sma/GEN3_DASHBOARD.generated.html`. It summarizes controller state; it does not replace the source registries, lease ledger, conflict records, or gate output.

Before assigning agents, prefer the compact live snapshot:

```bash
npm run controller:snapshot:quiet -- --project sma
```

Regenerate the dashboard after meaningful controller changes. Do not edit generated HTML by hand.

## Read verdicts correctly

- A passing gate proves only the command and inputs it evaluated.
- An active lease identifies current ownership; it does not prove completed work.
- A dirty-unleased group is an integration blocker until claimed, cleaned, or conflict-reported.
- A graph gap is a retrieval warning; use the module's real gates for correctness.
- Predicted gains are forecasts until an observation receipt records the actual result.

## Planned Blueprint Ledger surface

The product design calls for a dark-first Blueprint Ledger interface with a live lease board, stamped verdicts, provenance ribbon, conflict heat strip, and brick wall. Those components are M3 work. The generated HTML and wiki server are operational tools available now; they are not evidence that the future web application has shipped.

When localized screenshots are added, place them under the locale-specific media root declared above and keep every caption and callout in Markdown. This page intentionally uses commands instead of screenshots because the current outputs are deterministic and easier to verify as text.
