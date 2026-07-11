#!/usr/bin/env node
/**
 * WHAT: Generates reviewable sibling test files for candidate bricks that lack tests.
 * WHY: Promotion requires executable evidence, while many discovered bricks begin without a focused test at their source boundary.
 * HOW: Reads candidate source, asks Codex for a runner-specific test, and previews or writes files for maintainers to inspect and run.
 * Usage: `node tools/sma-codex-test.ts --limit 1 --dry-run`
 */
/**
 * sma-codex-test: generate a sibling test file for a candidate brick so that
 * sma-promote will flip it candidate → canonical.
 *
 * For each candidate brick lacking a sibling test:
 *   - read up to ~8KB of source (top files + index)
 *   - ask codex (with strict schema) to return a `test_filename`,
 *     `test_runner` (vitest|deno|node|jest), `test_imports`, and `test_source`.
 *   - write the file as a sibling. Do NOT execute it.
 *
 * Use this as a one-shot way to lift bricks toward canonical. The user can
 * inspect/adjust the generated tests; they're starter tests, not exhaustive.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { codexBatch } from "./lib/codex-runner.ts";
import { PROJECTS_ROOT, smaPath } from "./lib/sma-paths.ts";

function parseArgs(argv: string[]) {
  const opts = {
    candidates: smaPath("security/reuse_candidates.json"),
    limit: 0,
    concurrency: 2,
    overwrite: false,
    project: "",
    filter: "",
    minScore: 40,
    timeoutMs: 240000,
    model: "gpt-5.4",
    dryRun: false
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
    else if (a === "--timeout" && n) { opts.timeoutMs = Number(n) * 1000; i += 1; }
    else if (a === "--model" && n) { opts.model = n; i += 1; }
    else if (a === "--dry-run") opts.dryRun = true;
  }
  return opts;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["test_filename", "test_runner", "test_source", "imports_used", "skipped"],
  properties: {
    test_filename: { type: "string" },
    test_runner: { type: "string", enum: ["vitest", "deno", "node", "jest", "playwright"] },
    test_source: { type: "string" },
    imports_used: { type: "array", items: { type: "string" } },
    skipped: { type: "boolean" }
  }
};

async function readJson(p: string): Promise<any> { return JSON.parse(await fs.readFile(p, "utf8")); }

async function hasSiblingTest(absDir) {
  try {
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && (e.name === "__tests__" || e.name === "tests")) return true;
      if (e.isFile() && /\.(test|spec)\.(t|j)sx?$/i.test(e.name)) return true;
    }
  } catch { /* optional source directory */ }
  return false;
}

async function gatherSource(brick) {
  const rootDir = path.dirname(brick.manifest_path);
  const wanted = new Set<string>();
  const isFileBrick = (brick.source_paths || []).some((p) => /\.(t|j)sx?$/i.test(p));
  if (isFileBrick) {
    wanted.add(path.resolve(PROJECTS_ROOT, brick.project || "", brick.source_paths[0]));
  }
  for (const name of ["index.ts", "index.tsx", "index.js", `${path.basename(rootDir)}.ts`, `${path.basename(rootDir)}.tsx`]) {
    wanted.add(path.join(rootDir, name));
  }
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    let added = 0;
    for (const e of entries) {
      if (added >= 4) break;
      if (!e.isFile()) continue;
      if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(e.name)) continue;
      if (/\.(test|spec)\./i.test(e.name)) continue;
      if (e.name.endsWith(".module.sweetspot.json")) continue;
      wanted.add(path.join(rootDir, e.name));
      added += 1;
    }
  } catch { /* optional source directory */ }
  const pieces: string[] = [];
  let bytes = 0;
  for (const f of wanted) {
    if (bytes >= 8000) break;
    try {
      const stat = await fs.stat(f);
      if (!stat.isFile()) continue;
      const text = await fs.readFile(f, "utf8");
      const slice = text.slice(0, Math.min(3500, 8000 - bytes));
      pieces.push(`### ${path.relative(PROJECTS_ROOT, f)}\n${slice}`);
      bytes += slice.length;
    } catch { /* optional source candidate */ }
  }
  return pieces.join("\n\n");
}

function buildPrompt(brick, sem, src) {
  return `You write a single starter test file for a software brick. The test will live next to the brick's source so an automated promotion gate can detect it. Keep it small and runnable.

## Brick
id: ${brick.id}
project: ${brick.project}
kind: ${brick.kind}
public_api: ${(sem.public_api || []).join(", ")}
purpose: ${sem.purpose || "(unknown)"}

## Source (truncated)

${src || "(no source)"}

## Your task
Return JSON matching the schema:
- test_filename: a relative file name in the same folder as the brick, ending in .test.ts (or .test.tsx for React) — choose the runner accordingly.
- test_runner: one of vitest|deno|node|jest|playwright. Prefer vitest for Node/Electron + ts-node code; deno for supabase functions; jest only if you can see jest in dependencies.
- imports_used: list the symbols the test imports (one per array item).
- test_source: the COMPLETE file body. It must:
   - import the brick's public_api symbols from a relative path (./<file> or ../<dir>) — never absolute imports.
   - mock external network/filesystem calls minimally (use the test runner's mocks).
   - exercise one happy-path interaction so the test compiles AND runs without external services.
   - NOT contain any secret values, API keys, or PII.
   - NOT depend on environment variables (use minimal stubs).
- skipped: false if a test could be written; true if no public surface is testable from the visible source. When skipped=true, emit an empty test_source string and explain in test_filename what's missing.

Return only JSON.`;
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
  const items = [];
  const meta = new Map();

  for (const b of candidates) {
    const rootDir = path.dirname(b.manifest_path);
    const isFileBrick = (b.source_paths || []).some((p) => /\.(t|j)sx?$/i.test(p));
    const dir = isFileBrick
      ? path.dirname(path.resolve(PROJECTS_ROOT, b.project, b.source_paths[0]))
      : rootDir;
    if (!opts.overwrite && await hasSiblingTest(dir)) continue;
    let mf;
    try { mf = JSON.parse(await fs.readFile(b.manifest_path, "utf8")); }
    catch { continue; }
    const src = await gatherSource(b);
    items.push({
      id: b.id,
      prompt: buildPrompt(b, mf.semantics || {}, src),
      schema: SCHEMA
    });
    meta.set(b.id, { brick: b, dir });
    if (opts.limit > 0 && items.length >= opts.limit) break;
  }

  console.error(`writing tests for ${items.length} candidate brick(s) (concurrency=${opts.concurrency})`);

  let processed = 0, cacheHits = 0, failed = 0, skipped = 0, written = 0;

  await codexBatch(items, {
    concurrency: opts.concurrency,
    model: opts.model,
    timeoutMs: opts.timeoutMs,
    onResult: async (wrapped) => {
      processed += 1;
      const r = wrapped.result;
      if (!r.ok) { failed += 1; console.error(`  ${wrapped.id}: ${r.error}`); return; }
      if (r.fromCache) cacheHits += 1;
      const m = meta.get(wrapped.id);
      if (!m) return;
      if (r.data.skipped) { skipped += 1; return; }
      // Defensive: codex sometimes returns a full relative path. Force just the basename.
      const safeName = path.basename(String(r.data.test_filename || "").trim() || `${m.brick.name || "brick"}.test.ts`);
      const target = path.join(m.dir, safeName);
      if (!opts.dryRun) {
        try {
          await fs.writeFile(target, r.data.test_source);
          written += 1;
        } catch (err) {
          failed += 1; console.error(`  write ${target}: ${err.message}`);
        }
      } else {
        written += 1;
      }
      if (processed % 5 === 0) console.error(`  ${processed}/${items.length} (${written} written, ${skipped} skipped${r.fromCache ? ", cache hit" : ""})`);
    }
  });

  console.log(JSON.stringify({ scanned: candidates.length, queued: items.length, processed, cache_hits: cacheHits, written, skipped, failed, dry_run: opts.dryRun }, null, 2));
}

main().catch((err) => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });
