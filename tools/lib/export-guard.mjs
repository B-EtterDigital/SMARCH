/**
 * export-guard.mjs — the single choke-point every export path must call before
 * emitting, copying, releasing, or publishing a brick/build.
 *
 * Enforcement was previously bolted onto one metadata tool (sma-publish),
 * leaving sma-clone (raw source copy), sma-release, and sma-store ungated. This
 * centralizes the check: given the bricks being exported and the target
 * audience, it resolves each brick's openness/visibility from the license
 * ledger (fail-safe: unknown => closed/private) and refuses to release closed
 * source to a wider audience than its license permits.
 *
 * IMPORTANT trust boundary: this is POLICY enforcement, not an access-control
 * barrier. Anyone with repo write access can edit these tools. True protection
 * of closed source is filesystem/git read permission on the source repos. What
 * this guarantees is that the DEFAULT and AUTOMATED paths cannot silently leak
 * closed source, that every closed-source export is an explicit, audited act,
 * and that CI blocks any openness/visibility escalation.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { meetOpenness, meetVisibility, visibilityRank } from './license-lattice.mjs';
import { buildLicenseIndex } from './ledger-resolve.mjs';
import { ownerFor, sameIdentity } from './ownership.mjs';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LICENSE_LEDGER = resolve(SMA_ROOT, 'registry/license-ledger.generated.json');
const AUDIT_LOG = resolve(SMA_ROOT, 'security/export-audit.generated.ndjson');

export class ExportBlockedError extends Error {
  constructor(message, evaluation) {
    super(message);
    this.name = 'ExportBlockedError';
    this.evaluation = evaluation;
  }
}

let _index = null;

/**
 * @typedef {object} ExportEvaluationOptions
 * @property {any[]} [brickIds]
 * @property {string | null} [project]
 * @property {string} [targetVisibility]
 * @property {any} [index]
 */

/**
 * @typedef {ExportEvaluationOptions & {
 *   operation: string,
 *   allowClosed?: boolean,
 *   requireOwner?: boolean,
 *   actor?: string
 * }} ExportAssertionOptions
 */

export function loadLicenseIndex() {
  if (_index) return _index;
  if (!existsSync(LICENSE_LEDGER)) { _index = buildLicenseIndex([]); _index._missing = true; return _index; }
  try {
    const data = JSON.parse(readFileSync(LICENSE_LEDGER, 'utf8'));
    _index = buildLicenseIndex(data.licenses || []);
  } catch {
    _index = buildLicenseIndex([]);
    _index._missing = true;
  }
  return _index;
}

/** Resolve each brick id to its openness/visibility; unknown => closed/private. */
export function resolveComponents(brickIds, project, index = loadLicenseIndex()) {
  return (brickIds || []).map((id) => {
    const row = index.resolve(id, project)?.row;
    return row
      ? { brick_id: id, spdx: row.spdx, openness: row.openness, visibility: row.visibility, resolved: true }
      : { brick_id: id, spdx: null, openness: 'closed', visibility: 'private', resolved: false };
  });
}

/**
 * Evaluate whether exporting `brickIds` to `targetVisibility` is permitted.
 * Returns { ok, meet_openness, meet_visibility, components, violations, ledger_missing }.
 * @param {ExportEvaluationOptions} options
 */
export function evaluateExport({ brickIds = [], project = null, targetVisibility = 'community', index }) {
  const idx = index || loadLicenseIndex();
  const components = resolveComponents(brickIds, project, idx);
  const meetOpen = meetOpenness(components.map((c) => c.openness));
  const meetVis = meetVisibility(components.map((c) => c.visibility));
  const violations = [];

  if (components.length && visibilityRank(targetVisibility) > visibilityRank(meetVis)) {
    violations.push({
      code: 'VISIBILITY_ESCALATION',
      message: `export target "${targetVisibility}" exceeds the most-restricted brick's visibility "${meetVis}"`,
    });
  }
  if (meetOpen === 'closed' && (targetVisibility === 'community' || targetVisibility === 'public')) {
    const closed = components.filter((c) => c.openness === 'closed').map((c) => c.brick_id);
    violations.push({
      code: 'CLOSED_SOURCE_EXPORT',
      message: `export target "${targetVisibility}" would release closed/unlicensed source: ${closed.slice(0, 3).join(', ')}${closed.length > 3 ? ` (+${closed.length - 3} more)` : ''}`,
    });
  }
  return {
    ok: violations.length === 0,
    target: targetVisibility,
    meet_openness: meetOpen,
    meet_visibility: meetVis,
    components,
    ledger_missing: Boolean(idx._missing),
    violations,
  };
}

/**
 * Assert an export is allowed, else throw ExportBlockedError. Always writes an
 * audit line. `allowClosed` is the explicit, recorded acknowledgment that lets
 * an authorized operator export closed source anyway.
 * @param {ExportAssertionOptions} options
 */
export function assertExportAllowed({ operation, brickIds = [], project = null, targetVisibility = 'community', allowClosed = false, requireOwner = false, actor, index }) {
  const who = actor || process.env.SMA_ACTOR_ID || process.env.USER || 'unknown';
  const evaluation = evaluateExport({ brickIds, project, targetVisibility, index });
  // Owner check: who owns the primary brick, and is the actor that owner?
  const owner = brickIds.length ? ownerFor(brickIds[0], project).owner : null;
  const actorIsOwner = owner ? sameIdentity(who, owner) : true; // no owner declared => don't block on ownership
  const allowed = evaluation.ok || (allowClosed && !evaluation.ledger_missing && (!requireOwner || actorIsOwner));
  audit({ operation, actor: who, targetVisibility, brickIds, evaluation, allowClosed, allowed, owner, actor_is_owner: actorIsOwner });

  if (evaluation.ledger_missing) {
    throw new ExportBlockedError(
      `Export blocked (${operation}): license ledger not found, so it cannot be proven these bricks may be "${targetVisibility}". Run: npm run provenance:ledger`,
      evaluation,
    );
  }
  if (!evaluation.ok && !allowClosed) {
    const msgs = evaluation.violations.map((v) => `  - ${v.code}: ${v.message}`).join('\n');
    throw new ExportBlockedError(
      `Export blocked (${operation} -> ${targetVisibility}):\n${msgs}\n  If this is an intentional, authorized export, re-run with --allow-closed (recorded in security/export-audit.generated.ndjson).`,
      evaluation,
    );
  }
  if (allowClosed && requireOwner && owner && !actorIsOwner) {
    throw new ExportBlockedError(
      `Export blocked (${operation}): actor "${who}" is not the owner ("${owner}") of ${brickIds[0]}. Only the owner may export this closed artifact.`,
      evaluation,
    );
  }
  return evaluation;
}

function audit(entry) {
  if (process.env.SMA_EXPORT_AUDIT_DISABLE) return; // tests must not pollute the real log
  try {
    mkdirSync(dirname(AUDIT_LOG), { recursive: true });
    appendFileSync(AUDIT_LOG, `${JSON.stringify({
      ts: new Date().toISOString(),
      operation: entry.operation,
      actor: entry.actor,
      owner: entry.owner,
      actor_is_owner: entry.actor_is_owner,
      target: entry.targetVisibility,
      allowed: entry.allowed,
      allow_closed_ack: entry.allowClosed,
      meet_openness: entry.evaluation.meet_openness,
      meet_visibility: entry.evaluation.meet_visibility,
      violations: entry.evaluation.violations.map((v) => v.code),
      brick_ids: (entry.brickIds || []).slice(0, 50),
    })}\n`);
  } catch { /* auditing must never crash the tool */ }
}
