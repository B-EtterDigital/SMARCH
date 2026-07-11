#!/usr/bin/env node
/**
 * WHAT: Scores scanned bricks and selects the strongest cross-project reuse candidates.
 * WHY: A raw registry contains project-specific pieces that should not enter the reuse catalog.
 * HOW: Combines shape, documentation, tests, boundaries, and cross-project similarity signals.
 * INPUTS: A registry, score threshold, and output paths for complete and filtered results.
 * OUTPUTS: Candidate and score files plus a concise ranking summary.
 * CALLERS: Registry curation and enrichment workflows building the reusable brick catalog.
 * Usage: `node tools/sma-filter.ts --registry registry/global-modules.generated.json --out /tmp/sma-candidates.json --all-out /tmp/sma-scores.json`
 */
/**
 * sma-filter: score each brick for cross-project reusability.
 *
 * Strategy: compute a reuse score 0..100 from these signals:
 *   +20  kind is an inherently reusable shape (library, utility, service,
 *         middleware, provider, adapter, hook, schema, migration, sidecar,
 *         edge-function, worker)
 *   +15  has a README or doc file next to it
 *   +15  brick size is in the sweet spot (3-20 files) — not a mega-module,
 *         not a single-line stub
 *   +10  name contains a generic word (auth, cors, rate-limit, logger, chat,
 *         billing, ingest, search, push, email, upload, migrate, ...)
 *   +10  no imports from project-specific absolute paths (heuristic: no `@/`
 *         alias + no deep relative imports with project names)
 *   +10  has a test next to it (brick.test.ts / __tests__ / *.spec.*)
 *   +10  another project has a brick with overlapping domain/feature_cluster
 *   +10  classification is public / user_private (data-safe reuse)
 *   −20  name is project-specific (contains the project id or a project-
 *         specific prefix like acme-desktop-, media-, sun-, factory-, acme-skills-)
 *   −20  size > 40 files (likely a composite, not a brick)
 *
 * Outputs:
 *   security/reuse_candidates.json      — bricks with score >= threshold
 *   security/reuse_all_scored.json      — every brick with its score
 */
import fs from "node:fs/promises";
import path from "node:path";
import { PROJECTS_ROOT, smaPath } from "./lib/sma-paths.ts";

const reusableKinds = new Set([
  "library_module", "utility_module", "utility_file",
  "service_module", "service_file",
  "middleware_module", "middleware_file",
  "provider_file", "adapter_file", "adapter_module",
  "hook_module", "state_module",
  "schema_module", "types_module",
  "migration_file", "migration_module",
  "supabase_function", "supabase_shared",
  "netlify_function", "netlify_edge_function",
  "sidecar_module", "agent_skill",
  "pipeline_file", "pipeline_module",
  "connector_file", "guard_file", "resolver_file",
  "query_file", "mutation_file", "handler_file", "strategy_file",
  "browser_worker"
]);

const genericWords = [
  "auth", "oauth", "session", "jwt", "rbac", "login", "signin", "signup", "signout",
  "cors", "rate", "ratelimit", "throttle",
  "logger", "log", "telemetry", "metrics", "observe", "trace",
  "cache", "redis", "queue", "worker", "job",
  "email", "webhook", "slack", "notify", "push", "fcm",
  "validate", "validator", "sanitize", "schema",
  "upload", "download", "presign",
  "billing", "stripe", "checkout", "subscription", "invoice",
  "chat", "message", "thread",
  "search", "index", "ingest", "embed",
  "migrate", "migration", "seed",
  "error", "retry", "backoff",
  "crypto", "hash", "sign", "encrypt",
  "workos", "clerk", "supabase", "google", "gcp", "openai", "anthropic"
];

