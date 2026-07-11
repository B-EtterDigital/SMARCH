# Codex SMA Skills

This guide shows how to install the SMARCH skill bundle for Codex and which project instruction files Codex reads. Developers who want Codex to follow Sweetspot project rules need it during workspace setup. Read it before running the installer or debugging a missing skill. Remember that the project instruction snippet keeps the rules visible even when a skill loader is inactive.

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

