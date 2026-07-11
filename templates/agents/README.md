# Agent instruction templates

This guide explains the repository instruction templates for Codex, Claude, and OpenCode agents. Project maintainers need it before they install or revise agent rules in another repository. Read it when bootstrapping a project or comparing an installed instruction file with the current template. Remember to adapt project commands and ownership without weakening the shared collision and proof rules.

## Included templates

- `AGENTS.sma.md` for Codex-compatible repository instructions
- `CLAUDE.sma.md` for Claude-compatible repository instructions
- `OPENCODE.sma.md` for OpenCode-compatible repository instructions

## Use

Copy the template that matches the agent surface into the target repository, then replace project placeholders and review every command. Keep the target repository's existing product constraints and merge only the shared Sweetspot rules it needs.

## Verification

Confirm that the installed file points to valid project commands, names the correct project and module boundaries, and preserves the required edit-lease workflow. Run the target project's instruction or agent-profile checks when available.