interface FilterOptions { allOut: string; out: string; registry: string; threshold: number }
interface RegistryBrick {
  candidate_type?: string; data_classes?: string[]; domain?: string[];
  feature_cluster?: { id?: string }; hierarchy?: { level?: string }; id?: string;
  kind?: string; manifest_path?: string; name?: string; project?: string;
  source_paths?: string[]; status?: string;
}
interface BrickIndices { byCluster: Map<string, RegistryBrick[]>; byDomain: Map<string, RegistryBrick[]> }
interface ScoredBrick extends RegistryBrick { reasons: string[]; score: number }

function parseArgs(argv: string[]): FilterOptions {
  const opts: FilterOptions = {
    registry: smaPath("scans/all-projects/latest.registry.json"),
    out: smaPath("security/reuse_candidates.json"),
    allOut: smaPath("security/reuse_all_scored.json"),
    threshold: 40
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const n = argv[i + 1];
    if (a === "--registry" && n) { opts.registry = path.resolve(n); i += 1; }
    else if (a === "--out" && n) { opts.out = path.resolve(n); i += 1; }
    else if (a === "--all-out" && n) { opts.allOut = path.resolve(n); i += 1; }
    else if (a === "--threshold" && n) { opts.threshold = Number(n); i += 1; }
  }
  return opts;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function countFiles(dir: string): Promise<number> {
  let count = 0;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !["node_modules", "dist", "build", ".next", ".turbo"].includes(e.name)) {
        count += await countFiles(path.join(dir, e.name));
      } else if (e.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs|py|sql|go|rs|java)$/i.test(e.name)) {
        count += 1;
      }
    }
  } catch {
    // Unreadable directories contribute no source-file count.
  }
  return count;
}

async function hasSibling(dir: string, patterns: RegExp[]): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (patterns.some((re) => re.test(e.name))) return true;
    }
  } catch {
    // Unreadable directories have no matching sibling evidence.
  }
  return false;
}

