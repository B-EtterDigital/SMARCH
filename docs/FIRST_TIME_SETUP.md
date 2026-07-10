# First-Time Setup

SMA has two setup paths:

1. New project before coding starts.
2. Existing project that needs to be refactored into SMA.

Both paths install the same rules and skills. The difference is whether manifests are created before code exists or bootstrapped from existing code.

## New Project Before Coding

Use this before the first feature is written:

```bash
node ~/DEV/SMARCH/tools/sma-init-project.mjs \
  --target /path/to/new-project \
  --project-id my-project \
  --name "My Project" \
  --platform all \
  --mode new
```

This creates:

- `.sweetspot/project.json`
- `.sweetspot/modules.json`
- `AGENTS.md` SMA instructions for Codex/OpenCode-style agents
- `CLAUDE.md` SMA instructions for Claude Code
- local SMA skills for Codex, Claude Code, and OpenCode

Then build every reusable feature as a brick from the start:

```text
src/features/my-feature/
  module.sweetspot.json
  index.ts
  components/
  services/
  tests/
```

Before calling the feature done, run:

```bash
node ~/DEV/SMARCH/tools/sma-scan.mjs \
  --root /path/to/new-project \
  --out /path/to/new-project/.sweetspot/scans/latest.registry.json \
  --check

node ~/DEV/SMARCH/tools/sma-security-gate.mjs \
  --root /path/to/new-project
```

## Existing Project Refactor

Use the dashboard server:

```bash
node ~/DEV/SMARCH/tools/sma-dashboard-server.mjs \
  --wiki ~/DEV/SMARCH/wiki \
  --scans ~/DEV/SMARCH/scans \
  --allow-root ~/DEV \
  --port 4777
```

Open:

```text
http://127.0.0.1:4777/
```

Then:

1. Browse to the project folder.
2. Run `First-Time Setup`.
3. Read the generated project dashboard.
4. Open `Feature Clusters` to understand which bricks belong to the same user-facing feature area.
5. Treat security findings and manifest warnings as the refactor backlog.
6. Promote bricks from `project_bound` to `candidate` only after evidence exists.
7. Promote to `canonical` only after validation, security, RLS/env, tests, and review pass.

## Agent Harness Setup Only

Install or refresh SMA skills and instruction snippets:

```bash
node ~/DEV/SMARCH/tools/install-agent-skills.mjs \
  --target /path/to/project \
  --platform all
```

Supported platforms:

- `codex`: installs `.codex/skills` and appends `AGENTS.md`
- `claude-code`: installs `.claude/skills` and appends `CLAUDE.md`
- `opencode`: installs `.opencode/skills`, `.agents/skills`, and appends `AGENTS.md`
- `all`: installs every supported harness

Use `--no-instructions` when you only want the skill files and do not want to append project instructions.

## Refactor Order

For existing projects, do not try to make everything canonical at once.

Use this order:

1. Clear high/critical security findings.
2. Fix env contracts and exposed secret setup.
3. Fix RLS/storage access contracts for private data.
4. Split oversized files and bloated bricks.
5. Add tests and performance evidence.
6. Record provenance and review events.
7. Promote the best bricks to `candidate`.
8. Promote only proven bricks to `canonical`.

## Rule Of Honesty

`project_bound` is not failure. It means the code is indexed and visible.

The failure is pretending unreviewed project-specific code is reusable. SMA should make the truth obvious before it makes anything look impressive.
