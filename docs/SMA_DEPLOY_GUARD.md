# Deploy Guard — serialized, stamped, verified releases

Push-style CLI deploys (`netlify deploy`, `vercel deploy`, an `rsync` to a server) are last-writer-wins with zero visibility: whoever runs the command last owns production, regardless of what their tree contains. With parallel agents this failed twice in one day — first two sessions racing deploys from divergent copies, then a *sequential*, protocol-compliant deploy from a stale snapshot tree that silently destroyed another lane's shipped UI. A lock stops races; it does not stop content loss. The deploy guard (`sma deploy-guard`, `tools/sma-deploy-guard.mjs`) is the engine's answer: it refuses bad deploys mechanically instead of trusting agents to remember doctrine, and it is the only sanctioned way to ship a [Gen3](GLOSSARY.md#gen3) project to an external deploy target.

## The five refusals

Every deploy must pass all preconditions, or the guard exits 11 and nothing is built:

1. **Canonical tree only** (`not-canonical-tree`) — the invoking directory's git toplevel must equal the absolute `canonicalRoot` declared in `sma.deploy.json`. A `/tmp` snapshot or worktree copy carries the same config with the same absolute path, so it can never pass this check. This is the refusal that ends stale-snapshot deploys.
2. **Clean tree only** (`dirty-tree`) — uncommitted work must never ship: it creates production state that exists in no tree, which the next deploy is then forced to destroy. The stamp records the exact commit that is live.
3. **Pushed only** (`unpushed` / `no-upstream`) — HEAD must exist on the upstream so every other lane can fetch and integrate what production runs.
4. **Fast-forward only** (`live-not-ancestor`) — the guard fetches the live stamp and refuses unless the currently-live commit is an ancestor of HEAD: "production has work your tree does not include; integrate first." This is the rule that stops sequential clobbers. Rollbacks require `--force "<reason>"` *and* `SMA_DEPLOY_FORCE_ACK=1`, and the override is recorded in the stamp.
5. **Provable state** (`live-unreachable`) — if the live stamp cannot be fetched, the fast-forward check cannot run, so the guard refuses (a 404 is treated as a first-deploy bootstrap, not an error). `--allow-unverified-live` overrides knowingly, recorded in the stamp.

Around the refusals: an atomic lock at `<canonicalRoot>/.sma/deploy-lock` serializes deploys per target (exit 12 when held, stale locks reaped after `lock.ttlSeconds`), preconditions are re-checked after the lock is acquired to close the race window, and after "deploy is live" the guard polls the live stamp until production serves **exactly** the stamp it just shipped — anything else is exit 13 and names whose deploy is actually live.

## Configuration

Create `sma.deploy.json` at the project root (the file's directory must be the canonical tree, and `canonicalRoot` must be that absolute path):

```json
{
  "project": "my-web-app",
  "canonicalRoot": "/absolute/path/to/the/canonical/checkout",
  "build": "pnpm build",
  "deploy": "netlify deploy --prod --dir=dist",
  "stampPath": "public/deploy-stamp.json",
  "liveStampUrl": "https://my-app.example.com/deploy-stamp.json",
  "verify": { "attempts": 12, "delaySeconds": 5 },
  "lock": { "ttlSeconds": 1800 }
}
```

Add `stampPath` and `.sma/` to `.gitignore` — the stamp is generated per deploy, and a tracked stamp would dirty the tree it certifies. `stampPath` must land inside whatever the build serves statically so the deployed site exposes it at `liveStampUrl`.

## Commands

```bash
node tools/sma-deploy-guard.mjs --why "what this deploy is"
node tools/sma-deploy-guard.mjs --dry-run          # evaluate refusals, ship nothing
node tools/sma-deploy-guard.mjs --status           # print the live stamp (whose build is live?)
SMA_DEPLOY_FORCE_ACK=1 node tools/sma-deploy-guard.mjs --why "roll back v3" --force "v3 broke sign-in"
```

Exit codes: `0` verified live, `2` usage/config error, `11` precondition refused, `12` deploy lock held, `13` deploy ran but production serves someone else's stamp.

## Diagnosing a stale-looking production

Fetch `liveStampUrl` before blaming caches — the stamp names the deployer, commit, tree, time, and reason for whatever is actually live. If the commit there is not in your tree, integrate before you ship; deploying over it destroys it.

## Doctrine

This tool is the mechanical form of the sma-gen3 skill's "External Deploy Targets" section: deploy targets are shared hot paths; one release owner deploys the canonical branch; lane agents never release; raw CLI deploys are forbidden where a guard exists — and adding the guard is part of the first deploy task in any project that lacks one.
