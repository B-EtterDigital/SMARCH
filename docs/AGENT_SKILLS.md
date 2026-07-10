# Agent Skills

SMA works best when the agent can load the rules automatically.

The canonical SMA skills live in:

```text
~/DEV/SMARCH/skills/
  sma-enforcer/
  sma-course-builder/
```

Install them into a project:

```bash
node ~/DEV/SMARCH/tools/install-agent-skills.mjs \
  --target /path/to/project \
  --platform all
```

## Platform Targets

| Platform | Target |
|----------|--------|
| Claude Code | `.claude/skills/` |
| Codex | `.codex/skills/` plus `AGENTS.md` SMA snippet |
| OpenCode | `.opencode/skills/` and `.agents/skills/` |

OpenCode documents that it loads matching `skills/*/SKILL.md` under `.opencode/`, `.claude/skills/`, and `.agents/skills/`. Claude Code documents project and user skill folders with `SKILL.md` frontmatter.

## Skills

### sma-enforcer

Purpose:

- scan project bricks
- validate manifests
- report health/status/provenance
- enforce canonical blockers
- generate wiki output

### sma-course-builder

Purpose:

- generate user-facing brick pages
- generate beginner course material
- teach lifecycle before acronyms

## Rule

If an agent changes a reusable module, it should either update the brick manifest or explicitly state why the module is not an SMA brick.

