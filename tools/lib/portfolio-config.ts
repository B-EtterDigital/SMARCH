/**
 * portfolio-config.ts — optional local portfolio description.
 *
 * The public framework ships with an empty portfolio. Each operator describes
 * their own machine in registry/portfolio.config.json (gitignored), or points
 * SMA_PORTFOLIO_CONFIG at another file. See
 * registry/portfolio.config.example.json for the shape.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { SMA_ROOT } from "./sma-paths.ts";

interface PortfolioConfig {
  priority_project_ids: string[];
  overrides: Record<string, PortfolioOverride>;
  ignored_top_level_dirs: string[];
  ignored_name_fragments: string[];
}

export interface PortfolioOverride { id?: string; name?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeOverrides(value: unknown): Record<string, PortfolioOverride> {
  if (!isRecord(value)) return DEFAULT_CONFIG.overrides;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (!isRecord(entry)) return [key, {}];
    return [key, {
      ...(typeof entry.id === "string" ? { id: entry.id } : {}),
      ...(typeof entry.name === "string" ? { name: entry.name } : {}),
    }];
  }));
}

const DEFAULT_CONFIG: PortfolioConfig = {
  priority_project_ids: [],
  overrides: {},
  ignored_top_level_dirs: ["DEPRECATED", "RESEARCH", "node_modules", ".netlify", ".sweetspot"],
  ignored_name_fragments: ["backup", "corrupt"],
};

let cached: PortfolioConfig | null = null;

export function loadPortfolioConfig() {
  if (cached) return cached;
  const configPath = process.env.SMA_PORTFOLIO_CONFIG
    ? path.resolve(process.env.SMA_PORTFOLIO_CONFIG)
    : path.join(SMA_ROOT, "registry", "portfolio.config.json");
  let raw: Partial<PortfolioConfig> & Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8")) as Partial<PortfolioConfig> & Record<string, unknown>;
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
      console.error(JSON.stringify({
        area: "portfolio-config.load",
        severity: "warning",
        config_path: configPath,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  cached = {
    priority_project_ids: Array.isArray(raw.priority_project_ids)
      ? raw.priority_project_ids.map(String)
      : DEFAULT_CONFIG.priority_project_ids,
    overrides: normalizeOverrides(raw.overrides),
    ignored_top_level_dirs: Array.isArray(raw.ignored_top_level_dirs)
      ? raw.ignored_top_level_dirs.map(String)
      : DEFAULT_CONFIG.ignored_top_level_dirs,
    ignored_name_fragments: Array.isArray(raw.ignored_name_fragments)
      ? raw.ignored_name_fragments.map(String)
      : DEFAULT_CONFIG.ignored_name_fragments,
  };
  return cached;
}
