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

interface CompactOptions {
  candidates: string; out: string; limit: number; concurrency: number; overwrite: boolean;
  project: string; filter: string; minScore: number; timeoutMs: number; model: string; dryRun: boolean;
}
interface CompactBrick {
  id: string; name?: string; project?: string; kind?: string; status?: string;
  source_paths?: string[]; score?: number; manifest_path: string;
}
interface CompactCard {
  tagline: string;
  hashtags: string[];
  inputs: string[];
  outputs: string[];
  verbs: string[];
  token_budget?: number;
}
interface CompactSemantics {
  purpose?: string; tags?: string[]; public_api?: string[]; use_when?: string[];
  reuse_archetype?: string; enrichment_source?: string; compact?: CompactCard;
  compact_at?: string; compact_source?: string;
}
interface CompactManifest { semantics?: CompactSemantics }

function parseArgs(argv: string[]): CompactOptions {
  const o: CompactOptions = {
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
    if (a === "--overwrite") o.overwrite = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (n && applyCompactOption(o, a, n)) i += 1;
  }
  return o;
}

function applyCompactOption(options: CompactOptions, flag: string, value: string) {
  if (flag === "--candidates") options.candidates = path.resolve(value);
  else if (flag === "--out") options.out = path.resolve(value);
  else if (flag === "--limit") options.limit = Number(value);
  else if (flag === "--concurrency") options.concurrency = Number(value);
  else if (flag === "--project") options.project = value;
  else if (flag === "--filter") options.filter = value.toLowerCase();
  else if (flag === "--min-score") options.minScore = Number(value);
  else if (flag === "--timeout") options.timeoutMs = Number(value) * 1000;
  else if (flag === "--model") options.model = value;
  else return false;
  return true;
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

async function readJson(p: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await fs.readFile(p, "utf8"));
  return parsed;
}

// Rough token estimate: 4 chars per token (GPT tokenizer average).
function estimateTokens(card: CompactCard) {
  const blob = [card.tagline, ...card.hashtags, ...card.inputs, ...card.outputs, ...card.verbs].join(" ");
  return Math.ceil(blob.length / 4) + 8; // +8 for keys/structure
}

function buildPrompt(brick: CompactBrick, manifest: CompactManifest) {
  const sem = manifest.semantics ?? {};
  return `Compress this software-brick into a token-efficient agent-readable card. The card is loaded into an LLM's context alongside hundreds of siblings, so every word must earn its place.

## Brick
- id: ${brick.id}
- name: ${String(brick.name)}
- project: ${String(brick.project)}
- kind: ${String(brick.kind)}
- status: ${brick.status ?? "project_bound"}
- source_paths: ${JSON.stringify(brick.source_paths ?? [])}

## Known semantics
- purpose: ${sem.purpose ?? "(none)"}
- tags: ${JSON.stringify(sem.tags ?? [])}
- public_api: ${JSON.stringify((sem.public_api ?? []).slice(0, 8))}
- use_when: ${JSON.stringify((sem.use_when ?? []).slice(0, 3))}
- archetype: ${sem.reuse_archetype ?? "unknown"}

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

async function loadCandidates(opts: CompactOptions): Promise<CompactBrick[]> {
  const document = objectValue(await readJson(opts.candidates));
  let bricks = Array.isArray(document?.bricks) ? document.bricks.map(parseCompactBrick).filter((brick): brick is CompactBrick => brick !== null) : [];
  if (opts.minScore > 0) bricks = bricks.filter((brick) => (brick.score ?? 0) >= opts.minScore);
  if (opts.project) bricks = bricks.filter((brick) => brick.project === opts.project);
  if (opts.filter) {
    const f = opts.filter;
    bricks = bricks.filter((brick) =>
      brick.id.toLowerCase().includes(f) ||
      (brick.name ?? "").toLowerCase().includes(f) ||
      (brick.source_paths ?? []).some((sourcePath) => sourcePath.toLowerCase().includes(f))
    );
  }
  if (opts.limit > 0) bricks = bricks.slice(0, opts.limit);
  return bricks;
}

function parseCompactBrick(value: unknown): CompactBrick | null {
  const brick = objectValue(value);
  if (!brick || typeof brick.id !== "string" || typeof brick.manifest_path !== "string") return null;
  return { id: brick.id, manifest_path: brick.manifest_path, name: optionalString(brick.name), project: optionalString(brick.project),
    kind: optionalString(brick.kind), status: optionalString(brick.status), source_paths: stringList(brick.source_paths),
    score: typeof brick.score === "number" ? brick.score : undefined };
}

function parseCompactManifest(value: unknown): CompactManifest {
  const document = objectValue(value);
  const semantics = objectValue(document?.semantics);
  if (!semantics) return {};
  const compact = objectValue(semantics.compact);
  return { semantics: { purpose: optionalString(semantics.purpose), tags: stringList(semantics.tags), public_api: stringList(semantics.public_api),
    use_when: stringList(semantics.use_when), reuse_archetype: optionalString(semantics.reuse_archetype), enrichment_source: optionalString(semantics.enrichment_source),
    compact: compact && typeof compact.tagline === "string" ? { tagline: compact.tagline, hashtags: stringList(compact.hashtags), inputs: stringList(compact.inputs),
      outputs: stringList(compact.outputs), verbs: stringList(compact.verbs), token_budget: typeof compact.token_budget === "number" ? compact.token_budget : undefined } : undefined,
    compact_at: optionalString(semantics.compact_at), compact_source: optionalString(semantics.compact_source) } };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const candidates = await loadCandidates(opts);
  console.error(`compacting ${String(candidates.length)} brick(s) (concurrency=${String(opts.concurrency)})...`);
  const { items, manifests } = await collectCompactionItems(candidates, opts);

  console.error(`queued ${String(items.length)} (skipped ${String(candidates.length - items.length)} already-compact or unenriched)`);

  let processed = 0, cache = 0, failed = 0;
  const writes: { brick: CompactBrick; mf: CompactManifest }[] = [];

  await codexBatch(items, {
    concurrency: opts.concurrency,
    model: opts.model,
    timeoutMs: opts.timeoutMs,
    onResult: (wrapped) => {
      processed += 1;
      const r = wrapped.result;
      if ("error" in r) { failed += 1; console.error(`  ${wrapped.id}: ${r.error}`); return; }
      if (r.fromCache) cache += 1;
      const brick = candidates.find((b: { id: string; }) => b.id === wrapped.id);
      const mf = manifests.get(wrapped.id);
      if (!brick || !mf) return;
      const data = objectValue(r.data);
      if (!data) { failed += 1; console.error(`  ${wrapped.id}: invalid compact payload`); return; }
      const compact: CompactCard = {
        tagline: stringValue(data.tagline),
        hashtags: stringList(data.hashtags),
        inputs: stringList(data.inputs),
        outputs: stringList(data.outputs),
        verbs: stringList(data.verbs)
      };
      compact.token_budget = estimateTokens(compact);
      mf.semantics = mf.semantics ?? {};
      mf.semantics.compact = compact;
      mf.semantics.compact_at = new Date().toISOString();
      mf.semantics.compact_source = "codex-gpt-5.4";
      writes.push({ brick, mf });
      if (processed % 10 === 0) console.error(`  ${String(processed)}/${String(items.length)}  cache=${String(cache)} fail=${String(failed)}`);
    }
  });

  if (!opts.dryRun) await writeCompactedManifests(writes);

  // Re-emit brick_cards.jsonl from ALL manifests (not just ones processed this round)
  // so the file is always a complete snapshot.
  const lines = buildCardLines(candidates, manifests);
  await fs.mkdir(path.dirname(opts.out), { recursive: true });
  await fs.writeFile(opts.out, lines.join("\n") + (lines.length ? "\n" : ""));

  // Token-budget summary
  let totalTokens = 0;
  for (const { mf } of writes) {
    totalTokens += (mf.semantics?.compact?.token_budget ?? 0);
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

async function collectCompactionItems(candidates: CompactBrick[], options: CompactOptions) {
  const items: { id: string; prompt: string; schema: typeof SCHEMA }[] = [];
  const manifests = new Map<string, CompactManifest>();
  for (const brick of candidates) {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(brick.manifest_path, "utf8"));
      const manifest = parseCompactManifest(parsed);
      manifests.set(brick.id, manifest);
      if (!options.overwrite && manifest.semantics?.compact?.tagline) continue;
      if (manifest.semantics?.enrichment_source !== "codex-gpt-5.4" || !manifest.semantics.purpose) continue;
      items.push({ id: brick.id, prompt: buildPrompt(brick, manifest), schema: SCHEMA });
    } catch {
      // A missing or malformed manifest is excluded from this best-effort batch.
    }
  }
  return { items, manifests };
}

async function writeCompactedManifests(writes: { brick: CompactBrick; mf: CompactManifest }[]) {
  for (const { brick, mf } of writes) {
    try {
      await fs.writeFile(brick.manifest_path, `${JSON.stringify(mf, null, 2)}\n`);
    } catch {
      // Later aggregate regeneration exposes any manifest that stayed unchanged.
    }
  }
}

function buildCardLines(candidates: CompactBrick[], manifests: Map<string, CompactManifest>) {
  const lines: string[] = [];
  for (const brick of candidates) {
    const compact = manifests.get(brick.id)?.semantics?.compact;
    if (!compact?.tagline) continue;
    lines.push(JSON.stringify({ id: brick.id, p: brick.project, s: brick.status ?? "project_bound", k: brick.kind, t: compact.tagline,
      h: compact.hashtags, i: compact.inputs, o: compact.outputs, v: compact.verbs }));
  }
  return lines;
}

main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
