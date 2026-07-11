/**
 * WHAT: Renders self-contained brick-diff and file-tree pages for the Gen3 wiki.
 * WHY: Operators need inspectable release and source structure when interactive renderers are unavailable.
 * HOW: The wiki passes release files or a root path; helpers return complete page markup with static fallbacks.
 * Browser scripts enhance the result, but plain preformatted diffs and tree lists preserve useful offline output.
 * Lineage lives in docs/INFLUENCES.md; Gen3 is defined in docs/GLOSSARY.md#gen3.
 * @example node --input-type=module -e "import * as renderers from './tools/lib/gen3-renderers.ts'; console.log(Object.keys(renderers))"
 */
/**
 * gen3-renderers.ts — small helpers for Pierre's open primitives:
 *   - diffs.com  → side-by-side diff renderer
 *   - trees.software → file-tree renderer
 * Lineage and current integration status: see docs/INFLUENCES.md.
 *
 * Intentionally simple. We render minimal HTML with <script src="…cdn…"></script>
 * embeds. No npm deps. No build step. The page only renders interactively when
 * loaded in a browser; static fallback is a <pre> diff or <ul> tree.
 *
 * Why CDN-style: diffs.com and trees.software are intended to be dropped in
 * via their public renderers. We do not reimplement their rendering. We just
 * shape the surrounding wrapper.
 *
 * Wired into wiki output via tools/sma-wiki-gen3.mjs (opt-in, additive).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DIFFS_CDN = 'https://unpkg.com/diffs.com/dist/diffs.min.js';
const TREES_CDN = 'https://unpkg.com/trees.software/dist/trees.min.js';

type ReleaseData = { release?: { content_hash?: string }; content?: { included_paths?: string[] } };
interface TreeNode { [key: string]: TreeNode }

/**
 * Render a side-by-side brick-release diff page.
 * Inputs are the two release JSON paths from releases/<brick>/<version>.json.
 * Falls back to a static unified diff embed if the CDN is unreachable.
 */
export function renderBrickDiffPage({
  brickId,
  versionA,
  versionB,
  releaseAPath,
  releaseBPath,
  cdn = DIFFS_CDN,
}: {
  brickId: string; versionA: string; versionB: string;
  releaseAPath: string; releaseBPath: string; cdn?: string;
}): string {
  const a = readReleaseSafe(releaseAPath);
  const b = readReleaseSafe(releaseBPath);
  const title = `${escape(brickId)} · ${escape(versionA)} → ${escape(versionB)}`;
  const fallback = staticUnifiedDiffFallback(a, b);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 24px; }
    h1 { font-size: 16px; margin: 0 0 12px 0; }
    .meta { color: #666; margin-bottom: 16px; }
    .fallback { white-space: pre; background: #f6f8fa; padding: 12px; border-radius: 4px; overflow: auto; }
    #diff-host { min-height: 200px; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div class="meta">
    A: ${escape(versionA)} · ${escape(a?.release?.content_hash ?? 'no-hash')}<br>
    B: ${escape(versionB)} · ${escape(b?.release?.content_hash ?? 'no-hash')}
  </div>
  <div id="diff-host"></div>
  <noscript><pre class="fallback">${escape(fallback)}</pre></noscript>
  <script src="${cdn}" defer></script>
  <script>
    window.__SMA_DIFF__ = ${JSON.stringify({ a, b })};
    document.addEventListener('DOMContentLoaded', () => {
      try {
        if (window.diffs && typeof window.diffs.render === 'function') {
          window.diffs.render(document.getElementById('diff-host'), window.__SMA_DIFF__);
        } else {
          document.getElementById('diff-host').innerHTML =
            '<pre class="fallback">' + ${JSON.stringify(escape(fallback))} + '</pre>';
        }
      } catch (e) {
        console.error(JSON.stringify({ area: 'gen3-renderers.diff', severity: 'warning', hint: 'Use the static diff fallback and inspect the embedded diff payload.', error: String(e) }));
        document.getElementById('diff-host').textContent = String(e);
      }
    });
  </script>
</body>
</html>
`;
}

/**
 * Render a brick-tree page. Input is an array of file paths included in a brick.
 * Falls back to a nested <ul> if the CDN script is missing.
 */
export function renderBrickTreePage({
  brickId,
  paths = [],
  cdn = TREES_CDN,
}: { brickId: string; paths?: string[]; cdn?: string }): string {
  const fallback = nestedUlFallback(paths);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escape(brickId)} · brick tree</title>
  <style>
    body { font-family: ui-sans-serif, system-ui; margin: 24px; }
    h1 { font-size: 16px; margin: 0 0 12px 0; }
    .fallback { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    #tree-host { min-height: 200px; }
  </style>
</head>
<body>
  <h1>${escape(brickId)}</h1>
  <div id="tree-host"></div>
  <noscript><div class="fallback">${fallback}</div></noscript>
  <script src="${cdn}" defer></script>
  <script>
    window.__SMA_TREE__ = ${JSON.stringify(paths)};
    document.addEventListener('DOMContentLoaded', () => {
      try {
        if (window.trees && typeof window.trees.render === 'function') {
          window.trees.render(document.getElementById('tree-host'), window.__SMA_TREE__);
        } else {
          document.getElementById('tree-host').innerHTML = ${JSON.stringify(fallback)};
        }
      } catch (e) {
        console.error(JSON.stringify({ area: 'gen3-renderers.tree', severity: 'warning', hint: 'Use the static tree fallback and inspect the embedded tree payload.', error: String(e) }));
        document.getElementById('tree-host').textContent = String(e);
      }
    });
  </script>
</body>
</html>
`;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function readReleaseSafe(p: string): ReleaseData | null {
  if (!p || !existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')) as ReleaseData; } catch (error) {
    console.error(JSON.stringify({ area: 'gen3-renderers.release-read', severity: 'warning', hint: 'Regenerate or repair the release JSON.', error: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

function staticUnifiedDiffFallback(a: ReleaseData | null, b: ReleaseData | null): string {
  if (!a && !b) return '(no release data)';
  const aPaths = (a?.content?.included_paths ?? []).slice().sort();
  const bPaths = (b?.content?.included_paths ?? []).slice().sort();
  const setA = new Set(aPaths);
  const setB = new Set(bPaths);
  const lines: string[] = [];
  for (const p of aPaths) if (!setB.has(p)) lines.push(`- ${p}`);
  for (const p of bPaths) if (!setA.has(p)) lines.push(`+ ${p}`);
  return lines.length ? lines.join('\n') : '(no path-level differences; check content_hash)';
}

function nestedUlFallback(paths: readonly string[]): string {
  if (!paths.length) return '<em>no paths</em>';
  // build a tree object
  const root: TreeNode = {};
  for (const p of paths) {
    const parts = p.split('/').filter(Boolean);
    let node = root;
    for (const part of parts) {
      node[part] = node[part] || {};
      node = node[part];
    }
  }
  const render = (node: TreeNode): string => {
    const keys = Object.keys(node).sort();
    if (!keys.length) return '';
    return '<ul>' + keys.map((k) => `<li>${escape(k)}${render(node[k])}</li>`).join('') + '</ul>';
  };
  return render(root);
}

function escape(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
