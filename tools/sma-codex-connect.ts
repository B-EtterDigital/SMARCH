#!/usr/bin/env node
/* Codex responses cross a runtime JSON boundary, so defensive response guards remain required. */
/* CLI dispatch is a linear option table; complexity counts each independent option as nested control flow. */
/* eslint @typescript-eslint/no-unnecessary-condition: "off", complexity: "off" */
/**
 * WHAT: Classifies meaningful relationships between semantically enriched bricks.
 * WHY: Reuse planning needs explicit dependency, composition, alternative, and shared-concept edges rather than tag overlap alone.
 * HOW: Reads candidates and manifests, asks Codex about bounded neighbour sets, and writes graph data consumed by ranking and wiki tools.
 * Usage: `node tools/sma-codex-connect.ts --limit 1 --neighbours 3`
 */
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
import { codexBatch } from "./lib/codex-runner.ts";
import { smaPath } from "./lib/sma-paths.ts";

interface ConnectOptions { registry: string; out: string; candidates: string; limit: number; concurrency: number; neighbours: number; minScore: number; project: string; filter: string; timeoutMs: number; model: string }
interface Brick { id: string; project: string; name?: string; kind?: string; source_paths?: string[]; score?: number; manifest_path: string }
interface Manifest { semantics?: { purpose?: string; tags?: unknown[]; public_api?: unknown[]; reuse_archetype?: string; connections?: ConnectionEdge[]; connections_source?: string; connections_at?: string } }
interface BrickSummary { id: string; project: string; name?: string; kind?: string; paths: string[]; purpose: string; tags: unknown[]; public_api: unknown[]; archetype: string }
interface ConnectionEdge { target: string; kind: string; confidence: string; reason: string }
interface WrittenEdge { from: string; to: string; kind: string; confidence: string; reason: string }
interface CandidateDocument { bricks?: Brick[] }
interface SummaryEntry { brick: Brick; manifest: Manifest; summary: BrickSummary }

function isEdgePayload(value: unknown): value is { edges: ConnectionEdge[] } {
  if (!value || typeof value !== "object" || !("edges" in value)) return false;
  const edges = Reflect.get(value, "edges");
  return Array.isArray(edges) && edges.every((edge) => edge && typeof edge === "object"
    && typeof Reflect.get(edge, "target") === "string"
    && typeof Reflect.get(edge, "kind") === "string"
    && typeof Reflect.get(edge, "confidence") === "string"
    && typeof Reflect.get(edge, "reason") === "string");
}

function parseArgs(argv: string[]) {
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

async function readJson(p: string): Promise<CandidateDocument> {
  const parsed: unknown = JSON.parse(await fs.readFile(p, "utf8"));
  return parsed as CandidateDocument;
}

async function loadManifest(p: string): Promise<Manifest | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(p, "utf8"));
    return parsed as Manifest;
  } catch { return null; }
}

function brickSummary(brick: Brick, manifest: Manifest): BrickSummary {
  const sem = manifest.semantics ?? {};
  return {
    id: brick.id,
    project: brick.project,
    name: brick.name,
    kind: brick.kind,
    paths: brick.source_paths ?? [],
    purpose: sem.purpose ? sem.purpose.slice(0, 320) : "(no purpose)",
    tags: sem.tags ?? [],
    public_api: (sem.public_api ?? []).slice(0, 8),
    archetype: sem.reuse_archetype ?? "unknown"
  };
}

function jaccard(a: unknown[], b: unknown[]): number {
  const setA = new Set((a || []).map((s) => String(s).toLowerCase()));
  const setB = new Set((b || []).map((s) => String(s).toLowerCase()));
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  return inter / union;
}

function pickNeighbours(anchorSummary: BrickSummary, allSummaries: BrickSummary[], k: number): BrickSummary[] {
  const scored: { s: number; cand: BrickSummary }[] = [];
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

function buildPrompt(anchor: BrickSummary, neighbours: BrickSummary[]): string {
  const neighbourBlock = neighbours
    .map((neighbour: BrickSummary, index: number) => `### N${String(index + 1)}  id=${neighbour.id}  project=${neighbour.project}  kind=${String(neighbour.kind)}  archetype=${neighbour.archetype}\nPurpose: ${neighbour.purpose}\nTags: ${neighbour.tags.join(", ")}\nPublic API: ${neighbour.public_api.join(", ")}`)
    .join("\n\n");

  return `You classify relationships between software bricks (reusable code modules) for a multi-project registry.

## Anchor brick
id: ${anchor.id}
project: ${anchor.project}
kind: ${String(anchor.kind)}
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

async function loadCandidates(opts: ConnectOptions): Promise<Brick[]> {
  const c = await readJson(opts.candidates);
  let bricks = c.bricks ?? [];
  if (opts.minScore > 0) bricks = bricks.filter((b) => (b.score ?? 0) >= opts.minScore);
  if (opts.project) bricks = bricks.filter((b) => b.project === opts.project);
  if (opts.filter) {
    const f = opts.filter;
    bricks = bricks.filter((b) =>
      (b.id || "").toLowerCase().includes(f) ||
      (b.name ?? "").toLowerCase().includes(f) ||
      (b.source_paths ?? []).some((p) => p.toLowerCase().includes(f))
    );
  }
  return bricks;
}

async function loadSummaries(candidates: Brick[]): Promise<SummaryEntry[]> {
  const summaries: SummaryEntry[] = [];
  for (const brick of candidates) {
    const manifest = await loadManifest(brick.manifest_path);
    if (manifest) summaries.push({ brick, manifest, summary: brickSummary(brick, manifest) });
  }
  return summaries;
}

async function enrichConnections(opts: ConnectOptions, anchors: SummaryEntry[], allSummaries: BrickSummary[]) {
  const items = anchors.map((anchor) => {
    const neighbours = pickNeighbours(anchor.summary, allSummaries, opts.neighbours);
    return { id: anchor.brick.id, prompt: buildPrompt(anchor.summary, neighbours), schema: SCHEMA, _anchor: anchor, _neighbours: neighbours };
  });
  const allEdges: WrittenEdge[] = [];
  const counters = { processed: 0, cacheHits: 0, failed: 0 };
  await codexBatch(items, {
    concurrency: opts.concurrency, model: opts.model, timeoutMs: opts.timeoutMs,
    onResult: (wrapped) => {
      counters.processed += 1;
      const result = wrapped.result;
      if (!result.ok) {
        counters.failed += 1;
        console.error(`  ${wrapped.id}: ${result.error}`);
        return;
      }
      if (result.fromCache) counters.cacheHits += 1;
      const item = items.find((candidate) => candidate.id === wrapped.id);
      if (!item || !isEdgePayload(result.data)) return;
      const knownIds = new Set(item._neighbours.map((neighbour) => neighbour.id));
      for (const edge of result.data.edges) {
        if (knownIds.has(edge.target)) allEdges.push({ from: wrapped.id, to: edge.target, kind: edge.kind, confidence: edge.confidence, reason: edge.reason });
      }
      const manifest = item._anchor.manifest;
      manifest.semantics = manifest.semantics ?? {};
      manifest.semantics.connections = result.data.edges.filter((edge) => knownIds.has(edge.target) && edge.kind !== "unrelated").slice(0, 20);
      manifest.semantics.connections_source = "codex-gpt-5.4";
      manifest.semantics.connections_at = new Date().toISOString();
      void fs.writeFile(item._anchor.brick.manifest_path, `${JSON.stringify(manifest, null, 2)}\n`).catch(() => { /* best-effort manifest sync */ });
      if (counters.processed % 5 === 0) console.error(`  ${String(counters.processed)}/${String(anchors.length)} done${result.fromCache ? " (cache)" : ""}`);
    },
  });
  return { allEdges, counters };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const candidates = await loadCandidates(opts);
  console.error(`scanning ${String(candidates.length)} bricks for connections (k=${String(opts.neighbours)}, concurrency=${String(opts.concurrency)})`);

  const summaries = await loadSummaries(candidates);
  const allSummaries = summaries.map((s) => s.summary);

  const anchors = opts.limit > 0 ? summaries.slice(0, opts.limit) : summaries;
  console.error(`enriching ${String(anchors.length)} anchor brick(s) with neighbour relationships`);

  const { allEdges, counters } = await enrichConnections(opts, anchors, allSummaries);

  await fs.mkdir(path.dirname(opts.out), { recursive: true });
  await fs.writeFile(opts.out, JSON.stringify({
    generated_at: new Date().toISOString(),
    anchors: anchors.length,
    edges: allEdges,
    edge_count: allEdges.length
  }, null, 2));

  console.log(JSON.stringify({
    anchors: anchors.length,
    processed: counters.processed, cache_hits: counters.cacheHits, failed: counters.failed,
    edges_written: allEdges.length,
    out: opts.out
  }, null, 2));
}

main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });
