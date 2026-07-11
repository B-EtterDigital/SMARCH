/**
 * WHAT: Computes the most restrictive effective license, openness, and visibility for composed bricks.
 * WHY: A build must never be declared more redistributable or visible than any component permits.
 * HOW: Gates pass declarations and component facts; pure functions classify, combine limits, and report violations.
 * Unknown licenses fail closed, and composition uses the greatest lower bound across every component.
 * The provenance ledger, license gate, publisher, and export guard share these deterministic decisions.
 * License abbreviations are defined in docs/GLOSSARY.md.
 * @example node --input-type=module -e "import { classifyLicense } from './tools/lib/license-lattice.mjs'; console.log(classifyLicense('MIT'))"
 */
/**
 * license-lattice.mjs — the openness / visibility / license lattice.
 *
 * Core rule (monotonic propagation): a composed artifact can never be declared
 * MORE open, MORE visible, or MORE permissively licensed than the most
 * restrictive brick it is derived from. Effective openness/visibility of a
 * build is the MEET (greatest lower bound) of its components. "You cannot
 * release as open what was built from something closed."
 *
 * Everything here is pure and deterministic — no I/O, no clock — so it is
 * trivially testable and safe to call from gates.
 */

// ---------------------------------------------------------------------------
// Openness — the legal "can this be redistributed / opened" axis.
// Ranks ascend from most-restrictive to least-restrictive. Meet = min rank.
// ---------------------------------------------------------------------------
export const OPENNESS = ['closed', 'source-available', 'open'];
const OPENNESS_RANK = new Map(OPENNESS.map((v, i) => [v, i]));

// ---------------------------------------------------------------------------
// Visibility — the access-tier axis. Meet = min rank.
// ---------------------------------------------------------------------------
export const VISIBILITY = ['private', 'internal', 'community', 'public'];
const VISIBILITY_RANK = new Map(VISIBILITY.map((v, i) => [v, i]));

// ---------------------------------------------------------------------------
// License classification. copyleft_rank ascends: the combined work must carry
// at least the strongest copyleft present among its components.
//   0 = no copyleft (proprietary handled separately / permissive / public)
//   1 = weak / file-level copyleft (MPL, LGPL, EPL)
//   2 = strong copyleft (GPL)
//   3 = network copyleft (AGPL)
// ---------------------------------------------------------------------------
const LICENSE_TABLE = [
  // proprietary / no-license — poisons openness to `closed`
  { match: /^(proprietary|unlicensed|closed|all-?rights-?reserved|none)$/i, class: 'proprietary', openness: 'closed', copyleft: 0, attribution: true },
  // source-available (viewable, restricted redistribution)
  { match: /^(busl|bsl)(-1\.1)?$/i, class: 'source-available', openness: 'source-available', copyleft: 0, attribution: true },
  { match: /^elastic(-2\.0)?$/i, class: 'source-available', openness: 'source-available', copyleft: 0, attribution: true },
  { match: /^sspl(-1\.0)?$/i, class: 'source-available', openness: 'source-available', copyleft: 3, attribution: true },
  { match: /^(polyform|prosperity|commons-?clause)/i, class: 'source-available', openness: 'source-available', copyleft: 0, attribution: true },
  // public domain / no attribution needed
  { match: /^(cc0(-1\.0)?|unlicense|0bsd|wtfpl)$/i, class: 'public-domain', openness: 'open', copyleft: 0, attribution: false },
  // permissive
  { match: /^mit(-0)?$/i, class: 'permissive', openness: 'open', copyleft: 0, attribution: true },
  { match: /^(apache(-2\.0)?|apache2)$/i, class: 'permissive', openness: 'open', copyleft: 0, attribution: true },
  { match: /^(bsd|bsd-2-clause|bsd-3-clause|bsd-4-clause|isc|zlib|python-2\.0|psf|ncsa)/i, class: 'permissive', openness: 'open', copyleft: 0, attribution: true },
  { match: /^(ms-pl|artistic(-2\.0)?|ofl(-1\.1)?|boost|bsl-1\.0|upl(-1\.0)?)/i, class: 'permissive', openness: 'open', copyleft: 0, attribution: true },
  { match: /^cc-by(-4\.0|-3\.0)?$/i, class: 'permissive', openness: 'open', copyleft: 0, attribution: true },
  // weak / file-level copyleft
  { match: /^(mpl(-2\.0)?|epl(-1\.0|-2\.0)?|cddl(-1\.0|-1\.1)?|ms-rl)/i, class: 'weak-copyleft', openness: 'open', copyleft: 1, attribution: true },
  { match: /^lgpl(-2\.1|-3\.0)?/i, class: 'weak-copyleft', openness: 'open', copyleft: 1, attribution: true },
  { match: /^cc-by-sa(-4\.0|-3\.0)?$/i, class: 'weak-copyleft', openness: 'open', copyleft: 1, attribution: true },
  // strong copyleft
  { match: /^(gpl(-2\.0|-3\.0)?|eupl(-1\.1|-1\.2)?)/i, class: 'strong-copyleft', openness: 'open', copyleft: 2, attribution: true },
  // network copyleft
  { match: /^agpl(-3\.0)?/i, class: 'network-copyleft', openness: 'open', copyleft: 3, attribution: true },
];

const UNKNOWN_LICENSE = { class: 'unknown', openness: 'closed', copyleft: 0, attribution: true };

/**
 * Normalize a free-form license string into a canonical SPDX-ish token.
 * Strips noise words ("license", "version") and punctuation so
 * "Apache License 2.0" and "Apache-2.0" resolve the same.
 */
export function normalizeSpdx(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim()
    .replace(/\blicen[cs]e\b/gi, '')
    .replace(/\bversion\b/gi, '')
    .replace(/[,]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || null;
}

/**
 * Classify a license string, including SPDX expressions.
 *   "A OR B"  -> the licensee may choose, so the MOST OPEN operand wins.
 *   "A AND B" -> both apply, so the MOST RESTRICTIVE operand wins.
 *   "X WITH e"-> exceptions loosen; classify the base license X.
 * Unknown / missing licenses are treated as `closed` (fail-safe): if we can't
 * prove it is open, we must not open it.
 */
export function classifyLicense(raw) {
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return { spdx: null, ...UNKNOWN_LICENSE, reason: 'no license declared' };
  }
  const expr = raw.trim().replace(/^\(+|\)+$/g, '').trim();

  // SPDX expression: OR / AND (single level; nested parens are treated as text)
  if (/\s+OR\s+/i.test(expr) || /\s+AND\s+/i.test(expr)) {
    const isOr = /\s+OR\s+/i.test(expr);
    const parts = expr.split(isOr ? /\s+OR\s+/i : /\s+AND\s+/i).map((p) => classifyLicense(p));
    // OR => choose the most open (max openness rank, min copyleft).
    // AND => the most restrictive (min openness rank, max copyleft).
    const pick = isOr
      ? parts.reduce((a, b) => (opennessRank(b.openness) > opennessRank(a.openness) ? b : a))
      : parts.reduce((a, b) => (opennessRank(b.openness) < opennessRank(a.openness) ? b : a));
    return {
      spdx: expr.replace(/\s+/g, ' '),
      class: pick.class,
      openness: pick.openness,
      copyleft: isOr ? Math.min(...parts.map((p) => p.copyleft)) : Math.max(...parts.map((p) => p.copyleft)),
      attribution: parts.some((p) => p.attribution),
      expression: isOr ? 'OR' : 'AND',
    };
  }

  // strip a WITH exception; classify the base license
  const base = expr.split(/\s+WITH\s+/i)[0];
  const spdx = normalizeSpdx(base);
  if (!spdx) return { spdx: null, ...UNKNOWN_LICENSE, reason: 'no license declared' };
  for (const row of LICENSE_TABLE) {
    if (row.match.test(spdx)) {
      return {
        spdx,
        class: row.class,
        openness: row.openness,
        copyleft: row.copyleft,
        attribution: row.attribution,
      };
    }
  }
  return { spdx, ...UNKNOWN_LICENSE, reason: 'unrecognized license token' };
}

// --- lattice primitives -----------------------------------------------------

export function opennessRank(v) {
  return OPENNESS_RANK.has(v) ? OPENNESS_RANK.get(v) : 0; // unknown => closed
}
export function visibilityRank(v) {
  return VISIBILITY_RANK.has(v) ? VISIBILITY_RANK.get(v) : 0; // unknown => private
}

/** MEET of openness values — the most restrictive wins. */
export function meetOpenness(values) {
  if (!values || !values.length) return 'closed';
  let rank = Infinity;
  for (const v of values) rank = Math.min(rank, opennessRank(v));
  return OPENNESS[Number.isFinite(rank) ? rank : 0];
}

/** MEET of visibility values — the least visible wins. */
export function meetVisibility(values) {
  if (!values || !values.length) return 'private';
  let rank = Infinity;
  for (const v of values) rank = Math.min(rank, visibilityRank(v));
  return VISIBILITY[Number.isFinite(rank) ? rank : 0];
}

/**
 * Combine component licenses into the effective license class of a composed
 * work. Returns the effective openness, the strongest copyleft obligation,
 * whether attribution is required, and any hard conflicts.
 *
 * components: [{ brick_id, spdx }]
 */
