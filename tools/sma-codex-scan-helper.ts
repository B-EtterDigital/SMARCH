#!/usr/bin/env node
/* eslint-disable @typescript-eslint/restrict-template-expressions -- Helper diagnostics intentionally interpolate observed subprocess values without altering their representation. */
/* eslint-disable complexity -- The helper parser is one explicit CLI option grammar; centralized branches preserve flag precedence. */
/**
 * WHAT: Finds plausible standalone bricks among source paths not covered by existing manifests.
 * WHY: Pattern-based scanning leaves a long tail of reusable units whose intent is visible only from surrounding project structure.
 * HOW: Reads an uncovered file tree, asks Codex for bounded detections, and writes a report consumed by manifest-bootstrap operators.
 * Usage: `node tools/sma-codex-scan-helper.ts --project smarch --root . --extras 20`
 */
/**
 * sma-codex-scan-helper: close the long tail of brickable units the regex
 * scanner missed. We feed codex a tree listing of files NOT yet covered by
 * a manifest, and ask "are any of these standalone bricks (one-by-one)".
 *
 * Output:
 *   security/scan_long_tail.<project>.json   — { detections: [{path, kind, reason}] }
 *
 * The user can then run sma-bootstrap-manifests over this list (we also
 * print the bash one-liner that does it).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { codex } from "./lib/codex-runner.ts";

function parseArgs(argv: string[]) {
  const opts = {
    project: "",
    root: "",
    out: "",
    extras: 200,
    timeoutMs: 360000,
    model: "gpt-5.4"
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const n = argv[i + 1];
    if (a === "--project" && n) { opts.project = n; i += 1; }
    else if (a === "--root" && n) { opts.root = path.resolve(n); i += 1; }
    else if (a === "--out" && n) { opts.out = path.resolve(n); i += 1; }
    else if (a === "--extras" && n) { opts.extras = Number(n); i += 1; }
    else if (a === "--timeout" && n) { opts.timeoutMs = Number(n) * 1000; i += 1; }
    else if (a === "--model" && n) { opts.model = n; i += 1; }
  }
  if (!opts.project) opts.project = path.basename(opts.root || "");
  if (!opts.out) opts.out = path.resolve(`~/DEV/SMARCH/security/scan_long_tail.${opts.project}.json`);
  return opts;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["detections"],
  properties: {
    detections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "is_brick", "kind_guess", "reason"],
        properties: {
          path: { type: "string" },
          is_brick: { type: "boolean" },
          kind_guess: { type: "string" },
          reason: { type: "string" }
        }
      }
    }
  }
};

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".astro", ".turbo", ".netlify", "tmp", ".tmp", "playwright-report", "test-results", "coverage", ".sweetspot"]);

interface Detection {
  path: string;
  is_brick: boolean;
  kind_guess: string;
  reason: string;
}

function isDetectionPayload(value: unknown): value is { detections: Detection[] } {
  if (!value || typeof value !== "object" || !("detections" in value)) return false;
  const detections = Reflect.get(value, "detections");
  return Array.isArray(detections) && detections.every((item) =>
    item !== null
    && typeof item === "object"
    && typeof Reflect.get(item, "path") === "string"
    && typeof Reflect.get(item, "is_brick") === "boolean"
    && typeof Reflect.get(item, "kind_guess") === "string"
    && typeof Reflect.get(item, "reason") === "string"
  );
}

async function listAllFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push(full);
    }
  }
  await walk(root);
  return out;
}

async function findCoveredPaths(root: string): Promise<Set<string>> {
  const covered = new Set<string>();
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name === "module.sweetspot.json") covered.add(path.dirname(full));
      else if (e.name.endsWith(".module.sweetspot.json")) {
        // sidecar manifest covers <basename>.<ext> in the same dir
        const baseName = e.name.replace(/\.module\.sweetspot\.json$/, "");
        covered.add(path.join(path.dirname(full), `${baseName}.ts`));
        covered.add(path.join(path.dirname(full), `${baseName}.tsx`));
        covered.add(path.join(path.dirname(full), `${baseName}.js`));
      }
    }
  }
  await walk(root);
  return covered;
}

function isCoveredByDirManifest(filePath: string, coveredDirs: Set<string>): boolean {
  let dir = path.dirname(filePath);
  for (let i = 0; i < 6; i += 1) {
    if (coveredDirs.has(dir)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.root) { console.error("error: --root ~/DEV/Projects/<x> required"); process.exit(2); }
  console.error(`scanning ${opts.root} for uncovered files...`);

  const allFiles = await listAllFiles(opts.root);
  const covered = await findCoveredPaths(opts.root);
  const uncovered = allFiles.filter((f) => {
    if (covered.has(f)) return false;
    if (isCoveredByDirManifest(f, covered)) return false;
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|py|sql|go|rs|java)$/i.test(f)) return false;
    if (/\.(test|spec)\./i.test(f)) return false;
    return true;
  });

  console.error(`uncovered code files: ${uncovered.length}, sampling top ${opts.extras} by promising names`);

  // Heuristic shortlist: paths with words a brick is likely to need
  const promising = uncovered
    .map((f) => ({ f, score: scoreUncovered(f) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.extras);

  if (promising.length === 0) {
    console.log(JSON.stringify({ uncovered_count: uncovered.length, asked: 0, message: "no promising candidates" }, null, 2));
    return;
  }

  const list = promising.map((x) => path.relative(opts.root, x.f)).join("\n");
  const prompt = `You are auditing a codebase for "bricks" — standalone reusable code units that deserve their own SMA manifest. Below is a list of files in project ${opts.project} that are NOT yet covered by any manifest. For each, decide if the file is itself a standalone brick (a single-file unit with a clear public API) and what kind it is.

## Uncovered files
${list}

## Your task
For every listed path return one entry in \`detections\`. Mark \`is_brick: true\` only when the path is plausibly a single-file brick (e.g. a Service.ts, a Provider.ts, a top-level utility, a script, a migration). Mark \`is_brick: false\` for incidental files (assets, config, type-only re-exports, glue, tests). For \`kind_guess\` use one of: service_file, provider_file, adapter_file, handler_file, utility_file, script_file, migration_file, schema_file, plugin_file, integration_file, route_file, agent_skill, supabase_function, sidecar_module, or "ignore".

Return only JSON. Use the exact path strings I gave.`;

  console.error(`asking codex about ${promising.length} files...`);
  const r = await codex({ prompt, schema: SCHEMA, model: opts.model, timeoutMs: opts.timeoutMs });
  if (!r.ok) { console.error(JSON.stringify(r, null, 2)); process.exit(1); }
  if (!isDetectionPayload(r.data)) {
    console.error("codex returned an invalid detections payload");
    process.exit(1);
  }

  const detections = r.data.detections.filter((d) => d.is_brick && d.kind_guess !== "ignore");
  await fs.mkdir(path.dirname(opts.out), { recursive: true });
  await fs.writeFile(opts.out, JSON.stringify({
    project: opts.project,
    root: opts.root,
    uncovered_total: uncovered.length,
    asked: promising.length,
    detected: detections.length,
    detections
  }, null, 2));

  console.log(JSON.stringify({
    project: opts.project,
    uncovered: uncovered.length,
    asked: promising.length,
    detected: detections.length,
    out: opts.out,
    next_step: `Adapt sma-bootstrap-manifests to ingest ${opts.out} (or write per-file manifests by hand for the highest-value entries).`
  }, null, 2));
}

function scoreUncovered(f: string): number {
  const lower = f.toLowerCase();
  let s = 0;
  if (/(service|provider|handler|adapter|pipeline|connector|guard|middleware|webhook)/.test(lower)) s += 5;
  if (/(scripts?|migrations?|workflows?|integrations?|plugins?)/.test(lower)) s += 3;
  if (/^[a-z_-]+\.(ts|tsx|js|mjs|cjs)$/i.test(path.basename(f))) s += 1;
  if (/(types|schemas?|models?|interfaces?)\b/.test(lower)) s += 2;
  if (/index\.(ts|tsx|js|mjs)$/.test(lower)) s -= 2; // index files are usually re-exports
  if (lower.includes("/dist/") || lower.includes("/build/") || lower.includes("/.next/")) return 0;
  return s;
}

main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });
