#!/usr/bin/env node
/**
 * WHAT: Derives missing semantic fields for reusable brick manifests.
 * WHY: Thin manifests cannot be matched reliably by purpose, tags, or public surface.
 * HOW: Reads filtered candidates and nearby source documentation, then proposes manifest fields.
 * INPUTS: Candidate and registry files, an optional limit, and optional dry-run mode.
 * OUTPUTS: Updated manifests or a structured count of proposed, skipped, and touched bricks.
 * CALLERS: Registry curation workflows preparing candidates for discovery and reuse.
 * Usage: `node tools/sma-enrich.ts --candidates registry/global-modules.generated.json --registry registry/global-modules.generated.json --dry-run --limit 1`
 */
/**
 * sma-enrich: heuristically fill the semantic fields on brick manifests so
 * agents can query the registry by purpose/tags/use_when/public_api.
 *
 * For each brick in the filtered reuse-candidates file, derive:
 *   - purpose: first informative line of README / JSDoc / file-header comment,
 *              else a synthesized one from kind + domain + name
 *   - public_api: exported symbols from index.ts/index.tsx/<name>.ts top-level
 *   - tags: union of {domain, kind, feature_cluster.id, framework, generic-word
 *           matches, path segments}
 *   - use_when: synthesized from kind + purpose keywords
 *   - clone_steps: boilerplate driven by kind (supabase_function, frontend_module, etc.)
 *
 * Writes the semantic block into the existing `module.sweetspot.json` under a
 * new `semantics` field. Non-destructive: only fills fields that are missing.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { PROJECTS_ROOT, smaPath } from "./lib/sma-paths.ts";

interface EnrichOptions { candidates: string; registry: string; dryRun: boolean; limit: number }
interface EnrichBrick {
  manifest_path: string;
  project?: string;
  source_paths?: string[];
  domain?: string[];
  kind?: string;
  name?: string;
  feature_cluster?: { id?: string };
  data_classes?: string[];
}
interface EnrichSemantics {
  purpose?: string; purpose_synthesized?: boolean; public_api?: string[]; tags?: string[]; use_when?: string[];
  do_not_use_when?: string[]; clone_steps?: string[]; enriched_at?: string; enrichment_source?: string;
}
interface EnrichManifest { semantics: EnrichSemantics; [key: string]: unknown }

function parseArgs(argv: string[]): EnrichOptions {
  const opts: EnrichOptions = {
    candidates: smaPath("security/reuse_candidates.json"),
    registry: smaPath("scans/all-projects/latest.registry.json"),
    dryRun: false,
    limit: 0
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const n = argv[i + 1];
    if (a === "--candidates" && n) { opts.candidates = path.resolve(n); i += 1; }
    else if (a === "--registry" && n) { opts.registry = path.resolve(n); i += 1; }
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--limit" && n) { opts.limit = Number(n); i += 1; }
  }
  return opts;
}

async function readJson(p: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await fs.readFile(p, "utf8"));
  return parsed;
}

function sentenceClean(line: unknown) {
  return String(line)
    .replace(/^[\s*/#-]+/, "")
    .replace(/^\*+/, "")
    .replace(/\*+\/$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractPurpose(brick: EnrichBrick) {
  const rootDir = path.dirname(brick.manifest_path);
  const candidatesFiles = [
    path.join(rootDir, "README.md"),
    path.join(rootDir, "README.txt"),
    path.join(rootDir, "readme.md"),
    path.join(rootDir, "index.ts"),
    path.join(rootDir, "index.tsx"),
    path.join(rootDir, "index.js"),
    path.join(rootDir, `${path.basename(rootDir)}.ts`),
    path.join(rootDir, `${path.basename(rootDir)}.tsx`)
  ];

  // Also look for a sidecar source file if this is a file-level brick
  const sourcePath = brick.source_paths?.[0];
  if (sourcePath) {
    const srcAbs = path.resolve(PROJECTS_ROOT, brick.project ?? "", sourcePath);
    candidatesFiles.push(srcAbs);
  }

  for (const f of candidatesFiles) {
    try {
      const stat = await fs.stat(f);
      if (!stat.isFile() || stat.size > 500_000) continue;
      const text = await fs.readFile(f, "utf8");
      const purpose = purposeFromText(f, text);
      if (purpose) return purpose;
    } catch {
      // Source inspection is optional enrichment; retain the next evidence source on failure.
    }
  }
  return null;
}

function purposeFromText(filePath: string, text: string): string | null {
  if (/\.md$|\.txt$/i.test(filePath)) return markdownPurpose(text);
  const blockMatch = /\/\*\*?([\s\S]*?)\*\//.exec(text);
  const firstSentence = blockMatch?.[1].split(/\r?\n/).map(sentenceClean).filter(Boolean).join(" ").split(/(?<=[.!?])\s+/)[0];
  if (firstSentence && firstSentence.length >= 20) return firstSentence.slice(0, 280);
  const lineMatch = /^[\t ]*\/\/\s*(.+)/m.exec(text);
  const first = lineMatch ? sentenceClean(lineMatch[1]) : "";
  return first.length >= 20 ? first.slice(0, 280) : null;
}

function markdownPurpose(text: string): string | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const line = lines.find((candidate) => !candidate.startsWith("#") && candidate.length >= 20 && !candidate.startsWith("!") && !candidate.startsWith("["));
  return line ? sentenceClean(line).slice(0, 280) : null;
}

async function extractExportsFromFile(filePath: string) {
  const exported = new Set<string>();
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > 500_000) return exported;
    const text = await fs.readFile(filePath, "utf8");
    const re = /export\s+(?:default\s+(?:async\s+)?(?:function|class|const|let|var)?\s*([A-Za-z_$][\w$]*)|(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)|\{([^}]+)\})/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[1]) exported.add(m[1]);
      if (m[2]) exported.add(m[2]);
      if (m[3]) m[3].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim()).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n)).forEach((n) => exported.add(n));
    }
  } catch {
    // Missing or unreadable entry points expose no export evidence.
  }
  return exported;
}

async function extractPublicApi(brick: EnrichBrick) {
  const rootDir = path.dirname(brick.manifest_path);
  const allExports = new Set<string>();
  const candidates = [
    path.join(rootDir, "index.ts"),
    path.join(rootDir, "index.tsx"),
    path.join(rootDir, "index.js"),
    path.join(rootDir, "index.mjs"),
    path.join(rootDir, `${path.basename(rootDir)}.ts`),
    path.join(rootDir, `${path.basename(rootDir)}.tsx`)
  ];

  const sourcePath = brick.source_paths?.[0];
  if (sourcePath) {
    const srcAbs = path.resolve(PROJECTS_ROOT, brick.project ?? "", sourcePath);
    try {
      const st = await fs.stat(srcAbs);
      if (st.isFile()) candidates.unshift(srcAbs);
    } catch {
      // An unreadable declared source path is skipped in favor of conventional entry points.
    }
  }

  for (const f of candidates) {
    const exports = await extractExportsFromFile(f);
    for (const x of exports) allExports.add(x);
    if (allExports.size > 0) break; // prefer the first entry point found
  }
  if (allExports.size === 0) await scanDirectoryExports(rootDir, allExports);
  if (allExports.size === 0) await inferFileApi(rootDir, brick.source_paths?.[0], allExports);

  return [...allExports].slice(0, 20);
}

async function scanDirectoryExports(rootDir: string, allExports: Set<string>) {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(entry.name) || /\.(test|spec)\./i.test(entry.name)) continue;
      if (entry.name === "module.sweetspot.json" || entry.name.endsWith(".module.sweetspot.json")) continue;
      for (const item of await extractExportsFromFile(path.join(rootDir, entry.name))) allExports.add(item);
      if (allExports.size >= 20) break;
    }
  } catch {
    // An unreadable brick directory exposes no top-level export fallback.
  }
}

async function inferFileApi(rootDir: string, sourcePath: string | undefined, allExports: Set<string>) {
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs|py|sql|go)$/i.test(entry.name)).map((entry) => `file:${entry.name}`);
    for (const file of files.slice(0, 10)) allExports.add(file);
    if (files.length > 0) allExports.add("__api_inferred_from_files__");
  } catch {
    // An unreadable brick directory exposes no filename-based API fallback.
  }
  if (allExports.size === 0 && sourcePath) {
    allExports.add(`file:${path.basename(sourcePath)}`);
    allExports.add("__api_inferred_from_files__");
  }
}

