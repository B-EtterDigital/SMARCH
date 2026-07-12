/**
 * WHAT: Resolves a configured project identifier to its canonical on-disk root.
 * WHY: Repeated override maps drifted and made different tools target different directories.
 * HOW: Inverts the portfolio configuration once, then falls back to bounded directory discovery.
 * INPUTS: A project identifier and the shared portfolio configuration.
 * OUTPUTS: An absolute project root, relative root, or null when no project matches.
 * CALLERS: Backfill and other cross-project tools use this as their path source of truth.
 * @example node --input-type=module -e "import { resolveProjectRoot } from './tools/lib/project-paths.ts'; console.log(resolveProjectRoot('sma'));"
 */
/**
 * project-paths.ts — single source of truth for project_id → on-disk path.
 *
 * Replaces the 5+ ad-hoc override maps that drifted across tools. Derived
 * from registry/portfolio.config.json (which holds the canonical
 * relative_path → { id, name } mapping); we invert it to id → relative_path.
 *
 * Usage:
 *   import { PROJECTS_ROOT, resolveProjectRoot } from './lib/project-paths.ts';
 *   const root = resolveProjectRoot('acme-desktop'); // '<PROJECTS_ROOT>/000_AcmeDesktop_v1'
 */

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPortfolioConfig } from './portfolio-config.ts';

export { PROJECTS_ROOT } from './sma-paths.ts';
import { PROJECTS_ROOT } from './sma-paths.ts';

// Inverted from registry/portfolio.config.json::overrides.
export const PROJECT_PATH_OVERRIDES = Object.fromEntries(
  Object.entries(loadPortfolioConfig().overrides).map(([relativePath, entry]) => [
    entry.id ?? relativePath,
    relativePath,
  ]),
);

let dirCache: Map<string, string> | null = null;
function buildCache(): Map<string, string> {
  if (dirCache) return dirCache;
  dirCache = new Map<string, string>();
  try {
    for (const ent of readdirSync(PROJECTS_ROOT)) {
      dirCache.set(ent.toLowerCase(), ent);
    }
  } catch (error) {
    const errorCode = error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
    const code = typeof errorCode === 'string' ? errorCode : '';
    if (code !== 'ENOENT') {
      console.error(JSON.stringify({ area: 'project-paths.directory-cache', severity: 'warning', hint: 'Check the portfolio projects root and its permissions.', error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) }));
    }
  }
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
export function resolveProjectRoot(projectId: string | null | undefined): string | null {
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