function normalizeName(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function bestCrossProjectMatch(brick: RegistryBrick, byCluster: BrickIndices['byCluster'], byDomain: BrickIndices['byDomain']): boolean {
  const clusterId = brick.feature_cluster?.id;
  if (clusterId && byCluster.get(clusterId)) {
    const otherProjects = (byCluster.get(clusterId) ?? []).filter((b) => b.project !== brick.project);
    if (otherProjects.length > 0) return true;
  }
  const domain = (brick.domain ?? [])[0];
  if (domain && byDomain.get(domain)) {
    const otherProjects = (byDomain.get(domain) ?? []).filter((b) => b.project !== brick.project);
    if (otherProjects.length > 0) return true;
  }
  return false;
}

async function scoreBrick(brick: RegistryBrick, context: BrickIndices): Promise<{ reasons: string[]; score: number }> {
  let score = 0;
  const reasons: string[] = [];

  // Kind signal
  const kind = (brick.kind ?? brick.candidate_type) ?? "";
  const manifestKind = brick.hierarchy?.level === "brick" ? (brick.domain?.[0] ?? kind) : kind;
  if (reusableKinds.has(kind) || reusableKinds.has(manifestKind)) {
    score += 20; reasons.push("+20 reusable-kind");
  }

  // Cross-project domain/cluster overlap
  if (bestCrossProjectMatch(brick, context.byCluster, context.byDomain)) {
    score += 10; reasons.push("+10 cross-project-match");
  }

  // Generic word in name/path
  const haystack = normalizeName(`${brick.name ?? ""} ${(brick.source_paths ?? []).join(" ")} ${(brick.domain ?? []).join(" ")}`);
  if (genericWords.some((w) => haystack.includes(`-${w}-`) || haystack.startsWith(`${w}-`) || haystack.endsWith(`-${w}`) || haystack.includes(w))) {
    score += 10; reasons.push("+10 generic-word");
  }

  // Project-specific name penalty
  const projectLower = (brick.project ?? "").toLowerCase();
  const projectPrefixes = [projectLower, "acme-desktop-", "modchat", "modcap", "moddic", "modtrack", "modwflow", "media-", "acme-skills-", "studio-", "factory-", "acme-factory-"];
  if (projectPrefixes.filter(Boolean).some((p) => haystack.includes(p))) {
    score -= 20; reasons.push("-20 project-specific-name");
  }

  // Size signal — read the dir if possible
  const sourcePath = (brick.source_paths ?? [])[0];
  if (sourcePath) {
    const abs = path.resolve(PROJECTS_ROOT, brick.project ?? "", sourcePath);
    try {
      const st = await fs.stat(abs);
      if (st.isDirectory()) {
        const n = await countFiles(abs);
        if (n >= 3 && n <= 20) { score += 15; reasons.push(`+15 sweet-spot-size(${String(n)})`); }
        else if (n > 40) { score -= 20; reasons.push(`-20 huge-size(${String(n)})`); }
      } else {
        // File-level brick — always small; give modest bonus if matches reusable-kind
        if (reusableKinds.has(kind)) { score += 5; reasons.push("+5 file-brick"); }
      }

      // Sibling docs / tests
      const parentDir = st.isDirectory() ? abs : path.dirname(abs);
      if (await hasSibling(parentDir, [/^readme(\.md|\.txt)?$/i, /^index\.(md|mdx)$/i, /^docs?$/i])) {
        score += 15; reasons.push("+15 has-readme");
      }
      if (await hasSibling(parentDir, [/\.test\.(t|j)sx?$/i, /\.spec\.(t|j)sx?$/i, /^__tests__$/, /^tests?$/i])) {
        score += 10; reasons.push("+10 has-tests");
      }
    } catch {
      // skip if path doesn't exist
    }
  }

  // Data classification safety
  const classes = (brick.data_classes ?? []);
  if (classes.includes("public") || classes.includes("user_private")) {
    if (!classes.includes("credential") && !classes.includes("admin_only") && !classes.includes("payment")) {
      score += 10; reasons.push("+10 data-safe");
    }
  }

  return { score, reasons };
}

function buildIndices(bricks: RegistryBrick[]): BrickIndices {
  const byCluster = new Map<string, RegistryBrick[]>();
  const byDomain = new Map<string, RegistryBrick[]>();
  for (const b of bricks) {
    const c = b.feature_cluster?.id;
    if (c) {
      if (!byCluster.has(c)) byCluster.set(c, []);
      byCluster.get(c)?.push(b);
    }
    const d = (b.domain ?? [])[0];
    if (d) {
      if (!byDomain.has(d)) byDomain.set(d, []);
      byDomain.get(d)?.push(b);
    }
  }
  return { byCluster, byDomain };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const registry = await readJson<{ bricks?: RegistryBrick[] }>(opts.registry);
  const bricks = registry.bricks ?? [];
  const indices = buildIndices(bricks);

  const scored: ScoredBrick[] = [];
  for (const b of bricks) {
    const { score, reasons } = await scoreBrick(b, indices);
    scored.push({
      id: b.id,
      name: b.name,
      project: b.project,
      kind: b.kind,
      domain: b.domain,
      feature_cluster: b.feature_cluster,
      source_paths: b.source_paths,
      manifest_path: b.manifest_path,
      status: b.status,
      score,
      reasons
    });
  }

  scored.sort((a, b) => b.score - a.score);

  const keepers = scored.filter((s) => s.score >= opts.threshold);

  await fs.mkdir(path.dirname(opts.allOut), { recursive: true });
  await fs.writeFile(opts.allOut, JSON.stringify({
    threshold: opts.threshold,
    total: scored.length,
    kept: keepers.length,
    scored
  }, null, 2));
  await fs.writeFile(opts.out, JSON.stringify({
    threshold: opts.threshold,
    count: keepers.length,
    bricks: keepers
  }, null, 2));

  // Concise summary to stdout
  console.log(JSON.stringify({
    scanned: scored.length,
    threshold: opts.threshold,
    kept: keepers.length,
    top_10: keepers.slice(0, 10).map((k) => ({ id: k.id, score: k.score, project: k.project }))
  }, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
