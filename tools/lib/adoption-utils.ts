/* eslint-disable @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-base-to-string -- This untrusted-report boundary intentionally preserves legacy truthy fallback, defensive guards, and JavaScript string coercion; simplifying them changes accepted-input behavior. */
/* eslint-disable complexity -- The comparator is a compact ordered ranking policy; each branch is an independent sort key and extraction would hide precedence. */
/**
 * WHAT: Shared parsing, ranking, formatting, and registry-loading helpers for adoption tools.
 * WHY: Adoption commands otherwise drift when they interpret the same project and registry data separately.
 * HOW: Callers pass command arguments or loaded state; these functions return normalized values and ranked entries.
 * Callers include the doctor, blocked-work explainer, curated-build helpers, and tool server.
 * This module performs no writes and uses the adoption module's canonical default paths.
 * @example node --input-type=module -e "import { formatNumber } from './tools/lib/adoption-utils.ts'; console.log(formatNumber(1234))"
 */
import path from "node:path";
import { defaultPaths, maybeReadJson } from "./sma-adoption.ts";

export const DEFAULT_STATE_PATH = defaultPaths.state;
export const DEFAULT_REGISTRY_PATH = defaultPaths.registry;

type Scalar = string | number | boolean | bigint | null | undefined;
type SortableRecord = Record<string, unknown>;
type ParsedArgs = { _: string[] } & Record<string, string | boolean | string[]>;

export function formatNumber(value: Scalar) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

export function relativeFromCwd(cwd: string, targetPath: string): string {
  return path.relative(cwd, targetPath).split(path.sep).join("/");
}

export function parseArgs(argv: string[], options: { booleanFlags?: string[] } = {}): ParsedArgs {
  const booleanFlags = new Set(options.booleanFlags || []);
  const parsed: ParsedArgs = { _: [] };

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

export async function loadStateAndRegistry({ cwd, statePath = DEFAULT_STATE_PATH, registryPath = DEFAULT_REGISTRY_PATH }: {
  cwd: string;
  statePath?: string;
  registryPath?: string;
}) {
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

export function compareBy<T extends SortableRecord>(key: keyof T & string, direction: "asc" | "desc" = "asc") {
  const factor = direction === "desc" ? -1 : 1;
  return (left: T, right: T): number => {
    const a = Number(left?.[key] ?? 0);
    const b = Number(right?.[key] ?? 0);
    if (a !== b) return (a - b) * factor;
    return String(left?.name || left?.project || left?.target_id || "").localeCompare(String(right?.name || right?.project || right?.target_id || ""));
  };
}

export function topList<T>(values: readonly T[] | null | undefined, limit = 5, comparator: ((left: T, right: T) => number) | null = null): T[] {
  const rows: T[] = Array.isArray(values) ? Array.from(values as readonly T[]) : [];
  if (typeof comparator === "function") rows.sort(comparator);
  return rows.slice(0, limit);
}

export function uniqueBy<T>(values: readonly T[] | null | undefined, keyFn: (value: T) => unknown): T[] {
  const seen = new Set<unknown>();
  const out: T[] = [];
  for (const value of values || []) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

export function fuzzyMatchScore(query: Scalar, ...fields: readonly Scalar[]): number {
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

export function findProjectEntries(
  state: { projects?: SortableRecord[] } | null | undefined,
  registry: { projects?: SortableRecord[] } | null | undefined,
  projectId: Scalar,
) {
  const stateProject = (state?.projects || []).find((entry) => String(entry.project) === String(projectId)) || null;
  const registryProject = (registry?.projects || []).find((entry) => String(entry.id || entry.project) === String(projectId)) || null;
  return { stateProject, registryProject };
}
