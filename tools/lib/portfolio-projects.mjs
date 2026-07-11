import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { PROJECTS_ROOT } from "./sma-paths.mjs";
import { loadPortfolioConfig } from "./portfolio-config.mjs";

const portfolioConfig = loadPortfolioConfig();

export const portfolioProjectsRoot = PROJECTS_ROOT;
export const priorityProjectIds = [...portfolioConfig.priority_project_ids];

const ignoredTopLevelDirs = new Set(portfolioConfig.ignored_top_level_dirs);

const ignoredNameFragments = [...portfolioConfig.ignored_name_fragments];

const rootMarkers = [".git", "package.json", "pnpm-workspace.yaml"];

const portfolioOverrides = new Map(Object.entries(portfolioConfig.overrides));

let portfolioCache = null;

export class PortfolioDiscoveryError extends Error {
  constructor(directory, cause) {
    const code = typeof cause?.code === "string" ? cause.code : "UNKNOWN";
    super(`portfolio discovery could not read ${directory} (${code}): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PortfolioDiscoveryError";
    this.code = "PORTFOLIO_DISCOVERY_UNREADABLE";
    this.details = { directory, cause_code: code };
  }
}

export async function discoverPortfolioProjects(options = {}) {
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

export function projectPriorityRank(projectId, portfolioProjects = []) {
  const id = String(projectId || "").trim();
  const priorityIndex = priorityProjectIds.indexOf(id);
  if (priorityIndex >= 0) return priorityIndex + 1;

  const portfolioIndex = portfolioProjects.findIndex((entry) => entry.id === id);
  if (portfolioIndex >= 0) return priorityProjectIds.length + portfolioIndex + 1;

  return priorityProjectIds.length + portfolioProjects.length + 1;
}

export function sortByPortfolioPriority(entries, portfolioProjects = [], idSelector = (entry) => entry?.project || entry?.id) {
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
} = {}) {
  const readDirectory = async (directory) => {
    try {
      return await fsApi.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      const discoveryError = new PortfolioDiscoveryError(directory, error);
      logger?.warn?.(`warn: ${discoveryError.message}`);
      if (strict) throw discoveryError;
      return [];
    }
  };

  const topEntries = await readDirectory(projectsRoot);
  const results = [];

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

  const deduped = new Map();
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

async function describeProject(absolutePath, projectsRoot = portfolioProjectsRoot) {
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

async function hasProjectMarkers(absolutePath, fsApi = fs) {
  for (const marker of rootMarkers) {
    try {
      await fsApi.access(path.join(absolutePath, marker));
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function shouldIgnore(name) {
  const value = String(name || "");
  if (!value || value.startsWith(".")) return true;
  if (ignoredTopLevelDirs.has(value)) return true;
  const lowered = value.toLowerCase();
  return ignoredNameFragments.some((fragment) => lowered.includes(fragment));
}

function slugify(value) {
  return String(value || "project")
    .toLowerCase()
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

function humanizeName(value) {
  return String(value || "Project")
    .replace(/[_-]+/g, " ")
    .replace(/\b0+([A-Za-z0-9])/g, "$1")
    .replace(/\s+/g, " ")
    .trim() || "Project";
}

function normalizePath(value) {
  return String(value || "").split(path.sep).join("/");
}

async function runSelftest() {
  const projectsRoot = path.resolve("/virtual/projects");
  const directoryEntry = (name) => ({ name, isDirectory: () => true });
  const unreadable = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const missing = Object.assign(new Error("not found"), { code: "ENOENT" });
  const warnings = [];
  const fsApi = {
    async access() {
      throw missing;
    },
    async readdir(directory) {
      if (directory === projectsRoot) return [directoryEntry("unreadable")];
      throw unreadable;
    },
  };

  const nonStrict = await discoverPortfolioProjects({
    projectsRoot,
    fsApi,
    strict: false,
    logger: { warn: (message) => warnings.push(message) },
  });
  assert.deepEqual(nonStrict, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /EACCES/);

  await assert.rejects(
    discoverPortfolioProjects({
      projectsRoot,
      fsApi,
      strict: true,
      logger: { warn: (message) => warnings.push(message) },
    }),
    (error) => error instanceof PortfolioDiscoveryError
      && error.details.cause_code === "EACCES",
  );

  const emptyWarnings = [];
  const empty = await discoverPortfolioProjects({
    projectsRoot,
    fsApi: {
      async readdir() {
        throw missing;
      },
    },
    strict: true,
    logger: { warn: (message) => emptyWarnings.push(message) },
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
