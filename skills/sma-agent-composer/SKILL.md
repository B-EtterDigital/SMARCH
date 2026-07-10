---
name: sma-agent-composer
description: Compose a new application from the Sweetspot brick registry. Use when the user has a product vision and wants to pick canonical/candidate bricks to reuse. This skill runs sma-codex-rank (LLM-powered vision→bricks), picks the plan, then drives sma-clone to copy selected bricks + their portable docs into a target project with provenance stamped in .sweetspot/imports.json. Read when: user describes a new app and asks "what can we reuse", or explicitly says "compose from bricks", or mentions product features matching registry tags (auth, chat, transcription, billing, etc).
---

# SMA Agent Composer

Use this skill to turn a product **vision** into a **build plan** made from existing Sweetspot bricks. It's the "LEGO for agents" workflow: don't start from scratch; find bricks, pick bricks, clone bricks.

## Inputs you need

1. A clear one-paragraph vision from the user (runtime, features, constraints).
2. An existing (or to-be-created) target project root on disk.
3. Permission to write (the skill is read-only by default until `--write`).

## Default workflow

### 1. Translate the vision into a ranked brick plan

```bash
node ~/DEV/SMARCH/tools/sma-codex-rank.mjs \
  --vision "<user's vision paragraph>" \
  --top 12 \
  --min-status candidate
```

Output is JSON with:

- `selected_bricks[]` — ordered (rank 1..N) list with `id`, `role`, `reason`, `project`, `paths`, `purpose`, `public_api`.
- `integration_plan[]` — ordered prose steps.
- `missing_bricks[]` — capabilities the registry doesn't cover; tell the user they'll have to build those.
- `risks[]` — known integration pitfalls.

Present the plan to the user for approval before writing anything.

### 2. Clone each approved brick into the target

```bash
node ~/DEV/SMARCH/tools/sma-clone.mjs \
  --brick <id> \
  --target /path/to/target/project \
  --write
```

Each clone:

- Copies `source_paths` into the target at the same relative path.
- Copies the `.portable.md` doc into `target/docs/bricks/<slug>.md`.
- Appends a row to `target/.sweetspot/imports.json` with provenance (brick id, source project, commit if available, timestamp, model, clone_steps, integration_recipe, risks).
- Writes a per-brick `target/.sweetspot/clones/<slug>.md` checklist.

### 3. Walk the user through the checklists

After cloning, point the user at the integration checklist files in `target/.sweetspot/clones/` and walk them through:

- npm dependencies to install
- env vars to set (from each brick's configuration matrix)
- tests to run
- re-running `sma-scan` + `sma-promote` in the target so the cloned brick appears in the target's registry.

## Cost control

- Always use `--top` to cap brick candidates for the LLM ranker.
- Re-use cached results: every codex call is keyed by sha256(prompt + schema + model) in `~/.cache/sma-codex/`.
- Use `--min-status candidate` to exclude the 3000+ project-bound bricks that haven't been reviewed.

## When not to use

- If the registry has no matching bricks (`missing_bricks` covers everything). Then just scaffold from scratch.
- If the vision is one file worth of code. Bricks are for reusable modules, not toy scripts.

## Related tools

| Need | Tool |
|---|---|
| Rank bricks for a vision (LLM) | `tools/sma-codex-rank.mjs` |
| Rank bricks without LLM (token overlap) | `tools/sma-match.mjs` |
| Search the registry by keyword | `tools/sma-clone.mjs --search <term>` |
| List all canonical bricks | `tools/sma-clone.mjs --list` |
| Clone a specific brick | `tools/sma-clone.mjs --brick <id> --target <dir> --write` |
| Inspect a brick's MSDN-style docs | `http://127.0.0.1:8787/bricks-detailed/<project>/<slug>.html` after `python3 -m http.server 8787 --directory wiki` |
| Visual brick wall | `http://127.0.0.1:8787/BRICK_WALL_LEGO.generated.html` |
