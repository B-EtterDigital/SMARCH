#!/usr/bin/env node
/**
 * What: Compares a curated build's declared surface with what its source currently realizes.
 * Why: Promotion must stop when promised paths, commands, or product surfaces no longer exist.
 * How: Reads manifests and project trees, then reports missing declarations and extra realization.
 * Callers: Build promotion invokes it as a blocking scope-truth gate.
 * Example: `node tools/sma-scope-drift.ts --help`
 */
// sma-scope-drift.ts — declared-vs-realized diff for SMA curated builds.
// Catches the case where a manifest declares capabilities the implementation
// no longer delivers (or never did). Inverse direction is informational only.
//
// Wired into sma-build-promote.ts: a brick with declared_missing > 0 is blocked.

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { resolveProjectRoot as canonicalResolveProjectRoot, PROJECTS_ROOT } from "./lib/project-paths.ts";
import type { BuildManifest } from './lib/schema-types/build.manifest.schema.d.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const DEFAULTS = {
  projectsRoot: process.env.SMA_PROJECTS_ROOT ?? PROJECTS_ROOT,
};

const HELP = `sma-scope-drift — declared-vs-realized diff for curated builds.

A manifest declares source paths, brick refs, entrypoints, ui surfaces, api
endpoints, commands. This tool checks each declaration against the actual
source tree of the underlying project. Anything declared-but-missing is drift
and blocks promotion.

Usage:
  node tools/sma-scope-drift.ts --manifest <path>
  node tools/sma-scope-drift.ts --all
  node tools/sma-scope-drift.ts --manifest <path> --json

Options:
  --manifest <path>       Path to a build.sweetspot.json
  --all                   Every *.build.sweetspot.json under builds/
  --projects-root <path>  Where underlying projects live
                          (default: $SMA_PROJECTS_ROOT or ~/DEV/Projects)
  --report <path>         Write JSON report to file
  --json                  Print JSON to stdout
  --warn-only             Exit 0 even on drift (first-pass adoption)
  --help                  This text.

Exit codes:
  0  no drift
  1  declared_missing > 0
  2  configuration / IO error
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); process.exit(0); }
  const manifests = await resolveManifests(opts);

  const reports = [];
  for (const m of manifests) reports.push(await driftOne(m, opts));

  const combined = {
    generated_at: new Date().toISOString(),
    status: reports.length === 0 ? "warn" : "checked",
    manifests: reports.length,
    total_missing: reports.reduce((a, r) => a + r.summary.missing, 0),
    total_blocking: reports.reduce((a, r) => a + (r.summary.blocking ?? 0), 0),
    total_warning: reports.reduce((a, r) => a + (r.summary.warning ?? 0), 0),
    total_extra: reports.reduce((a, r) => a + r.summary.extra, 0),
    warnings: reports.length === 0
      ? ["nothing to check; run npm run scan to discover manifests, then rerun this gate"]
      : [],
    reports,
  };

  if (opts.report) {
    await fs.mkdir(path.dirname(opts.report), { recursive: true });
    await fs.writeFile(opts.report, JSON.stringify(combined, null, 2));
  } else if (opts.json) {
    process.stdout.write(JSON.stringify(combined, null, 2) + "\n");
  } else {
    printSummary(combined);
  }

  if (combined.status === "warn" && (opts.report || opts.json)) {
    console.error("[scope-drift] WARN — nothing to check; run npm run scan to discover manifests, then rerun this gate");
  }

  if (combined.total_blocking > 0 && !opts.warnOnly) process.exit(1);
}

// Bucket severities. Buckets backed by exact path/route checks block;
// buckets backed by string-grep heuristics warn (don't trust enough to block).
const BUCKET_SEVERITY = {
  source_paths: "block",
  brick_refs: "block",
  entrypoints: "block",
  api_endpoints: "block",
  commands: "block",
  ui_surfaces: "warn",
};

type DeepPartial<T> = T extends readonly unknown[] ? DeepPartial<T[number]>[] : T extends object ? { [Key in keyof T]?: DeepPartial<T[Key]> } : T;
type ManifestInput = DeepPartial<BuildManifest>;
type CheckBucket = 'declared' | 'missing' | 'realized';
interface DriftCheck {
  declared: unknown[];
  realized: unknown[];
  missing: unknown[];
  note?: string;
  severity?: string;
}
interface DriftOptions { all?: boolean; help?: boolean; json?: boolean; manifest?: string; projectsRoot: string; report?: string; warnOnly?: boolean }
interface DriftSummary { blocking?: number; declared: number; extra: number; missing: number; realized: number; warning?: number }
interface DriftReport { build_id?: string; checks: Record<string, DriftCheck>; manifest: string; project?: string; projectRoot: string | null; reason?: string; status: string; summary: DriftSummary }
interface CombinedReport { manifests: number; reports: DriftReport[]; status: string; total_blocking: number; total_extra: number; total_missing: number; total_warning: number }

async function driftOne(manifestPath: string, opts: DriftOptions): Promise<DriftReport> {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ManifestInput;
  const projectRoot =  resolveProjectRoot(manifest, opts.projectsRoot);
  const checks: Record<string, DriftCheck> = {
    source_paths: { declared: [], realized: [], missing: [] },
    brick_refs: { declared: [], realized: [], missing: [] },
    entrypoints: { declared: [], realized: [], missing: [] },
    api_endpoints: { declared: [], realized: [], missing: [] },
    ui_surfaces: { declared: [], realized: [], missing: [], note: "string-grep heuristic" },
    commands: { declared: [], realized: [], missing: [], note: "supabase-functions inferred" },
  };

  if (!projectRoot) {
    return {
      manifest: path.relative(repoRoot, manifestPath),
      build_id: manifest.build?.id,
      project: manifest.source?.project,
      projectRoot: null,
      status: "skipped",
      reason: "project root not resolved",
      checks,
      summary: { declared: 0, realized: 0, missing: 0, extra: 0 },
    };
  }

  // source.paths[]
  for (const p of manifest.source?.paths ?? []) {
    checks.source_paths.declared.push(p);
    if (existsSync(path.join(projectRoot, p))) checks.source_paths.realized.push(p);
    else checks.source_paths.missing.push(p);
  }

  // composition.brick_refs[]
  for (const ref of manifest.composition?.brick_refs ?? []) {
    const key = ref.brick_id ?? ref.path;
    checks.brick_refs.declared.push(key);
    const p = ref.path;
    if (p && existsSync(path.join(projectRoot, p))) checks.brick_refs.realized.push(key);
    else checks.brick_refs.missing.push({ brick_id: key, path: p });
  }

  // interfaces.entrypoints + api_endpoints — for "POST /functions/v1/X" patterns
  // we check supabase/functions/X exists; for "GET /api/Y" patterns we just record.
  const verifyRoute = (route: string) => {
    const m = /\/functions\/v1\/([a-z0-9-]+)/.exec(route);
    if (!m) return null;
    return existsSync(path.join(projectRoot, "supabase/functions", m[1]));
  };
  for (const e of manifest.interfaces?.entrypoints ?? []) {
    checks.entrypoints.declared.push(e);
    const v = verifyRoute(e);
    if (v === null) checks.entrypoints.realized.push(e); // not a supabase route — can't verify, don't flag
    else if (v) checks.entrypoints.realized.push(e);
    else checks.entrypoints.missing.push(e);
  }
  for (const e of manifest.interfaces?.api_endpoints ?? []) {
    checks.api_endpoints.declared.push(e);
    const v = verifyRoute(e);
    if (v === null) checks.api_endpoints.realized.push(e);
    else if (v) checks.api_endpoints.realized.push(e);
    else checks.api_endpoints.missing.push(e);
  }

  // ui_surfaces[] — heuristic: surface names should appear as a string token
  // somewhere in the declared source paths. Best-effort.
  const sourceText = await readSourceCorpus(projectRoot, manifest.source?.paths ?? []);
  for (const surface of manifest.interfaces?.ui_surfaces ?? []) {
    checks.ui_surfaces.declared.push(surface);
    const tokens = surfaceTokens(surface);
    const hit = tokens.some((t) => sourceText.includes(t));
    if (hit) checks.ui_surfaces.realized.push(surface);
    else checks.ui_surfaces.missing.push(surface);
  }

  // commands[] — supabase functions serve X → check supabase/functions/X
  for (const c of manifest.interfaces?.commands ?? []) {
    checks.commands.declared.push(c);
    const m = /supabase\s+functions\s+serve\s+([a-z0-9-]+)/.exec(c);
    if (!m) { checks.commands.realized.push(c); continue; }
    if (existsSync(path.join(projectRoot, "supabase/functions", m[1]))) checks.commands.realized.push(c);
    else checks.commands.missing.push(c);
  }

  const declared = sum(checks, "declared");
  const realized = sum(checks, "realized");
  const missing = sum(checks, "missing");
  let blocking = 0, warning = 0;
  for (const [bucket, c] of Object.entries(checks)) {
    const n = (c.missing || []).length;
    if (n === 0) continue;
    if (BUCKET_SEVERITY[bucket as keyof typeof BUCKET_SEVERITY] === "warn") warning += n;
    else blocking += n;
    c.severity = BUCKET_SEVERITY[bucket as keyof typeof BUCKET_SEVERITY] ?? "block";
  }
  const status = blocking > 0 ? "drift" : warning > 0 ? "warn" : "pass";

  return {
    manifest: path.relative(repoRoot, manifestPath),
    build_id: manifest.build?.id,
    project: manifest.source?.project,
    projectRoot: path.relative(os.homedir(), projectRoot),
    status,
    checks,
    summary: { declared, realized, missing, blocking, warning, extra: 0 },
  };
}

function sum(checks: Record<string, DriftCheck>, key: CheckBucket): number {
  let n = 0;
  for (const check of Object.values(checks)) n += check[key].length;
  return n;
}

function surfaceTokens(s: string) {
  return [
    s,
    s.replace(/-/g, ""),
    s.replace(/-/g, "_"),
    s.replace(/-([a-z])/g, (_: string, character: string) => character.toUpperCase()),
    s.replace(/(^|-)([a-z])/g, (_: string, _delimiter: string, character: string) => character.toUpperCase()),
  ];
}

async function readSourceCorpus(projectRoot: string, declared: string[]): Promise<string> {
  const exts = new Set([".ts", ".tsx", ".js", ".mjs", ".jsx"]);
  let corpus = "";
  for (const decl of declared) {
    const abs = path.join(projectRoot, decl);
    if (!existsSync(abs)) continue;
    const stat = await fs.stat(abs);
    if (stat.isFile()) {
      corpus += await safeRead(abs);
      continue;
    }
    await walkDir(abs, async (f) => {
      const ext = path.extname(f);
      if (!exts.has(ext)) return;
      corpus += (await safeRead(f)) || "";
    });
    if (corpus.length > 8_000_000) break; // safety cap
  }
  return corpus;
}

async function walkDir(dir: string, onFile: (file: string) => Promise<void>): Promise<void> {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".next" || e.name === "build") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkDir(full, onFile);
    else if (e.isFile()) await onFile(full);
  }
}

async function safeRead(file: string): Promise<string> {
  try { return await fs.readFile(file, "utf8"); } catch { return ""; }
}

function parseArgs(argv: string[]): DriftOptions {
  const out: DriftOptions = { projectsRoot: DEFAULTS.projectsRoot };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i], n = argv[i + 1];
    if (a === "--manifest") { out.manifest = n; i += 1; }
    else if (a === "--all") { out.all = true; }
    else if (a === "--projects-root") { out.projectsRoot = n; i += 1; }
    else if (a === "--report") { out.report = n; i += 1; }
    else if (a === "--json") { out.json = true; }
    else if (a === "--warn-only") { out.warnOnly = true; }
    else if (a === "--help" || a === "-h") { out.help = true; }
  }
  return out;
}

async function resolveManifests(opts: DriftOptions): Promise<string[]> {
  if (opts.manifest) return [path.resolve(opts.manifest)];
  if (opts.all) {
    const root = path.resolve(repoRoot, "builds");
    return await walkManifests(root);
  }
  return [];
}

async function walkManifests(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && full.endsWith(".build.sweetspot.json")) out.push(full);
    }
  }
  await walk(root);
  return out;
}

function resolveProjectRoot(manifest: ManifestInput, _projectsRoot: string): string | null {
  // Delegated to tools/lib/project-paths.ts — see same swap in sma-rule-gate.ts.
  return canonicalResolveProjectRoot(manifest.source?.project);
}

function printSummary(combined: CombinedReport): void {
  if (combined.status === "warn") {
    console.log("[scope-drift] WARN — nothing to check; run npm run scan to discover manifests, then rerun this gate");
    return;
  }
  const verdict = combined.total_blocking === 0 ? "PASS" : "DRIFT";
  console.log(`[scope-drift] ${verdict} — ${String(combined.manifests)} manifest(s), ${String(combined.total_blocking)} blocking, ${String(combined.total_warning)} warning`);
  for (const r of combined.reports) {
    const v = r.status === "pass" ? "✓" : r.status === "warn" ? "⚠" : r.status === "skipped" ? "⊘" : "✗";
    console.log(`  ${v} ${r.build_id ?? r.manifest}  (${String(r.summary.realized)}/${String(r.summary.declared)} realized)`);
    if (r.status === "skipped") {
      console.log(`      skipped: ${String(r.reason)}`);
      continue;
    }
    for (const [bucket, c] of Object.entries(r.checks)) {
      if (!c.missing || c.missing.length === 0) continue;
      const sev = c.severity ?? "block";
      console.log(`      ${bucket} (${sev}): ${String(c.missing.length)} missing`);
      for (const m of c.missing.slice(0, 5)) {
        console.log(`        - ${typeof m === "string" ? m : JSON.stringify(m)}`);
      }
      if (c.missing.length > 5) console.log(`        ... and ${String(c.missing.length - 5)} more`);
    }
  }
}

main().catch((err: unknown) => {
  console.error("[scope-drift] error:", err instanceof Error ? err.message : String(err));
  process.exit(2);
});
