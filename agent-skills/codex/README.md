# Codex SMA Skills

Install:

```bash
node ~/DEV/SMARCH/tools/install-agent-skills.mjs \
  --target /path/to/project \
  --platform codex
```

Target paths:

```text
.codex/skills/
AGENTS.md snippet from templates/agents/AGENTS.sma.md
```

Codex also reads project instructions, so the AGENTS snippet makes enforcement visible even when a skill loader is not active.

