#!/usr/bin/env node
/* eslint-disable complexity, max-lines-per-function -- Bootstrap assembly is an ordered manifest transaction; keeping derivation and validation together prevents partially initialized output. */
/**
 * WHAT: Generates reviewable starter manifests for scanner candidates that lack one.
 * WHY: Unmanifested modules cannot enter scoring and governance without an explicit initial contract.
 * HOW: Reads a scanner registry, inspects each candidate, infers conservative metadata, and defaults to dry run.
 * INPUTS: A registry path plus optional root, ownership, provenance, write, and overwrite settings.
 * OUTPUTS: A proposed report or, with the write switch, starter manifests and project indexes.
 * CALLERS: Portfolio onboarding operators run this after scanning a project with unmanifested candidates.
 * @example node tools/sma-bootstrap-manifests.ts --help
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { calculateScore } from "./sma-score.ts";

type FalsyValue = false | 0 | 0n | '' | null | undefined;
function orElse<T, U>(value: T, fallback: () => U): Exclude<T, FalsyValue> | U {
  if (!value) return fallback();
  return value as Exclude<T, FalsyValue>;
}

const defaults = {
  registry: "",
  root: "",
  owner: orElse(process.env.SMA_OWNER, () => "sma-operator"),
  team: "Sweetspot",
  provider: "openai",
  model: "gpt-5-codex",
  write: false,
  overwrite: false
};

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
  "test-results"
]);

const countableExtensions = new Set([
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".mjs",
  ".py",
  ".scss",
  ".sh",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);

interface BootstrapArgs {
  registry: string;
  root: string;
  owner: string;
  team: string;
  provider: string;
  model: string;
  write: boolean;
  overwrite: boolean;
}

interface Candidate {
  brick_group?: string;
  candidate_type?: string;
  file_brick?: boolean;
  hierarchy_role?: string;
  path: string;
  project?: string;
  relative_path?: string;
}

interface ExistingBrick {
  id: string;
  manifest_path?: string;
  score?: number;
  status: string;
}

interface BootstrapRegistry {
  bricks?: ExistingBrick[];
  projects?: { id?: string }[];
  scanned_project_roots?: { id?: string; root: string }[];
  unmanifested_bricks?: Candidate[];
}

interface PackageDocument {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  packageManager?: string;
  peerDependencies?: Record<string, string>;
}

interface SourceStats {
  extensions: string[];
  file_count: number;
  feature_lines: number;
  max_file_lines: number;
  over_600_count: number;
}

interface ClassificationInfo {
  data_classes: string[];
  risk: string;
  notes: string;
}

interface BootstrapContext {
  root: string;
  registryPath: string;
  projectId: string;
  packageJson: PackageDocument;
  repository: string;
  commit: string;
  timestamp: string;
  owner: string;
  team: string;
  provider: string;
  model: string;
}

interface ProjectIndexEntry {
  brick_id: string;
  manifest_path: string;
  status: string;
  score: number;
  notes: string;
}

function parseArgs(argv: string[]): BootstrapArgs {
  const options: BootstrapArgs = { ...defaults };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--registry" && next) {
      options.registry = path.resolve(next);
      i += 1;
    } else if (arg === "--root" && next) {
      options.root = path.resolve(next);
      i += 1;
    } else if (arg === "--owner" && next) {
      options.owner = next;
      i += 1;
    } else if (arg === "--team" && next) {
      options.team = next;
      i += 1;
    } else if (arg === "--provider" && next) {
      options.provider = next;
      i += 1;
    } else if (arg === "--model" && next) {
      options.model = next;
      i += 1;
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--overwrite") {
      options.overwrite = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!options.registry) {
    throw new Error("Missing --registry");
  }

  return options;
}

function printHelp(): void {
  console.log(`SMA manifest bootstrap

Usage:
  node tools/sma-bootstrap-manifests.ts \\
    --registry scans/acme-studio/latest.registry.json \\
    --write

Options:
  --registry   Scanner registry JSON with unmanifested candidates
  --root       Project root override. Defaults to the single scanned project root
  --owner      Manifest owner.primary
  --team       Manifest owner.team
  --provider   AI provenance provider
  --model      AI provenance model
  --write      Write files. Without this, the tool reports a dry run
  --overwrite  Replace existing module.sweetspot.json files
`);
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(target: string): Promise<T | null>;
async function readJson<T>(target: string, fallback: T): Promise<T>;
async function readJson<T>(target: string, fallback: T | null = null): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(target, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function gitValue(root: string, args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  try {
    const result = await execFileAsync("git", args, { cwd: root });
    return result.stdout.trim();
  } catch {
    return "";
  }
}

function slug(value: unknown): string {
  return String(orElse(value, () => ""))
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/[-.]{2,}/g, "-");
}

function stableBrickId(projectId: string, candidate: Candidate): string {
  const type = slug(orElse(candidate.candidate_type, () => "brick")).replaceAll("_", "-");
  const relative = slug(orElse(candidate.relative_path, () => path.basename(candidate.path)));
  const hash = crypto.createHash("sha1").update(orElse(candidate.relative_path, () => candidate.path)).digest("hex").slice(0, 8);
  const prefix = slug(orElse(projectId || candidate.project, () => "project"));
  const base = `${prefix}.${type}.${relative}`;

  if (base.length <= 111) {
    return `${base}.${hash}`;
  }

  return `${base.slice(0, 111).replace(/[.-]+$/g, "")}.${hash}`;
}

function title(value: unknown): string {
  return String(orElse(value, () => "Brick"))
    .replace(/\.[^.]+$/g, "")
    .replace(/[-_./]+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function brickKind(candidate: Candidate) {
  const type = candidate.candidate_type;

  if (type === "app") {
    return "module_group";
  }

  if (["agent_skill", "test_suite"].includes(orElse(type, () => ""))) {
    return "tooling";
  }

  if (["supabase_function", "netlify_function", "netlify_edge_function", "runpod_worker"].includes(orElse(type, () => ""))) {
    return "adapter";
  }

  if (candidate.hierarchy_role === "module_candidate") {
    return "module";
  }

  return "module";
}

function hierarchy(candidate: Candidate) {
  const role = candidate.hierarchy_role;

  if (role === "brick_group_candidate") {
    return {
      level: "brick_group",
      group_id: candidate.brick_group,
      contains: ["brick", "module", "component", "service", "adapter"],
      component_policy: "internal_by_default",
      notes: "Bootstrap group manifest. Child bricks need their own manifests before reuse."
    };
  }

  if (role === "module_candidate") {
    return {
      level: "module",
      group_id: candidate.brick_group,
      contains: ["component", "service", "adapter", "hook", "utility", "file"],
      component_policy: "internal_by_default",
      notes: "Module inventory manifest. Promote to brick only when it is independently reusable."
    };
  }

  return {
    level: "brick",
    group_id: candidate.brick_group,
    contains: ["module", "component", "service", "adapter", "hook", "utility", "file"],
    component_policy: "internal_by_default",
    notes: "Bootstrap brick manifest. Gates must be proven before canonical status."
  };
}

async function walkFiles(dir: string, files: string[] = []): Promise<string[]> {
  let entries: import('node:fs').Dirent[] = [];

  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!excludedDirs.has(entry.name)) {
        await walkFiles(path.join(dir, entry.name), files);
      }
      continue;
    }

    if (entry.isFile() && entry.name !== "module.sweetspot.json") {
      files.push(path.join(dir, entry.name));
    }
  }

  return files;
}

async function lineStats(dir: string): Promise<SourceStats> {
  const files = await walkFiles(dir);
  let maxFileLines = 0;
  let over600Count = 0;
  let featureLines = 0;
  let sourceFileCount = 0;
  const extensions = new Set<string>();

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    extensions.add(ext);

    if (!countableExtensions.has(ext)) {
      continue;
    }

    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }

    if (stat.size > 2_000_000) {
      continue;
    }

    const lineCount = (await fs.readFile(file, "utf8")).split(/\r?\n/).length;
    sourceFileCount += 1;
    featureLines += lineCount;
    maxFileLines = Math.max(maxFileLines, lineCount);

    if (lineCount > 600) {
      over600Count += 1;
    }
  }

  return {
    extensions: [...extensions].sort(),
    file_count: sourceFileCount,
    feature_lines: featureLines,
    max_file_lines: maxFileLines,
    over_600_count: over600Count
  };
}

function languages(stats: SourceStats, candidate: Candidate): string[] {
  const values = new Set<string>();

  for (const ext of stats.extensions) {
    if (ext === ".ts") values.add("typescript");
    if (ext === ".tsx") values.add("tsx");
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") values.add("javascript");
    if (ext === ".jsx") values.add("jsx");
    if (ext === ".py") values.add("python");
    if (ext === ".sql") values.add("sql");
    if (ext === ".sh") values.add("shell");
    if (ext === ".md") values.add("markdown");
  }

  if (candidate.candidate_type === "supabase_function") {
    values.add("typescript");
    values.add("deno");
  }

  if (values.size === 0) {
    values.add("unknown");
  }

  return [...values].sort();
}

function frameworks(candidate: Candidate, packageJson: PackageDocument): string[] {
  const relative = orElse(candidate.relative_path, () => "");
  const deps = { ...(orElse(packageJson.dependencies, () => ({}))), ...(orElse(packageJson.devDependencies, () => ({}))) };
  const values = new Set<string>();

  if (relative.startsWith("apps/web/") || relative === "apps/web" || deps.react) values.add("react");
  if (deps.vite || relative.startsWith("apps/web/")) values.add("vite");
  if (relative.includes("supabase/functions")) values.add("supabase-edge-functions");
  if (relative.includes("netlify/functions")) values.add("netlify-functions");
  if (relative.includes("netlify/edge-functions")) values.add("netlify-edge-functions");
  if (relative.startsWith("runpod-workers/")) values.add("runpod");
  if (relative.startsWith("skills/") || relative.includes("/skills/")) values.add("agent-skill");

  return [...values].sort();
}

function domains(candidate: Candidate): string[] {
  const relative = orElse(candidate.relative_path, () => "");
  const parts = relative.split(/[/-]/).filter(Boolean);
  const values = new Set([orElse(candidate.candidate_type, () => "brick")]);

  for (const part of parts) {
    if (["apps", "web", "src", "components", "pages", "supabase", "functions", "packages"].includes(part)) {
      continue;
    }

    values.add(slug(part));
    if (values.size >= 5) break;
  }

  return [...values].filter(Boolean);
}

function classification(candidate: Candidate): ClassificationInfo {
  const value = `${orElse(candidate.relative_path, () => "")} ${orElse(candidate.candidate_type, () => "")}`.toLowerCase();
  const classes = new Set(["public"]);
  let risk = "low";
  const notes = "Bootstrap classification. Manual data-flow review required before promotion.";

  if (/billing|stripe|paypal|polar|checkout|subscription|payout|payment|invoice|financial/.test(value)) {
    classes.add("payment");
    classes.add("user_private");
    risk = "high";
  } else if (/auth|oauth|jwt|credential|secret|token|api-key|cookie|dpop|key/.test(value)) {
    classes.add("credential");
    classes.add("user_private");
    risk = "high";
  } else if (/admin|rls|security|gdpr|pii|redaction|vulnerability/.test(value)) {
    classes.add("admin_only");
    classes.add("pii");
    risk = "high";
  } else if (/user|profile|personal|health|meditation|sleep|biometric/.test(value)) {
    classes.add("user_private");
    risk = "medium";
  } else if (/supabase\/functions|netlify\/functions|runpod-workers/.test(value)) {
    classes.add("user_private");
    risk = "medium";
  }

  return {
    data_classes: [...classes],
    risk,
    notes
  };
}

function security(candidate: Candidate, classInfo: ClassificationInfo) {
  const value = `${orElse(candidate.relative_path, () => "")} ${orElse(candidate.candidate_type, () => "")}`.toLowerCase();
  const serverRuntime = /supabase\/functions|netlify\/functions|runpod-workers|packages\//.test(value);
  const privateData = classInfo.data_classes.some((item) => item !== "public");

  return {
    rls: {
      required: privateData && value.includes('supabase'),
      status: privateData && value.includes('supabase') ? "partial" : "not_applicable",
      negative_tests: []
    },
    env: {
      required: serverRuntime || /proxy|provider|oauth|api|credential|key|token|webhook/.test(value),
      status: serverRuntime || /proxy|provider|oauth|api|credential|key|token|webhook/.test(value) ? "partial" : "not_applicable",
      variables: []
    },
    vulnerability_findings: {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      report_paths: []
    }
  };
}

function gate(status: string, score: number, notes: string) {
  return { status, score, notes, evidence: [] };
}

function sweetspot(candidate: Candidate, classInfo: ClassificationInfo) {
  const ui = /apps\/web\/src|components|pages|features/.test(orElse(candidate.relative_path, () => ""));
  const data = classInfo.data_classes.some((item) => item !== "public");

  return {
    ssa_v2: gate("partial", 55, "Bootstrap boundary. Needs manual SSA-v2 review and minimum-responsible-code proof."),
    ssi: ui ? gate("partial", 45, "UI/runtime isolation needs explicit error/loading/access gates.") : gate("not_applicable", 100, "No UI runtime boundary detected."),
    sstf: gate("missing", 0, "Tests must be mapped before promotion."),
    spe: gate("missing", 0, "Performance budget must be measured before promotion."),
    srs: gate("partial", 35, "Observability and degradation path need review."),
    ssra: gate("partial", 35, "Release readiness is project-bound until gates are proven."),
    sas: gate("partial", 50, "Agent ownership can be derived from this manifest but needs review."),
    sva: gate("partial", 45, "Security scanner has not certified this brick."),
    srls: data ? gate("partial", 35, "RLS/access contract must be confirmed for private data.") : gate("not_applicable", 100, "No private data inferred by bootstrap."),
    sev: gate("partial", 45, "Env contract needs explicit variables if runtime secrets are used."),
    ssc: gate("partial", 50, "Supply-chain metadata is bootstrap-level."),
    sai: gate("partial", 60, "Model/tool provenance recorded for manifest generation.")
  };
}

async function publicPaths(candidatePath: string, relativePath: string): Promise<string[]> {
  const candidates = ["index.ts", "index.tsx", "index.js", "mod.ts", "package.json", "README.md"];
  const found: string[] = [];

  for (const name of candidates) {
    if (await pathExists(path.join(candidatePath, name))) {
      found.push(path.posix.join(relativePath, name));
    }
  }

  return found.length ? found : [relativePath];
}

async function packageDependencies(candidatePath: string) {
  const packageJson = await readJson<PackageDocument>(path.join(candidatePath, "package.json"), {});
  const deps = { ...(orElse(packageJson.dependencies, () => ({}))), ...(orElse(packageJson.peerDependencies, () => ({}))) };

  return Object.entries(deps).slice(0, 20).map(([name, version]) => ({
    name,
    version: version,
    purpose: "Declared package dependency.",
    risk: "unknown"
  }));
}

function codeBudgetStatus(stats: SourceStats): string {
  if (stats.over_600_count > 0 || stats.file_count > 30) {
    return "bloated";
  }

  if (stats.feature_lines <= 600 && stats.file_count <= 8) {
    return "lean";
  }

  return "acceptable";
}

function testCommand(candidate: Candidate): string {
  if (candidate.candidate_type === "test_suite") {
    return "pnpm test";
  }

  if ((orElse(candidate.relative_path, () => "")).startsWith("apps/web/")) {
    return "pnpm -C apps/web test";
  }

  return "pnpm test";
}

function clone(candidate: Candidate) {
  return {
    readiness: "manual_only",
    adaptation_points: [
      "Confirm imports and runtime providers.",
      "Confirm env variables and secrets.",
      "Confirm RLS/authz/data contracts when data is touched."
    ],
    install_steps: [
      `Copy ${String(candidate.relative_path)}.`,
      "Copy or adapt declared runtime dependencies.",
      "Run the verification commands and update this manifest."
    ],
    known_traps: [
      "Bootstrap manifest is not canonical proof.",
      "Do not copy secrets, local env files, generated caches, or project-only assumptions.",
      "Promote only after tests, security, RLS/env, and ownership are reviewed."
    ]
  };
}

function projectIndexEntry(
  manifest: { brick: { id: string; status: string }; quality: { score: number } },
  manifestPath: string,
  root: string,
): ProjectIndexEntry {
  return {
    brick_id: manifest.brick.id,
    manifest_path: path.relative(root, manifestPath).split(path.sep).join("/"),
    status: manifest.brick.status,
    score: manifest.quality.score,
    notes: "Bootstrap manifest generated from SMA scanner candidate."
  };
}

function existingProjectIndexEntry(brick: ExistingBrick & { manifest_path: string }, root: string): ProjectIndexEntry {
  return {
    brick_id: brick.id,
    manifest_path: path.relative(root, brick.manifest_path).split(path.sep).join("/"),
    status: brick.status,
    score: brick.score ?? 0,
    notes: "Existing manifest found by SMA scanner."
  };
}

async function buildManifest(candidate: Candidate, context: BootstrapContext) {
  const candidatePath = candidate.path;
  const relativePath = orElse(candidate.relative_path, () => path.relative(context.root, candidatePath).split(path.sep).join("/"));
  const stats = await lineStats(candidatePath);
  const classInfo = classification(candidate);
  const securityInfo = security(candidate, classInfo);
  const gates = sweetspot(candidate, classInfo);
  // File-level bricks get a sidecar manifest next to the file (<base>.module.sweetspot.json),
  // not a manifest *inside* the file. Directory bricks keep the original convention.
  let manifestPath;
  if (candidate.file_brick) {
    const dir = path.dirname(candidatePath);
    const base = path.basename(candidatePath).replace(/\.(t|j)sx?$/, "");
    manifestPath = path.join(dir, `${base}.module.sweetspot.json`);
  } else {
    manifestPath = path.join(candidatePath, "module.sweetspot.json");
  }
  const verificationCommand = `node ~/DEV/SMARCH/tools/sma-bootstrap-manifests.ts --registry ${context.registryPath} --write`;
  const dependencyList = await packageDependencies(candidatePath);
  const manifest = {
    schema_version: "1.0.0",
    brick: {
      id: stableBrickId(context.projectId, candidate),
      name: title(path.basename(candidatePath)),
      kind: brickKind(candidate),
      status: "project_bound",
      version: "0.1.0",
      language: languages(stats, candidate),
      frameworks: frameworks(candidate, context.packageJson),
      domain: domains(candidate)
    },
    hierarchy: hierarchy(candidate),
    source: {
      project: context.projectId,
      repository: context.repository,
      commit: context.commit,
      paths: [relativePath]
    },
    owner: {
      primary: context.owner,
      team: context.team,
      reviewers: []
    },
    boundaries: {
      owned_paths: [relativePath],
      public_paths: await publicPaths(candidatePath, relativePath),
      private_paths: [],
      forbidden_imports: [
        "client-side service-role keys",
        "undocumented cross-brick private imports",
        "unscoped privileged provider clients"
      ],
      allowed_side_effects: []
    },
    classification: classInfo,
    sweetspot: gates,
    interfaces: {
      public_api: await publicPaths(candidatePath, relativePath),
      adapters: [],
      forbidden_dependencies: ["direct-service-role-client"],
      required_dependencies: dependencyList.map((item) => item.name)
    },
    security: securityInfo,
    supply_chain: {
      dependencies: dependencyList,
      licenses: [],
      checksums: [],
      sbom_path: ""
    },
    quality: {
      score: 0,
      line_count: {
        max_file_lines: stats.max_file_lines,
        over_600_count: stats.over_600_count
      },
      code_budget: {
        status: codeBudgetStatus(stats),
        feature_lines: stats.feature_lines,
        file_count: stats.file_count,
        dependency_count: dependencyList.length,
        notes: "Bootstrap estimate from countable source/text files. Generated/vendor files need manual exceptions."
      },
      test_commands: [testCommand(candidate)],
      verification: [
        {
          command: testCommand(candidate),
          status: "skipped",
          timestamp: context.timestamp,
          notes: "Bootstrap manifest created before per-brick verification."
        }
      ]
    },
    clone: clone(candidate),
    provenance: {
      created_by: {
        actor_kind: "automation",
        actor_id: "sma-bootstrap-manifests",
        role: "scanner",
        timestamp: context.timestamp,
        summary: "Generated bootstrap manifest from scanner candidate."
      },
      touched_by: [
        {
          actor_kind: "ai_model",
          actor_id: "codex",
          provider: context.provider,
          model: context.model,
          role: "scanner",
          session_id: "local-codex-session",
          files_touched: [path.relative(context.root, manifestPath).split(path.sep).join("/")],
          verification: [
            {
              command: verificationCommand,
              status: "pass",
              timestamp: context.timestamp,
              notes: "Bootstrap generation completed; per-brick gates remain project-bound."
            }
          ],
          timestamp: context.timestamp,
          summary: "Created SMA bootstrap metadata and hierarchy placement.",
          attestation: {
            method: "scanner",
            reference: "sma-bootstrap-manifests"
          }
        }
      ],
      reviewed_by: [],
      source_chain: [
        {
          project: context.projectId,
          brick_id: stableBrickId(context.projectId, candidate),
          commit: context.commit,
          path: relativePath,
          event: "created",
          timestamp: context.timestamp
        }
      ]
    }
  };

  manifest.quality.score = calculateScore(manifest);
  return { manifest, manifestPath };
}

function resolveRoot(registry: BootstrapRegistry, options: BootstrapArgs): string {
  if (options.root) {
    return options.root;
  }

  const roots = orElse(registry.scanned_project_roots, () => []);

  if (roots.length === 1) {
    return roots[0].root;
  }

  throw new Error("Could not infer project root; pass --root");
}

function inferProjectId(registry: BootstrapRegistry, root: string): string {
  const match = (orElse(registry.scanned_project_roots, () => [])).find((item) => item.root === root);
  return orElse(orElse(match?.id, () => (registry.projects?.[0]?.id)), () => path.basename(root));
}

function inferProjectStack(packageJson: PackageDocument): string[] {
  const deps = { ...(orElse(packageJson.dependencies, () => ({}))), ...(orElse(packageJson.devDependencies, () => ({}))) };
  const stack = new Set(["sma"]);

  if (deps.react) stack.add("react");
  if (deps.vite) stack.add("vite");
  if (deps["@supabase/supabase-js"]) stack.add("supabase");
  if (deps["@netlify/functions"]) stack.add("netlify");
  if (deps.typescript || deps["@types/node"]) stack.add("typescript");
  if (packageJson.packageManager) stack.add(packageJson.packageManager.split("@")[0]);

  return [...stack].sort();
}

async function writeProjectFiles(
  context: BootstrapContext,
  modules: ProjectIndexEntry[],
  options: BootstrapArgs,
): Promise<void> {
  const sweetspotDir = path.join(context.root, ".sweetspot");
  const scansDir = path.join(sweetspotDir, "scans");
  const projectFile = path.join(sweetspotDir, "project.json");
  const modulesFile = path.join(sweetspotDir, "modules.json");
  const latestScanFile = path.join(scansDir, "latest.registry.json");
  const projectJson = {
    schema_version: "1.0.0",
    project: {
      id: context.projectId,
      name: orElse(context.packageJson.name, () => context.projectId),
      root: context.root,
      repository: context.repository,
      commit: context.commit,
      stack: inferProjectStack(context.packageJson)
    },
    sma: {
      status: "bootstrap",
      generated_at: context.timestamp,
      manifest_policy: "Every scanner candidate gets a project_bound manifest before promotion.",
      hierarchy: "Workspace > Project > Brick Group > Brick > Module > Submodule > Component/Service/Adapter/Hook/Utility > File"
    }
  };
  const modulesJson = {
    schema_version: "1.0.0",
    project: projectJson.project,
    modules
  };

  if (!options.write) {
    return;
  }

  await fs.mkdir(scansDir, { recursive: true });
  await fs.writeFile(projectFile, `${JSON.stringify(projectJson, null, 2)}\n`);
  await fs.writeFile(modulesFile, `${JSON.stringify(modulesJson, null, 2)}\n`);
  await fs.copyFile(context.registryPath, latestScanFile);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const registry = await readJson<BootstrapRegistry>(options.registry);

  if (!registry) {
    throw new Error(`Could not read registry: ${options.registry}`);
  }

  const root = resolveRoot(registry, options);
  const packageJson = await readJson<PackageDocument>(path.join(root, "package.json"), {});
  const context = {
    root,
    registryPath: options.registry,
    projectId: inferProjectId(registry, root),
    packageJson,
    repository: await gitValue(root, ["config", "--get", "remote.origin.url"]),
    commit: await gitValue(root, ["rev-parse", "HEAD"]),
    timestamp: new Date().toISOString(),
    owner: options.owner,
    team: options.team,
    provider: options.provider,
    model: options.model
  };
  const candidates = orElse(registry.unmanifested_bricks, () => []);
  const modules: ProjectIndexEntry[] = [];
  const modulePaths = new Set<string>();
  let written = 0;
  let skipped = 0;

  for (const brick of orElse(registry.bricks, () => [])) {
    if (!brick.manifest_path) {
      continue;
    }

    const relativeManifestPath = path.relative(root, brick.manifest_path).split(path.sep).join("/");
    modulePaths.add(relativeManifestPath);
    modules.push(existingProjectIndexEntry({ ...brick, manifest_path: brick.manifest_path }, root));
  }

  for (const candidate of candidates) {
    const { manifest, manifestPath } = await buildManifest(candidate, context);
    const relativeManifestPath = path.relative(root, manifestPath).split(path.sep).join("/");

    if (await pathExists(manifestPath) && !options.overwrite) {
      skipped += 1;
      if (!modulePaths.has(relativeManifestPath)) {
        modules.push(projectIndexEntry(manifest, manifestPath, root));
        modulePaths.add(relativeManifestPath);
      }
      continue;
    }

    if (options.write) {
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }

    written += 1;
    if (!modulePaths.has(relativeManifestPath)) {
      modules.push(projectIndexEntry(manifest, manifestPath, root));
      modulePaths.add(relativeManifestPath);
    }
  }

  await writeProjectFiles(context, modules.sort((a, b) => a.brick_id.localeCompare(b.brick_id)), options);

  console.log(JSON.stringify({
    mode: options.write ? "write" : "dry-run",
    project: context.projectId,
    root,
    candidates: candidates.length,
    written,
    skipped,
    project_files: options.write ? [
      path.join(root, ".sweetspot", "project.json"),
      path.join(root, ".sweetspot", "modules.json"),
      path.join(root, ".sweetspot", "scans", "latest.registry.json")
    ] : []
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
