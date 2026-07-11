#!/usr/bin/env node
/**
 * WHAT: Replaces synthesized brick semantics with structured descriptions grounded in source files.
 * WHY: Search and reuse decisions are unreliable when purpose, interfaces, risks, and adaptation steps come only from filename heuristics.
 * HOW: Reads candidate source, requests bounded Codex output, and merges it into manifests for downstream ranking, connection, and wiki tools.
 * Usage: `node tools/sma-codex-enrich.mjs --limit 1 --dry-run`
 */
/**
 * sma-codex-enrich: replace synthesized semantic fields with real LLM-written
 * data drawn from the brick's source code.
 *
 * For each candidate brick:
 *   1. Read up to ~6KB of source (the most informative files: index.*,
 *      <brickname>.*, README*, the file under source_paths if it's a file
 *      brick).
 *   2. Send the source + the existing manifest's name/kind/path to codex
 *      with a strict JSON schema asking for: purpose, use_when,
 *      do_not_use_when, public_api, tags, clone_steps, risks,
 *      reuse_archetype, related_concepts.
 *   3. Merge the result into manifest.semantics, preserving anything the user
 *      may have edited unless --overwrite is set.
 *
 * Cached. Concurrent. Bounded by --limit and --filter.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { codexBatch } from "./lib/codex-runner.mjs";
import { PROJECTS_ROOT, smaPath } from "./lib/sma-paths.mjs";

function parseArgs(argv) {
  const opts = {
    candidates: smaPath("security/reuse_candidates.json"),
    limit: 0,
    concurrency: 3,
    overwrite: false,
    project: "",
    filter: "",
    minScore: 0,
    dryRun: false,
    timeoutMs: 240000,
    model: "gpt-5.4"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const n = argv[i + 1];
    if (a === "--candidates" && n) { opts.candidates = path.resolve(n); i += 1; }
    else if (a === "--limit" && n) { opts.limit = Number(n); i += 1; }
    else if (a === "--concurrency" && n) { opts.concurrency = Number(n); i += 1; }
    else if (a === "--overwrite") opts.overwrite = true;
    else if (a === "--project" && n) { opts.project = n; i += 1; }
    else if (a === "--filter" && n) { opts.filter = n.toLowerCase(); i += 1; }
    else if (a === "--min-score" && n) { opts.minScore = Number(n); i += 1; }
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--timeout" && n) { opts.timeoutMs = Number(n) * 1000; i += 1; }
    else if (a === "--model" && n) { opts.model = n; i += 1; }
  }
  return opts;
}

// OpenAI structured-output requires every property to appear in `required`.
// Optional fields can still come back as empty arrays / empty strings.
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "purpose", "use_when", "do_not_use_when", "public_api", "tags",
    "clone_steps", "risks", "reuse_archetype", "related_concepts"
  ],
  properties: {
    purpose: { type: "string" },
    use_when: { type: "array", items: { type: "string" } },
    do_not_use_when: { type: "array", items: { type: "string" } },
    public_api: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    clone_steps: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    reuse_archetype: {
      type: "string",
      enum: ["primitive", "adapter", "service", "feature", "module", "ui", "data-model", "infra", "agent-skill", "experiment", "unknown"]
    },
    related_concepts: { type: "array", items: { type: "string" } }
  }
};

async function readJson(p) { return JSON.parse(await fs.readFile(p, "utf8")); }

async function gatherSourceContext(brick, manifest) {
  const rootDir = path.dirname(brick.manifest_path);
  const wanted = new Set();
  const isFileBrick = (brick.source_paths || []).some((p) => /\.(t|j)sx?$|\.py$|\.sql$/i.test(p));
  if (isFileBrick) {
    const abs = path.resolve(PROJECTS_ROOT, brick.project || "", brick.source_paths[0]);
    wanted.add(abs);
  }
  for (const name of ["README.md", "README.txt", "readme.md", "index.ts", "index.tsx", "index.js", "index.mjs",
    `${path.basename(rootDir)}.ts`, `${path.basename(rootDir)}.tsx`, "main.ts", "main.tsx", "module.ts"]) {
    wanted.add(path.join(rootDir, name));
  }
  // Plus the first 3 .ts/.tsx files in the dir
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    let added = 0;
    for (const e of entries) {
      if (added >= 3) break;
      if (!e.isFile()) continue;
      if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(e.name)) continue;
      if (/\.(test|spec)\./i.test(e.name)) continue;
      if (e.name === "module.sweetspot.json" || e.name.endsWith(".module.sweetspot.json")) continue;
      wanted.add(path.join(rootDir, e.name));
      added += 1;
    }
  } catch {}

  const pieces = [];
  let totalBytes = 0;
  const BUDGET = 6_000;
  for (const f of wanted) {
    if (totalBytes >= BUDGET) break;
    try {
      const stat = await fs.stat(f);
      if (!stat.isFile() || stat.size === 0) continue;
      const room = BUDGET - totalBytes;
      const buf = await fs.readFile(f, "utf8");
      const slice = buf.slice(0, Math.max(200, Math.min(room, 2_500)));
      pieces.push(`### ${path.relative(PROJECTS_ROOT, f)}\n${slice}`);
      totalBytes += slice.length;
    } catch {}
  }
  return pieces.join("\n\n");
}

function buildPrompt(brick, manifest, sourceContext) {
  return `You are documenting a software brick (a reusable code module) for a multi-project registry. Your goal is to write the metadata an automated agent will read when deciding whether to reuse this brick in a new project.

## Brick metadata
- id: ${brick.id || manifest.brick?.id}
- name: ${brick.name || manifest.brick?.name}
- kind: ${brick.kind || manifest.brick?.kind}
- project: ${brick.project}
- source_paths: ${JSON.stringify(brick.source_paths || [])}
- existing_domain: ${JSON.stringify(brick.domain || [])}
- existing_tags: ${JSON.stringify(manifest.semantics?.tags || [])}

## Brick source (truncated; up to 6KB across the most informative files)

${sourceContext || "(no readable source available)"}

## Your task
Return JSON matching the provided schema. Be specific and grounded in the source above. Avoid generic boilerplate. If you cannot tell from the source, say so plainly in the field.

Field guidance:
- purpose: 1–2 sentences. Lead with what the brick *does*, not what kind it is.
- use_when: concrete situations where dropping this brick into a new project is the right call.
- do_not_use_when: concrete situations where it would be the wrong call (e.g. wrong runtime, wrong data model, wrong scale).
- public_api: the symbols / endpoints / files another project would import or invoke. If unknown, list the file paths or main exported names you found.
- tags: 5–15 lower-case tokens an agent could match a vision against.
- clone_steps: minimum ordered shell or wiring steps to bring the brick into a new project.
- risks: known weaknesses, deps, limitations.
- reuse_archetype: pick the closest one.
- related_concepts: nouns or feature names a vision search might use to find this brick (e.g. "billing portal", "magic link", "ratelimit").

Return only the JSON.`;
}

function isHonest(prev) {
  // Treat values that came from sma-enrich-heuristic OR are missing/synthesized as overwriteable.
  if (!prev) return false;
  if (prev.purpose_synthesized === true) return false;
  if (prev.enrichment_source && prev.enrichment_source.startsWith("sma-enrich-heuristic")) return false;
  return true;
}

async function loadCandidates(opts) {
  const c = await readJson(opts.candidates);
  let bricks = c.bricks || [];
  if (opts.project) bricks = bricks.filter((b) => b.project === opts.project);
  if (opts.minScore > 0) bricks = bricks.filter((b) => (b.score || 0) >= opts.minScore);
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
  console.error(`enriching ${candidates.length} brick(s) with codex (model=${opts.model}, concurrency=${opts.concurrency})...`);

  const items = [];
  const manifests = new Map();
  for (const b of candidates) {
    try {
      const mf = JSON.parse(await fs.readFile(b.manifest_path, "utf8"));
      manifests.set(b.id, mf);

      // Skip if already real-enriched and not --overwrite
      if (!opts.overwrite && isHonest(mf.semantics)) {
        continue;
      }
      const ctx = await gatherSourceContext(b, mf);
      items.push({
        id: b.id,
        prompt: buildPrompt(b, mf, ctx),
        schema: SCHEMA
      });
    } catch (err) {
      console.error(`skip ${b.id}: ${err.message}`);
    }
  }

  if (items.length === 0) {
    console.log(JSON.stringify({ scanned: candidates.length, queued: 0, message: "nothing to do (use --overwrite to redo enriched bricks)" }, null, 2));
    return;
  }

  console.error(`queued ${items.length} (skipped ${candidates.length - items.length} already real-enriched)`);

  let processed = 0;
  let cacheHits = 0;
  let failed = 0;

  const results = await codexBatch(items, {
    concurrency: opts.concurrency,
    model: opts.model,
    timeoutMs: opts.timeoutMs,
    onResult: (wrapped) => {
      processed += 1;
      const r = wrapped.result;
      if (r.ok) {
        if (r.fromCache) cacheHits += 1;
        const data = r.data;
        const brick = candidates.find((b) => b.id === wrapped.id);
        const mf = manifests.get(wrapped.id);
        if (!mf || !brick) return;
        mf.semantics = mf.semantics || {};
        Object.assign(mf.semantics, {
          purpose: data.purpose,
          use_when: data.use_when,
          do_not_use_when: data.do_not_use_when || [],
          public_api: data.public_api,
          tags: data.tags,
          clone_steps: data.clone_steps,
          risks: data.risks || [],
          reuse_archetype: data.reuse_archetype,
          related_concepts: data.related_concepts || []
        });
        delete mf.semantics.purpose_synthesized;
        mf.semantics.enrichment_source = "codex-gpt-5.4";
        mf.semantics.enriched_at = new Date().toISOString();
        if (!opts.dryRun) {
          fs.writeFile(brick.manifest_path, `${JSON.stringify(mf, null, 2)}\n`).catch((err) => {
            console.error(`write fail ${brick.id}: ${err.message}`);
          });
        }
        if (processed % 5 === 0) {
          console.error(`  ${processed}/${items.length} done${r.fromCache ? " (cache)" : ""} (${cacheHits} cache hits, ${failed} failed)`);
        }
      } else {
        failed += 1;
        console.error(`  ${wrapped.id}: ${r.error || "unknown error"}`);
      }
    }
  });

  console.log(JSON.stringify({
    scanned: candidates.length,
    queued: items.length,
    processed,
    cache_hits: cacheHits,
    failed,
    dry_run: opts.dryRun,
    overwrite: opts.overwrite
  }, null, 2));
}

main().catch((err) => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });
