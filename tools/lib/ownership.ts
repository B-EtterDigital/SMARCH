/**
 * WHAT: Resolves declared ownership and canonical identities for bricks and projects.
 * WHY: Release authority and authorship checks fail when owners are absent or aliases look like different people.
 * HOW: Loads committed owner and identity maps, caches them, and exposes lookup and comparison helpers.
 * INPUTS: Registry ownership files plus brick, project, or identity values supplied by callers.
 * OUTPUTS: Owner records, canonical identity strings, and same-identity decisions.
 * CALLERS: Provenance, release, and policy checks use this module to apply stable responsibility rules.
 * @example node --input-type=module -e "import { sameIdentity } from './tools/lib/ownership.ts'; console.log(sameIdentity('demo', 'demo'));"
 */
/**
 * ownership.ts — declared owners + identity aliasing.
 *
 * Two gaps this closes:
 *   1. No owner records → "only the owner may release" was unenforceable. An
 *      owners map assigns each brick/project a responsible owner + team.
 *   2. Identity aliasing → the same person under two git emails read as two
 *      authors (false-positive theft). A canonical-identity map collapses them.
 *
 * Both are plain committed JSON so they are reviewable and diffable. Config
 * lives in registry/owners.json and registry/identity-map.json.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OWNERS = resolve(SMA_ROOT, 'registry/owners.json');
const IDENTITY_MAP = resolve(SMA_ROOT, 'registry/identity-map.json');

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (error) {
    console.error(JSON.stringify({ area: 'ownership.read-json', severity: 'warning', hint: 'Repair the malformed ownership JSON.', error: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

// --- ownership --------------------------------------------------------------

let _owners;
export function loadOwners() {
  if (_owners) return _owners;
  const data = readJson(OWNERS) || { rules: [], default_owner: null };
  _owners = data;
  return _owners;
}

/**
 * Resolve the owner for a brick. Rules are matched most-specific first:
 * an exact brick_id beats a brick_id prefix beats a project match beats default.
 * Returns { owner, team, source } or { owner: null, ... }.
 */
export function ownerFor(brickId, project, owners = loadOwners()) {
  const rules = owners.rules || [];
  let best = null;
  let bestScore = -1;
  for (const rule of rules) {
    let score = -1;
    if (rule.brick_id && rule.brick_id === brickId) score = 3;
    else if (rule.brick_prefix && String(brickId || '').startsWith(rule.brick_prefix)) score = 2;
    else if (rule.project && rule.project === project) score = 1;
    if (score > bestScore) { bestScore = score; best = rule; }
  }
  if (best) return { owner: best.owner || null, team: best.team || null, source: bestScore === 3 ? 'brick' : bestScore === 2 ? 'brick_prefix' : 'project' };
  return { owner: owners.default_owner || null, team: owners.default_team || null, source: 'default' };
}

// --- identity aliasing ------------------------------------------------------

let _identityIndex;
function identityIndex() {
  if (_identityIndex) return _identityIndex;
  const data = readJson(IDENTITY_MAP) || { identities: [] };
  const index = new Map();
  for (const entry of data.identities || []) {
    const canonical = entry.canonical;
    if (!canonical) continue;
    index.set(normalize(canonical), canonical);
    for (const alias of entry.aliases || []) index.set(normalize(alias), canonical);
  }
  _identityIndex = index;
  return _identityIndex;
}

function normalize(id) {
  return String(id || '').trim().toLowerCase();
}

/** Map any actor id/email/name to its canonical identity (or itself if unknown). */
export function canonicalIdentity(id) {
  if (id == null) return null;
  return identityIndex().get(normalize(id)) || id;
}

/** True if two actor ids resolve to the same person. */
export function sameIdentity(a, b) {
  if (!a || !b) return false;
  return canonicalIdentity(a) === canonicalIdentity(b) || normalize(a) === normalize(b);
}

// test seam
export function _reset() { _owners = undefined; _identityIndex = undefined; }