const genericWordTags = [
  "auth", "oauth", "session", "jwt", "rbac", "login", "signup", "signout",
  "cors", "ratelimit", "throttle",
  "logger", "telemetry", "metrics", "tracing",
  "cache", "redis", "queue", "worker", "job",
  "email", "webhook", "slack", "notify", "push", "fcm",
  "validate", "validator", "sanitize", "schema",
  "upload", "download", "presign",
  "billing", "stripe", "checkout", "subscription",
  "chat", "message", "thread", "ai",
  "search", "index", "ingest", "embed",
  "migrate", "migration", "seed",
  "error", "retry", "backoff",
  "crypto", "hash", "sign", "encrypt",
  "workos", "clerk", "supabase", "google", "gcp", "openai", "anthropic",
  "transcription", "whisper", "audio", "capture", "screen", "electron",
  "react", "next", "vite", "deno", "node",
  "rls", "supabase-function", "edge-function"
];

function deriveTags(brick: EnrichBrick) {
  const tags = new Set<string>();
  for (const d of brick.domain ?? []) tags.add(d.toLowerCase());
  if (brick.kind) tags.add(brick.kind.toLowerCase());
  if (brick.feature_cluster?.id) tags.add(brick.feature_cluster.id);

  const hay = `${brick.name ?? ""} ${(brick.source_paths ?? []).join(" ")} ${(brick.domain ?? []).join(" ")}`.toLowerCase();
  for (const w of genericWordTags) {
    if (hay.includes(w)) tags.add(w);
  }

  addPathTags(tags, brick.source_paths ?? []);

  return [...tags].slice(0, 40);
}

function addPathTags(tags: Set<string>, sourcePaths: string[]) {
  for (const sourcePath of sourcePaths) {
    for (const segment of sourcePath.split("/")) {
      if (segment.length >= 3 && segment.length <= 30 && /^[a-z0-9_-]+$/i.test(segment)) tags.add(segment.toLowerCase().replace(/_/g, "-"));
    }
  }
}

function deriveUseWhen(brick: EnrichBrick, purpose: string | null) {
  const tags = deriveTags(brick);
  const rules: [tags: string[], message: string][] = [
    [["auth", "workos", "clerk", "jwt", "session"], "you need authentication / session management"],
    [["stripe", "billing", "checkout"], "you need billing / payment checkout"], [["chat"], "you need chat UI or chat routing"],
    [["transcription", "whisper"], "you need speech-to-text / transcription"], [["capture", "screen"], "you need screen / audio capture"],
    [["push", "fcm"], "you need push notifications"], [["migration"], "you need a database migration for this schema change"],
    [["supabase-function", "supabase_function"], "the host uses Supabase edge functions"], [["rls"], "you need Row-Level Security rules for this table"],
  ];
  const hints = rules.filter(([needles]) => needles.some((tag) => tags.includes(tag))).map(([, message]) => message);
  if (hints.length === 0 && purpose) hints.push("the problem statement matches the brick's purpose");
  return hints.slice(0, 6);
}

function deriveDoNotUseWhen(brick: EnrichBrick) {
  const tags = deriveTags(brick);
  const warn = [];
  if ((brick.data_classes ?? []).includes("admin_only") || tags.includes("admin")) {
    warn.push("the target project doesn't have an admin surface");
  }
  if (tags.includes("electron") && !tags.includes("browser")) {
    warn.push("the target runs in the browser only (no Node runtime)");
  }
  if (tags.includes("supabase-function") || tags.includes("supabase_function")) {
    warn.push("the target doesn't use Supabase");
  }
  return warn.slice(0, 4);
}

function deriveCloneSteps(brick: EnrichBrick) {
  const steps = [];
  const src = (brick.source_paths ?? [])[0] || "";
  const kind = brick.kind ?? "";

  steps.push(`copy ${src} into the target project at the same relative path (or adjust to the target's layout)`);

  if (kind === "supabase-function" || kind === "function" || /supabase_function/i.test(brick.domain?.join(" ") ?? "")) {
    steps.push("deploy with: supabase functions deploy <name> --project-ref <target-ref>");
  }
  if (kind === "migration" || /migration/i.test(brick.domain?.join(" ") ?? "")) {
    steps.push("apply with: supabase db push");
  }
  if (/module|feature|component/.test(kind)) {
    steps.push("install the missing npm dependencies listed in the brick's own package.json or imports");
    steps.push("register the brick's public exports in the host app's routing / feature registry");
  }
  steps.push("set the required env vars in the host's secret store (see env contract in this manifest)");
  steps.push("run the brick's tests in the target project to verify wiring");

  return steps.slice(0, 8);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const candidates = parseCandidates(await readJson(opts.candidates));
  const items = opts.limit > 0 ? candidates.slice(0, opts.limit) : candidates;
  let touched = 0;
  let skipped = 0;

  for (const brick of items) {
    try {
      await enrichBrick(brick, opts.dryRun);
      touched += 1;
    } catch {
      skipped += 1;
    }
  }

  console.log(JSON.stringify({
    candidates: items.length,
    touched,
    skipped,
    dry_run: opts.dryRun
  }, null, 2));
}

