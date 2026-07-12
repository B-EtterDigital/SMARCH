<!-- docs-i18n: key=docs.agent-skills; source=en; media=media/{locale}/agent-skills/ -->
# Agent Skills

This guide explains the agent skills that install, teach, and enforce Sweetspot Modular Architecture. Agent maintainers and repository operators need it when they configure an automation harness. Read it before enabling a skill or changing how agents discover project rules. Remember that a skill must load the repository contract before it acts.

SMA works best when the agent can load the rules automatically.

The canonical SMA skills live in:

```text
skills/
  sma-enforcer/
  sma-course-builder/
```

Install them into a project:

```bash
node tools/install-agent-skills.ts \
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
