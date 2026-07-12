/* Ledger rows cross a runtime JSON boundary, so defensive guards and existing diagnostic coercion remain required. */
/* eslint @typescript-eslint/no-base-to-string: "off", @typescript-eslint/no-unnecessary-condition: "off" */
/**
 * WHAT: Builds a license-ledger index that resolves component identifiers across registry namespace variations.
 * WHY: Doubled prefixes, ordering prefixes, and short project tokens otherwise make valid components look missing.
 * HOW: Callers provide ledger rows, then resolve by exact identifier, normalized signature, or trailing path segments.
 * Ambiguous fallbacks prefer the candidate whose normalized project matches the caller's project hint.
 * Unresolved identifiers remain unresolved so callers can apply their fail-safe closed policy.
 * @example node --input-type=module -e "import { buildLicenseIndex } from './tools/lib/ledger-resolve.ts'; console.log(buildLicenseIndex([{ brick_id: 'demo.part', project: 'demo' }]).resolve('demo.part', 'demo'))"
 */
/**
 * ledger-resolve.ts — resolve a build's component brick_id against the license
 * ledger, tolerating the id-namespace quirks in the registry.
 *
 * Build manifests reference bricks with ids like:
 *   acme-desktop.acme-desktop.supabase-function.<path>.<hash>   (doubled prefix)
 *   acme-lang.frontend-module.<path>                          (short project token)
 * while the all-projects ledger keys them as:
 *   0000-acme-lang.0000-acme-lang.frontend-module.<path>
 *
 * We index the ledger by exact id plus two fallback keys — a project-stripped
 * "signature" and the trailing path segments. When a fallback key maps to more
 * than one brick (e.g. a clone-test project that duplicates a real one) we
 * disambiguate by PROJECT AFFINITY: the candidate whose project, with any
 * numeric ordering prefix stripped, matches the requested project hint.
 * Resolution stays fail-safe: an unresolved component is the caller's
 * responsibility to treat as closed.
 */

interface LicenseRow {
  brick_id: string;
  project?: string;
  spdx?: unknown;
  openness?: unknown;
  visibility?: unknown;
  [key: string]: unknown;
}

function signatureOf(id: string, project?: string): string {
  const segs = id.split('.');
  let i = 0;
  // drop a leading run of segments equal to the project token or duplicated.
  while (i < segs.length - 1 && (segs[i] === project || (i > 0 && segs[i] === segs[i - 1]))) i += 1;
  return segs.slice(i).join('.');
}

function tail3(id: string): string {
  const segs = id.split('.');
  return segs.slice(Math.max(0, segs.length - 3)).join('.');
}

function normalizeProject(p: unknown): string {
  return String(p ?? '').replace(/^[0-9]+[-_]?/, '').toLowerCase();
}

function push(map: Map<string, LicenseRow[]>, key: string, row: LicenseRow): void {
  if (!key) return;
  const existing = map.get(key);
  if (existing) existing.push(row);
  else map.set(key, [row]);
}

function pick(candidates: LicenseRow[] | undefined, projectHint?: string): LicenseRow | null {
  if (!candidates?.length) return null;
  if (candidates.length === 1) return candidates[0];
  const hint = normalizeProject(projectHint);
  if (hint) {
    const exact = candidates.filter((r) => normalizeProject(r.project) === hint);
    if (exact.length === 1) return exact[0];
  }
  return null; // genuinely ambiguous
}

/**
 * Build an index over the license ledger's rows ([{brick_id, project, ...}]).
 * Returns { resolve(brickId, projectHint) -> { row, via } | null }.
 */
export function buildLicenseIndex(rows: readonly LicenseRow[]) {
  const byId = new Map<string, LicenseRow>();
  const bySig = new Map<string, LicenseRow[]>();
  const byTail = new Map<string, LicenseRow[]>();
  for (const row of rows || []) {
    byId.set(row.brick_id, row);
    push(bySig, signatureOf(row.brick_id, row.project), row);
    push(byTail, tail3(row.brick_id), row);
  }

  function resolve(brickId: string, projectHint?: string) {
    const exact = byId.get(brickId);
    if (exact) return { row: exact, via: 'exact' };
    const sig = pick(bySig.get(signatureOf(brickId, projectHint)), projectHint);
    if (sig) return { row: sig, via: 'signature' };
    const t = pick(byTail.get(tail3(brickId)), projectHint);
    if (t) return { row: t, via: 'tail' };
    return null;
  }

  return { resolve };
}