async function enrichBrick(brick: EnrichBrick, dryRun: boolean) {
  const parsed: unknown = JSON.parse(await fs.readFile(brick.manifest_path, "utf8"));
  const manifest = parseManifest(parsed);
  const semantics = manifest.semantics;
  await ensurePurpose(brick, semantics);
  if (!semantics.public_api?.length) {
    const api = await extractPublicApi(brick);
    if (api.length > 0) semantics.public_api = api;
  }
  semantics.tags ??= deriveTags(brick);
  if (semantics.tags.length === 0) semantics.tags = deriveTags(brick);
  semantics.use_when ??= deriveUseWhen(brick, semantics.purpose ?? "");
  if (semantics.use_when.length === 0) semantics.use_when = deriveUseWhen(brick, semantics.purpose ?? "");
  ensureWarnings(brick, semantics);
  if (!semantics.clone_steps?.length) semantics.clone_steps = deriveCloneSteps(brick);
  semantics.enriched_at = new Date().toISOString();
  semantics.enrichment_source = "sma-enrich-heuristic";
  if (!dryRun) await fs.writeFile(brick.manifest_path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function ensureWarnings(brick: EnrichBrick, semantics: EnrichSemantics) {
  const warnings = deriveDoNotUseWhen(brick);
  if (!semantics.do_not_use_when?.length && warnings.length > 0) semantics.do_not_use_when = warnings;
}

async function ensurePurpose(brick: EnrichBrick, semantics: EnrichSemantics) {
  if (semantics.purpose) return;
  const purpose = await extractPurpose(brick);
  if (purpose) {
    semantics.purpose = purpose;
    return;
  }
  const kindHuman = (brick.kind ?? "brick").replace(/_/g, " ");
  const tagList = deriveTags(brick).slice(0, 6).join(", ") || "reusable unit";
  const pathHint = brick.source_paths?.[0] ?? "";
  semantics.purpose = `${kindHuman} in ${brick.project ?? "unknown"} (${pathHint}). Covers: ${tagList}. [synthesized — rewrite with a real sentence before promoting]`;
  semantics.purpose_synthesized = true;
}

function parseCandidates(value: unknown): EnrichBrick[] {
  const root = objectValue(value);
  if (!root || !Array.isArray(root.bricks)) throw new Error("candidate file must contain a bricks array");
  return root.bricks.map(parseBrick).filter((brick): brick is EnrichBrick => brick !== null);
}

function parseBrick(value: unknown): EnrichBrick | null {
  const brick = objectValue(value);
  if (!brick || typeof brick.manifest_path !== "string") return null;
  const cluster = objectValue(brick.feature_cluster);
  return { manifest_path: brick.manifest_path, project: optionalString(brick.project), source_paths: stringList(brick.source_paths),
    domain: stringList(brick.domain), kind: optionalString(brick.kind), name: optionalString(brick.name),
    feature_cluster: cluster ? { id: optionalString(cluster.id) } : undefined, data_classes: stringList(brick.data_classes) };
}

function parseManifest(value: unknown): EnrichManifest {
  const record = objectValue(value);
  if (!record) throw new Error("manifest must be a JSON object");
  const source = objectValue(record.semantics) ?? {};
  return { ...record, semantics: { purpose: optionalString(source.purpose), purpose_synthesized: source.purpose_synthesized === true,
    public_api: stringList(source.public_api), tags: stringList(source.tags), use_when: stringList(source.use_when),
    do_not_use_when: stringList(source.do_not_use_when), clone_steps: stringList(source.clone_steps),
    enriched_at: optionalString(source.enriched_at), enrichment_source: optionalString(source.enrichment_source) } };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });
