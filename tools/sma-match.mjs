#!/usr/bin/env node
/**
 * WHAT: Ranks registered bricks against a plain-language product vision.
 * WHY: Builders need a fast shortlist of reusable parts before starting new implementation.
 * HOW: Tokenizes the vision and compares it with brick purpose, tags, names, and metadata.
 * INPUTS: Vision text or file, registry paths, status threshold, and result limit.
 * OUTPUTS: Human-readable or structured ranked brick matches with supporting signals.
 * CALLERS: Discovery workflows and operators planning reuse for a new product.
 * Usage: `node tools/sma-match.mjs --registry registry/global-modules.generated.json --vision "local dashboard" --top 5`
 */
/**
 * sma-match: match a product vision against the brick registry.
 *
 * Usage:
 *   node tools/sma-match.mjs --vision "I want to build an Electron app with multi-provider chat and screen capture"
 *   node tools/sma-match.mjs --vision-file ./vision.txt --top 15 --min-status candidate
 *
 * Ranking signals (token overlap, weighted):
 *   - purpose match  (3×)
 *   - tag match      (2×)
 *   - use_when match (2×)
 *   - name / path match (1×)
 *   - brick status boost: canonical +8, candidate +4, project_bound +0
 *   - filter-score tiebreak (if reuse_all_scored.json is available)
 *
 * Output: a ranked list of bricks with id, project, status, score, purpose,
 * clone_steps, and a one-line "why matched". If the output is a TTY, prints a
 * tidy report; otherwise prints JSON so it's easy to pipe into an agent.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { smaPath } from "./lib/sma-paths.mjs";

function parseArgs(argv) {
  const opts = {
    registry: smaPath("scans/all-projects/latest.registry.json"),
    scores: smaPath("security/reuse_all_scored.json"),
    cards: smaPath("security/brick_cards.jsonl"),
    vision: "",
    visionFile: "",
    top: 20,
    minStatus: "project_bound",
    json: false,
    compact: false  // emit compact brick cards for agent ingestion
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const n = argv[i + 1];
    if (a === "--registry" && n) { opts.registry = path.resolve(n); i += 1; }
    else if (a === "--scores" && n) { opts.scores = path.resolve(n); i += 1; }
    else if (a === "--cards" && n) { opts.cards = path.resolve(n); i += 1; }
    else if (a === "--vision" && n) { opts.vision = n; i += 1; }
    else if (a === "--vision-file" && n) { opts.visionFile = path.resolve(n); i += 1; }
    else if (a === "--top" && n) { opts.top = Number(n); i += 1; }
    else if (a === "--min-status" && n) { opts.minStatus = n; i += 1; }
    else if (a === "--json") { opts.json = true; }
    else if (a === "--compact") { opts.compact = true; opts.json = true; }
  }
  return opts;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "for", "with", "without", "in",
  "on", "at", "by", "from", "be", "is", "are", "was", "were", "it", "its",
  "this", "that", "these", "those", "as", "into", "that's",
  "i", "you", "we", "they", "them", "their", "my", "our",
  "want", "need", "like", "build", "create", "make", "get", "have", "has", "had",
  "app", "app's", "application", "apps", "thing", "stuff", "something"
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9+\-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function tokenSet(text) {
  return new Set(tokenize(text));
}

function overlap(aSet, bTokens) {
  if (!aSet.size || !bTokens.length) return 0;
  let hits = 0;
  for (const t of bTokens) if (aSet.has(t)) hits += 1;
  return hits;
}

async function readJson(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); }
  catch { return null; }
}

async function readManifest(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); }
  catch { return null; }
}

const statusRank = { project_bound: 0, candidate: 1, canonical: 2 };

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.vision && opts.visionFile) {
    opts.vision = await fs.readFile(opts.visionFile, "utf8");
  }
  if (!opts.vision) {
    console.error("error: provide --vision \"...\" or --vision-file <path>");
    process.exit(2);
  }

  const visionTokens = [...tokenSet(opts.vision)];
  if (!visionTokens.length) {
    console.error("error: no usable keywords in vision");
    process.exit(2);
  }

  const registry = await readJson(opts.registry);
  if (!registry?.bricks) {
    console.error(`error: cannot load registry at ${opts.registry}`);
    process.exit(2);
  }
  const scored = await readJson(opts.scores);
  const filterScoreById = new Map();
  if (scored?.scored) for (const s of scored.scored) filterScoreById.set(s.id, s.score);

  const results = [];
  for (const b of registry.bricks) {
    const mf = await readManifest(b.manifest_path);
    const sem = mf?.semantics || {};
    const purposeTokens = tokenSet(sem.purpose || "");
    const tagTokens = new Set((sem.tags || []).map((t) => String(t).toLowerCase()));
    const useWhenTokens = tokenSet((sem.use_when || []).join(" "));
    const nameTokens = tokenSet(`${b.name || ""} ${(b.source_paths || []).join(" ")} ${(b.domain || []).join(" ")}`);
    const compactTokens = tokenSet(`${sem.compact?.tagline || ""} ${(sem.compact?.hashtags || []).join(" ")} ${(sem.compact?.verbs || []).join(" ")}`);

    const purposeHits = overlap(purposeTokens, visionTokens) * 3;
    const tagHits = overlap(tagTokens, visionTokens) * 2;
    const useWhenHits = overlap(useWhenTokens, visionTokens) * 2;
    const nameHits = overlap(nameTokens, visionTokens) * 1;
    const compactHits = overlap(compactTokens, visionTokens) * 2;

    let score = purposeHits + tagHits + useWhenHits + nameHits + compactHits;
    if (score <= 0) continue;

    const status = b.status || "project_bound";
    if (opts.minStatus && statusRank[status] < statusRank[opts.minStatus]) continue;

    if (status === "canonical") score += 8;
    else if (status === "candidate") score += 4;

    const filterScore = filterScoreById.get(b.id);
    if (typeof filterScore === "number") score += filterScore / 20;

    results.push({
      id: b.id,
      name: b.name,
      project: b.project,
      status,
      kind: b.kind,
      paths: b.source_paths,
      score: Math.round(score * 10) / 10,
      filter_score: filterScore ?? null,
      purpose: sem.purpose || null,
      matched_tags: (sem.tags || []).filter((t) => visionTokens.includes(String(t).toLowerCase())),
      clone_steps: sem.clone_steps || null,
      public_api: sem.public_api || null,
      compact: sem.compact || null
    });
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, opts.top);

  if (opts.compact) {
    // Emit one JSON line per brick in the compressed 8-key form ready for
    // agent ingestion. Each line is ~30-45 tokens.
    for (const r of top) {
      const c = r.compact;
      const line = {
        id: r.id,
        p: r.project,
        s: r.status,
        k: r.kind,
        t: c?.tagline || (r.purpose ? r.purpose.slice(0, 110) : null),
        h: c?.hashtags || (r.matched_tags || []).slice(0, 6).map((x) => `#${x}`),
        i: c?.inputs || [],
        o: c?.outputs || [],
        v: c?.verbs || [],
        score: r.score
      };
      console.log(JSON.stringify(line));
    }
    return;
  }

  if (opts.json || !process.stdout.isTTY) {
    console.log(JSON.stringify({
      vision: opts.vision.slice(0, 500),
      vision_tokens: visionTokens.slice(0, 30),
      total_matched: results.length,
      top: opts.top,
      bricks: top
    }, null, 2));
    return;
  }

  console.log(`\nVision: ${opts.vision.trim().slice(0, 300)}\n`);
  console.log(`Keywords: ${visionTokens.slice(0, 15).join(", ")}`);
  console.log(`Matched ${results.length} bricks (showing top ${top.length}):\n`);
  for (const r of top) {
    console.log(`  [${r.score}]  ${r.project}/${r.name || r.id}  (${r.status}, ${r.kind})`);
    if (r.purpose) console.log(`    • ${r.purpose.slice(0, 180)}`);
    if (r.matched_tags?.length) console.log(`    • tags: ${r.matched_tags.join(", ")}`);
    if (r.paths?.[0]) console.log(`    • ${r.paths[0]}`);
  }
  console.log();
}

main().catch((err) => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });
