# Security

SMA treats reusable code as supply chain.

## Report A Security Issue

Report vulnerabilities privately via GitHub Security Advisories on this repository (Security tab → Report a vulnerability). Do not publish exploit details until the affected brick is demoted, fixed, or removed.

## Security Gates

Run:

```bash
node tools/sma-security-gate.mjs --root /path/to/project
node tools/sma-validate.mjs --registry /path/to/global-modules.generated.json
```

Canonical bricks cannot have:

- high or critical vulnerability findings
- exposed secrets
- service-role keys in client code
- missing required RLS/storage policy
- missing env contract
- missing security review event for auth, RLS, payment, crypto, upload, webhook, env, or CI/deploy code

## Secret Handling

- Never store real secrets in manifests, docs, examples, screenshots, logs, or wiki output.
- `.env.example` must contain placeholders only.
- Public client variables are public forever.
- Server-only variables must not be imported into frontend modules.

