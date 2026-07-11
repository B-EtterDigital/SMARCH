# Token-efficient brick cards

This reference explains the compact brick-card format used to load registry knowledge into an agent context. Tool authors and operators need it when generating cards or choosing how much brick detail to retrieve. Read it before changing the card schema, stream format, or retrieval workflow. Remember that a compact card points to deeper evidence and must not overstate what the full manifest proves.

> "Don't use more of the agent's context than the brick actually deserves."

Every enriched brick manifest now carries a `semantics.compact` block designed
to be loaded into an LLM's context alongside hundreds of siblings without
blowing the window.

## The card shape

Each brick gets a ~30–50 token record with exactly these keys:

| Key | Type | Budget | Purpose |
|---|---|---:|---|
| `tagline` | string | ≤16 words · ≤110 chars | one-sentence description, leads with the verb |
| `hashtags` | `["#…"]` | 4–6 items | semantic match surface for vision keywords |
| `inputs` | `["name:type"]` | 0–4 items | what an integrator passes in |
| `outputs` | `["name:type" or "type"]` | 0–4 items | what the brick produces |
| `verbs` | `["do"]` | 2–4 items | imperative actions the brick performs |
| `token_budget` | int | — | estimated tokens this card adds to a prompt |

## The JSONL stream — `security/brick_cards.jsonl`

One brick per line, one-letter keys for maximum token compression:

```json
{"id":"acme-desktop.acme-desktop.pipeline-file.src-main-services-transcription-cascadepipeline.ts.a09faf73","p":"acme-desktop","s":"canonical","k":"module","t":"Corrects STT text via staged, budgeted cascade.","h":["#stt","#cascade","#latency","#llm"],"i":["text:string","cfg?:CascadeConfig"],"o":["CascadeResult"],"v":["correct","cascade","score"]}
```

| Key | Long name |
|---|---|
| `id` | brick id |
| `p` | project |
| `s` | status (canonical / candidate / project_bound) |
| `k` | kind |
| `t` | tagline |
| `h` | hashtags |
| `i` | inputs |
| `o` | outputs |
| `v` | verbs |

Typical size: **35–50 tokens per brick**. 500 bricks = ~22k tokens —
fits comfortably in a 200k context window, leaving room for vision + plan.

## Typical agent workflow

```
                   ┌──────────────────────────────┐
vision  ──────▶   │  1. Ingest brick_cards.jsonl │  ~22k tokens
                   │     (500 bricks, compact)    │
                   └──────────────┬───────────────┘
                                  │
                         rank by token overlap
                                  │
                                  ▼
                   ┌──────────────────────────────┐
                   │  2. Take top-15 matches      │
                   └──────────────┬───────────────┘
                                  │
                   fetch full semantics ONLY for top 15
                                  │
                                  ▼
                   ┌──────────────────────────────┐
                   │  3. LLM integration plan     │  ~3k tokens
                   │     (full purpose+use_when+  │
                   │      public_api+connections+ │
                   │      clone_steps)            │
                   └──────────────────────────────┘
```

Compare:

|  | Full context | Compact pre-filter |
|---|---:|---:|
| Per brick | ~500–700 tokens | ~40 tokens |
| 500 bricks | ~300k tokens ❌ | ~22k tokens ✅ |
| 1,000 bricks | impossible | ~44k tokens ✅ |

## Generating the cards

```bash
npm run compact                           # all enriched bricks
npm run compact -- --limit 50             # cost-controlled
npm run compact -- --filter workos        # one group only
npm run compact -- --overwrite            # redo existing cards
```

Cached — identical prompts never call Codex twice. Each call uses a tiny
~300-token prompt (we pass the already-enriched `semantics`, not the source)
so the cost per card is negligible.

## Using the compact form

### From the CLI

```bash
# Rank + emit compact cards only (one JSON line per brick)
npm run match -- --vision "transcription with fallback" --compact --top 10
```

### From any agent

Feed the agent:

```
Here are <N> brick cards as NDJSON. Each line has id/p/s/k/t/h/i/o/v.
<paste security/brick_cards.jsonl here>

User vision: <...>

Rank the top 8 bricks that best match this vision.
Return their ids. I will then fetch full semantics for those 8 only.
```

The agent's own context only grew by N × ~40 tokens.

### From `sma-codex-rank`

The LLM-backed ranker now automatically prefers the compact `tagline` over
the verbose `purpose` field when building its prompt. With 500 pre-filtered
bricks, that's a ~10× saving in the prompt sent to Codex, meaning you can
raise `--pre-filter 500` without worrying about context blow-up.

## Where the card lives

Inside each manifest's `semantics` block:

```json
"semantics": {
  "purpose": "…verbose version… (still there for deep drill-down)",
  "tags": ["…"],
  "compact": {
    "tagline": "Corrects STT text via staged, budgeted cascade.",
    "hashtags": ["#stt","#cascade","#latency","#llm"],
    "inputs": ["text:string","cfg?:CascadeConfig"],
    "outputs": ["CascadeResult"],
    "verbs": ["correct","cascade","score"],
    "token_budget": 44
  }
}
```

And as a single line in `security/brick_cards.jsonl`.

Both stay in sync via `npm run compact`.
