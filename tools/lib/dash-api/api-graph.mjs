import fs from "node:fs/promises";
import path from "node:path";
import { DASH_API_MAX_ROWS, DashboardApiError, readJsonFile, runReadHandler, validateQuery } from "./core.mjs";

export const GRAPH_SCOPE = "dashboard:graph:read";
export const GRAPH_CONTRACT = Object.freeze({ method: "GET", path: "/api/graph", idempotent: true, retry: "safe with exponential backoff after 502/504", timeout_ms: 500, max_rows: DASH_API_MAX_ROWS });

export function validateGraphQuery(query) {
  return validateQuery(query, { limit: { type: "integer", min: 1, max: DASH_API_MAX_ROWS, default: DASH_API_MAX_ROWS } });
}

export async function loadGraph(smaRoot, input) {
  const modulesRoot = path.join(smaRoot, "graphify-out", "modules");
  let entries;
  try {
    entries = await fs.readdir(modulesRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") entries = [];
    else throw new DashboardApiError("DASH_API_STORAGE", { cause: error });
  }
  const directories = entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const selected = directories.slice(0, input.limit);
  const modules = (await Promise.all(selected.map(async (entry) => {
    const graphPath = path.join(modulesRoot, entry.name, "graphify-out", "graph.json");
    const graph = await readJsonFile(graphPath, null, { maxBytes: 16 * 1024 * 1024 });
    if (!graph) return null;
    try {
      const stat = await fs.stat(graphPath);
      return { id: entry.name, nodes: Array.isArray(graph.nodes) ? graph.nodes.length : 0, links: Array.isArray(graph.links) ? graph.links.length : 0, updated_at: stat.mtime.toISOString() };
    } catch (error) {
      throw new DashboardApiError("DASH_API_STORAGE", { cause: error });
    }
  }))).filter(Boolean);
  return { generated_at: new Date().toISOString(), stats: { modules: directories.length, returned: modules.length, truncated: directories.length > input.limit, nodes: modules.reduce((total, module) => total + module.nodes, 0), links: modules.reduce((total, module) => total + module.links, 0) }, modules };
}

export function handleGraph(options) {
  return runReadHandler({ ...options, area: "dashboard.api.graph", scope: GRAPH_SCOPE, validate: validateGraphQuery, load: options.load || ((input) => loadGraph(options.root, input)) });
}
