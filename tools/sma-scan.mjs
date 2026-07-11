#!/usr/bin/env node
/**
 * What: Discovers and validates module manifests across a project root.
 * Why: Portfolio tools need one normalized registry instead of trusting scattered declarations.
 * How: Reads manifests and source metadata, then writes a generated registry or checks drift.
 * Callers: Portfolio scan, state generation, validation, and dashboards consume its output.
 * Example: `node tools/sma-scan.mjs --help`
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { featureClusterForBrick } from "./lib/feature-clusters.ts";
import { normalizeRegistrySnapshot, writeJsonIfMeaningfulChanged } from "./lib/stable-generated.ts";
import { validateManifest } from "./sma-validate.mjs";
import { PROJECTS_ROOT } from "./lib/sma-paths.ts";
const smaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOptions = {
  root: PROJECTS_ROOT,
  out: path.join(smaRoot, "registry", "global-modules.generated.json"),
  projectId: "",
  excludeRoots: [],
  check: false,
  force: false,
  strict: false,
  json: false
};
let activeExcludedRoots = [];
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
const oversizedThresholds = {
  medium: 350,
  high: 600,
  critical: 900
};
const codeFileExtensions = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".swift", ".php", ".cs", ".sql"
]);
const analyzableSourceExtensions = new Set([
  ...codeFileExtensions,
  ".json", ".md", ".mdx", ".yaml", ".yml", ".toml", ".txt"
]);
const ignoredImportExtensions = new Set([
  ".css", ".scss", ".sass", ".less", ".styl",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico",
  ".mp3", ".wav", ".ogg", ".mp4", ".webm",
  ".woff", ".woff2", ".ttf", ".otf", ".eot"
]);
const ignoredEnvNames = new Set([
  "APPDATA",
  "CI",
  "COMSPEC",
  "DEBUG",
  "DEV",
  "HOME",
  "HOSTNAME",
  "INIT_CWD",
  "LOCALAPPDATA",
  "MODE",
  "NODE_ENV",
  "OS",
  "PATH",
  "PROD",
  "PRODUCTION",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES_X86",
  "PWD",
  "SHELL",
  "SHLVL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TEST",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERNAME",
  "USERPROFILE"
]);

const ignoredEnvPrefixes = [
  "ALLOW_",
  "ANT_",
  "CLAUDE_CODE_",
  "CLAUDE_",
  "COO_",
  "CURSOR_",
  "DEBUG_",
  "DISABLE_",
  "ENABLE_",
  "FLY_",
  "GITHUB_",
  "OTEL_",
  "RAILWAY_",
  "SESSION_",
  "SSH_",
  "TERM_",
  "TEST_",
  "USE_",
  "VSCODE_",
  "WEBSITE_",
  "NETLIFY_",
  "NPM_",
  "VITEST_"
];

const contractEnvSignals = [
  "ACCOUNT",
  "ANON",
  "API",
  "APP_URL",
  "AUTH",
  "BASE_URL",
  "BEDROCK",
  "BUCKET",
  "CREDENTIAL",
  "CRON",
  "DATABASE",
  "DB",
  "DOMAIN",
  "EMBED",
  "ENCRYPTION",
  "ENDPOINT",
  "FCM",
  "FUNCTION_SECRET",
  "GEMINI",
  "GOOGLE",
  "HOST",
  "INTERNAL",
  "KEY",
  "MODEL",
  "OPENAI",
  "OPENROUTER",
  "OPEN_ROUTER",
  "PASSWORD",
  "PORT",
  "PROJECT",
  "REDIS",
  "REGION",
  "RESEND",
  "R2",
  "RUNPOD",
  "SECRET",
  "SENTRY",
  "SERVICE_ROLE",
  "SMTP",
  "STRIPE",
  "SUPABASE",
  "TOKEN",
  "TWILIO",
  "UPSTASH",
  "URI",
  "URL",
  "USERNAME",
  "VAPID",
  "VERTEX",
  "WEBHOOK",
  "WORKOS"
];

const complianceDimensionDefinitions = [
  { key: "boundary_clean", label: "Boundary clean", weight: 22 },
  { key: "env_contract", label: "Env contract", weight: 18 },
  { key: "clone_steps", label: "Clone steps", weight: 12 },
  { key: "test_commands", label: "Test commands", weight: 12 },
  { key: "known_traps", label: "Known traps", weight: 10 },
  { key: "public_api", label: "Public API", weight: 8 },
  { key: "rls_contract", label: "RLS contract", weight: 8 },
  { key: "source_attestation", label: "Source attestation", weight: 5 },
  { key: "security_clean", label: "Security clean", weight: 5 }
];

const genericBuildTokens = new Set([
  "api",
  "app",
  "apps",
  "asset",
  "assets",
  "client",
  "common",
  "component",
  "components",
  "config",
  "context",
  "contexts",
  "core",
  "data",
  "domain",
  "feature",
  "features",
  "file",
  "files",
  "general",
  "helper",
  "helpers",
  "hook",
  "hooks",
  "internal",
  "lib",
  "libs",
  "main",
  "module",
  "modules",
  "page",
  "pages",
  "private",
  "provider",
  "providers",
  "public",
  "renderer",
  "route",
  "routes",
  "screen",
  "screens",
  "server",
  "service",
  "services",
  "shared",
  "src",
  "state",
  "store",
  "stores",
  "system",
  "test",
  "tests",
  "type",
  "types",
  "ui",
  "util",
  "utils",
  "view",
  "views",
  "web"
]);

function isExcludedDirName(name) {
  if (excludedDirs.has(name) || name.startsWith("SSA_SSI_SSTF_SPA_COLLECTION_")) {
    return true;
  }

  return archiveDirPatterns.some((pattern) => name.includes(pattern));
}

function isExcludedPath(targetPath) {
  const absoluteTarget = path.resolve(targetPath);
  return activeExcludedRoots.some((excludedRoot) => isWithinRoot(excludedRoot, absoluteTarget));
}

function parseArgs(argv) {
  const options = { ...defaultOptions, excludeRoots: [] };
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

function printHelp() {
  console.log(`SMA scanner

Usage:
  node tools/sma-scan.mjs --root ~/DEV/Projects --out registry/global-modules.generated.json

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

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, results = []) {
  if (isExcludedPath(dir)) {
    return results;
  }

  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (isExcludedDirName(entry.name) || isExcludedPath(fullPath)) {
        continue;
      }

      await walk(fullPath, results);
      continue;
    }

    if (entry.isFile() && !isExcludedPath(fullPath) && (entry.name === "module.sweetspot.json" || entry.name.endsWith(".module.sweetspot.json"))) {
      results.push(fullPath);
    }
  }

  return results;
}

// Folder names that mark a "well-known brickable container" — i.e. their direct
// children are candidate bricks of the corresponding type. Any of these names
// anywhere in the path (not just immediately under `src/`) qualifies, so that
// Electron / Next.js / sidecar layouts are picked up:
//
//   src/main/services/<brick>             -> service_module
//   src/renderer/modules/<brick>          -> frontend_module
//   src/renderer/features/<brick>         -> frontend_feature
//   src/renderer/components/<brick>       -> component_module
//   electron/services/<brick>             -> service_module
//   sidecar/<brick>                       -> sidecar_module
//   app/<route>                           -> page_module (Next.js app router)
//   pages/<route>                         -> page_module (Next.js pages router)
//
// The parent name -> brick type table.
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

function hasAppAncestor(parts, index) {
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

function candidateType(parts, index) {
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
    return moduleParentTypes.get(parent);
  }

  // Leaf-brick names anywhere in an app subtree (catches deep specialized dirs)
  if (leafBrickNames.has(name) && hasAppAncestor(parts, index) && index >= 2) {
    return leafBrickNames.get(name);
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

function toSlashPath(value) {
  return value.split(path.sep).join("/");
}

function hierarchyRole(type) {
  if (brickGroupCandidateTypes.has(type)) {
    return "brick_group_candidate";
  }

  if (moduleCandidateTypes.has(type)) {
    return "module_candidate";
  }

  return "brick_candidate";
}

function candidateDomain(name) {
  const [first] = String(name || "")
    .replace(/^_+/, "")
    .split(/[-_]/)
    .filter(Boolean);

  return first || "misc";
}

function candidateGroup(root, fullPath, type, project) {
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

async function hasManifest(dir) {
  try {
    await fs.access(path.join(dir, "module.sweetspot.json"));
    return true;
  } catch {
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
/** @type {Array<[RegExp, RegExp, string]>} */ const fileBrickPatterns = [
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

function fileCandidateType(parts) {
  if (parts.length < 2) return "";
  const fileName = parts.at(-1);
  const parentName = parts.at(-2);
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

async function discoverPotentialBricks(root, dir = root, candidates = [], forcedProjectId = "") {
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
        } catch {
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

async function readManifest(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function projectIdFromPath(root, manifestPath) {
  const relative = path.relative(root, manifestPath);
  const [first] = relative.split(path.sep);
  return first || "unknown";
}

async function inferProjectId(root) {
  try {
    const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));

    if (typeof packageJson.name === "string" && packageJson.name.trim()) {
      return packageJson.name.trim();
    }
  } catch {
    // Not a package root.
  }

  return "";
}

async function isProjectRoot(dir) {
  for (const marker of ["package.json", "pnpm-workspace.yaml", "turbo.json"]) {
    if (await pathExists(path.join(dir, marker))) {
      return true;
    }
  }

  return false;
}

function projectId(root, targetPath, forcedProjectId = "") {
  return forcedProjectId || projectIdFromPath(root, targetPath);
}

function normalizeBrickIdForProject(brickId, currentProjectId) {
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

async function discoverProjectRoots(root, explicitProjectId = "") {
  if (explicitProjectId) {
    return [{ root, id: explicitProjectId }];
  }

  const directId = await inferProjectId(root);
  if (directId || await isProjectRoot(root)) {
    return [{ root, id: directId || path.basename(root) }];
  }

  const discovered = [];

  async function visit(dir, depth) {
    if (depth > 2) {
      return;
    }

    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
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

function modelList(manifest) {
  const events = [
    manifest.provenance?.created_by,
    ...(manifest.provenance?.touched_by || []),
    ...(manifest.provenance?.reviewed_by || [])
  ].filter(Boolean);

  return [...new Set(events.map((event) => event.model).filter(Boolean))].sort();
}

function healthFromReport(report) {
  if (report.errors.length > 0) {
    return "fail";
  }

  if (report.warnings.length > 0) {
    return "warn";
  }

  return "ok";
}

function compactBrick(root, manifestPath, manifest, validation, forcedProjectId = "") {
  const currentProjectId = forcedProjectId
    || projectId(root, manifestPath, forcedProjectId)
    || manifest.source?.project
    || "unknown";
  const brick = {
    id: normalizeBrickIdForProject(manifest.brick?.id || "missing-id", currentProjectId),
    name: manifest.brick?.name || "Missing name",
    kind: manifest.brick?.kind || "unknown",
    status: manifest.brick?.status || "experimental",
    score: manifest.quality?.score ?? 0,
    // Prefer the detected project (from --project-id or root inference) over a
    // potentially stale `source.project` baked into the manifest. If the
    // manifest claims a different project than the one currently being
    // scanned, the scan-time project ID wins — that's the only way to recover
    // from old bootstrap mistakes without rewriting every manifest.
    project: currentProjectId,
    manifest_path: manifestPath,
    source_paths: manifest.source?.paths || [],
    domain: manifest.brick?.domain || [],
    hierarchy: manifest.hierarchy || null,
    brick_group: manifest.hierarchy?.group_id || null,
    data_classes: manifest.classification?.data_classes || [],
    risk: manifest.classification?.risk || "unknown",
    models: modelList(manifest),
    clone_readiness: manifest.clone?.readiness || "blocked",
    source_commit: manifest.source?.commit || "",
    source_archive_hash: manifest.source?.archive_hash || "",
    owned_paths: manifest.boundaries?.owned_paths || [],
    public_paths: manifest.boundaries?.public_paths || [],
    private_paths: manifest.boundaries?.private_paths || [],
    forbidden_imports: manifest.boundaries?.forbidden_imports || [],
    public_api: manifest.interfaces?.public_api || [],
    adapters: manifest.interfaces?.adapters || [],
    forbidden_dependencies: manifest.interfaces?.forbidden_dependencies || [],
    required_dependencies: manifest.interfaces?.required_dependencies || [],
    env_contract: manifest.security?.env || { required: false, status: "unknown", variables: [] },
    rls_contract: manifest.security?.rls || { required: false, status: "unknown", negative_tests: [] },
    vulnerability_findings: manifest.security?.vulnerability_findings || { critical: 0, high: 0, medium: 0, low: 0 },
    quality_line_count: manifest.quality?.line_count || { max_file_lines: 0, over_600_count: 0 },
    code_budget: manifest.quality?.code_budget || { status: "unknown", feature_lines: 0, file_count: 0, dependency_count: 0, notes: "" },
    test_commands: manifest.quality?.test_commands || [],
    verification: manifest.quality?.verification || [],
    clone_install_steps: manifest.clone?.install_steps || [],
    clone_known_traps: manifest.clone?.known_traps || [],
    clone_adaptation_points: manifest.clone?.adaptation_points || [],
    health: {
      status: healthFromReport(validation),
      error_count: validation.errors.length,
      warning_count: validation.warnings.length,
      errors: validation.errors.map((item) => item.code),
      warnings: validation.warnings.map((item) => item.code),
      calculated_score: validation.calculated_score ?? null
    }
  };

  brick.feature_cluster = featureClusterForBrick(brick);
  return brick;
}

function emptyStatusCounts() {
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

function projectHealth(root, bricks, unmanifested = [], forcedProjectId = "") {
  const byProject = new Map();

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
      candidate_group_count: candidateGroups?.size || 0,
      unmanifested_count: project.unmanifested_count || 0,
      average_score: project.brick_count ? Math.round(project.average_score / project.brick_count) : 0
    };
  });
}

function candidateGroups(candidates) {
  const byGroup = new Map();

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

function isCodeFile(filePath) {
  return codeFileExtensions.has(path.extname(filePath).toLowerCase());
}

function isAnalyzableSourceFile(filePath) {
  return analyzableSourceExtensions.has(path.extname(filePath).toLowerCase());
}

function severityForLineCount(lineCount) {
  if (lineCount >= oversizedThresholds.critical) {
    return "critical";
  }

  if (lineCount >= oversizedThresholds.high) {
    return "high";
  }

  if (lineCount >= oversizedThresholds.medium) {
    return "medium";
  }

  return "";
}

function severityWeight(severity) {
  return {
    medium: 1,
    high: 2,
    critical: 3
  }[severity] || 0;
}

function isWithinRoot(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function topLevelIndent(line) {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function detectSplitPoints(sourceText) {
  const lines = sourceText.split(/\r?\n/);
  const rawPoints = [];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      continue;
    }

    const indent = topLevelIndent(rawLine);
    const line = index + 1;
    let point = null;

    if (/^export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(trimmed)) {
      const [, , method] = trimmed.match(/^export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/) || [];
      point = { line, kind: "route_handler", label: method || "handler" };
    } else if (/^(\/\/|#|\/\*+)\s*(region|section|feature|domain|flow|phase)\b/i.test(trimmed)
      || /^(\/\/|#|\/\*+)\s*[=-]{3,}/.test(trimmed)) {
      point = { line, kind: "section", label: trimmed.replace(/^(\/*\s*|#+\s*|\/\/\s*)/, "").slice(0, 80) || "section" };
    } else if (indent <= 2 && /^export\s+class\s+([A-Za-z0-9_]+)/.test(trimmed)) {
      const [, name] = trimmed.match(/^export\s+class\s+([A-Za-z0-9_]+)/) || [];
      point = { line, kind: "export_class", label: name || "class" };
    } else if (indent <= 2 && /^(export\s+default\s+)?function\s+(use[A-Z][A-Za-z0-9_]*)\b/.test(trimmed)) {
      const [, , name] = trimmed.match(/^(export\s+default\s+)?function\s+(use[A-Z][A-Za-z0-9_]*)\b/) || [];
      point = { line, kind: "hook", label: name || "hook" };
    } else if (indent <= 2 && /^(export\s+default\s+)?function\s+([A-Z][A-Za-z0-9_]*)\b/.test(trimmed)) {
      const [, , name] = trimmed.match(/^(export\s+default\s+)?function\s+([A-Z][A-Za-z0-9_]*)\b/) || [];
      point = { line, kind: "react_component", label: name || "component" };
    } else if (indent <= 2 && /^export\s+(async\s+)?function\s+([A-Za-z0-9_]+)/.test(trimmed)) {
      const [, , name] = trimmed.match(/^export\s+(async\s+)?function\s+([A-Za-z0-9_]+)/) || [];
      point = { line, kind: "export_function", label: name || "function" };
    } else if (indent <= 2 && /^export\s+const\s+([A-Za-z0-9_]+)\s*=/.test(trimmed)) {
      const [, name] = trimmed.match(/^export\s+const\s+([A-Za-z0-9_]+)\s*=/) || [];
      point = { line, kind: /^use[A-Z]/.test(name || "") ? "hook" : "export_const", label: name || "export" };
    } else if (indent <= 2 && /^class\s+([A-Za-z0-9_]+)/.test(trimmed)) {
      const [, name] = trimmed.match(/^class\s+([A-Za-z0-9_]+)/) || [];
      point = { line, kind: "class", label: name || "class" };
    } else if (indent <= 2 && /^(async\s+)?function\s+([A-Za-z0-9_]+)/.test(trimmed)) {
      const [, , name] = trimmed.match(/^(async\s+)?function\s+([A-Za-z0-9_]+)/) || [];
      point = { line, kind: /^use[A-Z]/.test(name || "") ? "hook" : "helper_function", label: name || "function" };
    } else if (indent <= 2 && /^const\s+([A-Za-z0-9_]+)\s*=\s*(async\s*)?\(/.test(trimmed)) {
      const [, name] = trimmed.match(/^const\s+([A-Za-z0-9_]+)\s*=/) || [];
      point = { line, kind: /^[A-Z]/.test(name || "") ? "react_component" : /^use[A-Z]/.test(name || "") ? "hook" : "helper_const", label: name || "const" };
    }

    if (point) {
      rawPoints.push(point);
    }
  }

  const filtered = [];

  for (const point of rawPoints) {
    const previous = filtered.at(-1);

    if (previous && point.line - previous.line < 12) {
      continue;
    }

    filtered.push(point);

    if (filtered.length >= 8) {
      break;
    }
  }

  return filtered;
}

function suggestSplitStrategy(splitPoints) {
  if (splitPoints.length === 0) {
    return "Start by separating orchestration from helpers, then add explicit section boundaries for the next pass.";
  }

  const kinds = new Set(splitPoints.map((point) => point.kind));
  const exportCount = splitPoints.filter((point) => point.kind.startsWith("export_")).length;

  if (kinds.has("route_handler")) {
    return "Split route handlers from shared orchestration and move reusable logic into sibling services.";
  }

  if (kinds.has("hook") && kinds.has("react_component")) {
    return "Separate hooks, presentation, and orchestration into sibling modules.";
  }

  if (kinds.has("section")) {
    return "Split along the existing section markers and pull shared utilities into support files.";
  }

  if (exportCount >= 3) {
    return "Extract exported units into focused sibling modules with one primary responsibility each.";
  }

  if (splitPoints.length >= 4) {
    return "Break helpers and side effects into smaller modules around these seam lines.";
  }

  return "Start with the first seam, extract one cohesive concern, then re-scan for the next split.";
}

async function walkCodeFiles(targetPath, files = []) {
  if (isExcludedPath(targetPath)) {
    return files;
  }

  let stats;

  try {
    stats = await fs.stat(targetPath);
  } catch {
    return files;
  }

  if (stats.isFile()) {
    if (isCodeFile(targetPath)) {
      files.push(targetPath);
    }

    return files;
  }

  if (!stats.isDirectory()) {
    return files;
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      if (isExcludedDirName(entry.name) || isExcludedPath(fullPath)) {
        continue;
      }

      await walkCodeFiles(fullPath, files);
      continue;
    }

    if (entry.isFile() && !isExcludedPath(fullPath) && isCodeFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

async function walkAnalyzableFiles(targetPath, files = []) {
  if (isExcludedPath(targetPath)) {
    return files;
  }

  let stats;

  try {
    stats = await fs.stat(targetPath);
  } catch {
    return files;
  }

  if (stats.isFile()) {
    if (isAnalyzableSourceFile(targetPath)) {
      files.push(targetPath);
    }

    return files;
  }

  if (!stats.isDirectory()) {
    return files;
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      if (isExcludedDirName(entry.name) || isExcludedPath(fullPath)) {
        continue;
      }

      await walkAnalyzableFiles(fullPath, files);
      continue;
    }

    if (entry.isFile() && !isExcludedPath(fullPath) && isAnalyzableSourceFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function sourcePathCandidates(projectRoot, sourcePath) {
  const requestedPath = String(sourcePath || "").split("/").join(path.sep);
  const candidates = [path.resolve(projectRoot, requestedPath)];
  const projectDirName = path.basename(projectRoot);
  const prefixedPattern = new RegExp(`^${projectDirName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\\\/]`);

  if (prefixedPattern.test(requestedPath)) {
    candidates.push(path.resolve(projectRoot, requestedPath.replace(prefixedPattern, "")));
  }

  return [...new Set(candidates)];
}

async function resolveSourceTarget(projectRoot, sourcePath) {
  for (const candidate of sourcePathCandidates(projectRoot, sourcePath)) {
    if (!isWithinRoot(projectRoot, candidate)) {
      continue;
    }

    if (await pathExists(candidate)) {
      return {
        absolute_path: candidate,
        relative_path: toSlashPath(path.relative(projectRoot, candidate))
      };
    }
  }

  return null;
}

function attachFileReference(fileMap, absolutePath, relativePath, brickIds) {
  const key = toSlashPath(absolutePath);
  const current = fileMap.get(key) || {
    absolute_path: absolutePath,
    relative_path: toSlashPath(relativePath),
    brick_ids: new Set()
  };

  for (const brickId of brickIds) {
    current.brick_ids.add(brickId);
  }

  fileMap.set(key, current);
}

async function analyzeProjectRefactorOpportunities(projectRoot, projectIdValue, bricks) {
  const sourceTargets = new Map();
  const missingSourcePathMap = new Map();

  for (const brick of bricks) {
    for (const sourcePath of brick.source_paths || []) {
      const resolvedTarget = await resolveSourceTarget(projectRoot, sourcePath);

      if (!resolvedTarget) {
        const key = toSlashPath(sourcePath);
        const currentMissing = missingSourcePathMap.get(key) || {
          project: projectIdValue,
          path: key,
          brick_ids: new Set()
        };

        currentMissing.brick_ids.add(brick.id);
        missingSourcePathMap.set(key, currentMissing);
        continue;
      }

      const key = toSlashPath(resolvedTarget.absolute_path);
      const current = sourceTargets.get(key) || {
        absolute_path: resolvedTarget.absolute_path,
        relative_path: resolvedTarget.relative_path,
        brick_ids: new Set()
      };

      current.brick_ids.add(brick.id);
      sourceTargets.set(key, current);
    }
  }

  const fileMap = new Map();
  const missingSourcePaths = [...missingSourcePathMap.values()].map((entry) => ({
    project: entry.project,
    path: entry.path,
    related_brick_count: entry.brick_ids.size,
    related_bricks: [...entry.brick_ids].sort().slice(0, 12)
  }));
  const analysisFailures = [];

  for (const target of sourceTargets.values()) {
    const sourceFiles = [];

    try {
      await walkCodeFiles(target.absolute_path, sourceFiles);
    } catch {
      analysisFailures.push({
        project: projectIdValue,
        path: target.relative_path,
        error: `Failed to walk source path ${target.relative_path}`
      });
      continue;
    }

    for (const sourceFile of sourceFiles) {
      attachFileReference(
        fileMap,
        sourceFile,
        path.relative(projectRoot, sourceFile),
        target.brick_ids
      );
    }
  }

  const oversizedFiles = [];
  const severityCounts = { medium: 0, high: 0, critical: 0 };

  for (const file of fileMap.values()) {
    try {
      const sourceText = await fs.readFile(file.absolute_path, "utf8");
      const lineCount = sourceText.split(/\r?\n/).length;
      const severity = severityForLineCount(lineCount);

      if (!severity) {
        continue;
      }

      const splitPoints = detectSplitPoints(sourceText);
      severityCounts[severity] += 1;
      oversizedFiles.push({
        project: projectIdValue,
        path: file.relative_path,
        absolute_path: file.absolute_path,
        extension: path.extname(file.absolute_path).toLowerCase(),
        lines: lineCount,
        bytes: Buffer.byteLength(sourceText, "utf8"),
        severity,
        related_brick_count: file.brick_ids.size,
        related_bricks: [...file.brick_ids].sort().slice(0, 12),
        split_points: splitPoints,
        split_strategy: suggestSplitStrategy(splitPoints)
      });
    } catch (error) {
      analysisFailures.push({
        project: projectIdValue,
        path: file.relative_path,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
  }

  oversizedFiles.sort((a, b) => {
    const severityOrder = severityWeight(b.severity) - severityWeight(a.severity);
    return severityOrder || b.lines - a.lines || a.path.localeCompare(b.path);
  });

  return {
    project: projectIdValue,
    analyzed_file_count: fileMap.size,
    oversized_file_count: oversizedFiles.length,
    split_opportunity_count: oversizedFiles.filter((file) => file.split_points.length > 0).length,
    missing_source_path_count: missingSourcePaths.length,
    analysis_failure_count: analysisFailures.length,
    severity_counts: severityCounts,
    oversized_files: oversizedFiles,
    missing_source_paths: missingSourcePaths.sort((a, b) => a.path.localeCompare(b.path)),
    analysis_failures: analysisFailures.sort((a, b) => a.path.localeCompare(b.path))
  };
}

function buildRefactorReport(projectReports) {
  const oversizedFiles = projectReports
    .flatMap((report) => report.oversized_files)
    .sort((a, b) => {
      const severityOrder = severityWeight(b.severity) - severityWeight(a.severity);
      return severityOrder || b.lines - a.lines || a.path.localeCompare(b.path);
    });

  const missingSourcePaths = projectReports
    .flatMap((report) => report.missing_source_paths)
    .sort((a, b) => a.project.localeCompare(b.project) || a.path.localeCompare(b.path));
  const analysisFailures = projectReports
    .flatMap((report) => report.analysis_failures)
    .sort((a, b) => a.project.localeCompare(b.project) || a.path.localeCompare(b.path));
  const refactorQueue = buildRefactorQueue(oversizedFiles);

  return {
    thresholds: { ...oversizedThresholds },
    analyzed_file_count: projectReports.reduce((sum, report) => sum + report.analyzed_file_count, 0),
    oversized_file_count: oversizedFiles.length,
    split_opportunity_count: oversizedFiles.filter((file) => file.split_points.length > 0).length,
    missing_source_path_count: missingSourcePaths.length,
    analysis_failure_count: analysisFailures.length,
    severity_counts: projectReports.reduce((counts, report) => ({
      medium: counts.medium + report.severity_counts.medium,
      high: counts.high + report.severity_counts.high,
      critical: counts.critical + report.severity_counts.critical
    }), { medium: 0, high: 0, critical: 0 }),
    projects: projectReports.map((report) => ({
      project: report.project,
      analyzed_file_count: report.analyzed_file_count,
      oversized_file_count: report.oversized_file_count,
      split_opportunity_count: report.split_opportunity_count,
      missing_source_path_count: report.missing_source_path_count,
      analysis_failure_count: report.analysis_failure_count,
      severity_counts: report.severity_counts
    })),
    top_split_opportunities: oversizedFiles
      .filter((file) => file.split_points.length > 0)
      .slice(0, 50),
    refactor_queue: refactorQueue,
    oversized_files: oversizedFiles,
    missing_source_paths: missingSourcePaths,
    analysis_failures: analysisFailures
  };
}

function inferRefactorTheme(file) {
  const splitKinds = new Set((file.split_points || []).map((point) => point.kind));
  const lowerPath = String(file.path || "").toLowerCase();
  const isUiFile = [".tsx", ".jsx"].includes(String(file.extension || "").toLowerCase())
    || lowerPath.includes("/components/")
    || lowerPath.includes("/pages/");

  if (splitKinds.has("route_handler")) {
    return "route_orchestration";
  }

  if (splitKinds.has("react_component") && splitKinds.has("hook")) {
    return "react_orchestration";
  }

  if (splitKinds.has("react_component") || isUiFile) {
    return "ui_component";
  }

  if (splitKinds.has("section")) {
    return "sectioned_module";
  }

  if (splitKinds.has("export_class") || splitKinds.has("class")) {
    return "service_or_engine";
  }

  if (lowerPath.includes("/types/") || lowerPath.endsWith(".types.ts") || lowerPath.includes("schema")) {
    return "types_or_schema";
  }

  if (lowerPath.includes("/data/") || lowerPath.includes("dictionary") || lowerPath.includes("messages")) {
    return "data_payload";
  }

  return "utility_module";
}

function queuePriorityScore(file) {
  const severityBase = severityWeight(file.severity) * 1000;
  const lineFactor = Math.min(file.lines || 0, 12000);
  const splitFactor = Math.min((file.split_points || []).length, 8) * 120;
  const brickFactor = Math.min(file.related_brick_count || 0, 5) * 60;
  return severityBase + lineFactor + splitFactor + brickFactor;
}

function extractionTargets(file, theme) {
  const labels = (file.split_points || []).map((point) => point.label).filter(Boolean);
  const uniqueLabels = [...new Set(labels)];

  if (theme === "route_orchestration") {
    return ["handlers", "service", "schema", "shared-utils"];
  }

  if (theme === "react_orchestration" || theme === "ui_component") {
    return ["view", "hooks", "state", "supporting-components"];
  }

  if (theme === "sectioned_module") {
    const sectionTargets = uniqueLabels
      .map((label) => slugifyRefactorLabel(label))
      .filter((label) => label !== "segment");

    if (sectionTargets.length > 0) {
      return sectionTargets.slice(0, 4);
    }

    return ["section-1", "section-2", "section-3", "section-4"];
  }

  if (theme === "service_or_engine") {
    return ["contracts", "core-service", "helpers", "errors"];
  }

  if (theme === "types_or_schema") {
    return ["shared-types", "feature-types", "generated-types", "constants"];
  }

  if (theme === "data_payload") {
    return ["catalog-part-1", "catalog-part-2", "constants", "lookup-utils"];
  }

  const utilityTargets = uniqueLabels.slice(0, 4).map((label) => slugifyRefactorLabel(label));
  return utilityTargets.length > 0 ? utilityTargets : ["exports", "helpers", "state", "compat"];
}

function slugifyRefactorLabel(label) {
  return String(label || "segment")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "segment";
}

function firstActionForTheme(theme) {
  return {
    route_orchestration: "Extract shared route logic and validation into sibling service modules before touching handlers.",
    react_orchestration: "Move hooks and state transitions out first, then split presentational components.",
    ui_component: "Extract helper hooks and child panels before changing the top-level component contract.",
    sectioned_module: "Cut along existing section markers and keep the current public entrypoint as a thin facade.",
    service_or_engine: "Separate errors, contracts, and pure helpers before breaking the main service class.",
    types_or_schema: "Shard generated and feature-specific types into import-safe slices, then leave a barrel file.",
    data_payload: "Split static payloads into smaller shards and add a lookup/index layer.",
    utility_module: "Extract exported helpers into focused modules and leave compatibility re-exports."
  }[theme] || "Extract one cohesive concern at a time and keep the old entrypoint as a facade until imports are updated.";
}

function riskNoteForTheme(theme) {
  return {
    route_orchestration: "Watch for request/response shape drift and auth checks moving out of the handler path.",
    react_orchestration: "Watch for hook order regressions and prop contract churn across child components.",
    ui_component: "Watch for state ownership moving too early and turning a render split into a behavior regression.",
    sectioned_module: "Watch for circular imports if section helpers start reaching back into the facade.",
    service_or_engine: "Watch for hidden singleton state and side-effect ordering across extracted helpers.",
    types_or_schema: "Watch for import storms and generated-type consumers relying on a single mega-file path.",
    data_payload: "Watch for lookup performance regressions and duplicated constants across shards.",
    utility_module: "Watch for accidental behavior changes in shared helpers with many downstream callers."
  }[theme] || "Watch for import churn and compatibility breaks while the file is still the main integration point.";
}

function buildRefactorQueue(oversizedFiles) {
  return oversizedFiles
    .filter((file) => file.severity === "critical" || (file.severity === "high" && (file.split_points || []).length > 0))
    .map((file) => {
      const theme = inferRefactorTheme(file);
      const targets = extractionTargets(file, theme).filter(Boolean).slice(0, 4);
      const expectedSlices = Math.max(2, Math.min(targets.length || 2, Math.ceil((file.lines || 0) / 900)));
      const score = queuePriorityScore(file);

      return {
        project: file.project,
        path: file.path,
        severity: file.severity,
        lines: file.lines,
        priority_score: score,
        theme,
        expected_slices: expectedSlices,
        first_action: firstActionForTheme(theme),
        extraction_targets: targets,
        split_points: (file.split_points || []).slice(0, 6),
        strategy: file.split_strategy,
        risk_note: riskNoteForTheme(theme),
        related_brick_count: file.related_brick_count,
        related_bricks: file.related_bricks
      };
    })
    .sort((a, b) => b.priority_score - a.priority_score || b.lines - a.lines || a.path.localeCompare(b.path))
    .slice(0, 100)
    .map((entry, index) => ({
      rank: index + 1,
      ...entry
    }));
}

function countBy(items, keyFn) {
  const counts = new Map();

  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

const codeQualityPatternDefinitions = [
  {
    key: "ts_any",
    label: "TypeScript any",
    weight: 4,
    regex: /(?:\:\s*any\b|<\s*any\s*>|\bas\s+any\b)/g
  },
  {
    key: "ts_suppression",
    label: "TS suppression",
    weight: 6,
    regex: /@ts-ignore\b|@ts-expect-error\b|@ts-nocheck\b/g
  },
  {
    key: "lint_suppression",
    label: "Lint suppression",
    weight: 5,
    regex: /eslint-disable(?:-next-line|-line)?\b|biome-ignore\b/g
  },
  {
    key: "console_debug",
    label: "Console debug",
    weight: 2,
    regex: /\bconsole\.(?:log|debug|trace)\s*\(/g
  },
  {
    key: "todo_fixme",
    label: "TODO/FIXME debt",
    weight: 1,
    regex: /\b(?:TODO|FIXME|HACK|XXX)\b/g
  },
  {
    key: "deep_relative_import",
    label: "Deep relative import",
    weight: 3,
    regex: /from\s+['"](?:\.\.\/){3,}[^'"]+['"]|require\(\s*['"](?:\.\.\/){3,}[^'"]+['"]\s*\)|import\(\s*['"](?:\.\.\/){3,}[^'"]+['"]\s*\)/g
  },
  {
    key: "empty_catch",
    label: "Empty catch",
    weight: 6,
    regex: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g
  }
];

const codeQualityStructuralDefinitions = [
  {
    key: "oversized_react_component",
    label: "Oversized React component",
    weight: 18
  },
  {
    key: "oversized_custom_hook",
    label: "Oversized custom hook",
    weight: 14
  },
  {
    key: "oversized_service_file",
    label: "Oversized service file",
    weight: 12
  }
];

const codeQualityDefinitions = [
  ...codeQualityPatternDefinitions,
  ...codeQualityStructuralDefinitions
];

function emptyCodeQualityCounts() {
  return Object.fromEntries(codeQualityDefinitions.map((definition) => [definition.key, 0]));
}

function countMatches(sourceText, regex) {
  const matches = String(sourceText || "").match(regex);
  return matches ? matches.length : 0;
}

function qualitySeverityLevel(lineCount, baseThreshold, step, maxLevel = 3) {
  if (lineCount < baseThreshold) {
    return 0;
  }

  return Math.max(1, Math.min(maxLevel, 1 + Math.floor((lineCount - baseThreshold) / step)));
}

function looksLikeReactComponentFile(filePath, sourceText) {
  if (!/\.(?:tsx|jsx)$/i.test(filePath)) {
    return false;
  }

  return /<[A-Za-z][\w:-]*/.test(sourceText)
    || /\buse(?:State|Effect|Memo|Callback|Reducer|Ref|LayoutEffect|Transition|DeferredValue)\b/.test(sourceText);
}

function looksLikeHookFile(filePath, sourceText) {
  const base = path.basename(filePath);
  return /^use[A-Z0-9].*\.(?:ts|tsx|js|jsx)$/i.test(base)
    || /\bfunction\s+use[A-Z0-9_]/.test(sourceText)
    || /\bconst\s+use[A-Z0-9_]\w*\s*=\s*(?:async\s*)?\(/.test(sourceText);
}

function looksLikeServiceFile(filePath) {
  return /(?:^|\/)(?:src\/)?(?:main\/)?services?(?:\/|$)/i.test(toSlashPath(filePath))
    || /Service\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(path.basename(filePath));
}

function structuralCodeQualityCounts({ filePath, sourceText, lineCount, testLike = false }) {
  const counts = emptyCodeQualityCounts();

  if (testLike) {
    return counts;
  }

  if (looksLikeReactComponentFile(filePath, sourceText)) {
    counts.oversized_react_component = qualitySeverityLevel(lineCount, 320, 220);
  }

  if (looksLikeHookFile(filePath, sourceText)) {
    counts.oversized_custom_hook = qualitySeverityLevel(lineCount, 220, 180);
  }

  if (looksLikeServiceFile(filePath)) {
    counts.oversized_service_file = qualitySeverityLevel(lineCount, 320, 220);
  }

  return counts;
}

function normalizeCodeFingerprint(sourceText) {
  return String(sourceText || "")
    .replace(/\b\d+(?:\.\d+)?\b/g, "0")
    .replace(/\s+/g, "");
}

function duplicateFingerprintForFile({ filePath, sourceText, lineCount, testLike = false }) {
  if (testLike || lineCount < 120 || !isCodeFile(filePath)) {
    return null;
  }

  const normalized = normalizeCodeFingerprint(sourceText);

  if (normalized.length < 800) {
    return null;
  }

  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

function analyzeCodeQualityCounts(sourceText, { filePath = "", lineCount = 0, testLike = false } = {}) {
  const counts = emptyCodeQualityCounts();

  for (const definition of codeQualityPatternDefinitions) {
    if (testLike && definition.key === "console_debug") {
      continue;
    }

    counts[definition.key] = countMatches(sourceText, definition.regex);
  }

  mergeCodeQualityCounts(
    counts,
    structuralCodeQualityCounts({ filePath, sourceText, lineCount, testLike })
  );

  return counts;
}

function mergeCodeQualityCounts(target, nextCounts) {
  for (const definition of codeQualityDefinitions) {
    target[definition.key] = (target[definition.key] || 0) + (nextCounts?.[definition.key] || 0);
  }

  return target;
}

function codeQualityMatchCount(counts) {
  return Object.values(counts || {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

function codeQualityWeightedScore(counts) {
  return codeQualityDefinitions.reduce((sum, definition) => sum + ((counts?.[definition.key] || 0) * definition.weight), 0);
}

function compactCodeQualityCounts(counts) {
  return Object.fromEntries(
    Object.entries(counts || {})
      .filter(([, value]) => Number(value || 0) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0])))
  );
}

function topCodeQualityTypes(counts, limit = 3) {
  return codeQualityDefinitions
    .map((definition) => ({
      key: definition.key,
      label: definition.label,
      count: counts?.[definition.key] || 0,
      weighted_score: (counts?.[definition.key] || 0) * definition.weight
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.weighted_score - a.weighted_score || b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

function buildQualityDuplicateGroups(entries) {
  const byFingerprint = new Map();

  for (const entry of entries) {
    const current = byFingerprint.get(entry.fingerprint) || [];
    current.push(entry);
    byFingerprint.set(entry.fingerprint, current);
  }

  return [...byFingerprint.entries()]
    .map(([fingerprint, files]) => ({
      fingerprint,
      files
    }))
    .map((group) => {
      const uniqueFiles = [...new Map(group.files.map((entry) => [entry.path, entry])).values()];
      const files = uniqueFiles
        .sort((a, b) => (b.line_count || 0) - (a.line_count || 0) || String(a.path).localeCompare(String(b.path)));
      const relatedBricks = [...new Set(files.map((entry) => entry.brick_id).filter(Boolean))];

      return {
        project: files[0]?.project || "",
        category: "duplicate_code",
        fingerprint: group.fingerprint,
        path: files[0]?.path || "",
        related_bricks: relatedBricks,
        file_count: files.length,
        brick_count: relatedBricks.length,
        total_lines: files.reduce((sum, entry) => sum + Number(entry.line_count || 0), 0),
        total_tokens: files.reduce((sum, entry) => sum + Number(entry.raw_source_tokens || 0), 0),
        sample_paths: files.map((entry) => entry.path).slice(0, 8),
        priority_score: (files.length * 60) + Math.round(files.reduce((sum, entry) => sum + Number(entry.line_count || 0), 0) / 20),
        why: `Normalized code fingerprint repeats across ${files.length} file(s) and ${relatedBricks.length} brick(s).`,
        first_action: "Extract a shared seam or delete one fork instead of maintaining duplicate code."
      };
    })
    .filter((group) => group.file_count >= 2)
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || String(a.path).localeCompare(String(b.path)));
}

function qualityQueuePriority(entry) {
  return Math.round(
    Number(entry.smell_score || 0)
    + Math.min(120, Number(entry.line_count || 0) / 6)
    + Math.min(80, Number(entry.raw_source_tokens || 0) / 3000)
  );
}

function qualityQueueAction(topTypes = []) {
  const primary = topTypes[0]?.key;

  switch (primary) {
    case "ts_any":
      return "Replace `any` at the public seam first, then narrow the internal flow types.";
    case "deep_relative_import":
      return "Cut deep relative imports behind a local barrel, alias, or public module seam.";
    case "console_debug":
      return "Remove noisy debug logging or route it through a real debug/logger seam.";
    case "empty_catch":
      return "Replace empty catches with explicit handling, telemetry, or a documented ignore path.";
    case "lint_suppression":
    case "ts_suppression":
      return "Delete broad suppressions and fix the underlying type or lint issue at the boundary.";
    case "oversized_react_component":
      return "Split this component into smaller presentational and stateful seams before adding more features.";
    case "oversized_custom_hook":
      return "Break this hook into smaller hooks or pure helpers so behavior and state are isolated.";
    case "oversized_service_file":
      return "Split orchestration, adapters, and domain rules out of this service file.";
    default:
      return "Reduce the dominant code smells in this file before promoting it further.";
  }
}

function buildQualityQueue(hotspots, duplicateGroups) {
  const hotspotActions = hotspots
    .filter((entry) => Number(entry.smell_score || 0) >= 40 || Number(entry.total_matches || 0) >= 12)
    .map((entry) => ({
      project: entry.project,
      category: "quality_hotspot",
      path: entry.path,
      brick_id: entry.brick_id,
      brick_name: entry.brick_name,
      smell_score: entry.smell_score,
      total_matches: entry.total_matches,
      line_count: entry.line_count,
      raw_source_tokens: entry.raw_source_tokens,
      by_type: entry.by_type,
      top_types: entry.top_types,
      priority_score: qualityQueuePriority(entry),
      why: `${entry.total_matches} smell hit(s) with dominant issues in ${entry.top_types.map((type) => type.label).join(", ")}.`,
      first_action: qualityQueueAction(entry.top_types)
    }));

  return [...hotspotActions, ...duplicateGroups]
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 120);
}

function dedupeQualityHotspots(entries) {
  const byKey = new Map();

  for (const entry of entries || []) {
    const key = `${entry.project || ""}:${entry.path || ""}`;
    const current = byKey.get(key);

    if (!current || Number(entry.smell_score || 0) > Number(current.smell_score || 0) || Number(entry.total_matches || 0) > Number(current.total_matches || 0)) {
      byKey.set(key, entry);
    }
  }

  return [...byKey.values()];
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil(String(value || "").length / 4));
}

function gradeForScore(score) {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 55) return "D";
  return "F";
}

function readinessLabel(score) {
  if (score >= 90) return "launch_ready";
  if (score >= 80) return "strong_foundation";
  if (score >= 70) return "promising_but_incomplete";
  if (score >= 55) return "refactor_required";
  return "heavy_repair_required";
}

function isIgnoredEnvReference(name) {
  const normalized = String(name || "").trim().toUpperCase();

  if (!normalized) {
    return true;
  }

  if (ignoredEnvNames.has(normalized)) {
    return true;
  }

  if (normalized.startsWith("NPM_")) {
    return true;
  }

  return ignoredEnvPrefixes.some((prefix) => normalized.startsWith(prefix));
}

function isContractRelevantEnvReference(name) {
  const normalized = String(name || "").trim().toUpperCase();

  if (!normalized || isIgnoredEnvReference(normalized)) {
    return false;
  }

  return contractEnvSignals.some((signal) => normalized === signal || normalized.includes(`_${signal}`) || normalized.startsWith(`${signal}_`) || normalized.endsWith(`_${signal}`));
}

function emptyComplianceReport(project = null) {
  return {
    ...(project ? { project } : {}),
    trackable_brick_count: 0,
    score: 0,
    grade: "F",
    dimensions: Object.fromEntries(complianceDimensionDefinitions.map((definition) => [definition.key, {
      label: definition.label,
      weight: definition.weight,
      ready_count: 0,
      coverage_units: 0,
      total_count: 0,
      coverage_rate: 0
    }])),
    weakest_dimensions: [],
    highest_gap_bricks: []
  };
}

function emptyBuildReport(project = null) {
  return {
    ...(project ? { project } : {}),
    candidate_count: 0,
    detected_brick_count: 0,
    recurrent_candidate_count: 0,
    recurrent_family_count: 0,
    average_confidence_score: 0,
    signal_type_counts: {
      feature: 0,
      domain: 0,
      path: 0,
      group: 0
    },
    top_candidates: [],
    candidate_signatures: [],
    projects: []
  };
}

function contractStatusScore(status) {
  const normalized = String(status || "").toLowerCase();

  if (["pass", "complete", "ready"].includes(normalized)) {
    return 1;
  }

  if (["partial", "in_progress", "draft"].includes(normalized)) {
    return 0.4;
  }

  if (["not_applicable", "n/a", "na"].includes(normalized)) {
    return 1;
  }

  return 0;
}

function finalizeComplianceReport(report) {
  const dimensions = Object.fromEntries(complianceDimensionDefinitions.map((definition) => {
    const current = report.dimensions?.[definition.key] || {};
    const totalCount = Number(current.total_count || 0);
    const readyCount = Number(current.ready_count || 0);
    const coverageUnits = Number((current.coverage_units ?? readyCount) || 0);
    const coverageRate = totalCount > 0 ? Math.round((coverageUnits / totalCount) * 100) : 100;

    return [definition.key, {
      label: current.label || definition.label,
      weight: Number(current.weight || definition.weight),
      ready_count: readyCount,
      coverage_units: Number(coverageUnits.toFixed(2)),
      total_count: totalCount,
      coverage_rate: coverageRate
    }];
  }));
  const activeDimensions = Object.entries(dimensions).filter(([, dimension]) => dimension.total_count > 0);
  const weightTotal = activeDimensions.reduce((sum, [, dimension]) => sum + dimension.weight, 0);
  const score = weightTotal > 0
    ? Math.round(activeDimensions.reduce((sum, [, dimension]) => sum + (dimension.coverage_rate * dimension.weight), 0) / weightTotal)
    : 100;

  return {
    ...report,
    score,
    grade: gradeForScore(score),
    dimensions,
    weakest_dimensions: [...activeDimensions]
      .sort((a, b) => a[1].coverage_rate - b[1].coverage_rate || b[1].total_count - a[1].total_count || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([key, dimension]) => ({
        key,
        label: dimension.label,
        coverage_rate: dimension.coverage_rate,
        ready_count: dimension.ready_count,
        total_count: dimension.total_count
      })),
    highest_gap_bricks: [...(report.highest_gap_bricks || [])]
      .sort((a, b) => b.missing_count - a.missing_count || b.raw_source_tokens - a.raw_source_tokens || String(a.path).localeCompare(String(b.path)))
      .slice(0, 80)
  };
}

function normalizeBuildToken(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|php|cs|sql|json|md|mdx)$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isMeaningfulBuildToken(value) {
  const token = normalizeBuildToken(value);

  if (!token || token.length < 3) {
    return false;
  }

  if (/^\d+$/.test(token)) {
    return false;
  }

  return !genericBuildTokens.has(token);
}

function titleCaseBuildToken(value) {
  return String(value || "")
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizedKindFamily(kind) {
  return String(kind || "unknown").replace(/_(module|file)$/, "");
}

function primarySourcePath(brick) {
  return String((brick.source_paths || [])[0] || "");
}

function meaningfulDomainTokens(brick) {
  const tokens = [];

  for (const entry of brick.domain || []) {
    for (const part of String(entry || "").split(/[^a-zA-Z0-9]+/)) {
      const normalized = normalizeBuildToken(part);

      if (isMeaningfulBuildToken(normalized) && !tokens.includes(normalized)) {
        tokens.push(normalized);
      }
    }
  }

  return tokens.slice(0, 3);
}

function featureTokenForBrick(brick) {
  const cluster = brick.feature_cluster;

  if (cluster && typeof cluster === "object") {
    return normalizeBuildToken(cluster.id || cluster.name || "");
  }

  return normalizeBuildToken(cluster);
}

function pathSignalTokensForBrick(brick) {
  const sourcePath = primarySourcePath(brick);

  if (!sourcePath) {
    return [];
  }

  const parsed = path.parse(sourcePath);
  const baseToken = normalizeBuildToken(parsed.name);
  const segmentTokens = path.dirname(sourcePath)
    .split(/[\\/]+/)
    .map((segment) => normalizeBuildToken(segment))
    .filter((segment) => isMeaningfulBuildToken(segment));
  const meaningfulSegments = [...new Set(segmentTokens)];
  const signals = [];

  if (meaningfulSegments.length > 0) {
    signals.push(meaningfulSegments[meaningfulSegments.length - 1]);
  }

  if (meaningfulSegments.length > 1) {
    signals.push(`${meaningfulSegments[meaningfulSegments.length - 2]}-${meaningfulSegments[meaningfulSegments.length - 1]}`);
  }

  if (isMeaningfulBuildToken(baseToken)) {
    signals.push(baseToken);

    if (meaningfulSegments.length > 0) {
      signals.push(`${meaningfulSegments[meaningfulSegments.length - 1]}-${baseToken}`);
    }
  }

  return [...new Set(signals.filter((signal) => isMeaningfulBuildToken(signal) || signal.includes("-")))].slice(0, 3);
}

function buildSignalsForBrick(brick) {
  const signals = [];
  const seen = new Set();
  const pushSignal = (type, value) => {
    const normalized = normalizeBuildToken(value);

    if (!isMeaningfulBuildToken(normalized)) {
      return;
    }

    const key = `${type}:${normalized}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    signals.push({ type, value: normalized });
  };

  const featureToken = featureTokenForBrick(brick);

  if (isMeaningfulBuildToken(featureToken)) {
    pushSignal("feature", featureToken);
  }

  for (const token of meaningfulDomainTokens(brick)) {
    pushSignal("domain", token);
  }

  for (const token of pathSignalTokensForBrick(brick)) {
    pushSignal("path", token);
  }

  const brickGroupToken = normalizeBuildToken(String(brick.brick_group || "").split(":").pop() || "");

  if (isMeaningfulBuildToken(brickGroupToken)) {
    pushSignal("group", brickGroupToken);
  }

  return signals;
}

function buildSignalWeight(type, groupSize) {
  const base = {
    group: 5,
    feature: 4,
    domain: 3,
    path: 3
  }[type] || 1;

  return Math.max(1, base - Math.floor(Math.max(0, groupSize - 2) / 5));
}

function buildSignalGroupLimit(type) {
  return {
    group: 18,
    feature: 12,
    domain: 10,
    path: 8
  }[type] || 10;
}

function buildPairKey(leftId, rightId) {
  return leftId < rightId ? `${leftId}\0${rightId}` : `${rightId}\0${leftId}`;
}

function buildCandidateName(candidate) {
  const primary = candidate.dominant_feature_cluster
    || candidate.dominant_domain
    || candidate.dominant_path_root
    || candidate.dominant_group
    || "capability";
  const secondary = [candidate.dominant_domain, candidate.dominant_path_root]
    .filter(Boolean)
    .find((value) => value !== primary);
  const label = secondary ? `${titleCaseBuildToken(primary)} ${titleCaseBuildToken(secondary)}` : titleCaseBuildToken(primary);
  return `${label} Build Candidate`;
}

function confidenceLabel(score) {
  if (score >= 80) return "high";
  if (score >= 60) return "medium";
  return "low";
}

function candidateRecurrenceKey(candidate) {
  const ordered = [
    candidate.dominant_feature_cluster,
    candidate.dominant_domain,
    candidate.dominant_path_root,
    candidate.dominant_group
  ].filter(Boolean);
  const unique = [...new Set(ordered)];
  return unique.slice(0, 2).join("::") || "capability";
}

function summarizeBuildCandidate(projectIdValue, bricks, sharedSignals) {
  const featureCounts = new Map();
  const domainCounts = new Map();
  const pathCounts = new Map();
  const groupCounts = new Map();
  const signalTypeCounts = new Map();
  const kindCounts = new Map();
  const statusCounts = new Map();
  const sharedSignalTypes = new Set();

  for (const brick of bricks) {
    const kindFamily = normalizedKindFamily(brick.kind);
    kindCounts.set(kindFamily, (kindCounts.get(kindFamily) || 0) + 1);
    statusCounts.set(brick.status || "unknown", (statusCounts.get(brick.status || "unknown") || 0) + 1);

    for (const signal of buildSignalsForBrick(brick)) {
      if (signal.type === "feature") {
        featureCounts.set(signal.value, (featureCounts.get(signal.value) || 0) + 1);
      } else if (signal.type === "domain") {
        domainCounts.set(signal.value, (domainCounts.get(signal.value) || 0) + 1);
      } else if (signal.type === "path") {
        pathCounts.set(signal.value, (pathCounts.get(signal.value) || 0) + 1);
      } else if (signal.type === "group") {
        groupCounts.set(signal.value, (groupCounts.get(signal.value) || 0) + 1);
      }
    }
  }

  for (const signal of sharedSignals) {
    sharedSignalTypes.add(signal.type);
    signalTypeCounts.set(signal.type, (signalTypeCounts.get(signal.type) || 0) + 1);
  }

  const sortCounts = (entries) => [...entries.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const dominantFeatureCluster = sortCounts(featureCounts)[0]?.[0] || null;
  const dominantDomain = sortCounts(domainCounts)[0]?.[0] || null;
  const dominantPathRoot = sortCounts(pathCounts)[0]?.[0] || null;
  const dominantGroup = sortCounts(groupCounts)[0]?.[0] || null;
  const averageBrickScore = bricks.length
    ? Math.round(bricks.reduce((sum, brick) => sum + Number(brick.score || 0), 0) / bricks.length)
    : 0;
  const confidenceScore = Math.min(100, Math.round(
    12
    + Math.min(18, Math.round(bricks.length * 1.5))
    + (sharedSignalTypes.size * 10)
    + (Math.min(4, kindCounts.size) * 3)
    + Math.min(6, Math.round(averageBrickScore / 25))
    + (dominantFeatureCluster ? 8 : 0)
    + (dominantDomain ? 6 : 0)
    + (dominantPathRoot ? 4 : 0)
    + (dominantGroup ? 6 : 0)
    - (Math.max(0, bricks.length - 12) * 2)
  ));
  const sampleBricks = [...bricks]
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || a.id.localeCompare(b.id))
    .slice(0, 8)
    .map((brick) => ({
      id: brick.id,
      name: brick.name,
      kind: brick.kind,
      status: brick.status,
      score: brick.score,
      feature_cluster: featureTokenForBrick(brick) || null,
      source_path: primarySourcePath(brick)
    }));
  const brickIds = [...new Set(bricks.map((brick) => brick.id))].sort();
  const recurrenceKey = candidateRecurrenceKey({
    dominant_feature_cluster: dominantFeatureCluster,
    dominant_domain: dominantDomain,
    dominant_path_root: dominantPathRoot,
    dominant_group: dominantGroup
  });

  const candidate = {
    candidate_key: `${projectIdValue}:${recurrenceKey}:${normalizeBuildToken(sampleBricks[0]?.name || brickIds[0] || "build")}:${brickIds.length}`,
    recurrence_key: recurrenceKey,
    project: projectIdValue,
    name: "",
    confidence_score: confidenceScore,
    confidence_label: confidenceLabel(confidenceScore),
    brick_count: brickIds.length,
    average_brick_score: averageBrickScore,
    detection_sources: [...sharedSignalTypes].sort(),
    dominant_feature_cluster: dominantFeatureCluster,
    dominant_domain: dominantDomain,
    dominant_path_root: dominantPathRoot,
    dominant_group: dominantGroup,
    signal_type_counts: Object.fromEntries([...signalTypeCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    kind_counts: Object.fromEntries(sortCounts(kindCounts)),
    status_counts: Object.fromEntries(sortCounts(statusCounts)),
    sample_paths: [...new Set(sampleBricks.map((brick) => brick.source_path).filter(Boolean))].slice(0, 6),
    brick_ids: brickIds,
    sample_bricks: sampleBricks,
    recurrent_projects: [],
    recurrent_project_count: 0,
    why: ""
  };

  candidate.name = buildCandidateName(candidate);
  candidate.why = `Shared ${candidate.detection_sources.join(", ")} around ${titleCaseBuildToken(dominantFeatureCluster || dominantDomain || dominantPathRoot || dominantGroup || "capability")}.`;
  return candidate;
}

function buildProjectBuildReport(projectIdValue, candidates) {
  const report = emptyBuildReport(projectIdValue);
  const detectedBrickIds = new Set();

  for (const candidate of candidates) {
    for (const brickId of candidate.brick_ids || []) {
      detectedBrickIds.add(brickId);
    }

    for (const type of candidate.detection_sources || []) {
      report.signal_type_counts[type] = (report.signal_type_counts[type] || 0) + 1;
    }
  }

  report.candidate_count = candidates.length;
  report.detected_brick_count = detectedBrickIds.size;
  report.average_confidence_score = candidates.length
    ? Math.round(candidates.reduce((sum, candidate) => sum + Number(candidate.confidence_score || 0), 0) / candidates.length)
    : 0;
  report.top_candidates = [...candidates]
    .sort((a, b) => Number(b.confidence_score || 0) - Number(a.confidence_score || 0) || Number(b.brick_count || 0) - Number(a.brick_count || 0) || a.name.localeCompare(b.name))
    .slice(0, 24);
  report.candidate_signatures = candidates.map((candidate) => ({
    candidate_key: candidate.candidate_key,
    recurrence_key: candidate.recurrence_key,
    project: projectIdValue,
    confidence_score: candidate.confidence_score,
    brick_count: candidate.brick_count,
    detection_sources: candidate.detection_sources,
    dominant_feature_cluster: candidate.dominant_feature_cluster,
    dominant_domain: candidate.dominant_domain,
    dominant_path_root: candidate.dominant_path_root,
    dominant_group: candidate.dominant_group
  }));
  return report;
}

function detectProjectBuildCandidates(projectIdValue, bricks) {
  if (bricks.length < 2) {
    return [];
  }

  const signalsByBrick = new Map();
  const signalBuckets = new Map();

  for (const brick of bricks) {
    const signals = buildSignalsForBrick(brick);
    signalsByBrick.set(brick.id, signals);

    for (const signal of signals) {
      const key = `${signal.type}:${signal.value}`;
      const current = signalBuckets.get(key) || { type: signal.type, value: signal.value, brick_ids: [] };
      current.brick_ids.push(brick.id);
      signalBuckets.set(key, current);
    }
  }

  const pairScores = new Map();

  for (const bucket of signalBuckets.values()) {
    const brickIds = [...new Set(bucket.brick_ids)].sort();

    if (brickIds.length < 2 || brickIds.length > buildSignalGroupLimit(bucket.type)) {
      continue;
    }

    for (let index = 0; index < brickIds.length; index += 1) {
      for (let nextIndex = index + 1; nextIndex < brickIds.length; nextIndex += 1) {
        const pairKey = buildPairKey(brickIds[index], brickIds[nextIndex]);
        const current = pairScores.get(pairKey) || {
          score: 0,
          shared_signals: []
        };

        current.score += buildSignalWeight(bucket.type, brickIds.length);
        current.shared_signals.push({
          type: bucket.type,
          value: bucket.value,
          group_size: brickIds.length
        });
        pairScores.set(pairKey, current);
      }
    }
  }

  const adjacency = new Map();
  const addEdge = (leftId, rightId) => {
    const left = adjacency.get(leftId) || new Set();
    const right = adjacency.get(rightId) || new Set();
    left.add(rightId);
    right.add(leftId);
    adjacency.set(leftId, left);
    adjacency.set(rightId, right);
  };

  for (const [pairKey, details] of pairScores.entries()) {
    const [leftId, rightId] = pairKey.split("\0");
    const signalTypes = new Set(details.shared_signals.map((signal) => signal.type));
    const smallFeatureLink = details.shared_signals.some((signal) => signal.type === "feature" && signal.group_size <= 6);
    const mixedLink = (signalTypes.has("feature") && (signalTypes.has("domain") || signalTypes.has("path")))
      || (signalTypes.has("domain") && signalTypes.has("path"));
    const strongLink = signalTypes.has("group") || details.score >= 7;

    if (smallFeatureLink || mixedLink || strongLink) {
      addEdge(leftId, rightId);
    }
  }

  const brickById = new Map(bricks.map((brick) => [brick.id, brick]));
  const visited = new Set();
  const candidates = [];

  for (const brick of bricks) {
    if (visited.has(brick.id) || !adjacency.has(brick.id)) {
      continue;
    }

    const stack = [brick.id];
    const componentIds = [];

    while (stack.length > 0) {
      const currentId = stack.pop();

      if (!currentId || visited.has(currentId)) {
        continue;
      }

      visited.add(currentId);
      componentIds.push(currentId);

      for (const linkedId of adjacency.get(currentId) || []) {
        if (!visited.has(linkedId)) {
          stack.push(linkedId);
        }
      }
    }

    const componentBricks = componentIds
      .map((id) => brickById.get(id))
      .filter(Boolean);

    if (componentBricks.length < 2) {
      continue;
    }

    const sharedSignals = [];
    const sharedSignalKeys = new Set();

    for (const candidateBrick of componentBricks) {
      for (const signal of signalsByBrick.get(candidateBrick.id) || []) {
        const overlapCount = componentBricks.filter((entry) => (signalsByBrick.get(entry.id) || []).some((candidateSignal) => candidateSignal.type === signal.type && candidateSignal.value === signal.value)).length;

        if (overlapCount < 2) {
          continue;
        }

        const key = `${signal.type}:${signal.value}`;

        if (!sharedSignalKeys.has(key)) {
          sharedSignalKeys.add(key);
          sharedSignals.push(signal);
        }
      }
    }

    const distinctKinds = new Set(componentBricks.map((candidateBrick) => normalizedKindFamily(candidateBrick.kind)));

    if (sharedSignals.length === 0 || (componentBricks.length === 2 && distinctKinds.size < 2 && !sharedSignals.some((signal) => signal.type === "group"))) {
      continue;
    }

    candidates.push(summarizeBuildCandidate(projectIdValue, componentBricks, sharedSignals));
  }

  return candidates
    .sort((a, b) => Number(b.confidence_score || 0) - Number(a.confidence_score || 0) || Number(b.brick_count || 0) - Number(a.brick_count || 0) || a.name.localeCompare(b.name))
    .slice(0, 60);
}

function finalizeMergedBuildReport(report) {
  const finalized = {
    ...emptyBuildReport(),
    ...report,
    signal_type_counts: {
      feature: report.signal_type_counts?.feature || 0,
      domain: report.signal_type_counts?.domain || 0,
      path: report.signal_type_counts?.path || 0,
      group: report.signal_type_counts?.group || 0
    }
  };
  const recurrence = new Map();

  for (const signature of finalized.candidate_signatures || []) {
    const key = signature.recurrence_key || "capability";
    const current = recurrence.get(key) || {
      projects: new Set(),
      candidate_count: 0,
      max_confidence_score: 0
    };

    current.projects.add(signature.project);
    current.candidate_count += 1;
    current.max_confidence_score = Math.max(current.max_confidence_score, Number(signature.confidence_score || 0));
    recurrence.set(key, current);
  }

  finalized.candidate_count = (finalized.candidate_signatures || []).length;
  finalized.recurrent_family_count = [...recurrence.values()].filter((entry) => entry.projects.size >= 2).length;
  finalized.recurrent_candidate_count = [...(finalized.candidate_signatures || [])]
    .filter((signature) => (recurrence.get(signature.recurrence_key || "capability")?.projects.size || 0) >= 2)
    .length;
  finalized.average_confidence_score = finalized.candidate_signatures?.length
    ? Math.round(finalized.candidate_signatures.reduce((sum, signature) => sum + Number(signature.confidence_score || 0), 0) / finalized.candidate_signatures.length)
    : 0;
  finalized.top_candidates = [...(finalized.top_candidates || [])]
    .map((candidate) => {
      const recurrenceEntry = recurrence.get(candidate.recurrence_key || "capability");
      return {
        ...candidate,
        recurrent_project_count: recurrenceEntry?.projects.size || 0,
        recurrent_projects: recurrenceEntry ? [...recurrenceEntry.projects].sort() : []
      };
    })
    .sort((a, b) => (b.recurrent_project_count || 0) - (a.recurrent_project_count || 0) || Number(b.confidence_score || 0) - Number(a.confidence_score || 0) || Number(b.brick_count || 0) - Number(a.brick_count || 0) || a.name.localeCompare(b.name))
    .slice(0, 40);
  finalized.projects = [...(finalized.projects || [])]
    .map((project) => ({
      ...project,
      recurrent_candidate_count: (project.candidate_signatures || [])
        .filter((signature) => (recurrence.get(signature.recurrence_key || "capability")?.projects.size || 0) >= 2)
        .length
    }))
    .map(({ candidate_signatures, ...project }) => project)
    .sort((a, b) => Number(b.candidate_count || 0) - Number(a.candidate_count || 0) || Number(b.average_confidence_score || 0) - Number(a.average_confidence_score || 0) || String(a.project).localeCompare(String(b.project)));
  finalized.candidate_signatures = [...(finalized.candidate_signatures || [])]
    .sort((a, b) => Number(b.confidence_score || 0) - Number(a.confidence_score || 0) || Number(b.brick_count || 0) - Number(a.brick_count || 0) || String(a.project).localeCompare(String(b.project)))
    .slice(0, 160);
  return finalized;
}

function normalizeDuplicateStem(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|php|cs|sql)$/i, "")
    .replace(/^(use|get|set|create|build|render)-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^(acme-desktop|acme-studio|acme-factory|workspace-root|acme-desktop)-/, "")
    .replace(/^-+|-+$/g, "");
}

function normalizeImportSpecifier(specifier) {
  return String(specifier || "")
    .split("?")[0]
    .split("#")[0]
    .trim();
}

function isIgnoredProjectImportSpecifier(specifier) {
  const normalized = normalizeImportSpecifier(specifier);

  if (!normalized || /^virtual:/i.test(normalized)) {
    return true;
  }

  const ext = path.extname(normalized).toLowerCase();
  return ignoredImportExtensions.has(ext);
}

function isTestLikePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  return /(^|\/)(__tests__|tests?|suites)(\/|$)|\.(test|spec)\.[a-z0-9]+$/i.test(normalized)
    || normalized.includes("0000testing/");
}

function isTestLikeBrick(brick) {
  if (!brick) {
    return false;
  }

  if (/test/i.test(String(brick.kind || ""))) {
    return true;
  }

  if (isTestLikePath(brick.name) || isTestLikePath(brick.brick_group)) {
    return true;
  }

  return (brick.source_paths || []).some((sourcePath) => isTestLikePath(sourcePath));
}

function normalizeBrickGroupKey(value) {
  const group = String(value || "");
  const [, relative = ""] = group.split(":");
  return relative.replace(/\/+$/g, "");
}

function sharedSourceRoot(brick) {
  const [sourcePath = ""] = brick?.source_paths || [];
  return String(sourcePath || "").replace(/\/+$/g, "");
}

function sharesBrickGroupFamily(left, right) {
  if (!left || !right) {
    return false;
  }

  const leftGroup = normalizeBrickGroupKey(left.brick_group);
  const rightGroup = normalizeBrickGroupKey(right.brick_group);

  if (leftGroup && rightGroup && (
    leftGroup === rightGroup
    || leftGroup.startsWith(`${rightGroup}/`)
    || rightGroup.startsWith(`${leftGroup}/`)
  )) {
    return true;
  }

  const leftRoot = sharedSourceRoot(left);
  const rightRoot = sharedSourceRoot(right);

  return Boolean(leftRoot && rightRoot && (
    leftRoot === rightRoot
    || leftRoot.startsWith(`${rightRoot}/`)
    || rightRoot.startsWith(`${leftRoot}/`)
  ));
}

function isCloneTrackableBrick(brick) {
  return brick.status === "candidate"
    || brick.status === "canonical"
    || ["copy_ready", "guided", "semi_automatic"].includes(brick.clone_readiness)
    || (brick.clone_install_steps || []).length > 0
    || (brick.clone_known_traps || []).length > 0;
}

function shouldTrackManifestDrift(brick, files) {
  if ((files || []).length === 0) {
    return false;
  }

  return isCloneTrackableBrick(brick);
}

function duplicateStemForBrick(brick) {
  const firstSourcePath = String((brick.source_paths || [])[0] || "");
  const pathStem = normalizeDuplicateStem(path.basename(firstSourcePath));
  const nameStem = normalizeDuplicateStem(brick.name || brick.id);
  return pathStem || nameStem || "unknown";
}

function looksLikeProjectImport(specifier) {
  if (isIgnoredProjectImportSpecifier(specifier)) {
    return false;
  }

  if (specifier === "electron") {
    return false;
  }

  return specifier.startsWith(".")
    || specifier.startsWith("/")
    || specifier.startsWith("@/")
    || specifier.startsWith("~/")
    || /^(src|app|apps|web|packages|acme-agent|supabase|electron|renderer|main|sidecar|shared|lib|libs|0000[a-z0-9._-]*|000_[a-z0-9._-]+|002-[a-z0-9._-]+|099_[a-z0-9._-]+)/i.test(specifier);
}

function importResolutionCandidates(basePath) {
  const ext = path.extname(basePath).toLowerCase();
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".sql"];
  const candidates = [basePath];

  if (!ext) {
    for (const candidateExt of extensions) {
      candidates.push(`${basePath}${candidateExt}`);
    }

    for (const candidateExt of extensions) {
      candidates.push(path.join(basePath, `index${candidateExt}`));
    }

    return [...new Set(candidates)];
  }

  const baseWithoutExt = basePath.slice(0, -ext.length);

  if (extensions.includes(ext)) {
    for (const candidateExt of extensions) {
      candidates.push(`${baseWithoutExt}${candidateExt}`);
    }

    for (const candidateExt of extensions) {
      candidates.push(path.join(baseWithoutExt, `index${candidateExt}`));
    }

    return [...new Set(candidates)];
  }

  for (const candidateExt of extensions) {
    candidates.push(`${basePath}${candidateExt}`);
  }

  for (const candidateExt of extensions) {
    candidates.push(path.join(basePath, `index${candidateExt}`));
  }

  return [...new Set(candidates)];
}

function importBasePath(projectRoot, fromFile, specifier) {
  if (specifier.startsWith(".")) {
    return path.resolve(path.dirname(fromFile), specifier);
  }

  if (specifier.startsWith("/")) {
    return path.resolve(projectRoot, `.${specifier}`);
  }

  if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
    return null;
  }

  if (looksLikeProjectImport(specifier)) {
    return path.resolve(projectRoot, specifier);
  }

  return null;
}

function contextualProjectRoots(projectRoot, fromFile, leadingSegment = "src") {
  const roots = [projectRoot];
  let current = path.dirname(fromFile);

  while (isWithinRoot(projectRoot, current)) {
    if (path.basename(current) === leadingSegment) {
      roots.push(path.dirname(current));
    }

    if (current === projectRoot) {
      break;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      break;
    }

    current = parent;
  }

  return [...new Set(roots)];
}

async function resolveProjectImport(projectRoot, fromFile, specifier, cache = null, existsCache = null) {
  const normalizedSpecifier = normalizeImportSpecifier(specifier);
  const cacheKey = `${fromFile}\0${normalizedSpecifier}`;

  if (cache?.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  if (!normalizedSpecifier || !looksLikeProjectImport(normalizedSpecifier)) {
    return null;
  }

  const basePaths = [];

  if (normalizedSpecifier.startsWith("@/") || normalizedSpecifier.startsWith("~/")) {
    const trimmed = normalizedSpecifier.slice(2);
    const roots = contextualProjectRoots(projectRoot, fromFile, "src");

    for (const root of roots) {
      basePaths.push(
        path.resolve(root, trimmed),
        path.resolve(root, "src", trimmed),
        path.resolve(root, "web", "src", trimmed),
        path.resolve(root, "app", trimmed)
      );
    }
  } else {
    const basePath = importBasePath(projectRoot, fromFile, normalizedSpecifier);

    if (basePath) {
      basePaths.push(basePath);
    }

    if (!normalizedSpecifier.startsWith(".") && !normalizedSpecifier.startsWith("/")) {
      const [leadingSegment = "src"] = normalizedSpecifier.split("/");

      for (const root of contextualProjectRoots(projectRoot, fromFile, leadingSegment)) {
        basePaths.push(path.resolve(root, normalizedSpecifier));
      }
    }
  }

  const scopedBasePaths = [...new Set(basePaths)].filter((basePath) => basePath && isWithinRoot(projectRoot, basePath));

  if (scopedBasePaths.length === 0) {
    return null;
  }

  for (const basePath of scopedBasePaths) {
    for (const candidate of importResolutionCandidates(basePath)) {
      if (!isWithinRoot(projectRoot, candidate)) {
        continue;
      }

      const exists = existsCache?.has(candidate)
        ? existsCache.get(candidate)
        : await pathExists(candidate);

      if (existsCache && !existsCache.has(candidate)) {
        existsCache.set(candidate, exists);
      }

      if (exists) {
        const resolved = {
          absolute_path: candidate,
          unresolved: false
        };

        if (cache) {
          cache.set(cacheKey, resolved);
        }

        return resolved;
      }
    }
  }

  const unresolved = {
    absolute_path: importResolutionCandidates(scopedBasePaths[0])[0],
    unresolved: true
  };

  if (cache) {
    cache.set(cacheKey, unresolved);
  }

  return unresolved;
}

function extractImportSpecifiers(sourceText) {
  const specifiers = new Set();
  const patterns = [
    /\bimport\s+(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\bexport\s+(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g
  ];

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(sourceText)) !== null) {
      const specifier = match[1];

      if (!specifier || specifier.startsWith("node:") || /^[a-z]+:\/\//i.test(specifier)) {
        continue;
      }

      specifiers.add(specifier);
    }
  }

  return [...specifiers];
}

function countExports(sourceText) {
  const matches = sourceText.match(/\bexport\s+(default\s+)?(async\s+)?(function|class|const|let|var|type|interface|enum)\b/g) || [];
  const moduleExports = sourceText.match(/\bmodule\.exports\b|\bexports\.[A-Za-z0-9_]+\b/g) || [];
  return matches.length + moduleExports.length;
}

function extractEnvReferences(sourceText) {
  const names = [];
  const patterns = [
    /\bprocess\.env\.([A-Z][A-Z0-9_]+)/g,
    /\bprocess\.env\[\s*["'`]([A-Z][A-Z0-9_]+)["'`]\s*\]/g,
    /\bimport\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
    /\bimport\.meta\.env\[\s*["'`]([A-Z][A-Z0-9_]+)["'`]\s*\]/g,
    /\bDeno\.env\.get\(\s*["'`]([A-Z][A-Z0-9_]+)["'`]\s*\)/g,
    /\bBun\.env\.([A-Z][A-Z0-9_]+)/g,
    /\bBun\.env\[\s*["'`]([A-Z][A-Z0-9_]+)["'`]\s*\]/g
  ];

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(sourceText)) !== null) {
      if (match[1]) {
        names.push(match[1]);
      }
    }
  }

  return names;
}

function extractSupabaseTableRefs(sourceText, filePath = "") {
  const names = new Set();
  const fromPattern = /\.\s*from\(\s*["'`]([A-Za-z0-9_.-]+)["'`]\s*\)/g;
  let match;
  const sqlKeywords = new Set([
    "all",
    "and",
    "as",
    "before",
    "by",
    "cascade",
    "case",
    "check",
    "constraint",
    "default",
    "delete",
    "desc",
    "distinct",
    "do",
    "else",
    "end",
    "exists",
    "false",
    "for",
    "from",
    "function",
    "group",
    "if",
    "in",
    "insert",
    "into",
    "is",
    "join",
    "not",
    "null",
    "on",
    "or",
    "order",
    "primary",
    "references",
    "returning",
    "select",
    "set",
    "table",
    "then",
    "true",
    "unique",
    "update",
    "using",
    "values",
    "when",
    "where",
    "with"
  ]);

  const addTableName = (value) => {
    const normalized = String(value || "").replace(/^public\./i, "");
    if (!normalized || sqlKeywords.has(normalized.toLowerCase())) {
      return;
    }

    names.add(normalized);
  };

  while ((match = fromPattern.exec(sourceText)) !== null) {
    if (match[1]) {
      addTableName(match[1]);
    }
  }

  if (path.extname(filePath).toLowerCase() === ".sql") {
    const sqlPatterns = [
      /\b(?:from|into|update|join)\s+(?:public\.)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi,
      /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi,
      /\balter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi,
      /\bdrop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi,
      /\breferences\s+(?:public\.)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s*\(/gi
    ];

    for (const sqlPattern of sqlPatterns) {
      while ((match = sqlPattern.exec(sourceText)) !== null) {
        if (match[1]) {
          addTableName(match[1]);
        }
      }
    }
  }

  return [...names].sort();
}

function envRemediationPriority(entry) {
  const blockedWeight = entry.effective_status === "blocked" ? 18 : entry.effective_status === "manual_review" ? 8 : 0;
  return (entry.undeclared_env_refs?.length || 0) * 18
    + (entry.observed_env_variable_count || 0) * 2
    + blockedWeight
    + Math.min(24, Math.round((entry.raw_source_tokens || 0) / 12000));
}

function rlsRemediationPriority(entry) {
  const blockedWeight = entry.effective_status === "blocked" ? 16 : entry.effective_status === "manual_review" ? 7 : 0;
  return (entry.observed_table_refs?.length || 0) * 16
    + ((entry.negative_test_count || 0) === 0 ? 12 : 0)
    + blockedWeight
    + Math.min(24, Math.round((entry.raw_source_tokens || 0) / 12000));
}

function boundaryRemediationPriority(entry) {
  return (entry.private_cross_import_count || 0) * 60
    + (entry.cross_brick_owned_import_count || 0) * 12
    + (entry.unresolved_local_import_count || 0) * 10
    + (entry.unowned_local_dependency_count || 0) * 5
    + Math.min(24, Math.round((entry.raw_source_tokens || 0) / 12000));
}

function remediationActionProjectPlans(actions, limit = 3) {
  const byProject = new Map();

  for (const action of actions) {
    const current = byProject.get(action.project) || [];
    current.push(action);
    byProject.set(action.project, current);
  }

  return [...byProject.entries()]
    .map(([project, entries]) => ({
      project,
      actions: entries
        .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || String(a.path).localeCompare(String(b.path)))
        .slice(0, limit)
    }))
    .sort((a, b) => {
      const aTop = a.actions[0]?.priority_score || 0;
      const bTop = b.actions[0]?.priority_score || 0;
      return bTop - aTop || a.project.localeCompare(b.project);
    });
}

function manifestPathHint(projectRoot, sourcePath) {
  for (const candidate of sourcePathCandidates(projectRoot, sourcePath)) {
    if (!isWithinRoot(projectRoot, candidate)) {
      continue;
    }

    return {
      absolute_path: candidate,
      relative_path: toSlashPath(path.relative(projectRoot, candidate))
    };
  }

  return null;
}

function pathRuleMatches(rulePath, targetPath) {
  return rulePath === targetPath || isWithinRoot(rulePath, targetPath);
}

function buildBoundaryRules(projectRoot, bricks) {
  const rules = [];
  const rulesByBrick = new Map();
  const scopes = [
    ["private", "private_paths"],
    ["public", "public_paths"],
    ["owned", "owned_paths"],
    ["source", "source_paths"]
  ];

  for (const brick of bricks) {
    const brickRules = [];

    for (const [scope, field] of scopes) {
      for (const sourcePath of brick[field] || []) {
        const hint = manifestPathHint(projectRoot, sourcePath);

        if (!hint) {
          continue;
        }

        const rule = {
          brick_id: brick.id,
          scope,
          absolute_path: hint.absolute_path,
          relative_path: hint.relative_path
        };

        brickRules.push(rule);
        rules.push(rule);
      }
    }

    rulesByBrick.set(brick.id, brickRules.sort((a, b) => b.absolute_path.length - a.absolute_path.length));
  }

  const scopeWeight = { private: 4, public: 3, owned: 2, source: 1 };

  rules.sort((a, b) => {
    const byLength = b.absolute_path.length - a.absolute_path.length;
    return byLength || (scopeWeight[b.scope] || 0) - (scopeWeight[a.scope] || 0);
  });

  return { rules, rulesByBrick };
}

function findBoundaryMatch(rules, targetPath) {
  return rules.find((rule) => pathRuleMatches(rule.absolute_path, targetPath)) || null;
}

function matchesOwnBoundary(targetPath, ownRules = []) {
  return ownRules.some((rule) => pathRuleMatches(rule.absolute_path, targetPath));
}

async function collectProjectSourceGraph(projectRoot, projectIdValue, bricks) {
  const sourceTargets = new Map();
  const missingSourcePathMap = new Map();

  for (const brick of bricks) {
    for (const sourcePath of brick.source_paths || []) {
      const resolvedTarget = await resolveSourceTarget(projectRoot, sourcePath);

      if (!resolvedTarget) {
        const key = `${brick.id}\0${sourcePath}`;
        missingSourcePathMap.set(key, {
          project: projectIdValue,
          brick_id: brick.id,
          path: toSlashPath(sourcePath)
        });
        continue;
      }

      const key = toSlashPath(resolvedTarget.absolute_path);
      const current = sourceTargets.get(key) || {
        absolute_path: resolvedTarget.absolute_path,
        relative_path: resolvedTarget.relative_path,
        brick_ids: new Set()
      };

      current.brick_ids.add(brick.id);
      sourceTargets.set(key, current);
    }
  }

  const fileMap = new Map();
  const brickFiles = new Map();
  const analysisFailures = [];

  for (const target of sourceTargets.values()) {
    const sourceFiles = [];

    try {
      await walkAnalyzableFiles(target.absolute_path, sourceFiles);
    } catch (error) {
      analysisFailures.push({
        project: projectIdValue,
        path: target.relative_path,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    for (const sourceFile of sourceFiles) {
      const relativePath = toSlashPath(path.relative(projectRoot, sourceFile));
      attachFileReference(fileMap, sourceFile, relativePath, target.brick_ids);

      for (const brickId of target.brick_ids) {
        const existing = brickFiles.get(brickId) || [];

        if (!existing.some((item) => item.absolute_path === sourceFile)) {
          existing.push({
            absolute_path: sourceFile,
            relative_path: relativePath
          });
        }

        brickFiles.set(brickId, existing);
      }
    }
  }

  return {
    file_map: fileMap,
    brick_files: brickFiles,
    missing_source_paths: [...missingSourcePathMap.values()].sort((a, b) => a.path.localeCompare(b.path)),
    analysis_failures: analysisFailures.sort((a, b) => a.path.localeCompare(b.path))
  };
}

async function loadCompactCardIndex() {
  const filePath = path.join(smaRoot, "security", "brick_cards.jsonl");
  const index = new Map();

  try {
    const raw = await fs.readFile(filePath, "utf8");

    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      try {
        const record = JSON.parse(line);

        if (record.id) {
          index.set(record.id, record);
        }
      } catch {
        // ignore malformed lines
      }
    }
  } catch {
    return index;
  }

  return index;
}

function cardTokenEstimate(card) {
  return estimateTokens(JSON.stringify(card || {}));
}

function buildDuplicateClusters(bricks) {
  const byStem = new Map();

  for (const brick of bricks) {
    const stem = duplicateStemForBrick(brick);

    if (!stem || stem.length < 4) {
      continue;
    }

    const key = `${stem}:${String(brick.kind || "unknown").replace(/_(module|file)$/, "")}`;
    const current = byStem.get(key) || [];
    current.push(brick);
    byStem.set(key, current);
  }

  return [...byStem.entries()]
    .map(([key, group]) => ({
      key,
      projects: [...new Set(group.map((brick) => brick.project))].sort(),
      kind: group[0]?.kind || "unknown",
      stem: key.split(":")[0],
      count: group.length,
      bricks: group
        .sort((a, b) => (b.score || 0) - (a.score || 0) || a.id.localeCompare(b.id))
        .slice(0, 10)
        .map((brick) => ({
          id: brick.id,
          project: brick.project,
          name: brick.name,
          status: brick.status,
          score: brick.score,
          source_path: (brick.source_paths || [])[0] || ""
        }))
    }))
    .filter((cluster) => cluster.count >= 2 && (cluster.projects.length >= 2 || cluster.count >= 3))
    .sort((a, b) => b.projects.length - a.projects.length || b.count - a.count || a.stem.localeCompare(b.stem))
    .slice(0, 80);
}

function readinessReasons(penalties) {
  return penalties
    .filter((penalty) => penalty.points > 0)
    .sort((a, b) => b.points - a.points || a.label.localeCompare(b.label))
    .slice(0, 5)
    .map((penalty) => `${penalty.label} (-${penalty.points})`);
}

function boundaryViolationPriority(kind) {
  return {
    private_cross_brick_import: 4,
    unresolved_local_import: 3,
    unowned_local_dependency: 2,
    cross_brick_owned_import: 1
  }[kind] || 0;
}

async function analyzeProjectScannerReport(projectRoot, projectIdValue, bricks, unmanifestedCount = 0, compactCardIndex = new Map()) {
  const sourceGraph = await collectProjectSourceGraph(projectRoot, projectIdValue, bricks);
  const buildCandidates = detectProjectBuildCandidates(projectIdValue, bricks);
  const buildReport = buildProjectBuildReport(projectIdValue, buildCandidates);
  const { rules, rulesByBrick } = buildBoundaryRules(projectRoot, bricks);
  const brickById = new Map(bricks.map((brick) => [brick.id, brick]));
  const importResolutionCache = new Map();
  const importExistsCache = new Map();
  const boundaryMatchCache = new Map();
  const boundaryViolations = [];
  const driftEntries = [];
  const cloneEntries = [];
  const tokenHeavyBricks = [];
  const envGapBricks = [];
  const blockerCounts = new Map();
  const observedEnvNameCounts = new Map();
  const undeclaredEnvNameCounts = new Map();
  const ignoredEnvNameCounts = new Map();
  const declaredEnvNames = new Set();
  const complianceReport = emptyComplianceReport(projectIdValue);
  const rlsGapBricks = [];
  const boundaryHotspots = [];
  let localImportCount = 0;
  let publicCrossBrickImportCount = 0;
  let sameGroupInternalImportCount = 0;
  let crossBrickOwnedImportCount = 0;
  let privateCrossBrickImportCount = 0;
  let unresolvedLocalImportCount = 0;
  let unownedLocalDependencyCount = 0;
  let rawSourceTokens = 0;
  let estimatedSummaryTokens = 0;
  let compactCardTokens = 0;
  let compactCardCoverageCount = 0;
  let observedEnvReferenceCount = 0;
  let ignoredEnvReferenceCount = 0;
  let analyzedCodeFileCount = 0;
  let totalQualitySmellCount = 0;
  let totalQualityWeightedScore = 0;
  const aggregateQualityCounts = emptyCodeQualityCounts();
  const codeQualityHotspots = [];
  const codeQualityBricks = [];
  const duplicateFingerprintEntries = [];

  for (const brick of bricks) {
    const files = sourceGraph.brick_files.get(brick.id) || [];
    let totalLines = 0;
    let maxFileLines = 0;
    let exportCount = 0;
    let brickTokens = 0;
    let localImportsForBrick = 0;
    let publicImportsForBrick = 0;
    let sameGroupImportsForBrick = 0;
    let ownedImportsForBrick = 0;
    let privateImportsForBrick = 0;
    let unresolvedImportsForBrick = 0;
    let unknownDepsForBrick = 0;
    let brickQualitySmellCount = 0;
    let brickQualityWeighted = 0;
    const brickQualityCounts = emptyCodeQualityCounts();
    const observedEnvRefs = new Set();
    const observedTableRefs = new Set();
    const ownRules = rulesByBrick.get(brick.id) || [];
    const testLikeBrick = isTestLikeBrick(brick);
    const cloneTrackable = isCloneTrackableBrick(brick);
    const strictReuseBrick = brick.status === "candidate"
      || brick.status === "canonical"
      || ["copy_ready", "guided", "semi_automatic"].includes(brick.clone_readiness);
    const declaredEnvSet = new Set((brick.env_contract?.variables || []).map((entry) => entry?.name).filter(Boolean));

    for (const name of declaredEnvSet) {
      declaredEnvNames.add(name);
    }

    for (const file of files) {
      const sourceText = await fs.readFile(file.absolute_path, "utf8");
      const lineCount = sourceText.split(/\r?\n/).length;
      const tokenCount = estimateTokens(sourceText);

      totalLines += lineCount;
      maxFileLines = Math.max(maxFileLines, lineCount);
      brickTokens += tokenCount;
      exportCount += isCodeFile(file.absolute_path) ? countExports(sourceText) : 0;

      if (!isCodeFile(file.absolute_path)) {
        continue;
      }

      analyzedCodeFileCount += 1;
      const fileIsTestLike = testLikeBrick || isTestLikePath(file.relative_path);
      const qualityCounts = analyzeCodeQualityCounts(sourceText, {
        filePath: file.relative_path,
        lineCount,
        testLike: fileIsTestLike
      });
      const qualityMatchCount = codeQualityMatchCount(qualityCounts);
      const qualityWeighted = codeQualityWeightedScore(qualityCounts);
      const duplicateFingerprint = duplicateFingerprintForFile({
        filePath: file.relative_path,
        sourceText,
        lineCount,
        testLike: fileIsTestLike
      });

      if (qualityMatchCount > 0) {
        totalQualitySmellCount += qualityMatchCount;
        totalQualityWeightedScore += qualityWeighted;
        brickQualitySmellCount += qualityMatchCount;
        brickQualityWeighted += qualityWeighted;
        mergeCodeQualityCounts(aggregateQualityCounts, qualityCounts);
        mergeCodeQualityCounts(brickQualityCounts, qualityCounts);

        codeQualityHotspots.push({
          project: projectIdValue,
          brick_id: brick.id,
          brick_name: brick.name,
          path: file.relative_path,
          smell_score: qualityWeighted,
          total_matches: qualityMatchCount,
          line_count: lineCount,
          raw_source_tokens: tokenCount,
          by_type: compactCodeQualityCounts(qualityCounts),
          top_types: topCodeQualityTypes(qualityCounts)
        });
      }

      if (duplicateFingerprint) {
        duplicateFingerprintEntries.push({
          project: projectIdValue,
          brick_id: brick.id,
          brick_name: brick.name,
          path: file.relative_path,
          line_count: lineCount,
          raw_source_tokens: tokenCount,
          fingerprint: duplicateFingerprint
        });
      }

      if (!fileIsTestLike) {
        for (const envName of extractEnvReferences(sourceText)) {
          if (!isContractRelevantEnvReference(envName)) {
            ignoredEnvReferenceCount += 1;
            ignoredEnvNameCounts.set(envName, (ignoredEnvNameCounts.get(envName) || 0) + 1);
            continue;
          }

          observedEnvReferenceCount += 1;
          observedEnvRefs.add(envName);
          observedEnvNameCounts.set(envName, (observedEnvNameCounts.get(envName) || 0) + 1);
        }

        for (const tableName of extractSupabaseTableRefs(sourceText, file.absolute_path)) {
          observedTableRefs.add(tableName);
        }
      }

      for (const specifier of extractImportSpecifiers(sourceText)) {
        const normalizedSpecifier = normalizeImportSpecifier(specifier);

        if (!normalizedSpecifier || isIgnoredProjectImportSpecifier(normalizedSpecifier)) {
          continue;
        }

        const cachedResolved = await resolveProjectImport(projectRoot, file.absolute_path, normalizedSpecifier, importResolutionCache, importExistsCache);
        if (!cachedResolved) {
          continue;
        }

        localImportCount += 1;
        localImportsForBrick += 1;

        if (cachedResolved.unresolved) {
          unresolvedLocalImportCount += 1;
          unresolvedImportsForBrick += 1;

          if (!testLikeBrick && !isTestLikePath(file.relative_path)) {
            boundaryViolations.push({
              project: projectIdValue,
              brick_id: brick.id,
              file: file.relative_path,
              specifier: normalizedSpecifier,
              kind: "unresolved_local_import"
            });
          }
          continue;
        }

        const match = boundaryMatchCache.has(cachedResolved.absolute_path)
          ? boundaryMatchCache.get(cachedResolved.absolute_path)
          : findBoundaryMatch(rules, cachedResolved.absolute_path);

        if (!boundaryMatchCache.has(cachedResolved.absolute_path)) {
          boundaryMatchCache.set(cachedResolved.absolute_path, match);
        }

        if (match && match.brick_id !== brick.id) {
          const targetBrick = brickById.get(match.brick_id);
          const testContext = fileIsTestLike;

          if (testContext) {
            continue;
          }

          if (match.scope === "private") {
            privateCrossBrickImportCount += 1;
            privateImportsForBrick += 1;
            boundaryViolations.push({
              project: projectIdValue,
              brick_id: brick.id,
              target_brick_id: match.brick_id,
              file: file.relative_path,
              target: match.relative_path,
              specifier: normalizedSpecifier,
              kind: "private_cross_brick_import"
            });
          } else if (sharesBrickGroupFamily(brick, targetBrick)) {
            sameGroupInternalImportCount += 1;
            sameGroupImportsForBrick += 1;
          } else if (match.scope !== "public") {
            crossBrickOwnedImportCount += 1;
            ownedImportsForBrick += 1;
            boundaryViolations.push({
              project: projectIdValue,
              brick_id: brick.id,
              target_brick_id: match.brick_id,
              file: file.relative_path,
              target: match.relative_path,
              specifier: normalizedSpecifier,
              kind: "cross_brick_owned_import"
            });
          } else {
            publicCrossBrickImportCount += 1;
            publicImportsForBrick += 1;
          }
        } else if (!match && !matchesOwnBoundary(cachedResolved.absolute_path, ownRules)) {
          unownedLocalDependencyCount += 1;
          unknownDepsForBrick += 1;

          if (!testLikeBrick && !isTestLikePath(file.relative_path)) {
            boundaryViolations.push({
              project: projectIdValue,
              brick_id: brick.id,
              file: file.relative_path,
              target: toSlashPath(path.relative(projectRoot, cachedResolved.absolute_path)),
              specifier: normalizedSpecifier,
              kind: "unowned_local_dependency"
            });
          }
        }
      }
    }

    const envContractTrackable = cloneTrackable && (
      Boolean(brick.env_contract?.required)
      || observedEnvRefs.size > 0
      || declaredEnvSet.size > 0
    );
    const undeclaredEnvRefs = envContractTrackable
      ? [...observedEnvRefs].filter((name) => !declaredEnvSet.has(name)).sort()
      : [];

    for (const name of undeclaredEnvRefs) {
      const current = undeclaredEnvNameCounts.get(name) || {
        name,
        brick_count: 0,
        bricks: new Set()
      };

      if (!current.bricks.has(brick.id)) {
        current.brick_count += 1;
        current.bricks.add(brick.id);
      }

      undeclaredEnvNameCounts.set(name, current);
    }

    rawSourceTokens += brickTokens;
    const card = compactCardIndex.get(brick.id);
    const compactTokens = card ? cardTokenEstimate(card) : 0;
    const summaryTokens = compactTokens || estimateTokens([
      brick.name,
      ...(brick.public_api || []).slice(0, 4),
      ...(brick.clone_install_steps || []).slice(0, 2),
      ...(brick.adapters || []).slice(0, 2)
    ].join(" "));

    estimatedSummaryTokens += summaryTokens;
    compactCardTokens += compactTokens;
    compactCardCoverageCount += compactTokens > 0 ? 1 : 0;

    tokenHeavyBricks.push({
      project: projectIdValue,
      brick_id: brick.id,
      name: brick.name,
      path: (brick.source_paths || [])[0] || "",
      raw_source_tokens: brickTokens,
      summary_tokens: summaryTokens,
      compact_card_tokens: compactTokens,
      estimated_savings_tokens: Math.max(0, brickTokens - summaryTokens),
      file_count: files.length
    });

    const driftTrackable = shouldTrackManifestDrift(brick, files);

    const maxFileLineDiff = Math.abs((brick.quality_line_count?.max_file_lines || 0) - maxFileLines);
    const featureLineDiff = Math.abs((brick.code_budget?.feature_lines || 0) - totalLines);
    const fileCountDiff = Math.abs((brick.code_budget?.file_count || 0) - files.length);

    if (
      driftTrackable
      && ((brick.quality_line_count?.max_file_lines || 0) > 0 || (strictReuseBrick && maxFileLines >= oversizedThresholds.critical))
      && maxFileLineDiff >= Math.max(120, Math.round((brick.quality_line_count?.max_file_lines || 0) * 0.5))
    ) {
      driftEntries.push({
        project: projectIdValue,
        brick_id: brick.id,
        kind: "max_file_lines_drift",
        manifest_value: brick.quality_line_count?.max_file_lines || 0,
        actual_value: maxFileLines,
        path: (brick.source_paths || [])[0] || ""
      });
    }

    if (driftTrackable && (brick.code_budget?.file_count || 0) > 0 && fileCountDiff >= Math.max(5, Math.round((brick.code_budget?.file_count || 0) * 0.3))) {
      driftEntries.push({
        project: projectIdValue,
        brick_id: brick.id,
        kind: "file_count_drift",
        manifest_value: brick.code_budget?.file_count || 0,
        actual_value: files.length,
        path: (brick.source_paths || [])[0] || ""
      });
    }

    if (
      driftTrackable
      && ((brick.code_budget?.feature_lines || 0) > 0 || (strictReuseBrick && totalLines >= 1200))
      && featureLineDiff >= Math.max(400, Math.round((brick.code_budget?.feature_lines || 0) * 0.35))
    ) {
      driftEntries.push({
        project: projectIdValue,
        brick_id: brick.id,
        kind: "feature_line_drift",
        manifest_value: brick.code_budget?.feature_lines || 0,
        actual_value: totalLines,
        path: (brick.source_paths || [])[0] || ""
      });
    }

    if (driftTrackable && isCloneTrackableBrick(brick) && (brick.public_api || []).length === 0 && exportCount >= 3) {
      driftEntries.push({
        project: projectIdValue,
        brick_id: brick.id,
        kind: "missing_public_api_declaration",
        manifest_value: 0,
        actual_value: exportCount,
        path: (brick.source_paths || [])[0] || ""
      });
    }

    const blockerCodes = [];
    const warningCodes = [];
    const highRiskFindings = (brick.vulnerability_findings?.critical || 0) + (brick.vulnerability_findings?.high || 0);
    const skippedVerification = (brick.verification || []).some((event) => event.status === "skipped");
    const missingSourceForBrick = sourceGraph.missing_source_paths.some((entry) => entry.brick_id === brick.id);

    if (brick.health.error_count > 0) blockerCodes.push("validation_error");
    if (missingSourceForBrick) blockerCodes.push("missing_source_files");
    if (highRiskFindings > 0) blockerCodes.push("high_risk_vulnerability");
    if (privateImportsForBrick > 0) blockerCodes.push("private_cross_brick_import");
    if (((strictReuseBrick && ownedImportsForBrick >= 6) || ownedImportsForBrick >= 20)) blockerCodes.push("cross_brick_owned_import");
    if (((strictReuseBrick && unknownDepsForBrick >= 4) || unknownDepsForBrick >= 20)) blockerCodes.push("unowned_local_dependency");
    if (((strictReuseBrick && unresolvedImportsForBrick >= 4) || unresolvedImportsForBrick >= 20)) blockerCodes.push("unresolved_local_import");
    if (strictReuseBrick && undeclaredEnvRefs.length > 0) blockerCodes.push("env_reference_undeclared");
    if (cloneTrackable && brick.clone_readiness !== "manual_only" && (brick.clone_install_steps || []).length === 0) blockerCodes.push("missing_clone_steps");
    if (cloneTrackable && brick.clone_readiness !== "manual_only" && (brick.clone_known_traps || []).length === 0) blockerCodes.push("missing_known_traps");
    if (envContractTrackable && brick.env_contract?.required && brick.env_contract.status !== "complete") blockerCodes.push("env_contract_incomplete");
    if (cloneTrackable && brick.rls_contract?.required && brick.rls_contract.status !== "complete") blockerCodes.push("rls_contract_incomplete");

    if (cloneTrackable && (brick.test_commands || []).length === 0) warningCodes.push("missing_test_commands");
    if (cloneTrackable && (brick.public_api || []).length === 0 && exportCount >= 3) warningCodes.push("public_api_missing");
    if ((brick.status === "candidate" || brick.status === "canonical") && !brick.source_commit && !brick.source_archive_hash) warningCodes.push("source_attestation_missing");
    if ((brick.status === "candidate" || brick.status === "canonical") && skippedVerification) warningCodes.push("verification_skipped");
    if (!strictReuseBrick && undeclaredEnvRefs.length > 0) warningCodes.push("env_reference_undeclared");
    if (ownedImportsForBrick > 0) warningCodes.push("cross_group_dependency");
    if (unknownDepsForBrick > 0 && !blockerCodes.includes("unowned_local_dependency")) warningCodes.push("unowned_local_dependency");
    if (unresolvedImportsForBrick > 0 && !blockerCodes.includes("unresolved_local_import")) warningCodes.push("unresolved_local_import");
    if (maxFileLines > 600) warningCodes.push("file_over_600");
    if (brick.code_budget?.status === "bloated") warningCodes.push("code_budget_bloated");
    if (brick.health.warning_count > 0) warningCodes.push("validation_warning");

    for (const code of [...blockerCodes, ...warningCodes]) {
      blockerCounts.set(code, (blockerCounts.get(code) || 0) + 1);
    }

    const effectiveStatus = blockerCodes.length > 0
      ? "blocked"
      : brick.clone_readiness === "copy_ready" && warningCodes.length === 0
        ? "copy_ready"
        : brick.clone_readiness === "guided" && warningCodes.length <= 2
          ? "guided"
          : "manual_review";

    cloneEntries.push({
      project: projectIdValue,
      brick_id: brick.id,
      name: brick.name,
      path: (brick.source_paths || [])[0] || "",
      declared_readiness: brick.clone_readiness,
      effective_status: effectiveStatus,
      blocker_codes: blockerCodes,
      warning_codes: warningCodes,
      local_import_count: localImportsForBrick,
      public_cross_import_count: publicImportsForBrick,
      same_group_internal_import_count: sameGroupImportsForBrick,
      cross_brick_owned_import_count: ownedImportsForBrick,
      private_cross_import_count: privateImportsForBrick,
      unresolved_local_import_count: unresolvedImportsForBrick,
      unowned_local_dependency_count: unknownDepsForBrick,
      undeclared_env_refs: undeclaredEnvRefs,
      raw_source_tokens: brickTokens,
      file_count: files.length
    });

    if (undeclaredEnvRefs.length > 0) {
      envGapBricks.push({
        project: projectIdValue,
        brick_id: brick.id,
        name: brick.name,
        path: (brick.source_paths || [])[0] || "",
        undeclared_env_refs: undeclaredEnvRefs,
        observed_env_variable_count: observedEnvRefs.size,
        declared_env_variable_count: declaredEnvSet.size,
        effective_status: effectiveStatus,
        raw_source_tokens: brickTokens
      });
    }

    if (cloneTrackable && Boolean(brick.rls_contract?.required) && contractStatusScore(brick.rls_contract?.status) < 1) {
      rlsGapBricks.push({
        project: projectIdValue,
        brick_id: brick.id,
        name: brick.name,
        path: (brick.source_paths || [])[0] || "",
        rls_status: brick.rls_contract?.status || "unknown",
        observed_table_refs: [...observedTableRefs].slice(0, 8),
        negative_test_count: (brick.rls_contract?.negative_tests || []).length,
        effective_status: effectiveStatus,
        raw_source_tokens: brickTokens
      });
    }

    const boundaryPriority = boundaryRemediationPriority({
      private_cross_import_count: privateImportsForBrick,
      cross_brick_owned_import_count: ownedImportsForBrick,
      unresolved_local_import_count: unresolvedImportsForBrick,
      unowned_local_dependency_count: unknownDepsForBrick,
      raw_source_tokens: brickTokens
    });

    if (boundaryPriority > 0) {
      boundaryHotspots.push({
        project: projectIdValue,
        brick_id: brick.id,
        name: brick.name,
        path: (brick.source_paths || [])[0] || "",
        private_cross_import_count: privateImportsForBrick,
        cross_brick_owned_import_count: ownedImportsForBrick,
        unresolved_local_import_count: unresolvedImportsForBrick,
        unowned_local_dependency_count: unknownDepsForBrick,
        effective_status: effectiveStatus,
        raw_source_tokens: brickTokens,
        priority_score: boundaryPriority
      });
    }

    if (cloneTrackable) {
      complianceReport.trackable_brick_count += 1;
    }

    const complianceDimensions = [
      {
        key: "boundary_clean",
        active: cloneTrackable,
        ready: privateImportsForBrick === 0 && ownedImportsForBrick === 0 && unresolvedImportsForBrick === 0 && unknownDepsForBrick === 0,
        contribution: privateImportsForBrick === 0 && ownedImportsForBrick === 0 && unresolvedImportsForBrick === 0 && unknownDepsForBrick === 0 ? 1 : 0
      },
      {
        key: "env_contract",
        active: envContractTrackable,
        ready: undeclaredEnvRefs.length === 0
          && contractStatusScore(brick.env_contract?.status) >= 1
          && (observedEnvRefs.size === 0 || declaredEnvSet.size > 0),
        contribution: (() => {
          const statusScore = contractStatusScore(brick.env_contract?.status);
          const declarationCoverage = observedEnvRefs.size > 0
            ? Math.max(0, (observedEnvRefs.size - undeclaredEnvRefs.length) / observedEnvRefs.size)
            : declaredEnvSet.size > 0
              ? 1
              : statusScore;

          return Number(((statusScore * 0.5) + (declarationCoverage * 0.5)).toFixed(2));
        })()
      },
      {
        key: "clone_steps",
        active: cloneTrackable && brick.clone_readiness !== "manual_only",
        ready: (brick.clone_install_steps || []).length > 0,
        contribution: (brick.clone_install_steps || []).length > 0 ? 1 : 0
      },
      {
        key: "test_commands",
        active: cloneTrackable,
        ready: (brick.test_commands || []).length > 0,
        contribution: (brick.test_commands || []).length > 0 ? 1 : 0
      },
      {
        key: "known_traps",
        active: cloneTrackable && brick.clone_readiness !== "manual_only",
        ready: (brick.clone_known_traps || []).length > 0,
        contribution: (brick.clone_known_traps || []).length > 0 ? 1 : 0
      },
      {
        key: "public_api",
        active: cloneTrackable && ((brick.public_api || []).length > 0 || exportCount >= 3),
        ready: (brick.public_api || []).length > 0,
        contribution: (brick.public_api || []).length > 0 ? 1 : 0
      },
      {
        key: "rls_contract",
        active: cloneTrackable && Boolean(brick.rls_contract?.required),
        ready: contractStatusScore(brick.rls_contract?.status) >= 1,
        contribution: contractStatusScore(brick.rls_contract?.status)
      },
      {
        key: "source_attestation",
        active: brick.status === "candidate" || brick.status === "canonical",
        ready: Boolean(brick.source_commit || brick.source_archive_hash),
        contribution: brick.source_commit || brick.source_archive_hash ? 1 : 0
      },
      {
        key: "security_clean",
        active: cloneTrackable,
        ready: highRiskFindings === 0,
        contribution: highRiskFindings === 0 ? 1 : 0
      }
    ];
    const missingDimensions = [];

    for (const dimension of complianceDimensions) {
      if (!dimension.active) {
        continue;
      }

      complianceReport.dimensions[dimension.key].total_count += 1;
      complianceReport.dimensions[dimension.key].coverage_units += Number(dimension.contribution ?? (dimension.ready ? 1 : 0));

      if (dimension.ready) {
        complianceReport.dimensions[dimension.key].ready_count += 1;
      } else {
        missingDimensions.push(dimension.key);
      }
    }

    if (cloneTrackable && missingDimensions.length > 0) {
      complianceReport.highest_gap_bricks.push({
        project: projectIdValue,
        brick_id: brick.id,
        name: brick.name,
        path: (brick.source_paths || [])[0] || "",
        effective_status: effectiveStatus,
        missing_dimensions: missingDimensions,
        missing_count: missingDimensions.length,
        raw_source_tokens: brickTokens
      });
    }

    if (brickQualitySmellCount > 0) {
      codeQualityBricks.push({
        project: projectIdValue,
        brick_id: brick.id,
        name: brick.name,
        path: (brick.source_paths || [])[0] || "",
        smell_score: brickQualityWeighted,
        total_matches: brickQualitySmellCount,
        by_type: compactCodeQualityCounts(brickQualityCounts),
        top_types: topCodeQualityTypes(brickQualityCounts),
        raw_source_tokens: brickTokens
      });
    }
  }

  const uniqueCodeQualityHotspots = dedupeQualityHotspots(codeQualityHotspots);
  const duplicateGroups = buildQualityDuplicateGroups(duplicateFingerprintEntries);
  const qualityQueue = buildQualityQueue(uniqueCodeQualityHotspots, duplicateGroups);
  const cloneStatusCounts = Object.fromEntries(countBy(cloneEntries, (entry) => entry.effective_status));
  const codeQualityPenalty = analyzedCodeFileCount > 0
    ? Math.min(
      80,
      Math.round(
        ((codeQualityHotspots.length / analyzedCodeFileCount) * 55)
        + ((totalQualityWeightedScore / analyzedCodeFileCount) * 0.7)
      )
    )
    : 0;
  const codeQualityScore = Math.max(0, 100 - codeQualityPenalty);
  const penalties = [
    { label: "validation blockers", points: Math.min(28, Math.round((cloneEntries.filter((entry) => entry.blocker_codes.includes("validation_error")).length / Math.max(1, bricks.length)) * 80)) },
    { label: "blocked clone preflight", points: Math.min(24, Math.round(((cloneStatusCounts.blocked || 0) / Math.max(1, bricks.length)) * 70)) },
    { label: "boundary violations", points: Math.min(16, Math.round(((privateCrossBrickImportCount + unownedLocalDependencyCount + unresolvedLocalImportCount + Math.ceil(crossBrickOwnedImportCount / 3)) / Math.max(1, bricks.length)) * 8)) },
    { label: "env contract drift", points: Math.min(14, Math.round((envGapBricks.length / Math.max(1, bricks.length)) * 60)) },
    { label: "manifest drift", points: Math.min(12, Math.round((driftEntries.length / Math.max(1, bricks.length)) * 8)) },
    { label: "unmanifested backlog", points: Math.min(10, unmanifestedCount * 2) },
    { label: "oversized code", points: Math.min(10, Math.round((cloneEntries.filter((entry) => entry.warning_codes.includes("file_over_600")).length / Math.max(1, bricks.length)) * 24)) }
  ];
  const readinessScore = Math.max(0, 100 - penalties.reduce((sum, penalty) => sum + penalty.points, 0));
  const finalizedComplianceReport = finalizeComplianceReport(complianceReport);
  const envContractQueue = envGapBricks
    .map((entry) => ({
      ...entry,
      category: "env_contract",
      priority_score: envRemediationPriority(entry),
      first_action: `Declare ${entry.undeclared_env_refs.slice(0, 3).join(", ")} in the manifest env contract.`,
      why: `${entry.undeclared_env_refs.length} undeclared env var(s) keep this brick from being clone-safe.`
    }))
    .sort((a, b) => b.priority_score - a.priority_score || (b.undeclared_env_refs?.length || 0) - (a.undeclared_env_refs?.length || 0) || a.path.localeCompare(b.path))
    .slice(0, 80);
  const rlsContractQueue = rlsGapBricks
    .map((entry) => ({
      ...entry,
      category: "rls_contract",
      priority_score: rlsRemediationPriority(entry),
      first_action: entry.observed_table_refs.length > 0
        ? `Review RLS and negative tests for ${entry.observed_table_refs.slice(0, 3).join(", ")}.`
        : "Review required RLS contract and add negative tests in the manifest.",
      why: entry.observed_table_refs.length > 0
        ? `RLS is partial and this brick touches ${entry.observed_table_refs.length} table(s).`
        : "RLS is required but the contract is not complete."
    }))
    .sort((a, b) => b.priority_score - a.priority_score || (b.observed_table_refs?.length || 0) - (a.observed_table_refs?.length || 0) || a.path.localeCompare(b.path))
    .slice(0, 80);
  const boundaryQueue = boundaryHotspots
    .map((entry) => ({
      ...entry,
      category: "boundary",
      first_action: entry.private_cross_import_count > 0
        ? "Stop importing a sibling brick's private path; expose a public seam or merge the ownership."
        : "Resolve cross-brick ownership leaks and local unresolved imports before promoting reuse.",
      why: `${entry.private_cross_import_count || 0} private, ${entry.cross_brick_owned_import_count || 0} owned, ${entry.unresolved_local_import_count || 0} unresolved, ${entry.unowned_local_dependency_count || 0} unowned imports.`
    }))
    .sort((a, b) => b.priority_score - a.priority_score || a.path.localeCompare(b.path))
    .slice(0, 80);
  const remediationActions = [...envContractQueue, ...rlsContractQueue, ...boundaryQueue, ...qualityQueue]
    .sort((a, b) => b.priority_score - a.priority_score || String(a.category).localeCompare(String(b.category)) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 120);

  return {
    project: projectIdValue,
    readiness: {
      score: readinessScore,
      grade: gradeForScore(readinessScore),
      label: readinessLabel(readinessScore),
      reasons: readinessReasons(penalties),
      metrics: {
        brick_count: bricks.length,
        unmanifested_count: unmanifestedCount,
        blocked_clone_count: cloneStatusCounts.blocked || 0,
        copy_ready_count: cloneStatusCounts.copy_ready || 0,
        guided_count: cloneStatusCounts.guided || 0,
        manual_review_count: cloneStatusCounts.manual_review || 0,
        drift_count: driftEntries.length,
        boundary_violation_count: privateCrossBrickImportCount + crossBrickOwnedImportCount + unownedLocalDependencyCount + unresolvedLocalImportCount,
        same_group_coupling_count: sameGroupInternalImportCount,
        env_gap_count: envGapBricks.length,
        compliance_score: finalizedComplianceReport.score
      }
    },
    boundary_report: {
      import_scan_count: localImportCount,
      public_cross_brick_import_count: publicCrossBrickImportCount,
      same_group_internal_import_count: sameGroupInternalImportCount,
      cross_brick_owned_import_count: crossBrickOwnedImportCount,
      private_cross_brick_import_count: privateCrossBrickImportCount,
      unresolved_local_import_count: unresolvedLocalImportCount,
      unowned_local_dependency_count: unownedLocalDependencyCount,
      top_violations: boundaryViolations
        .sort((a, b) => boundaryViolationPriority(b.kind) - boundaryViolationPriority(a.kind) || String(a.file).localeCompare(String(b.file)))
        .slice(0, 100)
    },
    clone_preflight: {
      counts: {
        copy_ready: cloneStatusCounts.copy_ready || 0,
        guided: cloneStatusCounts.guided || 0,
        manual_review: cloneStatusCounts.manual_review || 0,
        blocked: cloneStatusCounts.blocked || 0
      },
      blocker_counts: Object.fromEntries([...blockerCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
      highest_risk_bricks: cloneEntries
        .sort((a, b) => b.blocker_codes.length - a.blocker_codes.length || b.warning_codes.length - a.warning_codes.length || b.raw_source_tokens - a.raw_source_tokens)
        .slice(0, 80)
    },
    manifest_drift: {
      count: driftEntries.length,
      by_type: Object.fromEntries(countBy(driftEntries, (entry) => entry.kind)),
      entries: driftEntries
        .sort((a, b) => String(a.path).localeCompare(String(b.path)))
        .slice(0, 120)
    },
    code_quality_report: {
      score: codeQualityScore,
      grade: gradeForScore(codeQualityScore),
      analyzed_code_file_count: analyzedCodeFileCount,
      hotspot_file_count: uniqueCodeQualityHotspots.length,
      brick_hotspot_count: codeQualityBricks.length,
      duplicate_cluster_count: duplicateGroups.length,
      total_smell_count: totalQualitySmellCount,
      weighted_smell_score: totalQualityWeightedScore,
      by_type: compactCodeQualityCounts(aggregateQualityCounts),
      top_hotspots: uniqueCodeQualityHotspots
        .sort((a, b) => b.smell_score - a.smell_score || b.total_matches - a.total_matches || String(a.path).localeCompare(String(b.path)))
        .slice(0, 100),
      highest_risk_bricks: codeQualityBricks
        .sort((a, b) => b.smell_score - a.smell_score || b.total_matches - a.total_matches || String(a.path).localeCompare(String(b.path)))
        .slice(0, 80),
      duplicate_groups: duplicateGroups.slice(0, 60)
    },
    env_contract_report: {
      observed_reference_count: observedEnvReferenceCount,
      observed_variable_count: observedEnvNameCounts.size,
      observed_variable_names: [...observedEnvNameCounts.keys()].sort(),
      ignored_reference_count: ignoredEnvReferenceCount,
      ignored_variable_count: ignoredEnvNameCounts.size,
      ignored_variable_names: [...ignoredEnvNameCounts.keys()].sort(),
      declared_variable_count: declaredEnvNames.size,
      undeclared_reference_count: envGapBricks.reduce((sum, entry) => sum + entry.undeclared_env_refs.length, 0),
      bricks_with_undeclared_refs: envGapBricks.length,
      top_undeclared_refs: [...undeclaredEnvNameCounts.values()]
        .sort((a, b) => b.brick_count - a.brick_count || a.name.localeCompare(b.name))
        .slice(0, 24)
        .map((entry) => ({
          name: entry.name,
          brick_count: entry.brick_count,
          sample_bricks: [...entry.bricks].sort().slice(0, 6)
        })),
      highest_gap_bricks: envGapBricks
        .map((entry) => {
          const cloneEntry = cloneEntries.find((candidate) => candidate.brick_id === entry.brick_id);

          return {
            ...entry,
            effective_status: cloneEntry?.effective_status || "manual_review"
          };
        })
        .sort((a, b) => b.undeclared_env_refs.length - a.undeclared_env_refs.length || a.path.localeCompare(b.path))
        .slice(0, 80)
    },
    compliance_report: finalizedComplianceReport,
    build_report: buildReport,
    remediation_report: {
      counts: {
        env_contract: envGapBricks.length,
        rls_contract: rlsGapBricks.length,
        boundary: boundaryHotspots.length,
        quality: qualityQueue.length
      },
      env_contract_queue: envContractQueue,
      rls_contract_queue: rlsContractQueue,
      boundary_queue: boundaryQueue,
      quality_queue: qualityQueue.slice(0, 80),
      top_actions: remediationActions,
      project_action_plans: remediationActionProjectPlans(remediationActions)
    },
    duplicate_clusters: [],
    token_economics: {
      raw_source_tokens: rawSourceTokens,
      estimated_summary_tokens: estimatedSummaryTokens,
      compact_card_tokens: compactCardTokens,
      compact_card_coverage_count: compactCardCoverageCount,
      compact_card_coverage_rate: bricks.length ? Number((compactCardCoverageCount / bricks.length).toFixed(3)) : 0,
      estimated_reduction_percent: rawSourceTokens ? Math.round(((rawSourceTokens - estimatedSummaryTokens) / rawSourceTokens) * 100) : 0,
      top_token_heavy_bricks: tokenHeavyBricks
        .sort((a, b) => b.raw_source_tokens - a.raw_source_tokens || a.path.localeCompare(b.path))
        .slice(0, 60)
    },
    missing_source_paths: sourceGraph.missing_source_paths,
    analysis_failures: sourceGraph.analysis_failures
  };
}

function buildScannerReport(projectReports, bricks) {
  const projects = projectReports.map((report) => ({
    project: report.project,
    readiness: report.readiness,
    boundary_report: {
      import_scan_count: report.boundary_report.import_scan_count,
      same_group_internal_import_count: report.boundary_report.same_group_internal_import_count,
      private_cross_brick_import_count: report.boundary_report.private_cross_brick_import_count,
      cross_brick_owned_import_count: report.boundary_report.cross_brick_owned_import_count,
      unresolved_local_import_count: report.boundary_report.unresolved_local_import_count,
      unowned_local_dependency_count: report.boundary_report.unowned_local_dependency_count
    },
    clone_preflight: report.clone_preflight.counts,
    manifest_drift: {
      count: report.manifest_drift.count
    },
    env_contract_report: {
      observed_reference_count: report.env_contract_report.observed_reference_count,
      undeclared_reference_count: report.env_contract_report.undeclared_reference_count,
      bricks_with_undeclared_refs: report.env_contract_report.bricks_with_undeclared_refs
    },
    compliance_report: {
      score: report.compliance_report?.score || 0,
      grade: report.compliance_report?.grade || "F",
      trackable_brick_count: report.compliance_report?.trackable_brick_count || 0,
      weakest_dimensions: report.compliance_report?.weakest_dimensions || []
    },
    code_quality_report: {
      score: report.code_quality_report?.score || 0,
      grade: report.code_quality_report?.grade || "F",
      analyzed_code_file_count: report.code_quality_report?.analyzed_code_file_count || 0,
      hotspot_file_count: report.code_quality_report?.hotspot_file_count || 0,
      brick_hotspot_count: report.code_quality_report?.brick_hotspot_count || 0,
      duplicate_cluster_count: report.code_quality_report?.duplicate_cluster_count || 0,
      total_smell_count: report.code_quality_report?.total_smell_count || 0,
      weighted_smell_score: report.code_quality_report?.weighted_smell_score || 0,
      by_type: report.code_quality_report?.by_type || {}
    },
    build_report: {
      candidate_count: report.build_report?.candidate_count || 0,
      detected_brick_count: report.build_report?.detected_brick_count || 0,
      average_confidence_score: report.build_report?.average_confidence_score || 0,
      recurrent_candidate_count: report.build_report?.recurrent_candidate_count || 0
    },
    remediation_report: {
      counts: report.remediation_report?.counts || {},
      top_actions: report.remediation_report?.top_actions || [],
      quality_queue: report.remediation_report?.quality_queue || []
    },
    token_economics: {
      raw_source_tokens: report.token_economics.raw_source_tokens,
      estimated_summary_tokens: report.token_economics.estimated_summary_tokens,
      compact_card_coverage_rate: report.token_economics.compact_card_coverage_rate,
      estimated_reduction_percent: report.token_economics.estimated_reduction_percent
    }
  })).sort((a, b) => a.project.localeCompare(b.project));

  const topViolations = projectReports
    .flatMap((report) => report.boundary_report.top_violations)
    .slice(0, 120);
  const highRiskBricks = projectReports
    .flatMap((report) => report.clone_preflight.highest_risk_bricks)
    .sort((a, b) => b.blocker_codes.length - a.blocker_codes.length || b.warning_codes.length - a.warning_codes.length || b.raw_source_tokens - a.raw_source_tokens)
    .slice(0, 120);
  const envGapBricks = projectReports
    .flatMap((report) => report.env_contract_report?.highest_gap_bricks || []);
  const driftEntries = projectReports
    .flatMap((report) => report.manifest_drift.entries)
    .slice(0, 160);
  const codeQualityHotspots = projectReports
    .flatMap((report) => report.code_quality_report?.top_hotspots || []);
  const uniqueCodeQualityHotspots = dedupeQualityHotspots(codeQualityHotspots);
  const codeQualityBricks = projectReports
    .flatMap((report) => report.code_quality_report?.highest_risk_bricks || []);
  const codeQualityDuplicateGroups = projectReports
    .flatMap((report) => report.code_quality_report?.duplicate_groups || []);
  const tokenHeavyBricks = projectReports
    .flatMap((report) => report.token_economics.top_token_heavy_bricks)
    .sort((a, b) => b.raw_source_tokens - a.raw_source_tokens || a.path.localeCompare(b.path))
    .slice(0, 80);
  const duplicateClusters = buildDuplicateClusters(bricks);
  const buildReport = finalizeMergedBuildReport({
    candidate_signatures: projectReports.flatMap((report) => report.build_report?.candidate_signatures || []),
    top_candidates: projectReports.flatMap((report) => report.build_report?.top_candidates || []),
    signal_type_counts: projectReports.reduce((counts, report) => ({
      feature: counts.feature + (report.build_report?.signal_type_counts?.feature || 0),
      domain: counts.domain + (report.build_report?.signal_type_counts?.domain || 0),
      path: counts.path + (report.build_report?.signal_type_counts?.path || 0),
      group: counts.group + (report.build_report?.signal_type_counts?.group || 0)
    }), { feature: 0, domain: 0, path: 0, group: 0 }),
    detected_brick_count: projectReports.reduce((sum, report) => sum + (report.build_report?.detected_brick_count || 0), 0),
    projects: projectReports.map((report) => ({
      project: report.project,
      candidate_count: report.build_report?.candidate_count || 0,
      detected_brick_count: report.build_report?.detected_brick_count || 0,
      average_confidence_score: report.build_report?.average_confidence_score || 0,
      signal_type_counts: report.build_report?.signal_type_counts || { feature: 0, domain: 0, path: 0, group: 0 },
      candidate_signatures: report.build_report?.candidate_signatures || []
    }))
  });
  const mergedEnvNames = new Map();
  const mergedDeclaredEnvNames = new Set();
  const mergedObservedEnvNames = new Set();
  const mergedIgnoredEnvNames = new Set();
  const complianceReport = emptyComplianceReport();
  const remediationCounts = {
    env_contract: 0,
    rls_contract: 0,
    boundary: 0,
    quality: 0
  };
  const mergedCodeQualityCounts = emptyCodeQualityCounts();

  for (const report of projectReports) {
    for (const entry of report.env_contract_report?.top_undeclared_refs || []) {
      const current = mergedEnvNames.get(entry.name) || {
        name: entry.name,
        brick_count: 0,
        sample_bricks: new Set()
      };

      current.brick_count += entry.brick_count || 0;

      for (const brickId of entry.sample_bricks || []) {
        current.sample_bricks.add(brickId);
      }

      mergedEnvNames.set(entry.name, current);
    }
  }

  for (const report of projectReports) {
    for (const name of report.env_contract_report?.observed_variable_names || []) {
      mergedObservedEnvNames.add(name);
    }

    for (const name of report.env_contract_report?.ignored_variable_names || []) {
      mergedIgnoredEnvNames.add(name);
    }
  }

  for (const brick of bricks) {
    for (const entry of brick.env_contract?.variables || []) {
      if (entry?.name) {
        mergedDeclaredEnvNames.add(entry.name);
      }
    }
  }

  for (const report of projectReports) {
    complianceReport.trackable_brick_count += report.compliance_report?.trackable_brick_count || 0;
    complianceReport.highest_gap_bricks.push(...(report.compliance_report?.highest_gap_bricks || []));

    for (const definition of complianceDimensionDefinitions) {
      const current = report.compliance_report?.dimensions?.[definition.key];

      if (!current) {
        continue;
      }

      complianceReport.dimensions[definition.key].ready_count += current.ready_count || 0;
      complianceReport.dimensions[definition.key].coverage_units += current.coverage_units ?? current.ready_count ?? 0;
      complianceReport.dimensions[definition.key].total_count += current.total_count || 0;
    }

    remediationCounts.env_contract += report.remediation_report?.counts?.env_contract || 0;
    remediationCounts.rls_contract += report.remediation_report?.counts?.rls_contract || 0;
    remediationCounts.boundary += report.remediation_report?.counts?.boundary || 0;
    remediationCounts.quality += report.remediation_report?.counts?.quality || 0;
    mergeCodeQualityCounts(mergedCodeQualityCounts, report.code_quality_report?.by_type || {});
  }

  const averageReadiness = projects.length
    ? Math.round(projects.reduce((sum, project) => sum + (project.readiness?.score || 0), 0) / projects.length)
    : 0;
  const finalizedComplianceReport = finalizeComplianceReport(complianceReport);
  const remediationActions = projectReports
    .flatMap((report) => report.remediation_report?.top_actions || [])
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 120);
  const remediationEnvQueue = projectReports
    .flatMap((report) => report.remediation_report?.env_contract_queue || [])
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 80);
  const remediationRlsQueue = projectReports
    .flatMap((report) => report.remediation_report?.rls_contract_queue || [])
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 80);
  const remediationBoundaryQueue = projectReports
    .flatMap((report) => report.remediation_report?.boundary_queue || [])
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 80);
  const remediationQualityQueue = projectReports
    .flatMap((report) => report.remediation_report?.quality_queue || [])
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 80);
  const codeQualityWeight = projectReports.reduce(
    (sum, report) => sum + Number(report.code_quality_report?.analyzed_code_file_count || 0),
    0
  );
  const weightedCodeQualityScore = codeQualityWeight > 0
    ? Math.round(
      projectReports.reduce(
        (sum, report) => sum + (Number(report.code_quality_report?.score || 0) * Number(report.code_quality_report?.analyzed_code_file_count || 0)),
        0
      ) / codeQualityWeight
    )
    : (projects.length
      ? Math.round(projects.reduce((sum, project) => sum + (project.code_quality_report?.score || 0), 0) / projects.length)
      : 0);

  return {
    readiness: {
      average_score: averageReadiness,
      average_grade: gradeForScore(averageReadiness),
      projects
    },
    boundary_report: {
      import_scan_count: projectReports.reduce((sum, report) => sum + (report.boundary_report.import_scan_count || 0), 0),
      same_group_internal_import_count: projectReports.reduce((sum, report) => sum + (report.boundary_report.same_group_internal_import_count || 0), 0),
      private_cross_brick_import_count: projectReports.reduce((sum, report) => sum + (report.boundary_report.private_cross_brick_import_count || 0), 0),
      cross_brick_owned_import_count: projectReports.reduce((sum, report) => sum + (report.boundary_report.cross_brick_owned_import_count || 0), 0),
      unresolved_local_import_count: projectReports.reduce((sum, report) => sum + (report.boundary_report.unresolved_local_import_count || 0), 0),
      unowned_local_dependency_count: projectReports.reduce((sum, report) => sum + (report.boundary_report.unowned_local_dependency_count || 0), 0),
      top_violations: topViolations
    },
    clone_preflight: {
      counts: projectReports.reduce((counts, report) => ({
        copy_ready: counts.copy_ready + (report.clone_preflight.counts.copy_ready || 0),
        guided: counts.guided + (report.clone_preflight.counts.guided || 0),
        manual_review: counts.manual_review + (report.clone_preflight.counts.manual_review || 0),
        blocked: counts.blocked + (report.clone_preflight.counts.blocked || 0)
      }), { copy_ready: 0, guided: 0, manual_review: 0, blocked: 0 }),
      highest_risk_bricks: highRiskBricks
    },
    manifest_drift: {
      count: projectReports.reduce((sum, report) => sum + (report.manifest_drift.count || 0), 0),
      by_type: Object.fromEntries(countBy(driftEntries, (entry) => entry.kind)),
      entries: driftEntries
    },
    code_quality_report: {
      average_score: weightedCodeQualityScore,
      average_grade: gradeForScore(weightedCodeQualityScore),
      analyzed_code_file_count: projectReports.reduce((sum, report) => sum + (report.code_quality_report?.analyzed_code_file_count || 0), 0),
      hotspot_file_count: projectReports.reduce((sum, report) => sum + (report.code_quality_report?.hotspot_file_count || 0), 0),
      brick_hotspot_count: projectReports.reduce((sum, report) => sum + (report.code_quality_report?.brick_hotspot_count || 0), 0),
      duplicate_cluster_count: projectReports.reduce((sum, report) => sum + (report.code_quality_report?.duplicate_cluster_count || 0), 0),
      total_smell_count: projectReports.reduce((sum, report) => sum + (report.code_quality_report?.total_smell_count || 0), 0),
      weighted_smell_score: projectReports.reduce((sum, report) => sum + (report.code_quality_report?.weighted_smell_score || 0), 0),
      by_type: compactCodeQualityCounts(mergedCodeQualityCounts),
      top_hotspots: uniqueCodeQualityHotspots
        .sort((a, b) => (b.smell_score || 0) - (a.smell_score || 0) || (b.total_matches || 0) - (a.total_matches || 0) || String(a.path).localeCompare(String(b.path)))
        .slice(0, 120),
      highest_risk_bricks: codeQualityBricks
        .sort((a, b) => (b.smell_score || 0) - (a.smell_score || 0) || (b.total_matches || 0) - (a.total_matches || 0) || String(a.path).localeCompare(String(b.path)))
        .slice(0, 80),
      duplicate_groups: codeQualityDuplicateGroups
        .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || Number(b.file_count || 0) - Number(a.file_count || 0) || String(a.path).localeCompare(String(b.path)))
        .slice(0, 80)
    },
    env_contract_report: {
      observed_reference_count: projectReports.reduce((sum, report) => sum + (report.env_contract_report?.observed_reference_count || 0), 0),
      observed_variable_count: mergedObservedEnvNames.size,
      observed_variable_names: [...mergedObservedEnvNames].sort(),
      ignored_reference_count: projectReports.reduce((sum, report) => sum + (report.env_contract_report?.ignored_reference_count || 0), 0),
      ignored_variable_count: mergedIgnoredEnvNames.size,
      ignored_variable_names: [...mergedIgnoredEnvNames].sort(),
      declared_variable_count: mergedDeclaredEnvNames.size,
      undeclared_reference_count: projectReports.reduce((sum, report) => sum + (report.env_contract_report?.undeclared_reference_count || 0), 0),
      bricks_with_undeclared_refs: projectReports.reduce((sum, report) => sum + (report.env_contract_report?.bricks_with_undeclared_refs || 0), 0),
      top_undeclared_refs: [...mergedEnvNames.values()]
        .sort((a, b) => b.brick_count - a.brick_count || a.name.localeCompare(b.name))
        .slice(0, 24)
        .map((entry) => ({
          name: entry.name,
          brick_count: entry.brick_count,
          sample_bricks: [...entry.sample_bricks].sort().slice(0, 6)
        })),
      highest_gap_bricks: envGapBricks
        .sort((a, b) => (b.undeclared_env_refs?.length || 0) - (a.undeclared_env_refs?.length || 0) || String(a.path).localeCompare(String(b.path)))
        .slice(0, 80)
    },
    compliance_report: {
      average_score: finalizedComplianceReport.score,
      average_grade: finalizedComplianceReport.grade,
      trackable_brick_count: finalizedComplianceReport.trackable_brick_count,
      dimensions: finalizedComplianceReport.dimensions,
      weakest_dimensions: finalizedComplianceReport.weakest_dimensions,
      highest_gap_bricks: finalizedComplianceReport.highest_gap_bricks
    },
    build_report: buildReport,
    remediation_report: {
      counts: remediationCounts,
      env_contract_queue: remediationEnvQueue,
      rls_contract_queue: remediationRlsQueue,
      boundary_queue: remediationBoundaryQueue,
      quality_queue: remediationQualityQueue,
      top_actions: remediationActions,
      project_action_plans: remediationActionProjectPlans(remediationActions)
    },
    duplicate_clusters: duplicateClusters,
    token_economics: {
      raw_source_tokens: projectReports.reduce((sum, report) => sum + (report.token_economics.raw_source_tokens || 0), 0),
      estimated_summary_tokens: projectReports.reduce((sum, report) => sum + (report.token_economics.estimated_summary_tokens || 0), 0),
      compact_card_tokens: projectReports.reduce((sum, report) => sum + (report.token_economics.compact_card_tokens || 0), 0),
      compact_card_coverage_count: projectReports.reduce((sum, report) => sum + (report.token_economics.compact_card_coverage_count || 0), 0),
      top_token_heavy_bricks: tokenHeavyBricks
    }
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  activeExcludedRoots = [...new Set((options.excludeRoots || []).map((root) => path.resolve(root)).filter((root) => root !== path.resolve(options.root)))];

  if (!(await pathExists(options.root))) {
    throw new Error(`Scan root does not exist: ${options.root}`);
  }

  const bricks = [];
  const failures = [];
  const validationFailures = [];
  const unmanifested = [];
  const projects = [];
  const projectRefactorReports = [];
  const projectScannerReports = [];
  const compactCardIndex = await loadCompactCardIndex();
  const projectRoots = await discoverProjectRoots(options.root, options.projectId);

  for (const projectRoot of projectRoots) {
    const manifestPaths = await walk(projectRoot.root);
    const projectUnmanifested = await discoverPotentialBricks(projectRoot.root, projectRoot.root, [], projectRoot.id);
    const projectBricks = [];

    unmanifested.push(...projectUnmanifested);

    for (const manifestPath of manifestPaths) {
      try {
        const manifest = await readManifest(manifestPath);
        const validation = validateManifest(manifestPath, manifest);
        if (validation.errors.length > 0) validationFailures.push({ manifest_path: manifestPath, brick_id: validation.brick_id, errors: validation.errors });
        const brick = compactBrick(projectRoot.root, manifestPath, manifest, validation, projectRoot.id);
        bricks.push(brick);
        projectBricks.push(brick);
      } catch (error) {
        failures.push({
          manifest_path: manifestPath,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const [projectSummary] = projectHealth(projectRoot.root, projectBricks, projectUnmanifested, projectRoot.id);
    const projectRefactorReport = await analyzeProjectRefactorOpportunities(projectRoot.root, projectRoot.id, projectBricks);
    const projectScannerReport = await analyzeProjectScannerReport(projectRoot.root, projectRoot.id, projectBricks, projectUnmanifested.length, compactCardIndex);

    projectRefactorReports.push(projectRefactorReport);
    projectScannerReports.push(projectScannerReport);
    projects.push({
      ...projectSummary,
      refactor: {
        analyzed_file_count: projectRefactorReport.analyzed_file_count,
        oversized_file_count: projectRefactorReport.oversized_file_count,
        split_opportunity_count: projectRefactorReport.split_opportunity_count,
        missing_source_path_count: projectRefactorReport.missing_source_path_count,
        analysis_failure_count: projectRefactorReport.analysis_failure_count,
        severity_counts: projectRefactorReport.severity_counts
      },
      scanner: {
        readiness: projectScannerReport.readiness,
        boundary_report: {
          same_group_internal_import_count: projectScannerReport.boundary_report.same_group_internal_import_count,
          private_cross_brick_import_count: projectScannerReport.boundary_report.private_cross_brick_import_count,
          cross_brick_owned_import_count: projectScannerReport.boundary_report.cross_brick_owned_import_count,
          unresolved_local_import_count: projectScannerReport.boundary_report.unresolved_local_import_count,
          unowned_local_dependency_count: projectScannerReport.boundary_report.unowned_local_dependency_count
        },
        clone_preflight: projectScannerReport.clone_preflight.counts,
        manifest_drift: {
          count: projectScannerReport.manifest_drift.count
        },
        code_quality_report: {
          score: projectScannerReport.code_quality_report.score,
          grade: projectScannerReport.code_quality_report.grade,
          analyzed_code_file_count: projectScannerReport.code_quality_report.analyzed_code_file_count,
          hotspot_file_count: projectScannerReport.code_quality_report.hotspot_file_count,
          brick_hotspot_count: projectScannerReport.code_quality_report.brick_hotspot_count,
          duplicate_cluster_count: projectScannerReport.code_quality_report.duplicate_cluster_count,
          total_smell_count: projectScannerReport.code_quality_report.total_smell_count,
          weighted_smell_score: projectScannerReport.code_quality_report.weighted_smell_score,
          by_type: projectScannerReport.code_quality_report.by_type
        },
        env_contract_report: {
          observed_reference_count: projectScannerReport.env_contract_report.observed_reference_count,
          undeclared_reference_count: projectScannerReport.env_contract_report.undeclared_reference_count,
          bricks_with_undeclared_refs: projectScannerReport.env_contract_report.bricks_with_undeclared_refs
        },
        compliance_report: {
          score: projectScannerReport.compliance_report.score,
          grade: projectScannerReport.compliance_report.grade,
          trackable_brick_count: projectScannerReport.compliance_report.trackable_brick_count,
          weakest_dimensions: projectScannerReport.compliance_report.weakest_dimensions
        },
        build_report: {
          candidate_count: projectScannerReport.build_report.candidate_count,
          detected_brick_count: projectScannerReport.build_report.detected_brick_count,
          average_confidence_score: projectScannerReport.build_report.average_confidence_score,
          recurrent_candidate_count: projectScannerReport.build_report.recurrent_candidate_count,
          signal_type_counts: projectScannerReport.build_report.signal_type_counts
        },
        remediation_report: {
          counts: projectScannerReport.remediation_report.counts
        },
        token_economics: {
          raw_source_tokens: projectScannerReport.token_economics.raw_source_tokens,
          estimated_summary_tokens: projectScannerReport.token_economics.estimated_summary_tokens,
          compact_card_coverage_rate: projectScannerReport.token_economics.compact_card_coverage_rate,
          estimated_reduction_percent: projectScannerReport.token_economics.estimated_reduction_percent
        }
      }
    });
  }

  const errorCount = bricks.reduce((sum, brick) => sum + brick.health.error_count, 0);
  const warningCount = bricks.reduce((sum, brick) => sum + brick.health.warning_count, 0);
  const groupedCandidates = candidateGroups(unmanifested);
  const refactorReport = buildRefactorReport(projectRefactorReports);
  const scannerReport = buildScannerReport(projectScannerReports, bricks);

  const output = {
    schema_version: "1.0.0",
    generated_at: new Date().toISOString(),
    scan_root: options.root,
    scan_project_id: options.projectId || null,
    excluded_roots: activeExcludedRoots,
    scanned_project_roots: projectRoots,
    projects,
    count: bricks.length,
    failure_count: failures.length,
    validation_error_count: errorCount,
    validation_warning_count: warningCount,
    unmanifested_count: unmanifested.length,
    candidate_group_count: groupedCandidates.length,
    refactor_report: refactorReport,
    scanner_report: scannerReport,
    bricks: bricks.sort((a, b) => a.id.localeCompare(b.id)),
    candidate_groups: groupedCandidates,
    unmanifested_bricks: unmanifested.sort((a, b) => a.path.localeCompare(b.path)),
    failures
  };

  if (failures.length > 0 || errorCount > 0) {
    const rejectedOut = `${options.out}.rejected.json`;
    await writeJsonIfMeaningfulChanged(rejectedOut, { schema_version: "1.0.0", generated_at: output.generated_at, registry_out: options.out,
      forced: options.force, failure_count: failures.length, validation_error_count: errorCount, failures, validation_failures: validationFailures },
    { normalize: normalizeRegistrySnapshot });
    console.error(`[sma-scan] ${options.force ? "WARN --force replaced registry despite manifest errors" : "ERROR manifest errors rejected registry replacement"}; report=${rejectedOut}`);
    if (!options.force) process.exit(options.check ? 1 : 2);
  }
  await writeJsonIfMeaningfulChanged(options.out, output, {
    normalize: normalizeRegistrySnapshot,
  });
  if (options.json) {
    console.log(JSON.stringify({
      count: bricks.length,
      failure_count: failures.length,
      validation_error_count: errorCount,
      validation_warning_count: warningCount,
      unmanifested_count: unmanifested.length,
      candidate_group_count: groupedCandidates.length,
      refactor_report: {
        analyzed_file_count: refactorReport.analyzed_file_count,
        oversized_file_count: refactorReport.oversized_file_count,
        split_opportunity_count: refactorReport.split_opportunity_count,
        refactor_queue_count: refactorReport.refactor_queue.length,
        missing_source_path_count: refactorReport.missing_source_path_count,
        analysis_failure_count: refactorReport.analysis_failure_count,
        severity_counts: refactorReport.severity_counts
      },
      scanner_report: {
        readiness: {
          average_score: scannerReport.readiness.average_score,
          average_grade: scannerReport.readiness.average_grade
        },
        boundary_report: {
          same_group_internal_import_count: scannerReport.boundary_report.same_group_internal_import_count,
          private_cross_brick_import_count: scannerReport.boundary_report.private_cross_brick_import_count,
          cross_brick_owned_import_count: scannerReport.boundary_report.cross_brick_owned_import_count,
          unresolved_local_import_count: scannerReport.boundary_report.unresolved_local_import_count,
          unowned_local_dependency_count: scannerReport.boundary_report.unowned_local_dependency_count
        },
        clone_preflight: scannerReport.clone_preflight.counts,
        manifest_drift: {
          count: scannerReport.manifest_drift.count
        },
        code_quality_report: {
          average_score: scannerReport.code_quality_report.average_score,
          average_grade: scannerReport.code_quality_report.average_grade,
          hotspot_file_count: scannerReport.code_quality_report.hotspot_file_count,
          duplicate_cluster_count: scannerReport.code_quality_report.duplicate_cluster_count,
          total_smell_count: scannerReport.code_quality_report.total_smell_count
        },
        env_contract_report: {
          undeclared_reference_count: scannerReport.env_contract_report.undeclared_reference_count,
          bricks_with_undeclared_refs: scannerReport.env_contract_report.bricks_with_undeclared_refs
        },
        compliance_report: {
          average_score: scannerReport.compliance_report.average_score,
          average_grade: scannerReport.compliance_report.average_grade,
          trackable_brick_count: scannerReport.compliance_report.trackable_brick_count
        },
        build_report: {
          candidate_count: scannerReport.build_report.candidate_count,
          detected_brick_count: scannerReport.build_report.detected_brick_count,
          recurrent_candidate_count: scannerReport.build_report.recurrent_candidate_count,
          recurrent_family_count: scannerReport.build_report.recurrent_family_count
        },
        remediation_report: scannerReport.remediation_report.counts,
        duplicate_cluster_count: scannerReport.duplicate_clusters.length,
        token_economics: {
          raw_source_tokens: scannerReport.token_economics.raw_source_tokens,
          estimated_summary_tokens: scannerReport.token_economics.estimated_summary_tokens,
          compact_card_tokens: scannerReport.token_economics.compact_card_tokens
        }
      },
      out: options.out
    }, null, 2));
  } else {
    console.log(`SMA scan complete: ${bricks.length} manifest brick(s), ${unmanifested.length} unmanifested candidate(s), ${groupedCandidates.length} candidate group(s), ${failures.length} failure(s), ${errorCount} validation error(s), ${warningCount} warning(s), ${refactorReport.oversized_file_count} oversized file(s), ${refactorReport.split_opportunity_count} split opportunity file(s), ${refactorReport.analysis_failure_count} refactor analysis failure(s), readiness ${scannerReport.readiness.average_score}/${scannerReport.readiness.average_grade}, compliance ${scannerReport.compliance_report.average_score}/${scannerReport.compliance_report.average_grade}, code quality ${scannerReport.code_quality_report.average_score}/${scannerReport.code_quality_report.average_grade}, ${scannerReport.code_quality_report.hotspot_file_count} quality hotspot file(s), ${scannerReport.build_report.candidate_count} build candidate(s), ${scannerReport.clone_preflight.counts.blocked} blocked clone candidate(s), ${scannerReport.env_contract_report.bricks_with_undeclared_refs} env-gap brick(s)`);
    console.log(`Wrote ${options.out}`);
  }

  if (options.check && options.strict && warningCount > 0 && !options.force) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
