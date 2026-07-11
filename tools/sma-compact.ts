#!/usr/bin/env node
/**
 * WHAT: Compresses enriched brick semantics into small agent-readable cards and a line-oriented catalog.
 * WHY: Agents must compare hundreds of bricks without spending their context budget on full manifests and prose descriptions.
 * HOW: Reads enriched candidates and manifests, asks Codex for bounded fields, then updates compact metadata and the shared card catalog.
 * Usage: `node tools/sma-compact.ts --limit 1 --dry-run`
 */
/**
 * sma-compact: produce token-efficient brick cards so agents can load hundreds
 * at once without blowing their context window.
 *
 * Each manifest gains a `semantics.compact` block:
 *
 *   {
 *     tagline:   "≤16-word description",
 *     hashtags:  ["#kw1", ..., "#kw6"],             // ≤6
 *     inputs:    ["name:type", ...],                // ≤4, ≤6 tokens each
 *     outputs:   ["name:type", ...],                // ≤4
 *     verbs:     ["imperative", ...],               // ≤4, action words
 *     token_budget: 42                              // tokenizer-approx estimate
 *   }
 *
 * Also writes security/brick_cards.jsonl — one line per brick:
 *
 *   {"id":"...","p":"acme-desktop","s":"canonical","k":"module","t":"Staged transcription cleanup with latency budgets and per-stage audit records.","h":["#transcription","#cascade","#post-processing"],"i":["raw_text:string"],"o":["CascadeResult"],"v":["correct","cascade"]}
 *
 * Field names are shortened (p/s/k/t/h/i/o/v) so an agent ingesting the file
 * can load ~500 bricks per ~15 KB of context.
 *
 * Uses Codex (cheap — prompts are ~300 tokens) with a strict schema. Cached.
 *
 * Usage:
 *   node tools/sma-compact.ts                # all enriched bricks
 *   node tools/sma-compact.ts --limit 30     # cost-controlled
 *   node tools/sma-compact.ts --filter workos
 */
import fs from "node:fs/promises";
import path from "node:path";
import { codexBatch } from "./lib/codex-runner.ts";
import { smaPath } from "./lib/sma-paths.ts";

function parseArgs(argv): Record<string, any> {
  const o = {
    candidates: smaPath("security/reuse_candidates.json"),
    out: smaPath("security/brick_cards.jsonl"),
    limit: 0,
    concurrency: 4,
    overwrite: false,
    project: "",
    filter: "",
    minScore: 40,
    timeoutMs: 180000,
    model: "gpt-5.4",
    dryRun: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const n = argv[i + 1];
    if (a === "--candidates" && n) { o.candidates = path.resolve(n); i += 1; }
    else if (a === "--out" && n) { o.out = path.resolve(n); i += 1; }
    else if (a === "--limit" && n) { o.limit = Number(n); i += 1; }
    else if (a === "--concurrency" && n) { o.concurrency = Number(n); i += 1; }
    else if (a === "--overwrite") o.overwrite = true;
    else if (a === "--project" && n) { o.project = n; i += 1; }
    else if (a === "--filter" && n) { o.filter = n.toLowerCase(); i += 1; }
    else if (a === "--min-score" && n) { o.minScore = Number(n); i += 1; }
    else if (a === "--timeout" && n) { o.timeoutMs = Number(n) * 1000; i += 1; }
    else if (a === "--model" && n) { o.model = n; i += 1; }
    else if (a === "--dry-run") o.dryRun = true;
  }
  return o;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tagline", "hashtags", "inputs", "outputs", "verbs"],
  properties: {
    tagline: { type: "string" },
    hashtags: { type: "array", items: { type: "string" } },
    inputs: { type: "array", items: { type: "string" } },
    outputs: { type: "array", items: { type: "string" } },
    verbs: { type: "array", items: { type: "string" } }
  }
};

async function readJson(p) { return JSON.parse(await fs.readFile(p, "utf8")); }

// Rough token estimate: 4 chars per token (GPT tokenizer average).
function estimateTokens(card) {
  const blob = [card.tagline || "", ...(card.hashtags||[]), ...(card.inputs||[]), ...(card.outputs||[]), ...(card.verbs||[])].join(" ");
  return Math.ceil(blob.length / 4) + 8; // +8 for keys/structure
}

function buildPrompt(brick, manifest) {
  const sem = manifest.semantics || {};
  return `Compress this software-brick into a token-efficient agent-readable card. The card is loaded into an LLM's context alongside hundreds of siblings, so every word must earn its place.

## Brick
- id: ${brick.id}
- name: ${brick.name}
- project: ${brick.project}
- kind: ${brick.kind}
- status: ${brick.status || "project_bound"}
- source_paths: ${JSON.stringify(brick.source_paths || [])}

## Known semantics
- purpose: ${sem.purpose || "(none)"}
- tags: ${JSON.stringify(sem.tags || [])}
- public_api: ${JSON.stringify((sem.public_api || []).slice(0, 8))}
- use_when: ${JSON.stringify((sem.use_when || []).slice(0, 3))}
- archetype: ${sem.reuse_archetype || "unknown"}

## Your task
Fill the schema. Strict rules:

- \`tagline\`: **exactly one sentence, ≤16 words, ≤110 characters**. Lead with the verb. No marketing words. No "this brick". Example: "Stages transcription cleanup with latency budgets and per-stage audit records."
- \`hashtags\`: 4–6 hashtags starting with '#'. Lowercase, no spaces, use '-' between words. Pick terms an agent would match a user vision against: concrete capabilities, runtimes, domains. Example: ["#transcription","#cascade","#latency-budget","#electron-main"].
- \`inputs\`: 0–4 entries as "name:type". 'name' is short, 'type' is the shape an integrator would actually pass. Use "?" suffix on name if optional. Example: ["text:string","stages?:StageConfig[]"]. If a free function, list its params; if a class, list the primary method's params; if a doc or config, return [].
- \`outputs\`: 0–4 entries as "name:type" or just "type". The shape the brick *produces* that a caller would read/write/emit. Example: ["CascadeResult"] or ["accessToken:string"].
- \`verbs\`: 2–4 imperative verbs the brick *does*. One word each, lowercase. Example: ["correct","cascade","score"]. Use present tense.

Keep total string content under ~140 characters across all fields combined (tagline + tags + inputs + outputs + verbs).

Return only the JSON object.`;
}

