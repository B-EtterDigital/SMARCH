# Agent Skills

This overview explains the supported agent skill packages and the two installation routes provided by SMARCH. Workspace maintainers need it when they add the bundle to Claude Code, Codex, OpenCode, or a generic agent runner. Read it before choosing a plugin install or a project-local install. Remember to regenerate plugin metadata after the skill inventory or package version changes.

## Claude Code plugin

Install the six-skill SMARCH bundle from GitHub in one shell command:

```bash
claude plugin marketplace add B-EtterDigital/SMARCH && claude plugin install smarch@smarch-plugins
```

The plugin registers these namespaced skills:

- `/smarch:sma-gen3`
- `/smarch:f5-ultravisionplan`
- `/smarch:sweetspot-frontend-fix`
- `/smarch:sweetspot-moa`
- `/smarch:sma-enforcer`
- `/smarch:sma-course-builder`

Confirm the installed component inventory with:

```bash
claude plugin details smarch@smarch-plugins
```

For a clean local-profile verification without changing your normal Claude
configuration:

```bash
scratch="$(mktemp -d)"; CLAUDE_CONFIG_DIR="$scratch" claude plugin marketplace add "$PWD" && CLAUDE_CONFIG_DIR="$scratch" claude plugin install smarch@smarch-plugins && CLAUDE_CONFIG_DIR="$scratch" claude plugin details smarch@smarch-plugins
```

Plugin metadata is generated from `skills/inventory.json`; its version always
comes from `package.json`. Regenerate after inventory or version changes and
run the drift check in CI:

```bash
node tools/sma-plugin-sync.mjs
node tools/sma-plugin-sync.mjs --check
```

## Cross-agent workspace installer

The workspace installer copies the core runtime and enforcement skills:

- `sma-gen3`: module ownership, claims, telemetry, Graphify, gates, and collision prevention
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
