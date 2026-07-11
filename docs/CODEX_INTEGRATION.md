<!-- docs-i18n: key=docs.codex-integration; source=en; media=media/{locale}/codex-integration/ -->
# SMA × Codex CLI integration

This guide explains how local Codex commands enrich and query the Sweetspot brick registry. Operators who maintain agent-facing documentation and registry intelligence need it during setup or troubleshooting. Read it before running the integration commands or interpreting their generated output. Remember that Codex enriches checked-in project evidence; it does not replace validation of the source bricks.

SMA can use the locally-installed `codex` CLI (OpenAI Codex, model `gpt-5.4`) to
turn the brick registry from a structural catalogue into an agent-queryable
knowledge base with MSDN-grade documentation, cross-brick connections, auto-
generated starter tests, and a vision → bricks ranker.

This document is the user-facing guide. [FRAMEWORK.md](FRAMEWORK.md) explains the architecture it extends.

## Prerequisites

- `codex` CLI on PATH (`codex --version` should print something).
- You're logged in: `codex login` once. Tokens you already have on the machine
  are reused.
- Node 20+ (already required elsewhere in SMA).

Smoke test:

```bash
npm run codex:ping
# Should print PONG
```

## The six Codex-powered workflows

The shared runner underpins six user-facing workflows:

| Tool | Script | What it does |
|---|---|---|
| Runner | `tools/lib/codex-runner.ts` | Thin wrapper: `codex exec --output-schema`, disk cache at `~/.cache/sma-codex/`, bounded-concurrency batch runner. All other tools use this. |
| Enrich | `npm run codex:enrich` | For each reuse-candidate brick, reads up to 6 KB of source and writes real `purpose`, `use_when`, `do_not_use_when`, `public_api`, `tags`, `clone_steps`, `risks`, `reuse_archetype`, `related_concepts` to the manifest's `semantics` block. Replaces the earlier heuristic-synthesized values. |
| Connect | `npm run codex:connect` | For each brick, picks K neighbours by tag-Jaccard and asks Codex to classify the relationship (`depends_on`, `composes_with`, `alternative_to`, `supersedes`, `shared_concept`, etc.) with confidence + reason. Outputs `security/brick_connections.json` and per-manifest `semantics.connections`. |
| Tests | `npm run codex:test` | For each candidate brick lacking a sibling test, asks Codex to write a minimal vitest/deno/node test importing the brick's public API. Enables candidate → canonical promotion. |
| Wiki | `npm run codex:wiki` | Generates MSDN/rustdoc-style per-brick pages under `wiki/bricks-detailed/<project>/<slug>.md`. Each page has full per-symbol API reference (signature, params, returns, throws, remarks, example, see-also), configuration matrix, installation + integration recipe, related-brick graph, troubleshooting table, FAQ, caveats, references. A companion `<slug>.portable.md` is written alongside — self-contained, droppable into the host project's `docs/` folder when you clone the brick. |
| Rank | `npm run codex:rank -- --vision "..."` | Pre-filters the registry by token overlap, then asks Codex to return a full integration plan with ordered selected bricks, integration steps, missing capabilities, and risks. |
| Scan-helper | `npm run codex:scan-helper -- --root /path/to/project` | Asks Codex to look at files not yet covered by any manifest and flag real bricks hiding in the long tail. |

One-shot runner:

```bash
npm run codex:all -- --project acme-desktop --limit 50
```

Runs: filter → enrich → connect → tests → promote → wiki → wiki-index.

## What each step writes

```
security/
├── reuse_all_scored.json              # filter output (every brick with score + reasons)
├── reuse_candidates.json              # filter keepers (default threshold 40)
└── brick_connections.json             # cross-brick edge list

# per-brick manifests under the source tree get enriched in place:
<project>/<path>/module.sweetspot.json  (or <file>.module.sweetspot.json for file bricks)
  {
    "semantics": {
      "purpose": "...",                     # written by codex-gpt-5.4
      "use_when": [...],
      "do_not_use_when": [...],
      "public_api": [...],
      "tags": [...],
      "clone_steps": [...],
      "risks": [...],
      "reuse_archetype": "...",
      "related_concepts": [...],
      "connections": [{ target, kind, confidence, reason }],
      "wiki_page": "wiki/bricks-detailed/<project>/<slug>.md",
      "wiki_portable_page": "wiki/bricks-detailed/<project>/<slug>.portable.md",
      "enrichment_source": "codex-gpt-5.4"
    }
  }

wiki/bricks-detailed/
├── README.md              # master index (every brick, by project)
├── TAGS.md                # reverse index by tag
├── ARCHETYPES.md          # grouped by reuse_archetype
└── <project>/
    ├── INDEX.md
    ├── <slug>.md          # MSDN-grade reference page
    └── <slug>.portable.md # self-contained portable doc
```

## Typical workflows

### Stage a new project around reused bricks

```bash
# 1. Describe your vision
VISION="Build an Electron app: WorkOS auth, multi-provider chat, screen capture, \
audio transcription with fallback, Stripe billing, Supabase backend."

# 2. Get the ranked plan
npm run codex:rank -- --vision "$VISION" --top 12 > my-plan.json

# 3. Review the plan; pick the bricks you'll actually use.
# 4. For each chosen brick, read its wiki page — selected_bricks[i].paths tells you
#    which file(s) to copy, and the wiki page has the clone_steps + integration recipe.

# 5. Drop the brick + its .portable.md into the target project's docs/
cp -r $SOURCE_BRICK_DIR $TARGET/src/lib/<brick>
cp $SMA/wiki/bricks-detailed/<project>/<brick>.portable.md $TARGET/docs/<brick>.md
```

### Enrich + document a single brick group (cheap)

```bash
# Just the WorkOS auth group
npm run codex:all -- --filter workos --limit 10
```

### Grow canonical coverage without touching code

```bash
# Generate tests for all candidates; re-promote
npm run codex:test
npm run promote
```

## Cost control

- **Disk cache.** Every `codex exec` call is keyed by
  `sha256(model + prompt + schema)`. Identical prompts are free after the first
  run. Inspect or clear with `~/.cache/sma-codex/`.
- **Concurrency.** `--concurrency N` controls parallel Codex calls. Default is
  a conservative 2–3.
- **Scoped runs.** Always combine with `--filter`, `--project`, or
  `--limit` on first try. Full-registry runs are expensive.
- **Status filtering.** `codex:wiki --statuses canonical,candidate` skips
  project-bound bricks without relying on a point-in-time registry count.

## Extending

- Add new SMA heuristics to `tools/sma-filter.ts` (non-LLM).
- Add new semantic fields to the schema in `tools/sma-codex-enrich.ts`;
  existing manifests are non-destructively extended.
- Swap the model: every tool accepts `--model <name>`; default is
  `gpt-5.4`. The runner works with any model `codex exec -m` accepts.
- Embeddings? Drop a `tools/sma-embed.mjs` that writes cached vectors to disk
  and add `--embeddings` to `sma-match` / `sma-codex-rank`. The runner already
  batches; an embeddings layer would be a thin addition.

## Known limits

- Codex CLI's structured-output mode requires *every* property to appear in
  `required`. Optional fields are modelled as arrays that can be empty, not as
  omitted keys.
- The wrapper runs Codex with `--sandbox read-only --skip-git-repo-check`. If
  you need Codex to *edit* anything, use a separate invocation. The wrapper is
  read-only on purpose.
- Prompts include up to ~12 KB of source/docs per brick. Bricks whose core
  behaviour lives outside that window may get a shallower doc. Point the
  prompt at a different entry file via a sibling `OVERVIEW.md` and the tools
  will pick it up automatically.
- Tests generated by `sma-codex-test` are *starter* tests: they compile and
  exercise one happy path. Human review recommended before shipping.
