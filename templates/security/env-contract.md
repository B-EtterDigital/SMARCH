# Env Contract

Brick:
Date:

| Variable | Scope | Required In | Forbidden In | Example |
|----------|-------|-------------|--------------|---------|
| NAME | server_only | local, preview, production | client_bundle, logs, docs | placeholder |

Scopes:

- `server_only`
- `public_client`
- `ci_only`
- `local_only`

Rules:

- no real secrets in examples
- no server-only variables in frontend bundles
- public variables are treated as public forever

