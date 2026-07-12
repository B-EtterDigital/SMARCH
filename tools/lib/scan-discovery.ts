/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Existing logical-OR fallbacks intentionally treat every falsy value as absent; replacing them with ?? would change behavior. */
/* eslint-disable @typescript-eslint/no-unnecessary-condition -- Runtime registry, manifest, and CLI inputs can violate their optimistic compile-time declarations; these guards are intentional. */
/* eslint-disable @typescript-eslint/no-base-to-string -- String() deliberately preserves the prior template-literal coercion contract for human-readable reports. */
/**
 * Manifest discovery, candidate classification, and project health.
 * Extracted from sma-scan.ts; keep registry behavior byte-identical.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { featureClusterForBrick } from "./feature-clusters.ts";
import { PROJECTS_ROOT } from "./sma-paths.ts";
import { walk as walkFiles } from "./scan-walk.ts";
import type { BrickManifest } from "./schema-types/brick.manifest.schema.d.ts";
import type { Dirent } from "node:fs";

export interface ScannerOptions { root: string; out: string; projectId: string; excludeRoots: string[]; check: boolean; force: boolean; strict: boolean; json: boolean }
export interface BrickCandidate {
  project: string; path: string; relative_path: string; candidate_type: string; hierarchy_role: string; brick_group: string;
  group_name: string; group_path: string; status: "unmanifested"; reason: string; file_brick?: boolean;
}
interface ValidationIssue { code: string }
interface ValidationReport { errors: ValidationIssue[]; warnings: ValidationIssue[]; calculated_score?: number | null }
export interface CompactBrick {
  id: string; name: string; kind: string; status: string; score: number; project: string; manifest_path: string; source_paths: string[];
  domain: string[]; hierarchy: BrickManifest["hierarchy"] | null; brick_group: string | null; data_classes: string[]; risk: string; models: string[];
  clone_readiness: string; source_commit: string; source_archive_hash: string; owned_paths: string[]; public_paths: string[]; private_paths: string[];
  forbidden_imports: string[]; public_api: string[]; adapters: string[]; forbidden_dependencies: string[]; required_dependencies: string[];
  env_contract: BrickManifest["security"]["env"]; rls_contract: BrickManifest["security"]["rls"]; vulnerability_findings: BrickManifest["security"]["vulnerability_findings"];
  quality_line_count: BrickManifest["quality"]["line_count"]; code_budget: BrickManifest["quality"]["code_budget"]; test_commands: string[];
  verification: BrickManifest["quality"]["verification"]; clone_install_steps: string[]; clone_known_traps: string[]; clone_adaptation_points: string[];
  health: { status: string; error_count: number; warning_count: number; errors: string[]; warnings: string[]; calculated_score: number | null };
  feature_cluster?: { id: string; name: string; description: string };
}
interface ProjectRoot { root: string; id: string }
interface ProjectHealthAccumulator {
  id: string; root: string; brick_count: number; unmanifested_count?: number; status_counts: Record<string, number>;
  health_counts: Record<string, number>; candidate_type_counts: Record<string, number>; candidate_role_counts: Record<string, number>;
  candidate_group_count: number; _candidate_groups: Set<string>; error_count: number; warning_count: number; average_score: number;
}

const smaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOptions: ScannerOptions = {
  root: PROJECTS_ROOT,
  out: path.join(smaRoot, "registry", "global-modules.generated.json"),
  projectId: "",
  excludeRoots: [],
  check: false,
  force: false,
  strict: false,
  json: false
};
let activeExcludedRoots: string[] = [];
const excludedDirs = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".astro",
  ".turbo",
  ".netlify",
  ".tmp",
  "tmp",
  "playwright-report",
  "test-results",
  // Local retrieval artifacts — these can be large and must not become bricks
  "graphify-out",
  ".graphify",
  // Python venvs + caches — never source
  ".venv",
  "venv",
  "__pycache__",
  // Generated-code markers — not authored sources
  "__generated__",
  // Parking convention from acme-factory (orphan-prototypes / by-path) — archived code
  "parking",
  // Common archive markers
  "archived",
  ".archive"
]);
const archiveDirPatterns = [
  "corrupt-backup",
  "stream_preview_release",
  "fix-push",
  "backup",
  // Agent worktree containers duplicate first-class projects and can carry
  // stale module manifests from in-flight branches. They are coordination
  // surfaces, not canonical portfolio scan roots.
  "worktrees"
];
const moduleCandidateTypes = new Set([
  "browser_worker",
  "component_module",
  "context_module",
  "library_module",
  "page_module",
  "service_module",
  "state_module",
  "supabase_shared",
  "test_suite_group"
]);
const brickGroupCandidateTypes = new Set([
  "app"
]);

export function setActiveExcludedRoots(roots: string[]) {
  activeExcludedRoots = roots;
}

export function getActiveExcludedRoots(): string[] {
  return activeExcludedRoots;
}

export function isExcludedDirName(name: string): boolean {
  if (excludedDirs.has(name) || name.startsWith("SSA_SSI_SSTF_SPA_COLLECTION_")) {
    return true;
  }

  return archiveDirPatterns.some((pattern) => name.includes(pattern));
}

export function isExcludedPath(targetPath: string): boolean {
  const absoluteTarget = path.resolve(targetPath);
  return activeExcludedRoots.some((excludedRoot) => isWithinRoot(excludedRoot, absoluteTarget));
}

// eslint-disable-next-line complexity -- Compatibility fallback expressions inflate the branch metric although this normalization and report assembly remains linear.
export function parseArgs(argv: string[]): ScannerOptions {
  const options: ScannerOptions = { ...defaultOptions, excludeRoots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--root" && next) {
      options.root = path.resolve(next);
      i += 1;
      continue;
    }
    if (arg === "--out" && next) {
      options.out = path.resolve(next);
      i += 1;
      continue;
    }
    if (arg === "--project-id" && next) {
      options.projectId = next;
      i += 1;
      continue;
    }
    if (arg === "--exclude-root" && next) {
      options.excludeRoots.push(path.resolve(next));
      i += 1;
      continue;
    }
    if (arg === "--check") {
      options.check = true;
      continue;
    }
    if (arg === "--force") { options.force = true; continue; }
    if (arg === "--strict") {
      options.strict = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`SMA scanner

Usage:
  node tools/sma-scan.ts --root $SMA_PROJECTS_ROOT --out registry/global-modules.generated.json

Options:
  --root  Directory to scan for module.sweetspot.json files
  --out   Output registry JSON path
  --project-id Force all results to a single project id
  --exclude-root Skip a nested subtree while scanning (repeatable)
  --check Exit non-zero when manifest validation errors exist
  --force Write a rejected registry despite manifest errors
  --strict Exit non-zero when validation warnings exist
  --json  Print machine-readable summary
`);
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    void error;
    return false;
  }
}

export async function walk(dir: string, results: string[] = []): Promise<string[]> {
  return walkFiles(dir, { isExcludedDirName, isExcludedPath }, results);
}

const moduleParentTypes = new Map([
  ["modules", "frontend_module"],
  ["features", "frontend_feature"],
  ["pages", "page_module"],
  ["components", "component_module"],
  ["services", "service_module"],
  ["stores", "state_module"],
  ["contexts", "context_module"],
  ["lib", "library_module"],
  ["libs", "library_module"],
  ["hooks", "hook_module"],
  ["adapters", "adapter_module"],
  ["utilities", "utility_module"],
  ["utils", "utility_module"],
  ["workers", "browser_worker"],
  ["theme", "theme_module"],
  ["themes", "theme_module"],
  ["types", "types_module"],
  ["scripts", "script_module"],
  ["migrations", "migration_module"],
  ["plugins", "plugin_module"],
  ["extensions", "extension_module"],
  ["workflows", "workflow_module"],
  ["actions", "action_module"],
  ["middleware", "middleware_module"],
  ["middlewares", "middleware_module"],
  ["integrations", "integration_module"],
  ["entities", "entity_module"],
  ["models", "model_module"],
  ["schemas", "schema_module"],
  ["queries", "query_module"],
  ["mutations", "mutation_module"],
  ["resolvers", "resolver_module"]
]);

// Ancestors that count as "in-app" so a generic moduleParentTypes match counts.
// Without this we'd over-match on coincidental folders named "services" anywhere.
const appAncestors = new Set([
  "src", "app", "apps", "packages", "electron", "renderer", "main",
  "sidecar", "shared", "frontend", "backend", "client", "server",
  "web", "mobile", "desktop", "core", "ui"
]);

function hasAppAncestor(parts: string[], index: number): boolean {
  for (let i = 0; i < index; i += 1) {
    if (appAncestors.has(parts[i])) return true;
  }
  return false;
}

// Specialized leaf-brick names — when a directory has one of these names AND
// any app ancestor, treat the directory itself as a brick of that type. This
// is what catches deep sub-bricks like:
//   src/renderer/modules/modchat/components/arena/hooks  -> hook_module
//   src/renderer/modules/modchat/components/deep-summation/engine -> engine_module
//   src/renderer/modules/modchat/components/chat/archive -> archive_module
const leafBrickNames = new Map([
  ["hooks", "hook_module"],
  ["utils", "utility_module"],
  ["utilities", "utility_module"],
  ["state", "state_module"],
  ["store", "state_module"],
  ["stores", "state_module"],
  ["services", "service_module"],
  ["adapters", "adapter_module"],
  ["styles", "style_module"],
  ["theme", "theme_module"],
  ["themes", "theme_module"],
  ["types", "types_module"],
  ["interfaces", "types_module"],
  ["config", "config_module"],
  ["security", "security_module"],
  ["engine", "engine_module"],
  ["pipeline", "pipeline_module"],
  ["pipelines", "pipeline_module"],
  ["providers", "providers_module"],
  ["archive", "archive_module"],
  ["setup", "setup_module"],
  ["ui", "ui_module"],
  ["views", "view_module"],
  ["blocks", "block_module"],
  ["smart", "smart_module"],
  ["finetuning", "training_module"]
]);

// eslint-disable-next-line complexity -- Compatibility fallback expressions inflate the branch metric although this normalization and report assembly remains linear.
function candidateType(parts: string[], index: number): string {
  const name = parts[index];
  const parent = parts[index - 1];
  const grandParent = parts[index - 2];
  const greatGrandParent = parts[index - 3];

  // App / package / worker top-level containers
  if (parent === "apps" && parts.length === 2) return "app";
  if (parent === "packages" && parts.length === 2) return "package";
  if (parent === "runpod-workers" && parts.length === 2) return "runpod_worker";

  // Sidecar layout: <root>/sidecar/<brick> or <root>/sidecars/<brick>
  if ((parent === "sidecar" || parent === "sidecars") && parts.length <= 3) {
    return "sidecar_module";
  }

  // Native build dirs are a brick (e.g. src/main/native/audio-capture)
  if (parent === "native" && hasAppAncestor(parts, index)) {
    return "native_module";
  }

  // Generic well-known parent names anywhere in an app subtree
  if (moduleParentTypes.has(parent) && hasAppAncestor(parts, index)) {
    return moduleParentTypes.get(parent) || "";
  }

  // Leaf-brick names anywhere in an app subtree (catches deep specialized dirs)
  if (leafBrickNames.has(name) && hasAppAncestor(parts, index) && index >= 2) {
    return leafBrickNames.get(name) || "";
  }

  // Next.js-style top-level routes: app/<route> or pages/<route> at project root
  if ((parent === "app" || parent === "pages") && parts.length === 2) {
    return "page_module";
  }

  // Supabase / Netlify functions
  if (parent === "functions" && grandParent === "supabase") {
    return name === "_shared" ? "supabase_shared" : "supabase_function";
  }
  if (parent === "functions" && grandParent === "netlify") {
    return "netlify_function";
  }
  if (parent === "edge-functions" && grandParent === "netlify") {
    return "netlify_edge_function";
  }

  // Skills
  if (parent === "skills") return "agent_skill";

  // Shared root folder
  if (parent === "shared" && parts.length === 2) return "shared_module";

  // Test suites
  if (parent === "suites" && grandParent === "0000testing") return "test_suite";
  if (parent === "suites" && greatGrandParent === "0000testing") return "test_suite_group";

  // 0000testing/<top> like ComprehensiveSuites/01_X, FeatureSuites/01_X etc.
  if (greatGrandParent === "0000testing" && (/Suites?$/i.test(parent) || /Suites?$/i.test(grandParent))) {
    return "test_suite";
  }

  return "";
}

export function toSlashPath(value: string): string {
  return value.split(path.sep).join("/");
}

function hierarchyRole(type: string): string {
  if (brickGroupCandidateTypes.has(type)) {
    return "brick_group_candidate";
  }

  if (moduleCandidateTypes.has(type)) {
    return "module_candidate";
  }

  return "brick_candidate";
}

function candidateDomain(name: unknown): string {
  const [first] = String(name || "")
    .replace(/^_+/, "")
    .split(/[-_]/)
    .filter(Boolean);

  return first || "misc";
}

function candidateGroup(root: string, fullPath: string, type: string, project: string) {
  const relative = path.relative(root, fullPath);
  const parts = relative.split(path.sep);
  const parentParts = parts.slice(0, -1);
  const parentPath = parentParts.length ? path.join(root, ...parentParts) : root;
  let groupKey = parentParts.length ? toSlashPath(parentParts.join(path.sep)) : ".";
  let groupName = groupKey;

  if (type === "supabase_function") {
    const domain = candidateDomain(parts.at(-1));
    groupKey = `${groupKey}:${domain}`;
    groupName = `${toSlashPath(parentParts.join(path.sep))}/${domain}*`;
  }

  return {
    id: `${project}:${groupKey}`,
    name: groupName,
    path: parentPath
  };
}

async function hasManifest(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, "module.sweetspot.json"));
    return true;
  } catch (error) {
    void error;
    return false;
  }
}

// File-level brick patterns: well-named individual files inside a known
// container that each represent an independent implementation (e.g., one
// transcription provider per file, one effect handler per file, etc.).
//
// Tuple: [parentDirNameRegex, fileNameRegex, brickType]
// File-level brick patterns. Match whenever the file is named *<Suffix>.ext AND
// EITHER the parent dir name matches the corresponding plural kind dir, OR any
// ancestor up to 3 levels above does (catches src/renderer/pipelines/whisperFlow/WhisperFlowPipeline.ts).
const fileBrickPatterns: [RegExp, RegExp, string][] = [
  [/^(providers?)$/, /([A-Za-z0-9]+Provider)\.(t|j)sx?$/i, "provider_file"],
  [/^(handlers?)$/, /([A-Za-z0-9]+Handler)\.(t|j)sx?$/i, "handler_file"],
  [/^(adapters?)$/, /([A-Za-z0-9]+Adapter)\.(t|j)sx?$/i, "adapter_file"],
  [/^(pipelines?)$/, /([A-Za-z0-9]+Pipeline)\.(t|j)sx?$/i, "pipeline_file"],
  [/^(services?)$/, /([A-Za-z0-9]+Service)\.(t|j)sx?$/i, "service_file"],
  [/^(strategies)$/, /([A-Za-z0-9]+Strategy)\.(t|j)sx?$/i, "strategy_file"],
  [/^(commands?)$/, /([A-Za-z0-9]+Command)\.(t|j)sx?$/i, "command_file"],
  [/^(connectors?)$/, /([A-Za-z0-9]+Connector)\.(t|j)sx?$/i, "connector_file"],
  [/^(middleware|middlewares)$/, /([A-Za-z0-9]+Middleware)\.(t|j)sx?$/i, "middleware_file"],
  [/^(guards?)$/, /([A-Za-z0-9]+Guard)\.(t|j)sx?$/i, "guard_file"],
  [/^(resolvers?)$/, /([A-Za-z0-9]+Resolver)\.(t|j)sx?$/i, "resolver_file"],
  [/^(queries)$/, /([A-Za-z0-9]+Query)\.(t|j)sx?$/i, "query_file"],
  [/^(mutations)$/, /([A-Za-z0-9]+Mutation)\.(t|j)sx?$/i, "mutation_file"],
  [/^(scripts?)$/, /^([a-zA-Z][A-Za-z0-9_-]*)\.(mjs|cjs|js|ts)$/i, "script_file"],
  [/^(migrations?)$/, /^([0-9]+[_-][a-zA-Z][A-Za-z0-9_-]*|\d{14,}[_-][a-zA-Z][A-Za-z0-9_-]*)\.sql$/i, "migration_file"],
  // Well-named top-level utility files: auth.ts, cors.ts, rateLimit.ts, etc., inside
  // any app ancestor directly (not in a subdir). We match common single-concern names.
  [/^(utils?|utilities|lib|libs|helpers?)$/, /^(auth|cors|rateLimit|logger|session|jwt|rbac|errors?|env|config|telemetry|metrics|cache|redis|queue|email|webhook|validate|validator|sanitize)\.(t|j)sx?$/i, "utility_file"],
  // The container can be the implementation dir itself (e.g. transcription/, whisperFlow/)
  // when one of the parents is the plural kind dir. We allow up to grandparent.
  [/transcription|whisper|wispr|chirp|stt|tts|audio2text/i, /([A-Za-z0-9]+Pipeline)\.(t|j)sx?$/i, "pipeline_file"]
];

function fileCandidateType(parts: string[]): string {
  if (parts.length < 2) return "";
  const fileName = parts.at(-1) || "";
  const parentName = parts.at(-2) || "";
  const grandParent = parts.at(-3);
  const greatGrandParent = parts.at(-4);
  for (const [parentRe, fileRe, type] of fileBrickPatterns) {
    if (!fileRe.test(fileName)) continue;
    if (parentRe.test(parentName)) return type;
    if (grandParent && parentRe.test(grandParent)) return type;
    if (greatGrandParent && parentRe.test(greatGrandParent)) return type;
  }
  return "";
}

// eslint-disable-next-line max-lines-per-function, complexity -- Declarative report, compatibility, or fixture assembly stays contiguous so field order and side-effect order remain auditable; splitting would not reduce conceptual complexity.
export async function discoverPotentialBricks(root: string, dir = root, candidates: BrickCandidate[] = [], forcedProjectId = ""): Promise<BrickCandidate[]> {
  if (isExcludedPath(dir)) {
    return candidates;
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relative = path.relative(root, fullPath);
    const parts = relative.split(path.sep);
    const lastIndex = parts.length - 1;

    if (entry.isDirectory()) {
      if (isExcludedDirName(entry.name) || isExcludedPath(fullPath)) continue;

      const type = candidateType(parts, lastIndex);

      if (type && !(await hasManifest(fullPath))) {
        const project = projectId(root, fullPath, forcedProjectId);
        const group = candidateGroup(root, fullPath, type, project);

        candidates.push({
          project,
          path: fullPath,
          relative_path: toSlashPath(relative),
          candidate_type: type,
          hierarchy_role: hierarchyRole(type),
          brick_group: group.id,
          group_name: group.name,
          group_path: group.path,
          status: "unmanifested",
          reason: `Potential ${type} brick has no module.sweetspot.json`
        });
      }

      await discoverPotentialBricks(root, fullPath, candidates, forcedProjectId);
      continue;
    }

    if (entry.isFile() && !isExcludedPath(fullPath) && hasAppAncestor(parts, lastIndex)) {
      const fileType = fileCandidateType(parts);
      if (fileType) {
        // File-level brick: manifest goes alongside the file as
        // <name>.module.sweetspot.json (different from the dir convention).
        const baseName = entry.name.replace(/\.(t|j)sx?$/, "");
        const sidecarManifest = path.join(dir, `${baseName}.module.sweetspot.json`);
        try {
          await fs.access(sidecarManifest);
          continue; // already has a sidecar manifest
        } catch (error) {
          void error;
          // no manifest yet
        }
        const project = projectId(root, fullPath, forcedProjectId);
        const groupKey = `${project}:${toSlashPath(parts.slice(0, -1).join(path.sep))}:files`;
        candidates.push({
          project,
          path: fullPath,
          relative_path: toSlashPath(relative),
          candidate_type: fileType,
          hierarchy_role: "brick_candidate",
          brick_group: groupKey,
          group_name: toSlashPath(parts.slice(0, -1).join(path.sep)) + "/*",
          group_path: dir,
          status: "unmanifested",
          file_brick: true,
          reason: `Potential ${fileType} brick (file-level) has no sidecar manifest`
        });
      }
    }
  }

  return candidates;
}

export async function readManifest(filePath: string): Promise<BrickManifest> {
  const raw = await fs.readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return parsed as BrickManifest;
}

function projectIdFromPath(root: string, manifestPath: string): string {
  const relative = path.relative(root, manifestPath);
  const [first] = relative.split(path.sep);
  return first || "unknown";
}

async function inferProjectId(root: string): Promise<string> {
  try {
    const packageJson: unknown = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

    if (
      typeof packageJson === "object"
      && packageJson !== null
      && "name" in packageJson
      && typeof packageJson.name === "string"
      && packageJson.name.trim()
    ) {
      return packageJson.name.trim();
    }
  } catch (error) {
    void error;
    // Not a package root.
  }

  return "";
}

async function isProjectRoot(dir: string): Promise<boolean> {
  for (const marker of ["package.json", "pnpm-workspace.yaml", "turbo.json"]) {
    if (await pathExists(path.join(dir, marker))) {
      return true;
    }
  }

  return false;
}

function projectId(root: string, targetPath: string, forcedProjectId = ""): string {
  return forcedProjectId || projectIdFromPath(root, targetPath);
}

function normalizeBrickIdForProject(brickId: unknown, currentProjectId: unknown): string {
  const value = String(brickId || "missing-id");
  const project = String(currentProjectId || "").trim();

  if (!project) {
    return value;
  }

  const parts = value.split(".");

  if (parts.length < 2 || parts[0] === project) {
    return value;
  }

  return [project, ...parts.slice(1)].join(".");
}

export async function discoverProjectRoots(root: string, explicitProjectId = ""): Promise<ProjectRoot[]> {
  if (explicitProjectId) {
    return [{ root, id: explicitProjectId }];
  }

  const directId = await inferProjectId(root);
  if (directId || await isProjectRoot(root)) {
    return [{ root, id: directId || path.basename(root) }];
  }

  const discovered: ProjectRoot[] = [];

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > 2) {
      return;
    }

    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      void error;
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || isExcludedDirName(entry.name)) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      const id = await inferProjectId(fullPath);

      if (id || await isProjectRoot(fullPath)) {
        discovered.push({ root: fullPath, id: id || entry.name });
        continue;
      }

      await visit(fullPath, depth + 1);
    }
  }

  await visit(root, 0);

  if (discovered.length === 0) {
    return [{ root, id: path.basename(root) }];
  }

  return discovered.sort((a, b) => a.root.localeCompare(b.root));
}

function modelList(manifest: BrickManifest): string[] {
  const events = [
    manifest.provenance.created_by,
    ...(manifest.provenance.touched_by || []),
    ...(manifest.provenance.reviewed_by || [])
  ].filter((event): event is NonNullable<typeof event> => Boolean(event));

  return [...new Set(events.map((event) => event.model).filter((model): model is string => typeof model === "string" && model.length > 0))].sort();
}

function healthFromReport(report: ValidationReport): string {
  if (report.errors.length > 0) {
    return "fail";
  }

  if (report.warnings.length > 0) {
    return "warn";
  }

  return "ok";
}

// eslint-disable-next-line max-lines-per-function, complexity -- Declarative report, compatibility, or fixture assembly stays contiguous so field order and side-effect order remain auditable; splitting would not reduce conceptual complexity.
export function compactBrick(root: string, manifestPath: string, manifest: BrickManifest, validation: ValidationReport, forcedProjectId = ""): CompactBrick {
  const currentProjectId = forcedProjectId
    || projectId(root, manifestPath, forcedProjectId)
    || manifest.source.project
    || "unknown";
  const brick: CompactBrick = {
    id: normalizeBrickIdForProject(manifest.brick.id || "missing-id", currentProjectId),
    name: manifest.brick.name || "Missing name",
    kind: manifest.brick.kind || "unknown",
    status: manifest.brick.status || "experimental",
    score: manifest.quality.score ?? 0,
    // Prefer the detected project (from --project-id or root inference) over a
    // potentially stale `source.project` baked into the manifest. If the
    // manifest claims a different project than the one currently being
    // scanned, the scan-time project ID wins — that's the only way to recover
    // from old bootstrap mistakes without rewriting every manifest.
    project: currentProjectId,
    manifest_path: manifestPath,
    source_paths: manifest.source.paths || [],
    domain: manifest.brick.domain || [],
    hierarchy: manifest.hierarchy || null,
    brick_group: manifest.hierarchy?.group_id || null,
    data_classes: manifest.classification.data_classes || [],
    risk: manifest.classification.risk || "unknown",
    models: modelList(manifest),
    clone_readiness: manifest.clone.readiness || "blocked",
    source_commit: manifest.source.commit || "",
    source_archive_hash: manifest.source.archive_hash || "",
    owned_paths: manifest.boundaries.owned_paths || [],
    public_paths: manifest.boundaries.public_paths || [],
    private_paths: manifest.boundaries.private_paths || [],
    forbidden_imports: manifest.boundaries.forbidden_imports || [],
    public_api: manifest.interfaces.public_api || [],
    adapters: manifest.interfaces.adapters || [],
    forbidden_dependencies: manifest.interfaces.forbidden_dependencies || [],
    required_dependencies: manifest.interfaces.required_dependencies || [],
    env_contract: manifest.security.env || { required: false, status: "not_applicable", variables: [] },
    rls_contract: manifest.security.rls || { required: false, status: "not_applicable", negative_tests: [] },
    vulnerability_findings: manifest.security.vulnerability_findings || { critical: 0, high: 0, medium: 0, low: 0 },
    quality_line_count: manifest.quality.line_count || { max_file_lines: 0, over_600_count: 0 },
    code_budget: manifest.quality.code_budget || { status: "unknown", feature_lines: 0, file_count: 0, dependency_count: 0, notes: "" },
    test_commands: manifest.quality.test_commands || [],
    verification: manifest.quality.verification || [],
    clone_install_steps: manifest.clone.install_steps || [],
    clone_known_traps: manifest.clone.known_traps || [],
    clone_adaptation_points: manifest.clone.adaptation_points || [],
    health: {
      status: healthFromReport(validation),
      error_count: validation.errors.length,
      warning_count: validation.warnings.length,
      errors: validation.errors.map((item) => item.code),
      warnings: validation.warnings.map((item) => item.code),
      calculated_score: validation.calculated_score ?? null
    }
  };

  brick.feature_cluster = featureClusterForBrick({
    id: brick.id,
    name: brick.name,
    kind: brick.kind,
    status: brick.status,
    risk: brick.risk,
    brick_group: brick.brick_group || undefined,
    manifest_path: brick.manifest_path,
    source_paths: brick.source_paths,
    domain: brick.domain,
  });
  return brick;
}

function emptyStatusCounts(): Record<string, number> {
  return {
    experimental: 0,
    project_bound: 0,
    variant: 0,
    duplicate: 0,
    legacy: 0,
    candidate: 0,
    canonical: 0
  };
}

export function projectHealth(root: string, bricks: CompactBrick[], unmanifested: BrickCandidate[] = [], forcedProjectId = "") {
  const byProject = new Map<string, ProjectHealthAccumulator>();

  for (const brick of bricks) {
    const current = byProject.get(brick.project) || {
      id: brick.project,
      root: forcedProjectId ? root : path.join(root, brick.project),
      brick_count: 0,
      status_counts: emptyStatusCounts(),
      health_counts: { ok: 0, warn: 0, fail: 0 },
      candidate_type_counts: {},
      candidate_role_counts: {},
      candidate_group_count: 0,
      _candidate_groups: new Set(),
      error_count: 0,
      warning_count: 0,
      average_score: 0
    };

    current.brick_count += 1;
    current.status_counts[brick.status] = (current.status_counts[brick.status] || 0) + 1;
    current.health_counts[brick.health.status] += 1;
    current.error_count += brick.health.error_count;
    current.warning_count += brick.health.warning_count;
    current.average_score += brick.score || 0;
    byProject.set(brick.project, current);
  }

  for (const candidate of unmanifested) {
    const current = byProject.get(candidate.project) || {
      id: candidate.project,
      root: forcedProjectId ? root : path.join(root, candidate.project),
      brick_count: 0,
      unmanifested_count: 0,
      status_counts: emptyStatusCounts(),
      health_counts: { ok: 0, warn: 0, fail: 0 },
      candidate_type_counts: {},
      candidate_role_counts: {},
      candidate_group_count: 0,
      _candidate_groups: new Set(),
      error_count: 0,
      warning_count: 0,
      average_score: 0
    };

    current.unmanifested_count = (current.unmanifested_count || 0) + 1;
    current.candidate_type_counts[candidate.candidate_type] = (current.candidate_type_counts[candidate.candidate_type] || 0) + 1;
    current.candidate_role_counts[candidate.hierarchy_role] = (current.candidate_role_counts[candidate.hierarchy_role] || 0) + 1;
    current._candidate_groups.add(candidate.brick_group);
    current.candidate_group_count = current._candidate_groups.size;
    current.health_counts.warn += 1;
    current.warning_count += 1;
    byProject.set(candidate.project, current);
  }

  return [...byProject.values()].sort((a, b) => a.id.localeCompare(b.id)).map((project) => {
    const { _candidate_groups: candidateGroups, ...publicProject } = project;

    return {
      ...publicProject,
      candidate_group_count: candidateGroups.size || 0,
      unmanifested_count: project.unmanifested_count || 0,
      average_score: project.brick_count ? Math.round(project.average_score / project.brick_count) : 0
    };
  });
}

export function candidateGroups(candidates: BrickCandidate[]) {
  const byGroup = new Map<string, { project: string; id: string; name: string; path: string; candidate_count: number; candidate_type_counts: Record<string, number>; candidate_role_counts: Record<string, number>; sample_paths: string[] }>();

  for (const candidate of candidates) {
    const key = `${candidate.project}\0${candidate.brick_group}`;
    const current = byGroup.get(key) || {
      project: candidate.project,
      id: candidate.brick_group,
      name: candidate.group_name,
      path: candidate.group_path,
      candidate_count: 0,
      candidate_type_counts: {},
      candidate_role_counts: {},
      sample_paths: []
    };

    current.candidate_count += 1;
    current.candidate_type_counts[candidate.candidate_type] = (current.candidate_type_counts[candidate.candidate_type] || 0) + 1;
    current.candidate_role_counts[candidate.hierarchy_role] = (current.candidate_role_counts[candidate.hierarchy_role] || 0) + 1;

    if (current.sample_paths.length < 12) {
      current.sample_paths.push(candidate.relative_path || candidate.path);
    }

    byGroup.set(key, current);
  }

  return [...byGroup.values()].sort((a, b) => {
    const projectOrder = a.project.localeCompare(b.project);
    return projectOrder || b.candidate_count - a.candidate_count || a.name.localeCompare(b.name);
  });
}

export function isWithinRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
