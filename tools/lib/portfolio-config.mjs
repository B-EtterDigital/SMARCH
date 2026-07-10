/**
 * portfolio-config.mjs — optional local portfolio description.
 *
 * The public framework ships with an empty portfolio. Each operator describes
 * their own machine in registry/portfolio.config.json (gitignored), or points
 * SMA_PORTFOLIO_CONFIG at another file. See
 * registry/portfolio.config.example.json for the shape.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { SMA_ROOT } from "./sma-paths.mjs";

const DEFAULT_CONFIG = {
  priority_project_ids: [],
  overrides: {},
  ignored_top_level_dirs: ["DEPRECATED", "RESEARCH", "node_modules", ".netlify", ".sweetspot"],
  ignored_name_fragments: ["backup", "corrupt"],
};

let cached = null;

export function loadPortfolioConfig() {
  if (cached) return cached;
  const configPath = process.env.SMA_PORTFOLIO_CONFIG
    ? path.resolve(process.env.SMA_PORTFOLIO_CONFIG)
    : path.join(SMA_ROOT, "registry", "portfolio.config.json");
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    raw = {};
  }
  cached = {
    priority_project_ids: Array.isArray(raw.priority_project_ids)
      ? raw.priority_project_ids.map(String)
      : DEFAULT_CONFIG.priority_project_ids,
    overrides: raw.overrides && typeof raw.overrides === "object" ? raw.overrides : DEFAULT_CONFIG.overrides,
    ignored_top_level_dirs: Array.isArray(raw.ignored_top_level_dirs)
      ? raw.ignored_top_level_dirs.map(String)
      : DEFAULT_CONFIG.ignored_top_level_dirs,
    ignored_name_fragments: Array.isArray(raw.ignored_name_fragments)
      ? raw.ignored_name_fragments.map(String)
      : DEFAULT_CONFIG.ignored_name_fragments,
  };
  return cached;
}
