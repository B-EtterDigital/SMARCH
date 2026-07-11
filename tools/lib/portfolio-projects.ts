/**
 * WHAT: Discovers and priority-sorts projects that belong to the local portfolio.
 * WHY: Scanners need one bounded project inventory instead of inconsistent directory guesses.
 * HOW: Combines configured overrides, root markers, ignore rules, caching, and strict discovery errors.
 * INPUTS: An optional projects root, file-system adapter, logger, and strictness setting.
 * OUTPUTS: Normalized project records, priority ranks, or a typed discovery error.
 * CALLERS: Portfolio scans, controller snapshots, and generated state builders share this inventory.
 * @example node --input-type=module -e "import { discoverPortfolioProjects } from './tools/lib/portfolio-projects.ts'; console.log((await discoverPortfolioProjects({ strict: false })).length);"
 */
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { PROJECTS_ROOT } from "./sma-paths.ts";
import { loadPortfolioConfig } from "./portfolio-config.ts";
import type { Dirent } from "node:fs";

const portfolioConfig = loadPortfolioConfig();

export const portfolioProjectsRoot = PROJECTS_ROOT;
export const priorityProjectIds = [...portfolioConfig.priority_project_ids];

const ignoredTopLevelDirs = new Set(portfolioConfig.ignored_top_level_dirs);

const ignoredNameFragments = [...portfolioConfig.ignored_name_fragments];

const rootMarkers = [".git", "package.json", "pnpm-workspace.yaml"];

export type PortfolioProject = {
  id: string;
  name: string;
  relative_root: string;
  absolute_root: string;
  priority_tier: "priority" | "standard";
  priority_rank?: number;
  portfolio_rank?: number;
};

type DirectoryEntry = Pick<Dirent, "name" | "isDirectory">;
type PortfolioFs = {
  readdir(directory: string, options: { withFileTypes: true }): Promise<DirectoryEntry[]>;
  access(file: string): Promise<void>;
};
type PortfolioLogger = { warn?: (message: string) => void };
type PortfolioOptions = {
  projectsRoot?: string;
  fsApi?: PortfolioFs;
  logger?: PortfolioLogger;
  strict?: boolean;
};

const portfolioOverrides = new Map(Object.entries(portfolioConfig.overrides));

let portfolioCache: Promise<PortfolioProject[]> | null = null;

class PortfolioDiscoveryError extends Error {
  code: string;
  details: { directory: string; cause_code: string };

  constructor(directory: string, cause: unknown) {
    const code = cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string" ? cause.code : "UNKNOWN";
    super(`portfolio discovery could not read ${directory} (${code}): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PortfolioDiscoveryError";
    this.code = "PORTFOLIO_DISCOVERY_UNREADABLE";
    this.details = { directory, cause_code: code };
  }
}

export async function discoverPortfolioProjects(options: PortfolioOptions = {}): Promise<PortfolioProject[]> {
  if (Object.keys(options).length > 0) {
    return loadPortfolioProjects(options);
  }
  if (!portfolioCache) {
    portfolioCache = loadPortfolioProjects({
      strict: process.argv.includes("--strict"),
    });
  }
  return portfolioCache;
}

export function projectPriorityRank(projectId: unknown, portfolioProjects: PortfolioProject[] = []): number {
  const id = String(projectId || "").trim();
  const priorityIndex = priorityProjectIds.indexOf(id);
  if (priorityIndex >= 0) return priorityIndex + 1;

  const portfolioIndex = portfolioProjects.findIndex((entry) => entry.id === id);
  if (portfolioIndex >= 0) return priorityProjectIds.length + portfolioIndex + 1;

  return priorityProjectIds.length + portfolioProjects.length + 1;
}

export function sortByPortfolioPriority<T>(entries: T[], portfolioProjects: PortfolioProject[] = [], idSelector: (entry: T) => unknown): T[] {
  return [...entries].sort((left, right) => {
    const leftId = String(idSelector(left) || "");
    const rightId = String(idSelector(right) || "");
    return projectPriorityRank(leftId, portfolioProjects) - projectPriorityRank(rightId, portfolioProjects)
      || leftId.localeCompare(rightId);
  });
}

async function loadPortfolioProjects({
  projectsRoot = portfolioProjectsRoot,
  fsApi = fs,
  logger = console,
  strict = process.argv.includes("--strict"),
}: PortfolioOptions = {}): Promise<PortfolioProject[]> {
  const readDirectory = async (directory: string): Promise<DirectoryEntry[]> => {
    try {
      return await fsApi.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      const discoveryError = new PortfolioDiscoveryError(directory, error);
      logger?.warn?.(`warn: ${discoveryError.message}`);
      if (strict) throw discoveryError;
      return [];
    }
  };

  const topEntries = await readDirectory(projectsRoot);
  const results: PortfolioProject[] = [];

  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    if (shouldIgnore(entry.name)) continue;

    const topPath = path.join(projectsRoot, entry.name);
    if (await hasProjectMarkers(topPath, fsApi)) {
      results.push(await describeProject(topPath, projectsRoot));
      continue;
    }

    const nestedEntries = await readDirectory(topPath);
    for (const nested of nestedEntries) {
      if (!nested.isDirectory()) continue;
      if (shouldIgnore(nested.name)) continue;

      const nestedPath = path.join(topPath, nested.name);
      if (await hasProjectMarkers(nestedPath, fsApi)) {
        results.push(await describeProject(nestedPath, projectsRoot));
      }
    }
  }

  const deduped = new Map<string, PortfolioProject>();
  for (const entry of results) {
    const current = deduped.get(entry.id);
    if (!current || entry.relative_root.length < current.relative_root.length) {
      deduped.set(entry.id, entry);
    }
  }

  const sorted = sortByPortfolioPriority(
    [...deduped.values()],
    [...deduped.values()],
    (entry) => entry.id,
  );

  return sorted.map((entry, index) => ({
    ...entry,
    priority_rank: projectPriorityRank(entry.id, sorted),
    portfolio_rank: index + 1,
  }));
}

async function describeProject(absolutePath: string, projectsRoot = portfolioProjectsRoot): Promise<PortfolioProject> {
  const relativeRoot = normalizePath(path.relative(projectsRoot, absolutePath));
  const override = portfolioOverrides.get(relativeRoot) || {};
  const id = override.id || slugify(relativeRoot);
  const name = override.name || humanizeName(path.basename(absolutePath));

  return {
    id,
    name,
    relative_root: relativeRoot,
    absolute_root: absolutePath,
    priority_tier: priorityProjectIds.includes(id) ? "priority" : "standard",
  };
}

async function hasProjectMarkers(absolutePath: string, fsApi: PortfolioFs = fs): Promise<boolean> {
  for (const marker of rootMarkers) {
    try {
      await fsApi.access(path.join(absolutePath, marker));
      return true;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
      if (code !== 'ENOENT') console.error(JSON.stringify({ area: 'portfolio-projects.root-marker', severity: 'warning', hint: 'Check marker access permissions for the candidate project.', error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) }));
      continue;
    }
  }
  return false;
}

function shouldIgnore(name: unknown): boolean {
  const value = String(name || "");
  if (!value || value.startsWith(".")) return true;
  if (ignoredTopLevelDirs.has(value)) return true;
  const lowered = value.toLowerCase();
  return ignoredNameFragments.some((fragment) => lowered.includes(fragment));
}

function slugify(value: unknown): string {
  return String(value || "project")
    .toLowerCase()
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

function humanizeName(value: unknown): string {
  return String(value || "Project")
    .replace(/[_-]+/g, " ")
    .replace(/\b0+([A-Za-z0-9])/g, "$1")
    .replace(/\s+/g, " ")
    .trim() || "Project";
}

function normalizePath(value: unknown): string {
  return String(value || "").split(path.sep).join("/");
}

async function runSelftest() {
  const projectsRoot = path.resolve("/virtual/projects");
  const directoryEntry = (name: string): DirectoryEntry => ({ name, isDirectory: () => true });
  const unreadable = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const missing = Object.assign(new Error("not found"), { code: "ENOENT" });
  const warnings: string[] = [];
  const fsApi: PortfolioFs = {
    async access() {
      throw missing;
    },
    async readdir(directory: string) {
      if (directory === projectsRoot) return [directoryEntry("unreadable")];
      throw unreadable;
    },
  };

  const nonStrict = await discoverPortfolioProjects({
    projectsRoot,
    fsApi,
    strict: false,
    logger: { warn: (message: string) => { warnings.push(message); } },
  });
  assert.deepEqual(nonStrict, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /EACCES/);

  await assert.rejects(
    discoverPortfolioProjects({
      projectsRoot,
      fsApi,
      strict: true,
    logger: { warn: (message: string) => { warnings.push(message); } },
    }),
    (error: unknown) => error instanceof PortfolioDiscoveryError
      && error.details.cause_code === "EACCES",
  );

  const emptyWarnings: string[] = [];
  const empty = await discoverPortfolioProjects({
    projectsRoot,
    fsApi: {
      async access() {
        throw missing;
      },
      async readdir() {
        throw missing;
      },
    },
    strict: true,
    logger: { warn: (message: string) => { emptyWarnings.push(message); } },
  });
  assert.deepEqual(empty, []);
  assert.deepEqual(emptyWarnings, []);
  process.stdout.write("portfolio-projects selftest: PASS\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--selftest")) {
    runSelftest().catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
  }
}
