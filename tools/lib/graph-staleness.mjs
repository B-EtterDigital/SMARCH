import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const IGNORED_SOURCE_PATH = /(^|\/)(\.git|node_modules|graphify-out|dist|build|coverage|\.next|out|tmp|temp)(\/|$)/;

/**
 * Resolve the configured ownership globs for a graph module target.
 *
 * @param {object|null|undefined} gen3Config Parsed sma.gen3.json content.
 * @param {object|null|undefined} moduleTarget Module target with an id or name.
 * @returns {string[]} Normalized, non-empty ownership globs.
 */
export function moduleOwnershipGlobs(gen3Config, moduleTarget) {
  try {
    const modules = Array.isArray(gen3Config?.modules) ? gen3Config.modules : [];
    const wantedIds = new Set([moduleTarget?.id, moduleTarget?.name]
      .map((value) => String(value || "").toLowerCase())
      .filter(Boolean));
    const module = modules.find((item) => (
      wantedIds.has(String(item.id || "").toLowerCase())
      || wantedIds.has(String(item.label || "").toLowerCase())
    ));
    return Array.isArray(module?.paths) ? module.paths.map((item) => String(item || "").trim()).filter(Boolean) : [];
  } catch (error) {
    throw structuredStalenessError("resolve_ownership_globs", error);
  }
}

/**
 * Find the newest modification time among files selected by ownership globs.
 *
 * @param {string} projectRoot Absolute project root used to resolve patterns.
 * @param {string[]} patterns Positive and negated source glob patterns.
 * @returns {number|null} Newest matching mtime in milliseconds, or null when no file matches.
 */
export function newestMatchingSourceMtime(projectRoot, patterns) {
  try {
    const normalizedPatterns = patterns.map((item) => {
      const negated = item.startsWith("!");
      const rawPattern = negated ? item.slice(1) : item;
      const candidate = path.resolve(projectRoot, rawPattern);
      const pattern = !/[?*]/.test(rawPattern) && existsSync(candidate) && statSync(candidate).isDirectory()
        ? `${rawPattern.replace(/\/+$/, "")}/**`
        : rawPattern;
      return negated ? `!${pattern}` : pattern;
    });
    const positivePatterns = normalizedPatterns.filter((item) => !item.startsWith("!"));
    const negativePatterns = normalizedPatterns.filter((item) => item.startsWith("!")).map((item) => item.slice(1));
    const positiveMatchers = positivePatterns.map(globPatternRegex);
    const negativeMatchers = negativePatterns.map(globPatternRegex);
    const roots = [...new Set(positivePatterns.map((item) => globStaticRoot(projectRoot, item)))];
    const visited = new Set();
    let newestMtimeMs = null;

    function visit(candidate) {
      const resolved = path.resolve(candidate);
      if (visited.has(resolved) || !existsSync(resolved)) return;
      visited.add(resolved);
      const stats = statSync(resolved);
      if (stats.isDirectory()) {
        for (const entry of readdirSync(resolved, { withFileTypes: true })) {
          if (entry.isSymbolicLink() || IGNORED_SOURCE_PATH.test(entry.name)) continue;
          visit(path.join(resolved, entry.name));
        }
        return;
      }
      if (!stats.isFile()) return;
      const relativePath = path.relative(projectRoot, resolved).replace(/\\/g, "/");
      if (!positiveMatchers.some((matcher) => matcher.test(relativePath))) return;
      if (negativeMatchers.some((matcher) => matcher.test(relativePath))) return;
      newestMtimeMs = newestMtimeMs == null ? stats.mtimeMs : Math.max(newestMtimeMs, stats.mtimeMs);
    }

    for (const root of roots) visit(root);
    return newestMtimeMs;
  } catch (error) {
    throw structuredStalenessError("compute_newest_source_mtime", error);
  }
}

/**
 * Compare a module graph timestamp with its newest owned source file.
 *
 * @param {string} projectRoot Absolute project root.
 * @param {object|null|undefined} moduleTarget Module graph target.
 * @param {{mtimeMs: number}|null|undefined} graphStat Graph file stat result.
 * @param {object|null|undefined} gen3Config Parsed sma.gen3.json content.
 * @returns {{graphFreshness: string|null, graphFresh: boolean|null, graphStale: boolean, sourceUpdatedAt: string|null, sourceGlobs: string[]}}
 */
export function sourceFreshness(projectRoot, moduleTarget, graphStat, gen3Config) {
  try {
    if (!moduleTarget || !graphStat) {
      return { graphFreshness: null, graphFresh: null, graphStale: false, sourceUpdatedAt: null, sourceGlobs: [] };
    }

    const ownershipGlobs = moduleOwnershipGlobs(gen3Config, moduleTarget);
    const fallbackRoot = moduleTarget.root || moduleTarget.scanRoot;
    const fallbackPattern = fallbackRoot
      ? path.relative(projectRoot, fallbackRoot).replace(/\\/g, "/")
      : "";
    const fallbackIsFile = Boolean(fallbackRoot && existsSync(fallbackRoot) && statSync(fallbackRoot).isFile());
    const sourceGlobs = ownershipGlobs.length
      ? ownershipGlobs
      : fallbackRoot ? [fallbackIsFile ? fallbackPattern : fallbackPattern ? `${fallbackPattern}/**` : "**"] : [];
    const sourceMtimeMs = sourceGlobs.length ? newestMatchingSourceMtime(projectRoot, sourceGlobs) : null;
    const graphStale = sourceMtimeMs != null && sourceMtimeMs > graphStat.mtimeMs;
    return {
      graphFreshness: graphStale ? "stale" : "fresh",
      graphFresh: !graphStale,
      graphStale,
      sourceUpdatedAt: sourceMtimeMs == null ? null : new Date(sourceMtimeMs).toISOString(),
      sourceGlobs,
    };
  } catch (error) {
    throw structuredStalenessError("compute_graph_freshness", error);
  }
}

function globPatternRegex(pattern) {
  const normalized = String(pattern || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*" && normalized[index + 1] === "*") {
      if (normalized[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (character === "*") {
      source += "[^/]*";
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function globStaticRoot(projectRoot, pattern) {
  const normalized = String(pattern || "").replace(/^!/, "").replace(/\\/g, "/").replace(/^\.\//, "");
  const wildcardIndex = normalized.search(/[?*]/);
  const prefix = wildcardIndex === -1 ? normalized : normalized.slice(0, wildcardIndex);
  const relativeRoot = wildcardIndex === -1 ? prefix : prefix.replace(/\/+$/, "");
  if (!relativeRoot) return projectRoot;
  const resolved = path.resolve(projectRoot, relativeRoot);
  if (wildcardIndex === -1 || existsSync(resolved)) return resolved;
  return path.dirname(resolved);
}

function structuredStalenessError(operation, error) {
  if (error?.code === "SMA_GRAPH_STALENESS_ERROR") return error;
  const structured = /** @type {Error & {code?: string}} */ (new Error(JSON.stringify({
    event: "graph_staleness_error",
    operation,
    message: error instanceof Error ? error.message : String(error),
  })));
  structured.code = "SMA_GRAPH_STALENESS_ERROR";
  structured.cause = error;
  return structured;
}
