import fs from "node:fs/promises";
import path from "node:path";
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

export async function discoverPortfolioProjects() {
  if (!portfolioCache) {
    portfolioCache = loadPortfolioProjects();
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

async function loadPortfolioProjects() {
  const topEntries = await fs.readdir(portfolioProjectsRoot, { withFileTypes: true });
  const results = [];

  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue;
    if (shouldIgnore(entry.name)) continue;

    const topPath = path.join(portfolioProjectsRoot, entry.name);
    if (await hasProjectMarkers(topPath)) {
      results.push(await describeProject(topPath));
      continue;
    }

    const nestedEntries = await fs.readdir(topPath, { withFileTypes: true }).catch(() => []);
    for (const nested of nestedEntries) {
      if (!nested.isDirectory()) continue;
      if (shouldIgnore(nested.name)) continue;

      const nestedPath = path.join(topPath, nested.name);
      if (await hasProjectMarkers(nestedPath)) {
        results.push(await describeProject(nestedPath));
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

async function describeProject(absolutePath) {
  const relativeRoot = normalizePath(path.relative(portfolioProjectsRoot, absolutePath));
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

async function hasProjectMarkers(absolutePath) {
  for (const marker of rootMarkers) {
    try {
      await fs.access(path.join(absolutePath, marker));
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