export function combineLicenses(components) {
  const classified = (components || []).map((c) => ({
    brick_id: c.brick_id,
    ...classifyLicense(c.spdx),
  }));

  const opennessValues = classified.map((c) => c.openness);
  const effectiveOpenness = meetOpenness(opennessValues.length ? opennessValues : ['closed']);

  let strongestCopyleft = 0;
  let copyleftSource = null;
  let attributionRequired = false;
  const proprietary = [];
  for (const c of classified) {
    if (c.copyleft > strongestCopyleft) {
      strongestCopyleft = c.copyleft;
      copyleftSource = c.brick_id;
    }
    if (c.attribution) attributionRequired = true;
    if (c.class === 'proprietary' || c.class === 'unknown') proprietary.push(c.brick_id);
  }

  const conflicts = [];
  // A strong/network copyleft component in the same work as a proprietary one
  // is a genuine legal conflict (cannot be combined and redistributed).
  if (strongestCopyleft >= 2 && proprietary.length) {
    conflicts.push({
      code: 'COPYLEFT_PROPRIETARY_CONFLICT',
      message: `copyleft component ${copyleftSource} cannot be combined with proprietary/unknown components ${proprietary.join(', ')}`,
    });
  }

  return {
    effective_openness: effectiveOpenness,
    strongest_copyleft: strongestCopyleft,
    copyleft_source: copyleftSource,
    attribution_required: attributionRequired,
    proprietary_components: proprietary,
    classified,
    conflicts,
  };
}

/**
 * The heart of the gate. Given a build's DECLARED intent and its component
 * bricks, return every way the declaration escalates beyond what the
 * components permit.
 *
 * input:
 *   declared: { visibility, license, openness?, publishable, has_attribution }
 *   components: [{ brick_id, spdx, openness, visibility }]
 *
 * Returns { ok, effective:{openness,visibility,license}, violations:[] }.
 */
export function checkComposition(declared, components) {
  const declaredVisibility = declared.visibility || 'private';
  const declaredOpenness = declared.openness || opennessOfLicense(declared.license);
  const combined = combineLicenses(components);

  const meetVis = meetVisibility(
    (components || []).map((c) => c.visibility).filter(Boolean),
  );
  const effectiveOpenness = combined.effective_openness;

  const violations = [];

  // 1. Visibility escalation — declared more visible than the least-visible brick.
  if (components && components.length && visibilityRank(declaredVisibility) > visibilityRank(meetVis)) {
    violations.push({
      code: 'VISIBILITY_ESCALATION',
      severity: 'block',
      message: `build declares visibility "${declaredVisibility}" but its most-restricted brick permits at most "${meetVis}"`,
      limit: meetVis,
      declared: declaredVisibility,
    });
  }

  // 2. Openness escalation — declared/derived openness exceeds the lattice meet.
  if (opennessRank(declaredOpenness) > opennessRank(effectiveOpenness)) {
    violations.push({
      code: 'OPENNESS_ESCALATION',
      severity: 'block',
      message: `build openness "${declaredOpenness}" exceeds the meet of its components "${effectiveOpenness}"`,
      limit: effectiveOpenness,
      declared: declaredOpenness,
    });
  }

  // 3. Publishing a closed-derived build to community/public.
  if (declared.publishable && effectiveOpenness === 'closed'
      && (declaredVisibility === 'community' || declaredVisibility === 'public')) {
    violations.push({
      code: 'CLOSED_SOURCE_PUBLISH',
      severity: 'block',
      message: `build is publishable to "${declaredVisibility}" but derives from closed/unlicensed bricks (${combined.proprietary_components.join(', ') || 'unknown-license components'})`,
    });
  }

  // 4. Copyleft not honored — strong copyleft component but declared license is
  //    proprietary/incompatible.
  if (combined.strongest_copyleft >= 2) {
    const declClass = classifyLicense(declared.license);
    if (declClass.copyleft < combined.strongest_copyleft || declClass.class === 'proprietary') {
      violations.push({
        code: 'COPYLEFT_UNDECLARED',
        severity: 'block',
        message: `component ${combined.copyleft_source} imposes copyleft that the declared license "${declared.license || 'none'}" does not satisfy`,
      });
    }
  }

  // 5. Attribution required but no attribution manifest / exposed docs.
  if (combined.attribution_required && declared.publishable && declared.has_attribution === false) {
    violations.push({
      code: 'ATTRIBUTION_MISSING',
      severity: 'warn',
      message: 'components require attribution but the build declares no attribution manifest (contributor ledger)',
    });
  }

  // 6. Genuine legal conflicts surfaced by combineLicenses.
  for (const c of combined.conflicts) {
    violations.push({ ...c, severity: 'block' });
  }

  return {
    ok: violations.filter((v) => v.severity === 'block').length === 0,
    effective: {
      openness: effectiveOpenness,
      visibility: meetVis,
      license_class: describeEffectiveLicense(combined),
      attribution_required: combined.attribution_required,
      strongest_copyleft: combined.strongest_copyleft,
    },
    violations,
  };
}

export function opennessOfLicense(license) {
  return classifyLicense(license).openness;
}

function describeEffectiveLicense(combined) {
  if (combined.effective_openness === 'closed') return 'proprietary';
  if (combined.strongest_copyleft >= 3) return 'network-copyleft';
  if (combined.strongest_copyleft === 2) return 'strong-copyleft';
  if (combined.strongest_copyleft === 1) return 'weak-copyleft';
  if (combined.effective_openness === 'source-available') return 'source-available';
  return 'permissive';
}