async function loadCandidates(opts) {
  const c = await readJson(opts.candidates);
  let bricks = c.bricks || [];
  if (opts.minScore > 0) bricks = bricks.filter((b) => (b.score || 0) >= opts.minScore);
  if (opts.project) bricks = bricks.filter((b) => b.project === opts.project);
  if (opts.filter) {
    const f = opts.filter;
    bricks = bricks.filter((b) =>
      (b.id || "").toLowerCase().includes(f) ||
      (b.name || "").toLowerCase().includes(f) ||
      (b.source_paths || []).some((p) => p.toLowerCase().includes(f))
    );
  }
  if (opts.limit > 0) bricks = bricks.slice(0, opts.limit);
  return bricks;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const candidates = await loadCandidates(opts);
  console.error(`compacting ${candidates.length} brick(s) (concurrency=${opts.concurrency})...`);

  const items = [];
  const manifests = new Map();
  for (const b of candidates) {
    try {
      const mf = JSON.parse(await fs.readFile(b.manifest_path, "utf8"));
      manifests.set(b.id, mf);
      if (!opts.overwrite && mf.semantics?.compact?.tagline) continue;
      // Only compact bricks that were enriched with real (Codex-written) semantics.
      // Heuristic-synthesized purpose strings aren't worth the Codex tokens —
      // their compact would just compress placeholder text into placeholder text.
      if (mf.semantics?.enrichment_source !== "codex-gpt-5.4") continue;
      if (!mf.semantics?.purpose) continue;
      items.push({ id: b.id, prompt: buildPrompt(b, mf), schema: SCHEMA });
    } catch (err) {
      // skip
    }
  }

  console.error(`queued ${items.length} (skipped ${candidates.length - items.length} already-compact or unenriched)`);

  let processed = 0, cache = 0, failed = 0;
  const writes = [];

  await codexBatch(items, {
    concurrency: opts.concurrency,
    model: opts.model,
    timeoutMs: opts.timeoutMs,
    onResult: (wrapped) => {
      processed += 1;
      const r = wrapped.result;
      if (!r.ok) { failed += 1; console.error(`  ${wrapped.id}: ${r.error}`); return; }
      if (r.fromCache) cache += 1;
      const brick = candidates.find((b) => b.id === wrapped.id);
      const mf = manifests.get(wrapped.id);
      if (!brick || !mf) return;
      const compact: Record<string, any> = {
        tagline: r.data.tagline,
        hashtags: r.data.hashtags,
        inputs: r.data.inputs,
        outputs: r.data.outputs,
        verbs: r.data.verbs
      };
      compact.token_budget = estimateTokens(compact);
      mf.semantics = mf.semantics || {};
      mf.semantics.compact = compact;
      mf.semantics.compact_at = new Date().toISOString();
      mf.semantics.compact_source = "codex-gpt-5.4";
      writes.push({ brick, mf });
      if (processed % 10 === 0) console.error(`  ${processed}/${items.length}  cache=${cache} fail=${failed}`);
    }
  });

  if (!opts.dryRun) {
    for (const { brick, mf } of writes) {
      try { await fs.writeFile(brick.manifest_path, `${JSON.stringify(mf, null, 2)}\n`); }
      catch {
        // Best-effort batch write: later aggregate regeneration exposes any manifest that stayed unchanged.
      }
    }
  }

  // Re-emit brick_cards.jsonl from ALL manifests (not just ones processed this round)
  // so the file is always a complete snapshot.
  const lines = [];
  for (const b of candidates) {
    const mf = manifests.get(b.id);
    const c = mf?.semantics?.compact;
    if (!c?.tagline) continue;
    lines.push(JSON.stringify({
      id: b.id,
      p: b.project,
      s: b.status || "project_bound",
      k: b.kind,
      t: c.tagline,
      h: c.hashtags,
      i: c.inputs,
      o: c.outputs,
      v: c.verbs
    }));
  }
  await fs.mkdir(path.dirname(opts.out), { recursive: true });
  await fs.writeFile(opts.out, lines.join("\n") + (lines.length ? "\n" : ""));

  // Token-budget summary
  let totalTokens = 0;
  for (const { mf } of writes) {
    totalTokens += (mf.semantics?.compact?.token_budget || 0);
  }

  console.log(JSON.stringify({
    scanned: candidates.length,
    queued: items.length,
    processed, cache_hits: cache, failed,
    cards_emitted: lines.length,
    estimated_tokens_added: totalTokens,
    avg_tokens_per_card: writes.length ? Math.round(totalTokens / writes.length) : 0,
    jsonl_path: opts.out,
    sample_first_card: lines[0] || null
  }, null, 2));
}

main().catch((err) => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });
