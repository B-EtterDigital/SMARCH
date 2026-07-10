#!/usr/bin/env node
/**
 * sma-codex-connect: discover how bricks relate to each other.
 *
 * For each anchor brick, we present codex with:
 *   - the anchor brick's semantic block (purpose, tags, kind, paths)
 *   - the semantic blocks of K candidate "neighbours" picked by tag overlap
 * and ask it to classify each pair as one of:
 *   depends_on, depended_by, alternative_to, composes_with, supersedes,
 *   shared_concept, unrelated.
 *
 * Output:
 *   security/brick_connections.json    — graph: { edges: [{from,to,kind,reason}] }
 *   manifest.semantics.connections     — per-brick neighbour list
 */
import fs from "node:fs/promises";
import path from "node:path";
import { codexBatch } from "./lib/codex-runner.mjs";
import { smaPath } from "./lib/sma-paths.mjs";

function parseArgs(argv) {
  const opts = {
    registry: smaPath("scans/all-projects/latest.registry.json"),
    out: smaPath("security/brick_connections.json"),
    candidates: smaPath("security/reuse_candidates.json"),
    limit: 0,
    concurrency: 3,
    neighbours: 8,
    minScore: 40,
    project: "",
    filter: "",
    timeoutMs: 240000,
    model: "gpt-5.4"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const n = argv[i + 1];
    if (a === "--registry" && n) { opts.registry = path.resolve(n); i += 1; }
    else if (a === "--out" && n) { opts.out = path.resolve(n); i += 1; }
    else if (a === "--candidates" && n) { opts.candidates = path.resolve(n); i += 1; }
    else if (a === "--limit" && n) { opts.limit = Number(n); i += 1; }
    else if (a === "--concurrency" && n) { opts.concurrency = Number(n); i += 1; }
    else if (a === "--neighbours" && n) { opts.neighbours = Number(n); i += 1; }
    else if (a === "--min-score" && n) { opts.minScore = Number(n); i += 1; }
    else if (a === "--project" && n) { opts.project = n; i += 1; }
    else if (a === "--filter" && n) { opts.filter = n.toLowerCase(); i += 1; }
    else if (a === "--timeout" && n) { opts.timeoutMs = Number(n) * 1000; i += 1; }
    else if (a === "--model" && n) { opts.model = n; i += 1; }
  }
  return opts;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["edges"],
  properties: {
    edges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["target", "kind", "confidence", "reason"],
        properties: {
          target: { type: "string" },
          kind: { type: "string", enum: ["depends_on", "depended_by", "alternative_to", "composes_with", "supersedes", "shared_concept", "unrelated"] },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          reason: { type: "string" }
        }
      }
    }
  }
};

async function readJson(p) { return JSON.parse(await fs.readFile(p, "utf8")); }

async function loadManifest(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

function brickSummary(brick, manifest) {
  const sem = manifest?.semantics || {};
  return {
    id: brick.id,
    project: brick.project,
    name: brick.name,
    kind: brick.kind,
    paths: brick.source_paths || [],
    purpose: sem.purpose ? sem.purpose.slice(0, 320) : "(no purpose)",
    tags: sem.tags || [],
    public_api: (sem.public_api || []).slice(0, 8),
    archetype: sem.reuse_archetype || "unknown"
  };
}

function jaccard(a, b) {
  const setA = new Set((a || []).map((s) => String(s).toLowerCase()));
  const setB = new Set((b || []).map((s) => String(s).toLowerCase()));
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  return inter / union;
}

function pickNeighbours(anchorSummary, allSummaries, k) {
  const scored = [];
  for (const cand of allSummaries) {
    if (cand.id === anchorSummary.id) continue;
    let s = jaccard(anchorSummary.tags, cand.tags) * 3;
    if (anchorSummary.archetype === cand.archetype && anchorSummary.archetype !== "unknown") s += 0.4;
    if (cand.project === anchorSummary.project) s += 0.2;
    if (s > 0) scored.push({ s, cand });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, k).map((x) => x.cand);
}

function buildPrompt(anchor, neighbours) {
  const neighbourBlock = neighbours
    .map((n, i) => `### N${i + 1}  id=${n.id}  project=${n.project}  kind=${n.kind}  archetype=${n.archetype}\nPurpose: ${n.purpose}\nTags: ${n.tags.join(", ")}\nPublic API: ${n.public_api.join(", ")}`)
    .join("\n\n");

  return `You classify relationships between software bricks (reusable code modules) for a multi-project registry.

## Anchor brick
id: ${anchor.id}
project: ${anchor.project}
kind: ${anchor.kind}
archetype: ${anchor.archetype}
Purpose: ${anchor.purpose}
Tags: ${anchor.tags.join(", ")}
Public API: ${anchor.public_api.join(", ")}

## Candidate neighbours
${neighbourBlock}

## Your task
For each candidate neighbour Ni, decide its relationship to the anchor and emit one entry per neighbour in \`edges\`. Use the exact neighbour id as \`target\`. Pick the relationship that is most defensible:

- depends_on        — anchor reads/imports/relies on neighbour at runtime
- depended_by       — neighbour reads/imports/relies on anchor at runtime
- alternative_to    — they solve the same problem in different ways; user would pick one
- composes_with     — they're often used together to form a larger feature
- supersedes        — anchor is a newer/better replacement for neighbour
- shared_concept    — same domain or vocabulary but no direct call relationship
- unrelated         — keep this for clearly unrelated bricks (still emit so the graph is dense)

Be conservative: when unsure between two relationships, prefer \`shared_concept\`. Always include a one-sentence \`reason\`.

Return only the JSON object matching the schema.`;
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
  return bricks;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const candidates = await loadCandidates(opts);
  console.error(`scanning ${candidates.length} bricks for connections (k=${opts.neighbours}, concurrency=${opts.concurrency})`);

  // Build summary index from manifests
  const summaries = [];
  for (const b of candidates) {
    const mf = await loadManifest(b.manifest_path);
    if (!mf) continue;
    summaries.push({ brick: b, manifest: mf, summary: brickSummary(b, mf) });
  }
  const allSummaries = summaries.map((s) => s.summary);

  const anchors = opts.limit > 0 ? summaries.slice(0, opts.limit) : summaries;
  console.error(`enriching ${anchors.length} anchor brick(s) with neighbour relationships`);

  const items = anchors.map((a) => {
    const neighbours = pickNeighbours(a.summary, allSummaries, opts.neighbours);
    return {
      id: a.brick.id,
      prompt: buildPrompt(a.summary, neighbours),
      schema: SCHEMA,
      _anchor: a,
      _neighbours: neighbours
    };
  });

  const allEdges = [];
  let processed = 0;
  let cacheHits = 0;
  let failed = 0;

  await codexBatch(items, {
    concurrency: opts.concurrency,
    model: opts.model,
    timeoutMs: opts.timeoutMs,
    onResult: (wrapped) => {
      processed += 1;
      const r = wrapped.result;
      if (r.ok) {
        if (r.fromCache) cacheHits += 1;
        const item = items.find((x) => x.id === wrapped.id);
        if (!item) return;
        const knownIds = new Set(item._neighbours.map((n) => n.id));
        for (const e of r.data.edges || []) {
          if (!knownIds.has(e.target)) continue;
          allEdges.push({ from: wrapped.id, to: e.target, kind: e.kind, confidence: e.confidence, reason: e.reason });
        }
        // Write into manifest
        const mf = item._anchor.manifest;
        mf.semantics = mf.semantics || {};
        mf.semantics.connections = (r.data.edges || [])
          .filter((e) => knownIds.has(e.target) && e.kind !== "unrelated")
          .map((e) => ({ target: e.target, kind: e.kind, confidence: e.confidence, reason: e.reason }))
          .slice(0, 20);
        mf.semantics.connections_source = "codex-gpt-5.4";
        mf.semantics.connections_at = new Date().toISOString();
        fs.writeFile(item._anchor.brick.manifest_path, `${JSON.stringify(mf, null, 2)}\n`).catch(() => {});
        if (processed % 5 === 0) console.error(`  ${processed}/${anchors.length} done${r.fromCache ? " (cache)" : ""}`);
      } else {
        failed += 1;
        console.error(`  ${wrapped.id}: ${r.error}`);
      }
    }
  });

  await fs.mkdir(path.dirname(opts.out), { recursive: true });
  await fs.writeFile(opts.out, JSON.stringify({
    generated_at: new Date().toISOString(),
    anchors: anchors.length,
    edges: allEdges,
    edge_count: allEdges.length
  }, null, 2));

  console.log(JSON.stringify({
    anchors: anchors.length,
    processed, cache_hits: cacheHits, failed,
    edges_written: allEdges.length,
    out: opts.out
  }, null, 2));
}

main().catch((err) => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });
