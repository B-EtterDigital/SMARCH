# Agent Swarm Rules

Before multi-agent work:

1. Assign each agent a write set.
2. Declare forbidden paths.
3. Declare required checks.
4. Keep shared files owned by one agent.
5. Record handoff notes.
6. Add provenance after edits.

Security-sensitive files require security review:

- auth
- RLS
- env/secrets
- payment
- crypto
- webhooks
- upload
- CI/deploy

