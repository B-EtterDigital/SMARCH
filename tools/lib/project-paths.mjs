/**
 * WHAT: Resolves a configured project identifier to its canonical on-disk root.
 * WHY: Repeated override maps drifted and made different tools target different directories.
 * HOW: Inverts the portfolio configuration once, then falls back to bounded directory discovery.
 * INPUTS: A project identifier and the shared portfolio configuration.
 * OUTPUTS: An absolute project root, relative root, or null when no project matches.
 * CALLERS: Backfill and other cross-project tools use this as their path source of truth.
 * @example node --input-type=module -e "import { resolveProjectRoot } from './tools/lib/project-paths.mjs'; console.log(resolveProjectRoot('sma'));"
 */
/**
 * project-paths.mjs — single source of truth for project_id → on-disk path.
 *
 * Replaces the 5+ ad-hoc override maps that drifted across tools. Derived
 * from registry/portfolio.config.json (which holds the canonical
 * relative_path → { id, name } mapping); we invert it to id → relative_path.
 *
 * Usage:
 *   import { PROJECTS_ROOT, resolveProjectRoot } from './lib/project-paths.mjs';
 *   const root = resolveProjectRoot('acme-desktop'); // '<PROJECTS_ROOT>/000_AcmeDesktop_v1'
 */

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPortfolioConfig } from './portfolio-config.mjs';

export { PROJECTS_ROOT } from './sma-paths.mjs';
import { PROJECTS_ROOT } from './sma-paths.mjs';

// Inverted from registry/portfolio.config.json::overrides.
export const PROJECT_PATH_OVERRIDES = Object.fromEntries(
  Object.entries(loadPortfolioConfig().overrides).map(([relativePath, entry]) => [
    entry?.id ?? relativePath,
    relativePath,
  ]),
);

let dirCache = null;
function buildCache() {
  if (dirCache) return dirCache;
  dirCache = new Map();
  try {
    for (const ent of readdirSync(PROJECTS_ROOT)) {
      dirCache.set(ent.toLowerCase(), ent);
    }
  } catch { /* ignore */ }
  return dirCache;
}

/**
 * Resolve a project id to an absolute path on disk. Returns null when the
 * project cannot be located.
 *
 * Order: override map (curated) → direct → case-insensitive exact match.
 * The override-first ordering matters: stub directories that share a
 * case-insensitive prefix with the real project (e.g. /Projects/acme-desktop
 * stub vs /Projects/Acme-Desktop real) would otherwise win the direct check.
 */
export function resolveProjectRoot(projectId) {
  if (!projectId) return null;
  const overridden = PROJECT_PATH_OVERRIDES[projectId];
  if (overridden) {
    const cand = resolve(PROJECTS_ROOT, overridden);
    if (existsSync(cand)) return cand;
  }
  const direct = resolve(PROJECTS_ROOT, projectId);
  if (existsSync(direct)) return direct;
  const cache = buildCache();
  const ci = cache.get(projectId.toLowerCase());
  if (ci) {
    const cand = resolve(PROJECTS_ROOT, ci);
    if (existsSync(cand)) return cand;
  }
  return null;
}

/**
 * For ids known via the override map, returns the relative path under
 * PROJECTS_ROOT. Useful for log lines and debug output.
 */
export function projectRelativeRoot(projectId) {
  return PROJECT_PATH_OVERRIDES[projectId] ?? projectId;
}
