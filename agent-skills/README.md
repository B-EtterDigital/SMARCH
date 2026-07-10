# Agent Skill Adapters

SMA ships two local skills:

- `sma-enforcer`: scan, validate, enforce, report health
- `sma-course-builder`: generate user-facing wiki and courses

Install them into an agent workspace with:

```bash
node ~/DEV/SMARCH/tools/install-agent-skills.mjs \
  --target /path/to/project \
  --platform all
```

Supported platform targets:

- `claude-code`
- `codex`
- `opencode`
- `all`

The installer copies the same canonical skill folders so behavior stays consistent across agents.

