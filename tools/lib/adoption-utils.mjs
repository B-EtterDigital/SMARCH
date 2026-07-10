import path from "node:path";
import { defaultPaths, maybeReadJson } from "./sma-adoption.mjs";

export const DEFAULT_STATE_PATH = defaultPaths.state;
export const DEFAULT_REGISTRY_PATH = defaultPaths.registry;

export function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

export function tokenize(value) {
  return [...new Set(
    String(value || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter((token) => token.length >= 2)
  )];
}

export function tokenOverlapScore(queryTokens, ...parts) {
  if (!Array.isArray(queryTokens) || queryTokens.length === 0) return 0;
  const haystack = new Set(tokenize(parts.filter(Boolean).join(" ")));
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) score += 1;
  }
  return score;
}

export function relativeFromCwd(cwd, targetPath) {
  return path.relative(cwd, targetPath).split(path.sep).join("/");
}

export function parseArgs(argv, options = {}) {
  const booleanFlags = new Set(options.booleanFlags || []);
  const parsed = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }

    const key = arg.slice(2);
    if (booleanFlags.has(key)) {
      parsed[key] = true;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "";
      continue;
    }
    parsed[key] = next;
    index += 1;
  }

  return parsed;
}

export async function loadStateAndRegistry({ cwd, statePath = DEFAULT_STATE_PATH, registryPath = DEFAULT_REGISTRY_PATH }) {
  const absoluteStatePath = path.resolve(cwd, statePath);
  const absoluteRegistryPath = path.resolve(cwd, registryPath);
  const [state, registry] = await Promise.all([
    maybeReadJson(absoluteStatePath),
    maybeReadJson(absoluteRegistryPath),
  ]);

  if (!state) {
    throw new Error(`missing state snapshot at ${absoluteStatePath}`);
  }
  if (!registry) {
    throw new Error(`missing merged registry at ${absoluteRegistryPath}`);
  }

  return {
    state,
    registry,
    statePath: absoluteStatePath,
    registryPath: absoluteRegistryPath,
  };
}

export function compareBy(key, direction = "asc") {
  const factor = direction === "desc" ? -1 : 1;
  return (left, right) => {
    const a = Number(left?.[key] ?? 0);
    const b = Number(right?.[key] ?? 0);
    if (a !== b) return (a - b) * factor;
    return String(left?.name || left?.project || left?.target_id || "").localeCompare(String(right?.name || right?.project || right?.target_id || ""));
  };
}

export function topList(values, limit = 5, comparator = null) {
  const rows = Array.isArray(values) ? [...values] : [];
  if (typeof comparator === "function") rows.sort(comparator);
  return rows.slice(0, limit);
}

export function uniqueBy(values, keyFn) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function fuzzyMatchScore(query, ...fields) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return 0;
  const tokens = q.split(/\s+/).filter(Boolean);
  let score = 0;

  for (const field of fields) {
    const haystack = String(field || "").toLowerCase();
    if (!haystack) continue;
    if (haystack.includes(q)) score += Math.max(4, tokens.length * 2);
    for (const token of tokens) {
      if (token.length < 2) continue;
      if (haystack.includes(token)) score += 1;
    }
  }

  return score;
}

export function findProjectEntries(state, registry, projectId) {
  const stateProject = (state?.projects || []).find((entry) => String(entry.project) === String(projectId)) || null;
  const registryProject = (registry?.projects || []).find((entry) => String(entry.id || entry.project) === String(projectId)) || null;
  return { stateProject, registryProject };
}
