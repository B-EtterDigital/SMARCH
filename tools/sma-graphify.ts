#!/usr/bin/env node
/* Defensive external-input guards and JavaScript coercion semantics are intentional in this behavior-preserving strict-type pass. */
/* eslint @typescript-eslint/no-unnecessary-boolean-literal-compare: "off", @typescript-eslint/no-unnecessary-condition: "off", @typescript-eslint/no-useless-default-assignment: "off", @typescript-eslint/prefer-nullish-coalescing: "off", @typescript-eslint/array-type: "off", max-lines-per-function: "off", complexity: "off", @typescript-eslint/prefer-optional-chain: "off", @typescript-eslint/no-base-to-string: "off", @typescript-eslint/no-unnecessary-type-conversion: "off", @typescript-eslint/restrict-template-expressions: "off", @typescript-eslint/use-unknown-in-catch-callback-variable: "off" */
/**
 * WHAT: Manages project and module code graphs for structural retrieval.
 * WHY: Agents need bounded architectural context without repeatedly scanning entire repositories.
 * HOW: Resolves graph targets and delegates checks, refreshes, queries, paths, and explanations.
 * INPUTS: A subcommand plus project, module, registry, graph, and query options.
 * OUTPUTS: Graph artifacts, readiness reports, or focused query and path results.
 * CALLERS: Agents, controller checks, graph repair packets, and portfolio refresh workflows.
 * Usage: `node tools/sma-graphify.ts query --project sma -- "lease ownership flow"`
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_ABSOLUTE_OVERRIDES } from "./lib/context-log.ts";
import { buildEmbeddingIndex, selftestEmbeddingContentAddress, semanticRerankQuery } from "./lib/graph-embeddings.ts";
import { queryGlobalGraph, selftestGlobalQuery } from "./lib/graph-global.mjs";
import { communitySummaryBlock, generateCommunitySummaries, selftestCommunitySummaries } from "./lib/graph-summaries.mjs";
import { sourceFreshness } from "./lib/graph-staleness.ts";
import { mergeNamespacedGraphs, namespaceGraph, resolveGraphNodeInput } from "./lib/graph-union.ts";

interface GraphifyOptions {
  command: string; rest: string[]; json: boolean; strict: boolean; staleOk: boolean; global: boolean; noCluster: boolean; missingOnly: boolean; quiet: boolean; verbose: boolean; semantic: boolean; semanticRank: boolean; timeoutSeconds: number | null; budget: string; registry: string; summaryJson?: boolean; limit?: number; help?: boolean; project?: string; module?: string; projectRoot?: string; as?: string; tags?: string; gen3Config?: Gen3Config | null;
}
interface GraphifyRuntimeOptions {
  cwd?: string; stdio?: "inherit" | "pipe";
  timeoutSeconds?: number | null; noCluster?: boolean; quiet?: boolean;
}
interface RegistryProject { id?: string; project_id?: string; name?: string; root?: string; project_root?: string; path?: string }
interface RegistryBrick { id?: string; name?: string; project?: string; kind?: string; brick_group?: string; manifest_path?: string; source_paths?: string[]; owned_paths?: string[] }
interface RegistryDocument { projects?: RegistryProject[]; scanned_project_roots?: RegistryProject[]; bricks?: RegistryBrick[] }
interface RegistrySource { path: string; registry: RegistryDocument }
interface Gen3Module { id?: string; label?: string; paths?: string[] }
interface Gen3Config { modules?: Gen3Module[]; [key: string]: unknown }
interface ModuleTarget { id: string; name: string; project: string; root: string; scanRoot: string; sourceKind: string; sourcePath: string }
interface GraphStatus {
  ok: boolean; graphifyAvailable: boolean; graphify: string; projectRoot: string; sourceRoot: string; sourceExists: boolean; targetRoot: string; targetExists: boolean; targetCandidates: { path: string; score: number; reason: string }[]; graphRoot: string; module: ModuleTarget | null; projectTag: string; graphPath: string; graphExists: boolean; graphReady: boolean; graphFreshness: unknown; graphFresh: boolean | null; graphStale: boolean; sourceUpdatedAt: string | null; sourceGlobs: string[]; graphKnownEmpty: boolean; graphEmptyReason: string; graphReadable: boolean; nodeCount: number; edgeCount: number; graphUpdatedAt: string | null; reportPath: string; reportExists: boolean; reportUpdatedAt: string | null;
}
interface SpawnOutcome { status: number; stdout: string; stderr: string; signal: string; timedOut: boolean; message: string }
const smaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultRegistry = path.join(smaRoot, "registry", "global-modules.generated.json");
const portfolioRegistry = path.join(smaRoot, "scans", "all-projects", "latest.registry.json");
const DEFAULT_GRAPHIFY_MAX_GRAPH_BYTES = 512 * 1024 * 1024;

function parseArgs(argv: string[]): GraphifyOptions {
  const options: GraphifyOptions = {
    command: "", rest: [],
    json: false, strict: false, staleOk: false, global: false,
    noCluster: false, missingOnly: false, quiet: false, verbose: false,
    semantic: false, semanticRank: true,
    timeoutSeconds: null, budget: "2000", registry: defaultRegistry,
  };

  const args = [...argv];
  options.command = args.shift() || "help";

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === "--") {
      options.rest.push(...args.slice(i + 1));
      break;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--summary-json") {
      options.summaryJson = true;
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--stale-ok") {
      options.staleOk = true;
    } else if (arg === "--global") {
      options.global = true;
    } else if (arg === "--no-cluster") {
      options.noCluster = true;
    } else if (arg === "--missing-only") {
      options.missingOnly = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--semantic") {
      options.semantic = true;
    } else if (arg === "--no-semantic-rank") {
      options.semanticRank = false;
    } else if (arg === "--limit" && next) {
      options.limit = Number(next);
      i += 1;
    } else if (arg === "--timeout-seconds" && next) {
      const value = Number(next);
      if (!Number.isFinite(value) || value <= 0) throw new Error("--timeout-seconds must be a positive number");
      options.timeoutSeconds = value;
      i += 1;
    } else if (arg === "--project" && next) {
      options.project = next;
      i += 1;
    } else if (arg === "--module" && next) {
      options.module = next;
      i += 1;
    } else if (arg === "--brick" && next) {
      options.module = next;
      i += 1;
    } else if (arg === "--project-root" && next) {
      options.projectRoot = next;
      i += 1;
    } else if (arg === "--registry" && next) {
      options.registry = next;
      i += 1;
    } else if (arg === "--as" && next) {
      options.as = next;
      i += 1;
    } else if (arg === "--tags" && next) {
      options.tags = next;
      i += 1;
    } else if (arg === "--budget" && next) {
      options.budget = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      options.rest.push(arg);
    }
  }

  return options;
}

function printHelp() {
  console.log(`SMA Graphify bridge

Usage:
  node tools/sma-graphify.ts check [--project <id>|--project-root <path>] [--strict] [--stale-ok] [--json]
  node tools/sma-graphify.ts check-modules [--project <id>|--project-root <path>] [--strict] [--stale-ok] [--json|--summary-json] [--verbose]
  node tools/sma-graphify.ts check [--project <id>] [--module <id-or-name>] [--strict] [--stale-ok] [--json]
  node tools/sma-graphify.ts refresh [--project <id>|--project-root <path>] [--module <id-or-name>] [--global] [--as <tag>] [--no-cluster] [--semantic] [--timeout-seconds N]
  node tools/sma-graphify.ts refresh-modules [--project <id>|--project-root <path>] [--global] [--no-cluster] [--missing-only] [--limit N] [--quiet] [--semantic] [--timeout-seconds N]
  node tools/sma-graphify.ts project-from-modules [--project <id>|--project-root <path>] [--global]
  node tools/sma-graphify.ts target-fixes [--project <id>|--project-root <path>] [--json]
  node tools/sma-graphify.ts embedding-index [--project <id>|--project-root <path>] [--module <id-or-name>]
  node tools/sma-graphify.ts query [--project <id>|--project-root <path>] [--module <id-or-name>] [--budget 1500] [--no-semantic-rank] -- "question"
  node tools/sma-graphify.ts path [--project <id>|--project-root <path>] [--module <id-or-name>] -- "A" "B"
  node tools/sma-graphify.ts explain [--project <id>|--project-root <path>] [--module <id-or-name>] -- "Node"
  node tools/sma-graphify.ts global list
  node tools/sma-graphify.ts global path
  node tools/sma-graphify.ts global query "question" [--tags a,b] [--budget N]
  node tools/sma-graphify.ts selftest

Project lookup reads registry/global-modules.generated.json plus the merged portfolio registry by default.
Use --project sma for the $SMARCH_DIR control-plane graph.
Refresh defaults to local code-only extraction. Pass --semantic to opt into
Graphify's semantic extraction/enrichment path.`);
}

// The caller supplies the schema-specific result type at each JSON boundary.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function knownRegistries(options: GraphifyOptions): RegistrySource[] {
  const registries: RegistrySource[] = [];
  const primaryPath = path.resolve(options.registry);
  const scansRoot = path.join(smaRoot, "scans");

  if (options.project) {
    const wanted = String(options.project).toLowerCase();
    const exactScanPath = path.join(scansRoot, wanted, "latest.registry.json");
    if (existsSync(exactScanPath)) {
      return [{ path: exactScanPath, registry: readJson<RegistryDocument>(exactScanPath) }];
    }

    try {
      for (const entry of readdirSync(scansRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const scanName = entry.name.toLowerCase();
        if (scanName !== wanted && !scanName.includes(wanted) && !wanted.includes(scanName)) continue;
        const scanRegistryPath = path.join(scansRoot, entry.name, "latest.registry.json");
        if (existsSync(scanRegistryPath)) registries.push({ path: scanRegistryPath, registry: readJson<RegistryDocument>(scanRegistryPath) });
      }
    } catch {
      // Fall through to the primary registry.
    }

    if (registries.length) return registries;
  }

  if (existsSync(primaryPath)) registries.push({ path: primaryPath, registry: readJson<RegistryDocument>(primaryPath) });
  if (existsSync(portfolioRegistry) && portfolioRegistry !== primaryPath) {
    registries.push({ path: portfolioRegistry, registry: readJson<RegistryDocument>(portfolioRegistry) });
  }

  if (options.projectRoot) return registries;

  try {
    for (const entry of readdirSync(scansRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const scanRegistryPath = path.join(scansRoot, entry.name, "latest.registry.json");
      if (!existsSync(scanRegistryPath) || scanRegistryPath === primaryPath) continue;
      registries.push({ path: scanRegistryPath, registry: readJson<RegistryDocument>(scanRegistryPath) });
    }
  } catch {
    // The global registry is enough when scans/ is unavailable.
  }

  return registries;
}

function graphifyBin(): string {
  const result = spawnSync("which", ["graphify"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function resolveProjectRoot(options: GraphifyOptions): string {
  if (options.projectRoot) return path.resolve(options.projectRoot);
  if (!options.project) return process.cwd();

  const wanted = String(options.project).toLowerCase();
  const absolute = PROJECT_ABSOLUTE_OVERRIDES[wanted];
  if (absolute && existsSync(absolute)) return path.resolve(absolute);

  let found: RegistryProject | null = null;
  for (const item of knownRegistries(options)) {
    const candidates = [...(item.registry.projects || []), ...(item.registry.scanned_project_roots || [])];
    const match = candidates.find((project) => {
      const id = String(project.id || project.project_id || project.name || "").toLowerCase();
      const root = String(project.root || project.project_root || project.path || "");
      if (!root) return false;
      const rootName = path.basename(root).toLowerCase();
      const scanName = path.basename(path.dirname(item.path)).toLowerCase();
      return id === wanted || rootName === wanted || scanName === wanted || rootName.includes(wanted) || scanName.includes(wanted);
    });
    found = match ?? null;
    if (found) break;
  }

  const foundRoot = found?.root || found?.project_root || found?.path || "";
  if (!foundRoot) throw new Error(`Project not found in SMA registry: ${options.project}`);
  return path.resolve(foundRoot);
}

function sourcePathCandidates(projectRoot: string, sourcePath: unknown): string[] {
  const raw = String(sourcePath || "");
  const candidates: string[] = [];
  if (!raw) return candidates;
  if (path.isAbsolute(raw)) return [path.resolve(raw)];

  const projectRootResolved = path.resolve(projectRoot);
  const projectName = path.basename(projectRootResolved).toLowerCase();
  const parts = raw.split(/[\\/]+/).filter(Boolean);

  candidates.push(path.resolve(projectRootResolved, raw));

  if (parts.length && parts[0].toLowerCase() === projectName) {
    candidates.push(path.resolve(path.dirname(projectRootResolved), ...parts));
    candidates.push(path.resolve(projectRootResolved, ...parts.slice(1)));
  }

  candidates.push(path.resolve(path.dirname(projectRootResolved), raw));
  return [...new Set(candidates)];
}

function resolveSourcePath(projectRoot: string, sourcePath: string) {
  const candidates = sourcePathCandidates(projectRoot, sourcePath);
  const sourceRoot = candidates.find((candidate) => existsSync(candidate)) || candidates[0] || path.resolve(projectRoot);
  let scanRoot = sourceRoot;
  let sourceKind = "missing";

  if (existsSync(sourceRoot)) {
    const sourceStat = statSync(sourceRoot);
    sourceKind = sourceStat.isFile() ? "file" : sourceStat.isDirectory() ? "directory" : "other";
    scanRoot = sourceStat.isFile() ? path.dirname(sourceRoot) : sourceRoot;
  }

  return {
    sourceRoot,
    scanRoot,
    sourceKind,
  };
}

function moduleTargetFromBrick(brick: RegistryBrick, options: GraphifyOptions, projectRoot: string, sourcePath: string): ModuleTarget {
  const resolved = resolveSourcePath(projectRoot, sourcePath);
  return {
    id: String(brick.id || options.module || brick.name || sourcePath),
    name: String(brick.name || options.module || brick.id || sourcePath),
    project: String(brick.project || options.project || path.basename(projectRoot)),
    root: resolved.sourceRoot,
    scanRoot: resolved.scanRoot,
    sourceKind: resolved.sourceKind,
    sourcePath,
  };
}

function normalizeGen3SourcePath(rawPath: unknown): string {
  let value = String(rawPath || "").trim().replace(/\\/g, "/");
  if (!value) return "";
  value = value.replace(/\/\*\*.*$/, "");
  value = value.replace(/\/\*.*$/, "");
  return value.replace(/\/+$/, "");
}

function gen3ModuleSourcePath(module: Gen3Module): string {
  const paths = Array.isArray(module.paths) ? module.paths : [];
  const normalized = paths.map(normalizeGen3SourcePath).filter(Boolean);
  return normalized.find((item) => !item.includes("*")) || normalized[0] || "";
}

function gen3ModuleBricksForProject(options: GraphifyOptions, projectRoot: string): RegistryBrick[] {
  const configPath = path.join(projectRoot, "sma.gen3.json");
  if (!existsSync(configPath)) return [];

  const config = readJson<Gen3Config>(configPath);
  const modules = Array.isArray(config.modules) ? config.modules : [];
  return modules
    .map<RegistryBrick | null>((module) => {
      const sourcePath = gen3ModuleSourcePath(module);
      if (!sourcePath) return null;
      const id = String(module.id || module.label || sourcePath);
      const label = String(module.label || module.id || sourcePath);
      return {
        id,
        name: label,
        kind: "module",
        project: String(options.project || path.basename(projectRoot)),
        source_paths: [sourcePath],
        owned_paths: Array.isArray(module.paths) ? module.paths : [sourcePath],
      };
    })
    .filter((brick): brick is RegistryBrick => brick !== null);
}

function moduleBrickMatches(brick: RegistryBrick, wanted: string): boolean {
  const haystack = [
    brick.id,
    brick.name,
    brick.kind,
    brick.brick_group,
    ...(brick.source_paths || []),
    ...(brick.owned_paths || []),
  ].map((value) => String(value || "").toLowerCase());
  return haystack.some((value) => value === wanted || value.includes(wanted));
}

function resolveModuleTarget(options: GraphifyOptions, projectRoot: string): ModuleTarget | null {
  if (!options.module) return null;

  const projectId = options.project ? String(options.project).toLowerCase() : "";
  const wanted = String(options.module).toLowerCase();
  const projectRootResolved = path.resolve(projectRoot);
  const bricks: RegistryBrick[] = [];
  const gen3Bricks = gen3ModuleBricksForProject(options, projectRoot);
  const exactGen3Brick = gen3Bricks.find(
    (brick) => moduleBrickMatches(brick, wanted) && String(brick.id || "").toLowerCase() === wanted,
  );
  if (exactGen3Brick) {
    const sourcePath = (exactGen3Brick.source_paths || exactGen3Brick.owned_paths || [])[0];
    return moduleTargetFromBrick(exactGen3Brick, options, projectRoot, sourcePath);
  }

  for (const item of knownRegistries(options)) {
    for (const brick of item.registry.bricks || []) {
      const brickProject = String(brick.project || "").toLowerCase();
      const manifestRoot = brick.manifest_path ? path.resolve(path.dirname(brick.manifest_path)) : "";
      const scanName = path.basename(path.dirname(item.path)).toLowerCase();
      const sameProject = projectId
        ? brickProject === projectId || brickProject.includes(projectId) || scanName === projectId || scanName.includes(projectId)
        : manifestRoot.startsWith(projectRootResolved);
      if (!sameProject) continue;
      if (moduleBrickMatches(brick, wanted)) bricks.push(brick);
    }
  }

  const brick = bricks[0] || gen3Bricks.find((item) => moduleBrickMatches(item, wanted));
  if (!brick) throw new Error(`Module not found in SMA registry: ${options.module}`);

  const sourcePath = (brick.source_paths || brick.owned_paths || [])[0];
  if (!sourcePath) throw new Error(`Module has no source path in SMA registry: ${brick.id}`);

  return moduleTargetFromBrick(brick, options, projectRoot, sourcePath);
}

function moduleTargetsForProject(options: GraphifyOptions, projectRoot: string): ModuleTarget[] {
  const projectId = options.project ? String(options.project).toLowerCase() : "";
  const projectRootResolved = path.resolve(projectRoot);
  const bricks = gen3ModuleBricksForProject(options, projectRoot);
  for (const item of knownRegistries(options)) {
    const scanName = path.basename(path.dirname(item.path)).toLowerCase();
    for (const brick of item.registry.bricks || []) {
      const brickProject = String(brick.project || "").toLowerCase();
      const manifestRoot = brick.manifest_path ? path.resolve(path.dirname(brick.manifest_path)) : "";
      const sameProject = projectId
        ? brickProject === projectId || brickProject.includes(projectId) || scanName === projectId || scanName.includes(projectId)
        : manifestRoot.startsWith(projectRootResolved);
      if (!sameProject) continue;
      if (!["module", "app"].includes(String(brick.kind || ""))) continue;
      if (!Boolean((brick.source_paths || brick.owned_paths || [])[0])) continue;
      bricks.push(brick);
    }
  }

  const seen = new Set<string>();
  const targets: ModuleTarget[] = [];
  for (const brick of bricks) {
    const sourcePath = (brick.source_paths || brick.owned_paths || [])[0];
    const target = moduleTargetFromBrick(brick, options, projectRoot, sourcePath);
    const targetRoot = target.root;
    const key = `${slug(brick.id)}\0${targetRoot}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }
  return targets.sort((left, right) => left.id.localeCompare(right.id));
}

function slug(value: unknown): string {
  return String(value || "module")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "module";
}

function projectTag(options: GraphifyOptions, projectRoot: string): string {
  return options.as || options.project || path.basename(projectRoot).toLowerCase();
}

function countGraphItems(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

function readGraphCounts(graphPath: string) {
  if (!existsSync(graphPath)) {
    return {
      graphReadable: false,
      nodeCount: 0,
      edgeCount: 0,
      emptyReason: "",
    };
  }

  try {
    const graph = readJson<{ nodes?: unknown; edges?: unknown; links?: unknown; elements?: { nodes?: unknown; edges?: unknown }; metadata?: { sma_status?: string; reason?: unknown } }>(graphPath);
    const nodes = graph.nodes ?? graph.elements?.nodes;
    const edges = graph.edges ?? graph.links ?? graph.elements?.edges;
    const metadata = graph.metadata && typeof graph.metadata === "object" ? graph.metadata : {};
    return {
      graphReadable: true,
      nodeCount: countGraphItems(nodes),
      edgeCount: countGraphItems(edges),
      emptyReason: metadata.sma_status === "empty" ? String(metadata.reason || "empty graph") : "",
    };
  } catch {
    return {
      graphReadable: false,
      nodeCount: 0,
      edgeCount: 0,
      emptyReason: "",
    };
  }
}

function readGen3Config(projectRoot: string): Gen3Config | null {
  const configPath = path.join(projectRoot, "sma.gen3.json");
  return existsSync(configPath) ? readJson<Gen3Config>(configPath) : null;
}

function graphStatusForTarget(options: GraphifyOptions, projectRoot: string, moduleTarget: ModuleTarget | null = null, graphifyPath: string | null = null): GraphStatus {
  const graphify = graphifyPath ?? graphifyBin();
  const graphRoot = moduleTarget
    ? path.join(projectRoot, "graphify-out", "modules", slug(moduleTarget.id))
    : projectRoot;
  const graphPath = path.join(graphRoot, "graphify-out", "graph.json");
  const reportPath = path.join(graphRoot, "graphify-out", "GRAPH_REPORT.md");
  const graphStat = existsSync(graphPath) ? statSync(graphPath) : null;
  const reportStat = existsSync(reportPath) ? statSync(reportPath) : null;
  const graphCounts = readGraphCounts(graphPath);
  const graphReady = Boolean(graphStat && graphCounts.graphReadable && graphCounts.nodeCount > 0);
  const graphKnownEmpty = Boolean(graphStat && graphCounts.graphReadable && graphCounts.nodeCount === 0 && graphCounts.emptyReason);
  const freshness = graphReady
    ? sourceFreshness(projectRoot, moduleTarget, graphStat, options.gen3Config ?? readGen3Config(projectRoot))
    : { graphFreshness: null, graphFresh: null, graphStale: false, sourceUpdatedAt: null, sourceGlobs: [] };
  const sourceRoot = moduleTarget?.root || projectRoot;
  const targetRoot = moduleTarget?.scanRoot || moduleTarget?.root || projectRoot;
  const targetExists = existsSync(targetRoot);
  const tag = moduleTarget
    ? `${projectTag(options, projectRoot)}/${slug(moduleTarget.name)}`
    : projectTag(options, projectRoot);

  return {
    ok: Boolean(graphify && graphReady && (!freshness.graphStale || options.staleOk)),
    graphifyAvailable: Boolean(graphify),
    graphify,
    projectRoot,
    sourceRoot,
    sourceExists: existsSync(sourceRoot),
    targetRoot,
    targetExists,
    targetCandidates: targetExists || !moduleTarget ? [] : missingTargetCandidates(projectRoot, targetRoot, moduleTarget.sourcePath),
    graphRoot,
    module: moduleTarget,
    projectTag: tag,
    graphPath,
    graphExists: Boolean(graphStat),
    graphReady,
    ...freshness,
    graphKnownEmpty,
    graphEmptyReason: graphCounts.emptyReason,
    graphReadable: graphCounts.graphReadable,
    nodeCount: graphCounts.nodeCount,
    edgeCount: graphCounts.edgeCount,
    graphUpdatedAt: graphStat ? graphStat.mtime.toISOString() : null,
    reportPath,
    reportExists: Boolean(reportStat),
    reportUpdatedAt: reportStat ? reportStat.mtime.toISOString() : null,
  };
}

function missingTargetCandidates(projectRoot: string, targetRoot: string, sourcePath: string): GraphStatus['targetCandidates'] {
  const files = trackedProjectFiles(projectRoot);
  if (!files.length) return [];

  const targetBase = path.basename(targetRoot).toLowerCase();
  const targetExt = path.extname(targetBase);
  const targetStem = targetBase.slice(0, targetBase.length - targetExt.length) || targetBase;
  const sourceParts = new Set(String(sourcePath || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((part) => part.length > 2));

  return files
    .map((relativePath) => {
      const base = path.basename(relativePath).toLowerCase();
      const ext = path.extname(base);
      const stem = base.slice(0, base.length - ext.length) || base;
      let score = 0;
      const reasons: string[] = [];
      if (base === targetBase) {
        score += 100;
        reasons.push("same filename");
      } else if (stem.startsWith(targetStem) || targetStem.startsWith(stem)) {
        score += 62;
        reasons.push("near rename");
      } else if (stem.includes(targetStem) || targetStem.includes(stem)) {
        score += 45;
        reasons.push("similar name");
      }
      if (score === 0) return null;
      if (ext && ext === targetExt) {
        score += 10;
        reasons.push("same extension");
      }
      const pathParts = String(relativePath).toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean);
      const overlap = pathParts.filter((part) => sourceParts.has(part)).length;
      if (overlap) {
        score += Math.min(24, overlap * 6);
        reasons.push(`${overlap} path token${overlap === 1 ? "" : "s"} match`);
      }
      if (relativePath.startsWith("src/")) score += 12;
      if (/(^|\/)(backup|backups|parking|archive|archived|old|tmp|temp)\b/i.test(relativePath)) score -= 36;
      return {
        path: relativePath,
        score,
        reason: reasons.join(", "),
      };
    })
    .filter((candidate): candidate is { path: string; score: number; reason: string } => candidate !== null && candidate.score >= 40)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 8);
}

function trackedProjectFiles(projectRoot: string): string[] {
  const tracked = spawnSync("git", ["-C", projectRoot, "ls-files"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 24 * 1024 * 1024,
  });
  if (tracked.status !== 0) return [];
  return tracked.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isIgnoredCandidatePath(line));
}

function isIgnoredCandidatePath(relativePath: string): boolean {
  return /(^|\/)(\.git|node_modules|graphify-out|dist|build|coverage|\.next|out|tmp|temp)(\/|$)/.test(relativePath);
}

function graphTargetCacheKey(status: GraphStatus): string {
  return path.resolve(status.targetRoot);
}

function copyGraphArtifacts(fromStatus: GraphStatus, toStatus: GraphStatus): void {
  mkdirSync(path.dirname(toStatus.graphPath), { recursive: true });
  copyFileSync(fromStatus.graphPath, toStatus.graphPath);
  if (fromStatus.reportExists) {
    mkdirSync(path.dirname(toStatus.reportPath), { recursive: true });
    copyFileSync(fromStatus.reportPath, toStatus.reportPath);
  }
}

function graphStatus(options: GraphifyOptions): GraphStatus {
  const projectRoot = resolveProjectRoot(options);
  const moduleTarget = resolveModuleTarget(options, projectRoot);
  return graphStatusForTarget(options, projectRoot, moduleTarget);
}

function moduleGraphStatus(options: GraphifyOptions) {
  const projectRoot = resolveProjectRoot(options);
  const graphify = graphifyBin();
  const gen3Config = readGen3Config(projectRoot);
  const modules = moduleTargetsForProject(options, projectRoot)
    .map((module) => graphStatusForTarget({ ...options, gen3Config }, projectRoot, module, graphify));
  const missing = modules.filter((status) => !status.graphReady);
  const stale = modules.filter((status) => status.graphStale);
  const unavailable = modules.filter((status) => !status.graphifyAvailable);
  const missingTargets = modules.filter((status) => !status.targetExists);
  const knownEmpty = modules.filter((status) => status.graphKnownEmpty);
  const missingGraphs = modules.filter((status) => (
    status.graphifyAvailable
    && status.targetExists
    && !status.graphReady
    && !status.graphKnownEmpty
  ));
  const actionableGaps = uniqueStatuses([
    ...unavailable,
    ...missingTargets,
    ...missingGraphs,
    ...(options.staleOk ? [] : stale),
  ]);
  return {
    ok: actionableGaps.length === 0,
    projectRoot,
    moduleCount: modules.length,
    satisfiedCount: modules.filter((status) => (
      (status.graphReady && (!status.graphStale || options.staleOk)) || status.graphKnownEmpty
    )).length,
    freshCount: modules.filter((status) => status.graphFresh).length,
    staleCount: stale.length,
    missingCount: missing.length,
    missingGraphCount: missingGraphs.length,
    knownEmptyCount: knownEmpty.length,
    graphifyUnavailableCount: unavailable.length,
    missingTargetCount: missingTargets.length,
    actionableGapCount: actionableGaps.length,
    actionableGaps,
    modules,
  };
}

function uniqueStatuses(statuses: readonly GraphStatus[]): GraphStatus[] {
  const seen = new Set<string>();
  const out: GraphStatus[] = [];
  for (const status of statuses) {
    const key = status.module?.id || status.graphPath || status.targetRoot;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(status);
  }
  return out;
}

function runGraphify(args: string[], options: GraphifyRuntimeOptions = {}) {
  const result = spawnSync("graphify", args, {
    cwd: options.cwd || process.cwd(),
    stdio: options.stdio || "inherit",
    encoding: options.stdio === "pipe" ? "utf8" : undefined,
    maxBuffer: 32 * 1024 * 1024,
    timeout: spawnTimeoutMs(options),
  });
  return spawnResult(result, options);
}

function spawnTimeoutMs(options: GraphifyRuntimeOptions = {}): number | undefined {
  const seconds = Number(options.timeoutSeconds);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined;
}

function spawnResult(result: ReturnType<typeof spawnSync>, options: GraphifyRuntimeOptions = {}): SpawnOutcome {
  const errorCode = result.error && 'code' in result.error ? result.error.code : undefined;
  const timedOut = errorCode === "ETIMEDOUT";
  const message = timedOut
    ? `timed out after ${options.timeoutSeconds}s`
    : result.error?.message || "";
  return {
    status: timedOut ? 124 : result.status ?? 1,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    signal: result.signal || "",
    timedOut,
    message,
  };
}

function printSpawnDetails(result: SpawnOutcome): void {
  if (result.message) console.log(result.message);
  if (result.stderr) console.log(result.stderr.trim());
  if (result.stdout) console.log(result.stdout.trim());
}

function isGraphifyOutIgnored(projectRoot: string): boolean {
  return isIgnored(projectRoot, "graphify-out/.sma-probe")
    && isIgnored(projectRoot, "sma-nested-probe/graphify-out/.sma-probe");
}

function isIgnored(projectRoot: string, probePath: string): boolean {
  const result = spawnSync("git", ["-C", projectRoot, "check-ignore", "--quiet", probePath], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function gitInfoExcludePath(projectRoot: string): string | null {
  const result = spawnSync("git", ["-C", projectRoot, "rev-parse", "--git-path", "info/exclude"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const raw = String(result.stdout || "").trim();
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw);
}

function ensureGraphifyOutLocalExclude(projectRoot: string): void {
  if (isGraphifyOutIgnored(projectRoot)) return;
  const excludePath = gitInfoExcludePath(projectRoot);
  if (!excludePath) return;

  let existing = "";
  try {
    existing = readFileSync(excludePath, "utf8");
  } catch {
    // Missing info/exclude is fine; create it below.
  }

  const alreadyListed = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === "graphify-out/" || line === "**/graphify-out/" || line === "graphify-out/**");
  if (alreadyListed) return;

  const newline = existing && !existing.endsWith("\n") ? "\n" : "";
  mkdirSync(path.dirname(excludePath), { recursive: true });
  writeFileSync(
    excludePath,
    `${existing}${newline}\n# SMA Gen3 local graph cache\n/graphify-out/\ngraphify-out/\n`,
  );
}

function graphifyPythonBin(graphifyPath: string): string {
  if (graphifyPath && existsSync(graphifyPath)) {
    try {
      const firstLine = readFileSync(graphifyPath, "utf8").split(/\r?\n/, 1)[0] || "";
      const shebang = firstLine.replace(/^#!/, "").trim();
      if (shebang && existsSync(shebang)) return shebang;
    } catch {
      // Fall through to python3; the caller reports any import failure.
    }
  }
  return "python3";
}

function runCodeOnlyGraphify(status: GraphStatus, options: GraphifyRuntimeOptions = {}): SpawnOutcome {
  const python = graphifyPythonBin(status.graphify);
  const script = String.raw`
import sys
import json
import unicodedata
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from graphify.build import build_from_json
from graphify.cluster import cluster
from graphify.export import to_json
from graphify.extract import collect_files, extract

target = Path(sys.argv[1])
out_root = Path(sys.argv[2]) / "graphify-out"
no_cluster = sys.argv[3] == "1"
quiet = sys.argv[4] == "1"
out_root.mkdir(parents=True, exist_ok=True)
graph_path = out_root / "graph.json"
report_path = out_root / "GRAPH_REPORT.md"

def norm_label(value):
    text = "" if value is None else str(value)
    return "".join(
        char for char in unicodedata.normalize("NFKD", text)
        if not unicodedata.combining(char)
    ).lower()

def write_empty(reason):
    graph_path.write_text(json.dumps({
        "nodes": [],
        "links": [],
        "edges": [],
        "hyperedges": [],
        "metadata": {
            "sma_status": "empty",
            "reason": reason,
            "local_code_only": True,
            "fast_no_cluster": no_cluster,
        },
    }, indent=2), encoding="utf-8")
    report_path.write_text("\n".join([
        "# SMA Code-Only Graph",
        "",
        f"Source: {target}",
        "Nodes: 0",
        "Edges: 0",
        f"Reason: {reason}",
        "",
        "Generated by the SMA Graphify bridge in local code-only mode. This path does not call external LLM APIs.",
    ]) + "\n", encoding="utf-8")
    print(f"local code-only graph: 0 nodes, 0 edges ({reason})")

def write_direct_graph(extraction):
    nodes = []
    seen_nodes = set()
    for raw_node in extraction.get("nodes", []):
        if not isinstance(raw_node, dict) or raw_node.get("id") is None:
            continue
        node_id = str(raw_node["id"])
        if node_id in seen_nodes:
            continue
        seen_nodes.add(node_id)
        node = dict(raw_node)
        node["id"] = node_id
        node.setdefault("label", node_id)
        node.setdefault("file_type", "concept")
        node.setdefault("community", 0)
        node.setdefault("norm_label", norm_label(node.get("label")))
        nodes.append(node)

    links = []
    for raw_edge in extraction.get("edges", extraction.get("links", [])):
        if not isinstance(raw_edge, dict):
            continue
        source = raw_edge.get("source", raw_edge.get("from"))
        target_edge = raw_edge.get("target", raw_edge.get("to"))
        if source is None or target_edge is None:
            continue
        edge = dict(raw_edge)
        edge["source"] = str(source)
        edge["target"] = str(target_edge)
        edge.setdefault("relation", "relates")
        edge.setdefault("confidence", "EXTRACTED")
        edge.setdefault("confidence_score", 1.0)
        links.append(edge)

    if not nodes:
        write_empty("extraction produced 0 nodes")
        return

    payload = {
        "directed": True,
        "multigraph": False,
        "graph": {},
        "nodes": nodes,
        "links": links,
        "edges": links,
        "hyperedges": extraction.get("hyperedges", []),
        "input_tokens": extraction.get("input_tokens", 0),
        "output_tokens": extraction.get("output_tokens", 0),
        "metadata": {
            "sma_status": "local_code_only_direct",
            "source": str(target),
            "local_code_only": True,
            "fast_no_cluster": True,
        },
    }
    graph_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    report_path.write_text("\n".join([
        "# SMA Code-Only Graph",
        "",
        f"Source: {target}",
        f"Files: {len(files)}",
        f"Nodes: {len(nodes)}",
        f"Edges: {len(links)}",
        "",
        "Generated by the SMA Graphify bridge in local code-only direct mode. This path does not call external LLM APIs.",
    ]) + "\n", encoding="utf-8")
    print(f"local code-only graph: {len(nodes)} nodes, {len(links)} edges")

files = collect_files(target)
if not files:
    write_empty("no code files")
    raise SystemExit(0)

if quiet:
    with redirect_stdout(StringIO()), redirect_stderr(StringIO()):
        extraction = extract(files, cache_root=target)
else:
    extraction = extract(files, cache_root=target)
if not extraction.get("nodes"):
    write_empty("extraction produced 0 nodes")
    raise SystemExit(0)

if no_cluster:
    write_direct_graph(extraction)
    raise SystemExit(0)

graph = build_from_json(extraction, root=target)
if graph.number_of_nodes() == 0:
    write_empty("graph has 0 nodes")
    raise SystemExit(0)

communities = {0: list(graph.nodes())} if no_cluster else cluster(graph)
if not to_json(graph, communities, str(graph_path), force=True):
    print("local code-only graph: graph write refused")
    raise SystemExit(1)

report = [
    "# SMA Code-Only Graph",
    "",
    f"Source: {target}",
    f"Files: {len(files)}",
    f"Nodes: {graph.number_of_nodes()}",
    f"Edges: {graph.number_of_edges()}",
    "",
    "Generated by the SMA Graphify bridge in local code-only mode. This path does not call external LLM APIs.",
]
(out_root / "GRAPH_REPORT.md").write_text("\n".join(report) + "\n", encoding="utf-8")
print(f"local code-only graph: {graph.number_of_nodes()} nodes, {graph.number_of_edges()} edges")
`;

  const result = spawnSync(python, ["-c", script, status.targetRoot, status.graphRoot, options.noCluster ? "1" : "0", options.quiet ? "1" : "0"], {
    cwd: status.targetRoot,
    stdio: options.quiet ? "pipe" : "inherit",
    encoding: options.quiet ? "utf8" : undefined,
    maxBuffer: 32 * 1024 * 1024,
    timeout: spawnTimeoutMs(options),
  });
  return spawnResult(result, options);
}

function graphifyGlobalCapMessage(result: Pick<SpawnOutcome, 'stderr' | 'stdout'>): string {
  const text = `${result.stderr || ""}\n${result.stdout || ""}`;
  if (!text.includes("exceeds") || !text.includes("GRAPHIFY_MAX_GRAPH_BYTES")) return "";
  return text.split(/\r?\n/).find((line) => line.includes("exceeds")) || "global graph size cap reached";
}

function parseByteLimit(value: unknown, fallback = DEFAULT_GRAPHIFY_MAX_GRAPH_BYTES): number {
  const raw = String(value || "").trim().replace(/_/g, "");
  if (!raw) return fallback;
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?b?)?$/i.exec(raw);
  if (!match) return fallback;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return fallback;
  const unit = String(match[2] || "b").toLowerCase();
  const multiplier = unit === "k" || unit === "kb"
    ? 1024
    : unit === "m" || unit === "mb"
      ? 1024 ** 2
      : unit === "g" || unit === "gb"
        ? 1024 ** 3
        : unit === "t" || unit === "tb"
          ? 1024 ** 4
          : 1;
  return Math.floor(amount * multiplier);
}

function formatBytes(bytes: unknown): string {
  const value = Number(bytes);
  if (!Number.isFinite(value)) return "unknown size";
  if (value >= 1024 ** 3) return `${(value / (1024 ** 3)).toFixed(2)}GB`;
  if (value >= 1024 ** 2) return `${(value / (1024 ** 2)).toFixed(1)}MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${value}B`;
}

function graphifyGlobalGraphPath(): string {
  const result = runGraphify(["global", "path"], { stdio: "pipe" });
  const stdout = String(result.stdout || "").trim();
  if (result.status === 0 && stdout) return stdout.split(/\r?\n/)[0].trim();
  const home = process.env.HOME || "";
  return home ? path.join(home, ".graphify", "global-graph.json") : "";
}

function graphifyGlobalAddPreflightReason(): string {
  const graphPath = graphifyGlobalGraphPath();
  if (!graphPath || !existsSync(graphPath)) return "";
  const maxBytes = parseByteLimit(process.env.GRAPHIFY_MAX_GRAPH_BYTES);
  const size = statSync(graphPath).size;
  if (size <= maxBytes) return "";
  return `${graphPath} is ${formatBytes(size)}, above GRAPHIFY_MAX_GRAPH_BYTES ${formatBytes(maxBytes)}; set GRAPHIFY_MAX_GRAPH_BYTES=<N>GB to opt into larger local global graph updates`;
}

function walkJsonFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkJsonFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(entryPath);
    }
  }
  return out;
}

function normalizeLabel(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function shellArg(value: unknown): string {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

function writeGraphFromAstCache(status: GraphStatus, reason = "cache fallback"): boolean {
  const astRoot = path.join(status.targetRoot, "graphify-out", "cache", "ast");
  const cacheFiles = walkJsonFiles(astRoot);
  if (!cacheFiles.length) return false;

  type CacheNode = Record<string, unknown> & { id?: unknown; label?: unknown; file_type?: unknown; community?: unknown; norm_label?: unknown };
  type CacheEdge = Record<string, unknown> & { source?: unknown; from?: unknown; target?: unknown; to?: unknown; relation?: unknown; confidence?: unknown; confidence_score?: unknown };
  const nodes = new Map<string, CacheNode>();
  const links: CacheEdge[] = [];
  let readFailures = 0;
  for (const filePath of cacheFiles) {
    let payload: { nodes?: CacheNode[]; edges?: CacheEdge[]; links?: CacheEdge[] };
    try {
      payload = readJson<{ nodes?: CacheNode[]; edges?: CacheEdge[]; links?: CacheEdge[] }>(filePath);
    } catch {
      readFailures += 1;
      continue;
    }

    for (const rawNode of payload.nodes || []) {
      if (!rawNode || typeof rawNode !== "object" || rawNode.id == null) continue;
      const nodeId = String(rawNode.id);
      if (nodes.has(nodeId)) continue;
      const node = { ...rawNode, id: nodeId };
      node.label ??= nodeId;
      node.file_type ??= "concept";
      node.community ??= 0;
      node.norm_label ??= normalizeLabel(node.label);
      nodes.set(nodeId, node);
    }

    for (const rawEdge of payload.edges || payload.links || []) {
      if (!rawEdge || typeof rawEdge !== "object") continue;
      const source = rawEdge.source ?? rawEdge.from;
      const target = rawEdge.target ?? rawEdge.to;
      if (source == null || target == null) continue;
      const edge = {
        ...rawEdge,
        source: String(source),
        target: String(target),
      };
      edge.relation ??= "relates";
      edge.confidence ??= "EXTRACTED";
      edge.confidence_score ??= 1.0;
      links.push(edge);
    }
  }

  if (!nodes.size) return false;

  mkdirSync(path.dirname(status.graphPath), { recursive: true });
  const graph = {
    directed: true,
    multigraph: false,
    graph: {},
    nodes: [...nodes.values()],
    links,
    edges: links,
    hyperedges: [],
    input_tokens: 0,
    output_tokens: 0,
    metadata: {
      sma_status: "local_code_only_cache_fallback",
      reason,
      source: status.targetRoot,
      local_code_only: true,
      cache_fragment_count: cacheFiles.length,
      cache_read_failures: readFailures,
    },
  };
  writeFileSync(status.graphPath, JSON.stringify(graph, null, 2) + "\n");
  writeFileSync(status.reportPath, [
    "# SMA Code-Only Graph",
    "",
    `Source: ${status.targetRoot}`,
    `Nodes: ${nodes.size}`,
    `Edges: ${links.length}`,
    `Cache fragments: ${cacheFiles.length}`,
    `Cache read failures: ${readFailures}`,
    `Fallback reason: ${reason}`,
    "",
    "Generated by the SMA Graphify bridge from local AST cache fragments after the direct extraction command timed out. This path does not call external LLM APIs.",
  ].join("\n") + "\n");
  console.log(`local code-only cache fallback graph: ${nodes.size} nodes, ${links.length} edges from ${cacheFiles.length} cache fragments`);
  return true;
}

function outputStatus(status: GraphStatus, options: GraphifyOptions): void {
  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  const freshness = status.graphFreshness ? ` (${status.graphFreshness})` : "";
  console.log(`${status.ok ? "OK" : "WARN"} graphify ${status.graphReady ? "ready" : status.graphExists ? "empty/unreadable" : "missing"}${freshness} for ${status.projectTag}`);
  console.log(`project: ${status.projectRoot}`);
  if (status.module) console.log(`module: ${status.module.id} (${status.module.sourcePath})`);
  if (status.module) console.log(`target: ${status.targetRoot}`);
  console.log(`graph: ${status.graphPath}`);
  if (status.graphExists) console.log(`nodes: ${status.nodeCount} edges: ${status.edgeCount}`);
  if (status.graphFreshness) console.log(`freshness: ${status.graphFreshness}`);
  if (status.sourceUpdatedAt) console.log(`newest source: ${status.sourceUpdatedAt}`);
  if (status.graphUpdatedAt) console.log(`updated: ${status.graphUpdatedAt}`);
  if (!status.graphifyAvailable) console.log("graphify CLI is not on PATH");
  if (!status.targetExists) console.log(`target is missing: ${status.targetRoot}`);
}

function requireGraph(options: GraphifyOptions): GraphStatus {
  const status = graphStatus(options);
  if (!status.graphifyAvailable) throw new Error("graphify CLI is not on PATH");
  if (!status.graphReady) throw new Error(`Missing or empty graphify graph: ${status.graphPath}`);
  return status;
}

function commandCheck(options: GraphifyOptions): number {
  const status = graphStatus(options);
  outputStatus(status, options);
  return checkExitCode(options, status);
}

function checkExitCode(options: GraphifyOptions, status: { ok: boolean }): number {
  return options.strict && !status.ok ? 1 : 0;
}

function commandCheckModules(options: GraphifyOptions): number {
  const status = moduleGraphStatus(options);
  if (options.summaryJson) {
    console.log(JSON.stringify(moduleGraphSummary(status), null, 2));
  } else if (options.json) {
    console.log(JSON.stringify(status, null, 2));
  } else if (options.quiet) {
    console.log(`${status.ok ? "OK" : "FAIL"} graphify module graphs ${status.satisfiedCount}/${status.moduleCount} satisfied`);
    if (status.freshCount) console.log(`fresh graphs: ${status.freshCount}`);
    if (status.staleCount) console.log(`stale graphs: ${status.staleCount}`);
    if (status.missingGraphCount) console.log(`missing graphs: ${status.missingGraphCount}`);
    if (status.missingTargetCount) console.log(`missing targets: ${status.missingTargetCount}`);
    if (status.knownEmptyCount) console.log(`known empty graphs: ${status.knownEmptyCount}`);
  } else {
    console.log(`${status.ok ? "OK" : "FAIL"} graphify module graphs ${status.satisfiedCount}/${status.moduleCount} satisfied`);
    console.log(`project: ${status.projectRoot}`);
    console.log(`ready: ${status.freshCount} fresh, ${status.staleCount} stale, ${status.knownEmptyCount} known empty, ${status.actionableGapCount} actionable gaps`);
    if (status.missingGraphCount) console.log(`missing graphs: ${status.missingGraphCount}`);
    if (status.missingTargetCount) console.log(`missing targets: ${status.missingTargetCount}`);
    if (status.graphifyUnavailableCount) console.log(`graphify unavailable: ${status.graphifyUnavailableCount}`);
    const rows = options.verbose ? status.modules : status.actionableGaps;
    const configuredLimit = options.limit;
    const rowLimit = options.verbose
      ? rows.length
      : typeof configuredLimit === 'number' && Number.isFinite(configuredLimit) && configuredLimit >= 0 ? configuredLimit : 20;
    for (const moduleStatus of rows.slice(0, rowLimit)) {
      const marker = !moduleStatus.graphifyAvailable
        ? "NO_GRAPHIFY"
        : moduleStatus.graphStale
          ? "STALE"
        : moduleStatus.graphReady
          ? "OK"
          : moduleStatus.graphKnownEmpty
            ? "EMPTY"
            : moduleStatus.targetExists ? "MISSING" : "STALE_TARGET";
      const counts = moduleStatus.graphExists ? ` (${moduleStatus.nodeCount} nodes, ${moduleStatus.edgeCount} edges)` : "";
      const freshness = moduleStatus.graphFreshness ? ` [${moduleStatus.graphFreshness}]` : "";
      console.log(`- ${marker} ${moduleStatus.module?.id}: ${moduleStatus.graphPath}${counts}${freshness}`);
      if (!moduleStatus.targetExists) {
        console.log(`  target: ${moduleStatus.targetRoot}`);
        for (const candidate of moduleStatus.targetCandidates || []) {
          console.log(`  candidate: ${candidate.path} (${candidate.reason}; score ${candidate.score})`);
        }
      }
    }
    if (!options.verbose && rows.length > rowLimit) {
      console.log(`... ${rows.length - rowLimit} more actionable gap(s); rerun with --verbose or --limit ${rows.length}`);
    }
    if (!options.verbose && status.actionableGapCount === 0 && status.knownEmptyCount) {
      console.log(`known empty graphs are accepted as satisfied; rerun with --verbose to list them.`);
    }
    if (status.actionableGapCount) {
      const projectHint = options.project ? ` --project ${options.project}` : options.projectRoot ? ` --project-root ${options.projectRoot}` : " --project <project-id>";
      console.log(`repair: npm run graphify:refresh:modules --${projectHint} --missing-only --limit 25 --global`);
    }
  }
  return checkExitCode(options, status);
}

function moduleGraphSummary(status: ReturnType<typeof moduleGraphStatus>) {
  const readyModules = status.modules.filter((item) => item.graphReady);
  const knownEmptyModules = status.modules.filter((item) => item.graphKnownEmpty);
  const updatedTimes = status.modules
    .map((item) => item.graphUpdatedAt)
    .filter((value): value is string => typeof value === 'string')
    .sort();
  return {
    ok: status.ok,
    projectRoot: status.projectRoot,
    moduleCount: status.moduleCount,
    satisfiedCount: status.satisfiedCount,
    readyCount: readyModules.length,
    freshCount: status.freshCount,
    staleCount: status.staleCount,
    knownEmptyCount: status.knownEmptyCount,
    actionableGapCount: status.actionableGapCount,
    missingGraphCount: status.missingGraphCount,
    missingTargetCount: status.missingTargetCount,
    graphifyUnavailableCount: status.graphifyUnavailableCount,
    nodeCount: readyModules.reduce((sum, item) => sum + Number(item.nodeCount || 0), 0),
    edgeCount: readyModules.reduce((sum, item) => sum + Number(item.edgeCount || 0), 0),
    oldestGraphUpdatedAt: updatedTimes[0] || null,
    newestGraphUpdatedAt: updatedTimes[updatedTimes.length - 1] || null,
    actionableGaps: status.actionableGaps.slice(0, 20).map((item) => ({
      moduleId: item.module?.id || null,
      sourcePath: item.module?.sourcePath || null,
      graphPath: item.graphPath,
      targetRoot: item.targetRoot,
      targetCandidates: (item.targetCandidates || []).slice(0, 5),
      reason: !item.graphifyAvailable
        ? "graphify unavailable"
        : !item.targetExists
          ? "target missing"
          : item.graphStale
            ? "graph stale"
          : item.graphKnownEmpty
            ? `known empty: ${item.graphEmptyReason || "empty graph"}`
            : "graph missing or unreadable",
    })),
    knownEmptySample: knownEmptyModules.slice(0, 10).map((item) => ({
      moduleId: item.module?.id || null,
      sourcePath: item.module?.sourcePath || null,
      reason: item.graphEmptyReason || "empty graph",
    })),
  };
}

function moduleTargetFixes(status: ReturnType<typeof moduleGraphStatus>) {
  return status.actionableGaps
    .filter((item) => !item.targetExists)
    .map((item) => ({
      moduleId: item.module?.id || null,
      moduleName: item.module?.name || null,
      sourcePath: item.module?.sourcePath || null,
      targetRoot: item.targetRoot,
      graphPath: item.graphPath,
      targetCandidates: (item.targetCandidates || []).slice(0, 8).map((candidate) => ({
        path: candidate.path,
        reason: candidate.reason,
        score: Number(candidate.score ?? 0),
      })),
    }));
}

function commandTargetFixes(options: GraphifyOptions): number {
  const status = moduleGraphStatus(options);
  const fixes = moduleTargetFixes(status);
  const payload = {
    ok: fixes.length === 0,
    projectRoot: status.projectRoot,
    missingTargetCount: fixes.length,
    fixes,
    nextCommands: {
      verify: options.project
        ? `npm run graphify:check:modules -- --project ${shellArg(options.project)} --strict --summary-json`
        : "npm run graphify:check:modules -- --project <project-id> --strict --summary-json",
      refreshAfterMapFix: options.project
        ? `npm run graphify:refresh:modules -- --project ${shellArg(options.project)} --missing-only --limit 25 --no-cluster --timeout-seconds 240 && npm run graphify:project-from-modules -- --project ${shellArg(options.project)}`
        : "npm run graphify:refresh:modules -- --project <project-id> --missing-only --limit 25 --no-cluster --timeout-seconds 240 && npm run graphify:project-from-modules -- --project <project-id>",
    },
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  if (!fixes.length) {
    console.log(`OK no module target drift for ${status.projectRoot}`);
    return 0;
  }

  console.log(`module target drift: ${fixes.length} missing target${fixes.length === 1 ? "" : "s"}`);
  console.log(`project: ${status.projectRoot}`);
  for (const fix of fixes) {
    console.log(`- ${fix.moduleId || fix.moduleName || fix.sourcePath}: ${fix.sourcePath || "unknown source path"}`);
    console.log(`  missing: ${fix.targetRoot}`);
    for (const candidate of fix.targetCandidates) {
      console.log(`  candidate: ${candidate.path} (${candidate.reason}; score ${candidate.score})`);
    }
    if (fix.targetCandidates[0]?.path) {
      console.log(`  action: update the module ownership/source map from ${fix.sourcePath} to ${fix.targetCandidates[0].path}, then refresh module graphs.`);
    } else {
      console.log("  action: inspect the module ownership/source map and replace the stale path with the current module path, then refresh module graphs.");
    }
  }
  console.log(`verify: ${payload.nextCommands.verify}`);
  console.log(`after map fix: ${payload.nextCommands.refreshAfterMapFix}`);
  return 0;
}

async function summarizeSemanticGraph(status: GraphStatus, options: GraphifyOptions): Promise<void> {
  if (!options.semantic || options.noCluster || !status.graphReady) return;
  const summaries = await generateCommunitySummaries({ graphPath: status.graphPath, semantic: true });
  if (summaries.summaryCount && !options.quiet) console.log(`community summaries: ${summaries.summaryCount} (${summaries.generated} generated, ${summaries.reused} cached)`);
}
async function commandRefresh(options: GraphifyOptions): Promise<number> {
  const status = graphStatus(options);
  if (!status.graphifyAvailable) throw new Error("graphify CLI is not on PATH");
  if (!status.targetExists) throw new Error(`Graphify target is missing: ${status.targetRoot}`);
  ensureGraphifyOutLocalExclude(status.projectRoot);

  const action = status.module ? "extract" : status.graphExists ? "update" : "extract";
  const result = options.semantic
    ? runGraphify([
      action,
      status.targetRoot,
      ...(status.module || action === "extract" ? ["--out", status.graphRoot] : []),
      ...(options.noCluster ? ["--no-cluster"] : []),
    ], options)
    : runCodeOnlyGraphify(status, options);
  if (result.status !== 0) {
    const mode = options.semantic ? "graphify extract/update" : "local code-only extraction";
    if (!options.semantic && options.noCluster && result.timedOut && writeGraphFromAstCache(status, result.message)) {
      return commandCheck({ ...options, strict: false });
    }
    console.log(`FAIL ${mode} exited ${result.status}`);
    printSpawnDetails(result);
    return result.status;
  }
  if (!options.semantic && result.stdout) console.log(result.stdout.trim());

  await summarizeSemanticGraph(graphStatus(options), options);

  if (options.global) {
    const refreshed = graphStatus(options);
    if (!refreshed.graphReady) throw new Error(`Graphify refresh did not produce a non-empty graph: ${refreshed.graphPath}`);
    const preflightReason = graphifyGlobalAddPreflightReason();
    if (preflightReason) {
      console.log(`WARN graphify global add skipped: ${preflightReason}`);
    } else {
      const globalResult = runGlobalGraphAdd(refreshed.graphPath, refreshed.projectTag, {
        ...options,
        stdio: "pipe",
      });
      if (globalResult.status !== 0) {
        const capMessage = graphifyGlobalCapMessage(globalResult);
        if (capMessage) {
          console.log(`WARN graphify global add skipped: ${capMessage}`);
        } else {
          printSpawnDetails(globalResult);
          return globalResult.status;
        }
      } else if (globalResult.stdout && !options.quiet) {
        console.log(globalResult.stdout.trim());
      }
    }
  }

  return commandCheck({ ...options, strict: false });
}

async function commandRefreshModules(options: GraphifyOptions): Promise<number> {
  const projectRoot = resolveProjectRoot(options);
  ensureGraphifyOutLocalExclude(projectRoot);
  const graphify = graphifyBin();
  const allModules = moduleTargetsForProject(options, projectRoot);
  const allStatuses = allModules.map((module) => graphStatusForTarget(options, projectRoot, module, graphify));
  const readyByTargetRoot = new Map<string, GraphStatus>();
  if (options.missingOnly) {
    for (const status of allStatuses) {
      if (status.targetExists && status.graphReady) readyByTargetRoot.set(graphTargetCacheKey(status), status);
    }
  }

  let modules = allStatuses;
  if (options.missingOnly) {
    modules = modules.filter((status) => !status.graphReady && !status.graphKnownEmpty);
  }
  if (typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit >= 0) {
    modules = modules.slice(0, options.limit);
  }
  if (!modules.length) {
    console.log(allModules.length
      ? `No SMA module targets selected for ${projectRoot}`
      : `No SMA module targets found for ${projectRoot}`);
    return 0;
  }

  let built = 0;
  let skipped = 0;
  let zeroNode = 0;
  let failed = 0;
  let reused = 0;
  let globalSkipped = 0;
  let globalDisabledReason = options.global ? graphifyGlobalAddPreflightReason() : "";
  if (globalDisabledReason) {
    console.log(`WARN graphify global add disabled for this batch: ${globalDisabledReason}`);
  }

  const addToGlobal = (refreshed: GraphStatus, module: ModuleTarget) => {
    if (!options.global) return;
    if (globalDisabledReason) {
      globalSkipped += 1;
      return;
    }
    const globalResult = runGlobalGraphAdd(
      refreshed.graphPath,
      refreshed.projectTag,
      { ...options, stdio: options.quiet ? "pipe" : "inherit" },
    );
    if (globalResult.status === 0) return;

    const capMessage = graphifyGlobalCapMessage(globalResult);
    if (capMessage) {
      globalDisabledReason = capMessage;
      globalSkipped += 1;
      console.log(`WARN graphify global add disabled for this batch: ${capMessage}`);
      return;
    }

    failed += 1;
    console.log(`FAIL graphify global add exited ${globalResult.status} for ${module.id}`);
    if (globalResult.message) console.log(globalResult.message);
    if (options.quiet && globalResult.stderr) console.log(globalResult.stderr.trim());
  };

  for (const status of modules) {
    const module = status.module;
    if (!module) continue;
    console.log(`\n== graphify module ${module.id} ==`);
    if (!status.targetExists) {
      skipped += 1;
      console.log(`SKIP stale target: ${status.targetRoot}`);
      continue;
    }

    const targetKey = graphTargetCacheKey(status);
    const cached = readyByTargetRoot.get(targetKey);
    if (cached && cached.graphPath !== status.graphPath) {
      copyGraphArtifacts(cached, status);
      let refreshed = graphStatusForTarget(options, projectRoot, module, graphify);
      if (!refreshed.graphReady) {
        failed += 1;
        console.log(`FAIL graph reuse did not produce a ready graph for ${module.id}`);
        continue;
      }
      if (options.semantic && !options.noCluster) {
        await summarizeSemanticGraph(refreshed, options);
        refreshed = graphStatusForTarget(options, projectRoot, module, graphify);
      }
      reused += 1;
      console.log(`REUSE ${module.id}: ${refreshed.nodeCount} nodes, ${refreshed.edgeCount} edges from ${cached.module?.id || targetKey}`);
      addToGlobal(refreshed, module);
      continue;
    }

    const result = options.semantic
      ? runGraphify(
        ["extract", status.targetRoot, "--out", status.graphRoot, ...(options.noCluster ? ["--no-cluster"] : [])],
        { ...options, stdio: options.quiet ? "pipe" : "inherit" },
      )
      : runCodeOnlyGraphify(status, options);
    const semanticSummaryEligible = options.semantic && !options.noCluster && result.status === 0;
    if (result.status !== 0) {
      const mode = options.semantic ? "graphify extract" : "local code-only extraction";
      console.log(`FAIL ${mode} exited ${result.status} for ${module.id}`);
      if (result.message) console.log(result.message);
      if (options.quiet && result.stderr) console.log(result.stderr.trim());
      if (options.semantic) {
        const fallback = runCodeOnlyGraphify(status, options);
        if (fallback.status !== 0) {
          failed += 1;
          console.log(`FAIL local code-only recovery exited ${fallback.status} for ${module.id}`);
          if (fallback.message) console.log(fallback.message);
          if (options.quiet && fallback.stderr) console.log(fallback.stderr.trim());
          if (options.quiet && fallback.stdout) console.log(fallback.stdout.trim());
          continue;
        }
        if (options.quiet && fallback.stdout) console.log(fallback.stdout.trim());
      } else {
        if (result.timedOut && options.noCluster && writeGraphFromAstCache(status, result.message)) {
          const refreshed = graphStatusForTarget(options, projectRoot, module, graphify);
          if (refreshed.graphReady) {
            built += 1;
            readyByTargetRoot.set(targetKey, refreshed);
            console.log(`OK ${module.id}: ${refreshed.nodeCount} nodes, ${refreshed.edgeCount} edges`);
            addToGlobal(refreshed, module);
            continue;
          }
        }
        failed += 1;
        if (options.quiet && result.stdout) console.log(result.stdout.trim());
        continue;
      }
    } else if (options.quiet && result.stdout) {
      console.log(result.stdout.trim());
    }

    let refreshed = graphStatusForTarget(options, projectRoot, module, graphify);
    if (!refreshed.graphReady) {
      console.log(`WARN graph is empty or unreadable: ${refreshed.graphPath}`);
      const recovery = options.semantic ? runCodeOnlyGraphify(status, options) : result;
      if (recovery.status !== 0) {
        zeroNode += 1;
        console.log(`FAIL local code-only recovery exited ${recovery.status} for ${module.id}`);
        if (recovery.message) console.log(recovery.message);
        if (options.quiet && recovery.stderr) console.log(recovery.stderr.trim());
        if (options.quiet && recovery.stdout) console.log(recovery.stdout.trim());
        continue;
      }
      if (options.semantic && options.quiet && recovery.stdout) console.log(recovery.stdout.trim());
      refreshed = graphStatusForTarget(options, projectRoot, module, graphify);
      if (!refreshed.graphReady) {
        zeroNode += 1;
        console.log(`WARN local code-only graph is still empty or unreadable: ${refreshed.graphPath}`);
        continue;
      }
    }

    if (semanticSummaryEligible) {
      await summarizeSemanticGraph(refreshed, options);
      refreshed = graphStatusForTarget(options, projectRoot, module, graphify);
    }

    built += 1;
    readyByTargetRoot.set(targetKey, refreshed);
    console.log(`OK ${module.id}: ${refreshed.nodeCount} nodes, ${refreshed.edgeCount} edges`);
    addToGlobal(refreshed, module);
  }

  console.log(`\nmodule graph refresh summary: built ${built}, reused ${reused}, skipped ${skipped}, empty ${zeroNode}, failed ${failed}, global skipped ${globalSkipped}`);
  if (globalDisabledReason) console.log(`global add disabled reason: ${globalDisabledReason}`);
  if (failed) return 1;
  return commandCheckModules({ ...options, strict: false, projectRoot });
}

function runGlobalGraphAdd(graphPath: string, tag: string, options: GraphifyRuntimeOptions): SpawnOutcome {
  const unionPath = path.join(path.dirname(graphPath), `.sma-global-union-${slug(tag)}.json`);
  const graph = namespaceGraph(readJson<Parameters<typeof namespaceGraph>[0]>(graphPath), tag);
  writeFileSync(unionPath, JSON.stringify(graph, null, 2) + "\n");
  try {
    return runGraphify(["global", "add", unionPath, "--as", tag], options);
  } finally {
    rmSync(unionPath, { force: true });
  }
}

function commandProjectFromModules(options: GraphifyOptions): number {
  const projectRoot = resolveProjectRoot(options);
  ensureGraphifyOutLocalExclude(projectRoot);
  const graphify = graphifyBin();
  const moduleStatuses = moduleTargetsForProject(options, projectRoot)
    .map((module) => graphStatusForTarget(options, projectRoot, module, graphify));
  let readyStatuses = moduleStatuses.filter((status) => status.graphReady);
  const readyStatusCount = readyStatuses.length;
  if (typeof options.limit === 'number' && Number.isFinite(options.limit) && options.limit >= 0) {
    if (options.limit < readyStatusCount) {
      throw new Error(`refusing to write a partial project graph from ${options.limit}/${readyStatusCount} module graphs; omit --limit for the canonical project graph`);
    }
    readyStatuses = readyStatuses.slice(0, options.limit);
  }
  if (!readyStatuses.length) {
    throw new Error(`No ready module graphs found for ${projectRoot}`);
  }

  const graphEntries: { graph: Parameters<typeof mergeNamespacedGraphs>[0][number]['graph']; namespace: string }[] = [];
  let readFailures = 0;

  for (const status of readyStatuses) {
    try {
      const graph = readJson<Parameters<typeof mergeNamespacedGraphs>[0][number]['graph']>(status.graphPath);
      graphEntries.push({ graph, namespace: status.projectTag });
    } catch (error: unknown) {
      readFailures += 1;
      console.log(`WARN could not read module graph ${status.graphPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const graphRoot = path.join(projectRoot, "graphify-out");
  const graphPath = path.join(graphRoot, "graph.json");
  const reportPath = path.join(graphRoot, "GRAPH_REPORT.md");
  mkdirSync(graphRoot, { recursive: true });

  const statusSummary = moduleGraphStatus(options);
  const union = mergeNamespacedGraphs(graphEntries);
  const merged = {
    nodes: union.nodes,
    edges: union.edges,
    hyperedges: union.hyperedges,
    input_tokens: union.inputTokens,
    output_tokens: union.outputTokens,
    metadata: {
      sma_status: "project_from_module_graphs",
      project: options.project || path.basename(projectRoot),
      source: "SMA module graph union",
      module_graphs_used: readyStatuses.length - readFailures,
      module_graph_read_failures: readFailures,
      module_graphs_ready: statusSummary.moduleCount - statusSummary.missingCount,
      module_graphs_total: statusSummary.moduleCount,
      known_empty_graphs: statusSummary.knownEmptyCount,
      missing_targets: statusSummary.missingTargetCount,
      local_code_only: true,
      generated_at: new Date().toISOString(),
    },
  };

  writeFileSync(graphPath, JSON.stringify(merged, null, 2) + "\n");
  writeFileSync(reportPath, [
    "# SMA Project Graph From Module Graphs",
    "",
    `Source: ${projectRoot}`,
    `Module graphs used: ${readyStatuses.length - readFailures}`,
    `Module graphs ready: ${statusSummary.moduleCount - statusSummary.missingCount}/${statusSummary.moduleCount}`,
    `Known empty graphs: ${statusSummary.knownEmptyCount}`,
    `Missing targets: ${statusSummary.missingTargetCount}`,
    `Nodes: ${union.nodes.length}`,
    `Edges: ${union.edges.length}`,
    `Hyperedges: ${union.hyperedges.length}`,
    "",
    "Generated by the SMA Graphify bridge from existing local module graphs. This path does not call external LLM APIs.",
  ].join("\n") + "\n");

  console.log(`project graph from modules: ${union.nodes.length} nodes, ${union.edges.length} edges, ${readyStatuses.length - readFailures} module graphs`);

  if (options.global) {
    const preflightReason = graphifyGlobalAddPreflightReason();
    if (preflightReason) {
      console.log(`WARN graphify global add skipped: ${preflightReason}`);
    } else {
      const globalResult = runGlobalGraphAdd(
        graphPath,
        projectTag(options, projectRoot),
        { ...options, stdio: options.quiet ? "pipe" : "inherit" },
      );
      if (globalResult.status !== 0) {
        const capMessage = graphifyGlobalCapMessage(globalResult);
        if (capMessage) {
          console.log(`WARN graphify global add skipped: ${capMessage}`);
        } else {
          if (globalResult.message) console.log(globalResult.message);
          if (options.quiet && globalResult.stderr) console.log(globalResult.stderr.trim());
          return globalResult.status;
        }
      }
    }
  }

  return commandCheck({ ...options, strict: false, projectRoot });
}

async function commandEmbeddingIndex(options: GraphifyOptions): Promise<number> {
  const status = requireGraph(options);
  const result = await buildEmbeddingIndex({ graphPath: status.graphPath });
  if (!result.built || !("count" in result)) return 0;
  console.log(`embedding index: ${result.count} nodes, ${result.dims} dims, ${result.backend}/${result.model}`);
  return 0;
}

async function commandQuery(options: GraphifyOptions): Promise<number> {
  const status = requireGraph(options);
  const question = options.rest.join(" ").trim();
  if (!question) throw new Error("query requires a question after --");
  const ranked = options.semanticRank
    ? await semanticRerankQuery({ graphPath: status.graphPath, question })
    : { expandedQuestion: question };
  const result = runGraphify(["query", ranked.expandedQuestion, "--graph", status.graphPath, "--budget", String(options.budget)],
    { ...options, stdio: "pipe" });
  if (result.status !== 0) {
    printSpawnDetails(result);
    return result.status;
  }
  const communityBlock = communitySummaryBlock({
    graphPath: status.graphPath,
    question,
    hits: 'hits' in ranked ? ranked.hits : undefined,
    traversalOutput: result.stdout,
  });
  if (communityBlock) {
    console.log(communityBlock);
    console.log("\n## Traversal result");
  }
  if (result.stdout) console.log(result.stdout.trim());
  if (result.stderr) console.log(result.stderr.trim());
  return result.status;
}

function commandPath(options: GraphifyOptions): number {
  const status = requireGraph(options);
  if (options.rest.length < 2) throw new Error("path requires two node labels after --");
  const graph = readJson<Parameters<typeof resolveGraphNodeInput>[0]>(status.graphPath);
  const source = resolveGraphNodeInput(graph, options.rest[0]);
  const target = resolveGraphNodeInput(graph, options.rest[1]);
  const result = runGraphify(["path", source, target, "--graph", status.graphPath]);
  return result.status;
}

function commandExplain(options: GraphifyOptions): number {
  const status = requireGraph(options);
  const label = options.rest.join(" ").trim();
  if (!label) throw new Error("explain requires a node label after --");
  const resolved = resolveGraphNodeInput(readJson<Parameters<typeof resolveGraphNodeInput>[0]>(status.graphPath), label);
  const result = runGraphify(["explain", resolved, "--graph", status.graphPath]);
  return result.status;
}

function commandGlobalList(): number {
  return runGraphify(["global", "list"]).status;
}

function commandGlobalPath(): number {
  return runGraphify(["global", "path"]).status;
}

async function commandGlobal(options: GraphifyOptions): Promise<number> {
  const [subcommand, ...rest] = options.rest;
  if (subcommand === "list") return commandGlobalList();
  if (subcommand === "path") return commandGlobalPath();
  if (subcommand !== "query") throw new Error("global requires one of: list, path, query");
  console.log(await queryGlobalGraph({ question: rest.join(" "), tags: options.tags, budget: options.budget, graphifyPath: graphifyBin() }));
  return 0;
}

async function commandSelftest() {
  const graphifyCli = graphifyBin(); // optional external graphify CLI is absent on bare CI; skip its global-query selftest there (pure-logic selftests below still run)
  if (graphifyCli) await selftestGlobalQuery({ graphifyPath: graphifyCli }); else console.log("SKIP global-query selftest (graphify CLI not installed)");
  const stderrCap = graphifyGlobalCapMessage({
    stderr: "Error: global graph exceeds GRAPHIFY_MAX_GRAPH_BYTES 512MB",
    stdout: "",
  });
  assertSelftest(stderrCap.includes("exceeds"), "cap message should be parsed from stderr");
  const stdoutCap = graphifyGlobalCapMessage({
    stderr: "",
    stdout: "global graph exceeds GRAPHIFY_MAX_GRAPH_BYTES 512MB",
  });
  assertSelftest(stdoutCap.includes("exceeds"), "cap message should be parsed from stdout");
  const noCap = graphifyGlobalCapMessage({
    stderr: "network failure",
    stdout: "",
  });
  assertSelftest(noCap === "", "non-cap failures must not be downgraded");
  assertSelftest(parseByteLimit("1GB") === 1024 ** 3, "GB byte limit parsing failed");
  assertSelftest(parseByteLimit("512MB") === 512 * 1024 ** 2, "MB byte limit parsing failed");

  const collisionUnion = mergeNamespacedGraphs([
    {
      namespace: "module-a",
      graph: {
        nodes: [{ id: "shared", label: "Shared A" }, { id: "only-a", label: "Only A" }],
        edges: [{ source: "shared", target: "only-a", relation: "calls" }],
        hyperedges: [{ id: "flow", nodes: ["shared", "only-a"], relation: "participate_in" }],
      },
    },
    {
      namespace: "module-b",
      graph: {
        nodes: [{ id: "shared", label: "Shared B" }, { id: "only-b", label: "Only B" }],
        edges: [{ source: "shared", target: "only-b", relation: "calls" }],
      },
    },
  ]);
  assertSelftest(collisionUnion.nodes.length === 4, "same raw node id from separate modules must not merge");
  assertSelftest(collisionUnion.nodes.some((node) => node.id === "module-a::shared" && node.original_id === "shared"), "module A node must retain its original id");
  assertSelftest(collisionUnion.nodes.some((node) => node.id === "module-b::shared" && node.original_id === "shared"), "module B node must retain its original id");
  assertSelftest(collisionUnion.edges.some((edge) => edge.source === "module-a::shared" && edge.target === "module-a::only-a"), "edge endpoints must follow namespaced node ids");
  const hyperedgeNodes = collisionUnion.hyperedges[0]?.nodes;
  assertSelftest(Array.isArray(hyperedgeNodes) && hyperedgeNodes.includes("module-a::shared"), "hyperedge members must follow namespaced node ids");
  assertSelftest(resolveGraphNodeInput(collisionUnion, "module-a::shared") === "module-a::shared", "qualified node ids must resolve directly");
  assertSelftest(resolveGraphNodeInput(collisionUnion, "only-a") === "module-a::only-a", "unique original node ids must resolve to their qualified form");
  let ambiguousOriginalRejected = false;
  try {
    resolveGraphNodeInput(collisionUnion, "shared");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    ambiguousOriginalRejected = message.includes("module-a::shared") && message.includes("module-b::shared");
  }
  assertSelftest(ambiguousOriginalRejected, "ambiguous original node ids must require a qualified form");

  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "sma-graphify-staleness-"));
  try {
    const sourceRoot = path.join(fixtureRoot, "src", "fixture");
    const moduleTarget: ModuleTarget = {
      id: "fixture-module",
      name: "Fixture module",
      project: "fixture",
      root: sourceRoot,
      scanRoot: sourceRoot,
      sourceKind: "directory",
      sourcePath: "src/fixture",
    };
    mkdirSync(sourceRoot, { recursive: true });
    const sourcePath = path.join(sourceRoot, "index.mjs");
    writeFileSync(sourcePath, "export const fixture = true;\n");

    const strictOptions = { ...parseArgs(["check", "--strict"]), projectRoot: fixtureRoot };
    const initialStatus = graphStatusForTarget(strictOptions, fixtureRoot, moduleTarget, process.execPath);
    mkdirSync(path.dirname(initialStatus.graphPath), { recursive: true });
    writeFileSync(initialStatus.graphPath, JSON.stringify({ nodes: [{ id: "fixture" }], edges: [] }) + "\n");

    const oldTime = new Date(Date.now() - 20_000);
    const newTime = new Date(Date.now() - 10_000);
    utimesSync(initialStatus.graphPath, oldTime, oldTime);
    utimesSync(sourcePath, newTime, newTime);

    const staleStatus = graphStatusForTarget(strictOptions, fixtureRoot, moduleTarget, process.execPath);
    assertSelftest(staleStatus.graphStale && staleStatus.graphFreshness === "stale", "newer fallback source should make the graph stale");
    assertSelftest(checkExitCode(strictOptions, staleStatus) === 1, "strict check should fail for a stale graph");

    const staleOkOptions = { ...parseArgs(["check", "--strict", "--stale-ok"]), projectRoot: fixtureRoot };
    const staleOkStatus = graphStatusForTarget(staleOkOptions, fixtureRoot, moduleTarget, process.execPath);
    assertSelftest(staleOkStatus.graphStale && checkExitCode(staleOkOptions, staleOkStatus) === 0, "--stale-ok should accept a stale graph");

    const freshTime = new Date(Date.now());
    utimesSync(initialStatus.graphPath, freshTime, freshTime);
    const freshStatus = graphStatusForTarget(strictOptions, fixtureRoot, moduleTarget, process.execPath);
    assertSelftest(freshStatus.graphFresh && freshStatus.graphFreshness === "fresh", "newer graph should be fresh");
    assertSelftest(checkExitCode(strictOptions, freshStatus) === 0, "strict check should pass for a fresh graph");

    const unownedPath = path.join(sourceRoot, "unowned.mjs");
    writeFileSync(unownedPath, "export const unowned = true;\n");
    utimesSync(unownedPath, new Date(Date.now() + 10_000), new Date(Date.now() + 10_000));
    const gen3Config = {
      modules: [{ id: moduleTarget.id, label: moduleTarget.name, paths: ["src/fixture/index.mjs"] }],
    };
    writeFileSync(path.join(fixtureRoot, "sma.gen3.json"), JSON.stringify(gen3Config, null, 2) + "\n");
    const ownershipStatus = graphStatusForTarget({ ...strictOptions, gen3Config }, fixtureRoot, moduleTarget, process.execPath);
    assertSelftest(ownershipStatus.graphFresh, "repo-root ownership globs should ignore newer unowned files");
    const newestTime = new Date(Date.now() + 20_000);
    utimesSync(sourcePath, newestTime, newestTime);
    const ownedStaleStatus = graphStatusForTarget({ ...strictOptions, gen3Config }, fixtureRoot, moduleTarget, process.execPath);
    assertSelftest(ownedStaleStatus.graphStale, "newer owned source should make the graph stale");

    writeFileSync(initialStatus.graphPath, JSON.stringify({
      nodes: [],
      edges: [],
      metadata: { sma_status: "empty", reason: "fixture has no source nodes" },
    }) + "\n");
    utimesSync(initialStatus.graphPath, oldTime, oldTime);
    const emptyStatus = graphStatusForTarget(strictOptions, fixtureRoot, moduleTarget, process.execPath);
    assertSelftest(emptyStatus.graphKnownEmpty && !emptyStatus.graphStale, "known-empty graphs must keep existing semantics");

    await selftestEmbeddingContentAddress({ fixtureRoot, assert: assertSelftest });
    assertSelftest(!parseArgs(["query", "--no-semantic-rank", "--", "question"]).semanticRank, "query should allow semantic ranking opt-out");

    await selftestCommunitySummaries({ fixtureRoot, assert: assertSelftest });
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }

  console.log("OK sma-graphify selftest");
  return 0;
}

function assertSelftest(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`selftest failed: ${message}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.command === "help" || options.command === "--help" || options.command === "-h") {
    printHelp();
    return 0;
  }

  if (options.command === "check") return commandCheck(options);
  if (options.command === "check-modules") return commandCheckModules(options);
  if (options.command === "refresh") return commandRefresh(options);
  if (options.command === "refresh-modules") return commandRefreshModules(options);
  if (options.command === "project-from-modules") return commandProjectFromModules(options);
  if (options.command === "target-fixes") return commandTargetFixes(options);
  if (options.command === "embedding-index") return commandEmbeddingIndex(options);
  if (options.command === "query") return commandQuery(options);
  if (options.command === "path") return commandPath(options);
  if (options.command === "explain") return commandExplain(options);
  if (options.command === "global") return commandGlobal(options);
  if (options.command === "global-list") return commandGlobalList();
  if (options.command === "global-path") return commandGlobalPath();
  if (options.command === "selftest") return commandSelftest();

  throw new Error(`Unknown command: ${options.command}`);
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
