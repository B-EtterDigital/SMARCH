# Claude Code SMA Skills

This guide shows how to install the SMARCH skill bundle for Claude Code and where the installer places it. Developers who want Claude Code to follow Sweetspot project rules need it during workspace setup. Read it before running the installer or checking whether the skill files landed in the expected directory. Remember to install into the target project rather than the SMARCH source checkout.

Install:

```bash
node ~/DEV/SMARCH/tools/install-agent-skills.mjs \
  --target /path/to/project \
  --platform claude-code
```

Target path:

```text
.claude/skills/
```

