#!/usr/bin/env node
/**
 * WHAT: Derives missing semantic fields for reusable brick manifests.
 * WHY: Thin manifests cannot be matched reliably by purpose, tags, or public surface.
 * HOW: Reads filtered candidates and nearby source documentation, then proposes manifest fields.
 * INPUTS: Candidate and registry files, an optional limit, and optional dry-run mode.
 * OUTPUTS: Updated manifests or a structured count of proposed, skipped, and touched bricks.
 * CALLERS: Registry curation workflows preparing candidates for discovery and reuse.
 * Usage: `node tools/sma-enrich.mjs --candidates registry/global-modules.generated.json --registry registry/global-modules.generated.json --dry-run --limit 1`
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
import { PROJECTS_ROOT, smaPath } from "./lib/sma-paths.mjs";

function parseArgs(argv) {
  const opts = {
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

async function readJson(p) { return JSON.parse(await fs.readFile(p, "utf8")); }

function sentenceClean(line) {
  return String(line)
    .replace(/^[\s*/#-]+/, "")
    .replace(/^\*+/, "")
    .replace(/\*+\/$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function extractPurpose(brick) {
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
  if ((brick.source_paths || [])[0]) {
    const srcAbs = path.resolve(PROJECTS_ROOT, brick.project || "", brick.source_paths[0]);
    candidatesFiles.push(srcAbs);
  }

  for (const f of candidatesFiles) {
    try {
      const stat = await fs.stat(f);
      if (!stat.isFile() || stat.size > 500_000) continue;
      const text = await fs.readFile(f, "utf8");
      // Markdown: first non-heading paragraph
      if (/\.md$|\.txt$/i.test(f)) {
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        for (const l of lines) {
          if (l.startsWith("#")) continue;
          if (l.length >= 20 && !l.startsWith("!") && !l.startsWith("[")) return sentenceClean(l).slice(0, 280);
        }
        continue;
      }
      // Source: top file comment block
      const blockMatch = text.match(/\/\*\*?([\s\S]*?)\*\//);
      if (blockMatch) {
        const firstSentence = blockMatch[1].split(/\r?\n/).map(sentenceClean).filter(Boolean).join(" ").split(/(?<=[.!?])\s+/)[0];
        if (firstSentence && firstSentence.length >= 20) return firstSentence.slice(0, 280);
      }
      const lineMatch = text.match(/^[\t ]*\/\/\s*(.+)/m);
      if (lineMatch) {
        const first = sentenceClean(lineMatch[1]);
        if (first.length >= 20) return first.slice(0, 280);
      }
    } catch {}
  }
  return null;
}

async function extractExportsFromFile(filePath) {
  const exported = new Set();
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
  } catch {}
  return exported;
}

async function extractPublicApi(brick) {
  const rootDir = path.dirname(brick.manifest_path);
  const allExports = new Set();
  const candidates = [
    path.join(rootDir, "index.ts"),
    path.join(rootDir, "index.tsx"),
    path.join(rootDir, "index.js"),
    path.join(rootDir, "index.mjs"),
    path.join(rootDir, `${path.basename(rootDir)}.ts`),
    path.join(rootDir, `${path.basename(rootDir)}.tsx`)
  ];

  if ((brick.source_paths || [])[0]) {
    const srcAbs = path.resolve(PROJECTS_ROOT, brick.project || "", brick.source_paths[0]);
    try {
      const st = await fs.stat(srcAbs);
      if (st.isFile()) candidates.unshift(srcAbs);
    } catch {}
  }

  for (const f of candidates) {
    const exports = await extractExportsFromFile(f);
    for (const x of exports) allExports.add(x);
    if (allExports.size > 0) break; // prefer the first entry point found
  }

  // Fallback: scan top-level .ts/.tsx files in the brick folder
  if (allExports.size === 0) {
    try {
      const entries = await fs.readdir(rootDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile()) continue;
        if (!/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(e.name)) continue;
        if (/\.(test|spec)\./i.test(e.name)) continue;
        if (e.name === "module.sweetspot.json" || e.name.endsWith(".module.sweetspot.json")) continue;
        const exports = await extractExportsFromFile(path.join(rootDir, e.name));
        for (const x of exports) allExports.add(x);
        if (allExports.size >= 20) break;
      }
    } catch {}
  }

  // Last-resort fallback: describe the surface by file name so promotion can proceed.
  if (allExports.size === 0) {
    try {
      const entries = await fs.readdir(rootDir, { withFileTypes: true });
      const files = entries
        .filter((e) => e.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs|py|sql|go)$/i.test(e.name))
        .map((e) => `file:${e.name}`);
      if (files.length) {
        for (const f of files.slice(0, 10)) allExports.add(f);
        allExports.add("__api_inferred_from_files__");
      }
    } catch {}
    if (allExports.size === 0 && (brick.source_paths || [])[0]) {
      allExports.add(`file:${path.basename(brick.source_paths[0])}`);
      allExports.add("__api_inferred_from_files__");
    }
  }

  return [...allExports].slice(0, 20);
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

function deriveTags(brick) {
  const tags = new Set();
  for (const d of brick.domain || []) tags.add(String(d).toLowerCase());
  if (brick.kind) tags.add(String(brick.kind).toLowerCase());
  if (brick.feature_cluster?.id) tags.add(brick.feature_cluster.id);

  const hay = `${brick.name || ""} ${(brick.source_paths || []).join(" ")} ${(brick.domain || []).join(" ")}`.toLowerCase();
  for (const w of genericWordTags) {
    if (hay.includes(w)) tags.add(w);
  }

  // Path segments as tags
  for (const p of brick.source_paths || []) {
    for (const seg of p.split("/")) {
      if (seg.length >= 3 && seg.length <= 30 && /^[a-z0-9_-]+$/i.test(seg)) {
        tags.add(seg.toLowerCase().replace(/_/g, "-"));
      }
    }
  }

  return [...tags].slice(0, 40);
}

function deriveUseWhen(brick, purpose) {
  const tags = deriveTags(brick);
  const hints = [];
  if (tags.includes("auth") || tags.includes("workos") || tags.includes("clerk") || tags.includes("jwt") || tags.includes("session")) {
    hints.push("you need authentication / session management");
  }
  if (tags.includes("stripe") || tags.includes("billing") || tags.includes("checkout")) {
    hints.push("you need billing / payment checkout");
  }
  if (tags.includes("chat")) hints.push("you need chat UI or chat routing");
  if (tags.includes("transcription") || tags.includes("whisper")) hints.push("you need speech-to-text / transcription");
  if (tags.includes("capture") || tags.includes("screen")) hints.push("you need screen / audio capture");
  if (tags.includes("push") || tags.includes("fcm")) hints.push("you need push notifications");
  if (tags.includes("migration")) hints.push("you need a database migration for this schema change");
  if (tags.includes("supabase-function") || tags.includes("supabase_function")) hints.push("the host uses Supabase edge functions");
  if (tags.includes("rls")) hints.push("you need Row-Level Security rules for this table");
  if (hints.length === 0 && purpose) hints.push("the problem statement matches the brick's purpose");
  return hints.slice(0, 6);
}

function deriveDoNotUseWhen(brick) {
  const tags = deriveTags(brick);
  const warn = [];
  if ((brick.data_classes || []).includes("admin_only") || tags.includes("admin")) {
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

function deriveCloneSteps(brick) {
  const steps = [];
  const src = (brick.source_paths || [])[0] || "";
  const targetRel = src;
  const kind = brick.kind || "";

  steps.push(`copy ${src} into the target project at the same relative path (or adjust to the target's layout)`);

  if (kind === "supabase-function" || kind === "function" || /supabase_function/i.test(brick.domain?.join(" ") || "")) {
    steps.push("deploy with: supabase functions deploy <name> --project-ref <target-ref>");
  }
  if (kind === "migration" || /migration/i.test(brick.domain?.join(" ") || "")) {
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
  const cands = await readJson(opts.candidates);
  const items = opts.limit > 0 ? cands.bricks.slice(0, opts.limit) : cands.bricks;
  let touched = 0;
  let skipped = 0;

  for (const brick of items) {
    try {
      const mf = JSON.parse(await fs.readFile(brick.manifest_path, "utf8"));
      if (!mf.semantics) mf.semantics = {};

      if (!mf.semantics.purpose) {
        const purpose = await extractPurpose(brick);
        if (purpose) {
          mf.semantics.purpose = purpose;
        } else {
          // Synthesize a fallback so downstream tools never see an empty
          // purpose. Agents can still query this; a human can rewrite later.
          const kindHuman = String(brick.kind || "brick").replace(/_/g, " ");
          const tagList = (deriveTags(brick).slice(0, 6)).join(", ") || "reusable unit";
          const pathHint = (brick.source_paths || [])[0] || "";
          mf.semantics.purpose = `${kindHuman} in ${brick.project || "unknown"} (${pathHint}). Covers: ${tagList}. [synthesized — rewrite with a real sentence before promoting]`;
          mf.semantics.purpose_synthesized = true;
        }
      }

      if (!mf.semantics.public_api || (Array.isArray(mf.semantics.public_api) && mf.semantics.public_api.length === 0)) {
        const api = await extractPublicApi(brick);
        if (api.length) mf.semantics.public_api = api;
      }

      if (!mf.semantics.tags || mf.semantics.tags.length === 0) {
        mf.semantics.tags = deriveTags(brick);
      }

      if (!mf.semantics.use_when || mf.semantics.use_when.length === 0) {
        mf.semantics.use_when = deriveUseWhen(brick, mf.semantics.purpose || "");
      }

      if (!mf.semantics.do_not_use_when || mf.semantics.do_not_use_when.length === 0) {
        const warn = deriveDoNotUseWhen(brick);
        if (warn.length) mf.semantics.do_not_use_when = warn;
      }

      if (!mf.semantics.clone_steps || mf.semantics.clone_steps.length === 0) {
        mf.semantics.clone_steps = deriveCloneSteps(brick);
      }

      mf.semantics.enriched_at = new Date().toISOString();
      mf.semantics.enrichment_source = "sma-enrich-heuristic";

      if (!opts.dryRun) {
        await fs.writeFile(brick.manifest_path, `${JSON.stringify(mf, null, 2)}\n`);
      }
      touched += 1;
    } catch (err) {
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

main().catch((err) => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });
