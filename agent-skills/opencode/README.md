# OpenCode SMA Skills

Install:

```bash
node ~/DEV/SMARCH/tools/install-agent-skills.mjs \
  --target /path/to/project \
  --platform opencode
```

Target paths:

```text
.opencode/skills/
.agents/skills/
```

Both targets are written so OpenCode-style agents and generic agent runners can load the same SMA enforcement instructions.

