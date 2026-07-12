# OpenCode SMA Skills

This guide shows how to install the SMARCH skill bundle for OpenCode-compatible agents. Developers who use OpenCode or a generic agent runner need it during workspace setup. Read it before running the installer or checking the two supported skill locations. Remember that both target directories receive the same enforcement instructions.

Install:

```bash
node tools/install-agent-skills.ts \
  --target /path/to/project \
  --platform opencode
```

Target paths:

```text
.opencode/skills/
.agents/skills/
```

Both targets are written so OpenCode-style agents and generic agent runners can load the same SMA enforcement instructions.

