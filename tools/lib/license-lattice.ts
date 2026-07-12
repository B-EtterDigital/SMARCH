/* eslint-disable @typescript-eslint/prefer-nullish-coalescing -- Existing logical-OR fallbacks intentionally treat every falsy value as absent; replacing them with ?? would change behavior. */
/* eslint-disable @typescript-eslint/no-unnecessary-condition -- Runtime registry, manifest, and CLI inputs can violate their optimistic compile-time declarations; these guards are intentional. */
/**
 * WHAT: Computes the most restrictive effective license, openness, and visibility for composed bricks.
 * WHY: A build must never be declared more redistributable or visible than any component permits.
 * HOW: Gates pass declarations and component facts; pure functions classify, combine limits, and report violations.
 * Unknown licenses fail closed, and composition uses the greatest lower bound across every component.
 * The provenance ledger, license gate, publisher, and export guard share these deterministic decisions.
 * License abbreviations are defined in docs/GLOSSARY.md.
 * @example node --input-type=module -e "import { classifyLicense } from './tools/lib/license-lattice.ts'; console.log(classifyLicense('MIT'))"
 */
/**
 * license-lattice.ts — the openness / visibility / license lattice.
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
const OPENNESS = ['closed', 'source-available', 'open'] as const;
const OPENNESS_RANK = new Map<string, number>(OPENNESS.map((v, i) => [v, i]));

// ---------------------------------------------------------------------------
// Visibility — the access-tier axis. Meet = min rank.
// ---------------------------------------------------------------------------
const VISIBILITY = ['private', 'internal', 'community', 'public'] as const;
const VISIBILITY_RANK = new Map<string, number>(VISIBILITY.map((v, i) => [v, i]));

const LICENSE_TIERS = ['open', 'commercial'] as const;

type Openness = typeof OPENNESS[number];
type Visibility = typeof VISIBILITY[number];
type LicenseTier = typeof LICENSE_TIERS[number];
interface LicenseClassification {
  spdx: string | null;
  class: string;
  openness: Openness;
  copyleft: number;
  attribution: boolean;
  reason?: string;
  expression?: 'OR' | 'AND';
}
interface LicenseComponent {
  brick_id: string;
  spdx?: string | null;
  openness?: Openness;
  visibility?: Visibility;
  license_tier?: LicenseTier;
  commercial_terms?: string | null;
}
interface CompositionDeclaration {
  visibility?: Visibility;
  license?: string | null;
  openness?: Openness;
  publishable?: boolean;
  has_attribution?: boolean;
  license_tier?: LicenseTier;
  commercial_waiver?: boolean | { approved_by?: string; reason?: string };
}
type LicenseCombination = ReturnType<typeof combineLicenses>;

// ---------------------------------------------------------------------------
// License classification. copyleft_rank ascends: the combined work must carry
// at least the strongest copyleft present among its components.
//   0 = no copyleft (proprietary handled separately / permissive / public)
//   1 = weak / file-level copyleft (MPL, LGPL, EPL)
//   2 = strong copyleft (GPL)
//   3 = network copyleft (AGPL)
// ---------------------------------------------------------------------------
type LicenseFacts = Omit<LicenseClassification, 'spdx' | 'reason' | 'expression'>;
type LicenseAst =
  | { kind: 'license'; id: string }
  | { kind: 'with'; license: { kind: 'license'; id: string }; exception: string }
  | { kind: 'and' | 'or'; left: LicenseAst; right: LicenseAst };

const LICENSE_IDS = new Map<string, LicenseFacts>();
const register = (ids: readonly string[], facts: LicenseFacts): void => {
  for (const id of ids) LICENSE_IDS.set(id.toLowerCase(), facts);
};

register(['Proprietary', 'Unlicensed', 'Closed', 'All-Rights-Reserved', 'AllRightsReserved', 'None'], { class: 'proprietary', openness: 'closed', copyleft: 0, attribution: true });
register(['BUSL-1.1', 'BUSL', 'BSL-1.1'], { class: 'source-available', openness: 'source-available', copyleft: 0, attribution: true });
register(['Elastic-2.0', 'Elastic'], { class: 'source-available', openness: 'source-available', copyleft: 0, attribution: true });
register(['SSPL-1.0', 'SSPL'], { class: 'source-available', openness: 'source-available', copyleft: 3, attribution: true });
register(['PolyForm', 'Prosperity', 'Commons-Clause', 'CommonsClause'], { class: 'source-available', openness: 'source-available', copyleft: 0, attribution: true });
register(['CC0-1.0', 'CC0', 'Unlicense', '0BSD', 'WTFPL'], { class: 'public-domain', openness: 'open', copyleft: 0, attribution: false });
register(['MIT', 'MIT-0', 'Apache-2.0', 'Apache', 'Apache2', 'BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'BSD-4-Clause', 'ISC', 'Zlib', 'Python-2.0', 'PSF', 'PSF-2.0', 'NCSA', 'MS-PL', 'Artistic-2.0', 'Artistic', 'OFL-1.1', 'OFL', 'Boost', 'BSL-1.0', 'UPL-1.0', 'UPL', 'CC-BY-3.0', 'CC-BY-4.0', 'CC-BY'], { class: 'permissive', openness: 'open', copyleft: 0, attribution: true });
register(['MPL-2.0', 'MPL', 'EPL-1.0', 'EPL-2.0', 'EPL', 'CDDL-1.0', 'CDDL-1.1', 'CDDL', 'MS-RL', 'LGPL-2.1', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'LGPL', 'CC-BY-SA-3.0', 'CC-BY-SA-4.0', 'CC-BY-SA'], { class: 'weak-copyleft', openness: 'open', copyleft: 1, attribution: true });
register(['GPL-2.0', 'GPL-2.0-only', 'GPL-2.0-or-later', 'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later', 'GPL', 'EUPL-1.1', 'EUPL-1.2', 'EUPL'], { class: 'strong-copyleft', openness: 'open', copyleft: 2, attribution: true });
register(['AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'AGPL'], { class: 'network-copyleft', openness: 'open', copyleft: 3, attribution: true });

const SPDX_EXCEPTIONS = new Set([
  '389-exception', 'Autoconf-exception-2.0', 'Autoconf-exception-3.0',
  'Bison-exception-2.2', 'Bootloader-exception', 'Classpath-exception-2.0',
  'CLISP-exception-2.0', 'DigiRule-FOSS-exception', 'FLTK-exception',
  'Font-exception-2.0', 'GCC-exception-2.0', 'GCC-exception-3.1',
  'LLVM-exception', 'Linux-syscall-note', 'OpenJDK-assembly-exception-1.0',
  'Qt-GPL-exception-1.0', 'Qt-LGPL-exception-1.1', 'WxWindows-exception-3.1',
].map((id) => id.toLowerCase()));

const UNKNOWN_LICENSE: Omit<LicenseClassification, 'spdx'> = { class: 'unknown', openness: 'closed', copyleft: 0, attribution: true };

/**
 * Normalize a free-form license string into a canonical SPDX-ish token.
 * Strips noise words ("license", "version") and punctuation so
 * "Apache License 2.0" and "Apache-2.0" resolve the same.
 */
function normalizeSpdx(raw: unknown): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim()
    .replace(/\blicen[cs]e\b/gi, '')
    .replace(/\bversion\b/gi, '')
    .replace(/[,]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || null;
}

function tokenizeExpression(raw: string): string[] | null {
  const tokens: string[] = [];
  const pattern = /\s*(\(|\)|AND\b|OR\b|WITH\b|[A-Za-z0-9][A-Za-z0-9.+-]*)/giy;
  let offset = 0;
  while (offset < raw.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(raw);
    if (match?.index !== offset) return null;
    tokens.push(match[1]);
    offset = pattern.lastIndex;
  }
  return tokens;
}

function parseSpdxExpression(raw: string): LicenseAst | null {
  const tokens = tokenizeExpression(raw);
  if (!tokens?.length) return null;
  let index = 0;
  const peek = (): string | undefined => tokens[index];
  const take = (): string | undefined => tokens[index++];
  const parsePrimary = (): LicenseAst | null => {
    if (peek() === '(') {
      take();
      const nested = parseOr();
      if (!nested || take() !== ')') return null;
      return nested;
    }
    const id = take();
    if (!id || /^(AND|OR|WITH|\(|\))$/i.test(id)) return null;
    return { kind: 'license', id };
  };
  const parseWith = (): LicenseAst | null => {
    const base = parsePrimary();
    if (!base) return null;
    if (!/^WITH$/i.test(peek() ?? '')) return base;
    take();
    const exception = take();
    if (base.kind !== 'license' || !exception || /^(AND|OR|WITH|\(|\))$/i.test(exception)) return null;
    return { kind: 'with', license: base, exception };
  };
  const parseAnd = (): LicenseAst | null => {
    let left = parseWith();
    if (!left) return null;
    while (/^AND$/i.test(peek() ?? '')) {
      take();
      const right = parseWith();
      if (!right) return null;
      left = { kind: 'and', left, right };
    }
    return left;
  };
  const parseOr = (): LicenseAst | null => {
    let left = parseAnd();
    if (!left) return null;
    while (/^OR$/i.test(peek() ?? '')) {
      take();
      const right = parseAnd();
      if (!right) return null;
      left = { kind: 'or', left, right };
    }
    return left;
  };
  const ast = parseOr();
  return ast && index === tokens.length ? ast : null;
}

function expressionText(ast: LicenseAst): string {
  if (ast.kind === 'license') return ast.id;
  if (ast.kind === 'with') return `${ast.license.id} WITH ${ast.exception}`;
  return `(${expressionText(ast.left)} ${ast.kind.toUpperCase()} ${expressionText(ast.right)})`;
}

function classifyId(id: string): LicenseClassification {
  const facts = LICENSE_IDS.get(id.toLowerCase());
  return facts
    ? { spdx: id, ...facts }
    : { spdx: id, ...UNKNOWN_LICENSE, reason: 'unrecognized license token' };
}

function combinedClass(openness: Openness, copyleft: number, operands: readonly LicenseClassification[]): string {
  if (openness === 'closed') return operands.some((part) => part.class === 'proprietary') ? 'proprietary' : 'unknown';
  if (openness === 'source-available') return 'source-available';
  if (copyleft >= 3) return 'network-copyleft';
  if (copyleft === 2) return 'strong-copyleft';
  if (copyleft === 1) return 'weak-copyleft';
  return operands.every((part) => part.class === 'public-domain') ? 'public-domain' : 'permissive';
}

function classifyAst(ast: LicenseAst): LicenseClassification {
  if (ast.kind === 'license') return classifyId(ast.id);
  if (ast.kind === 'with') {
    if (!SPDX_EXCEPTIONS.has(ast.exception.toLowerCase())) {
      return { spdx: expressionText(ast), ...UNKNOWN_LICENSE, reason: 'unrecognized SPDX exception' };
    }
    return { ...classifyId(ast.license.id), spdx: expressionText(ast) };
  }
  const parts = [classifyAst(ast.left), classifyAst(ast.right)];
  if (ast.kind === 'or') {
    const selected = [...parts].sort((a, b) =>
      opennessRank(b.openness) - opennessRank(a.openness)
      || a.copyleft - b.copyleft
      || Number(a.attribution) - Number(b.attribution)
      || a.class.localeCompare(b.class))[0];
    return { ...selected, spdx: expressionText(ast), expression: 'OR' };
  }
  const openness = meetOpenness(parts.map((part) => part.openness));
  const copyleft = Math.max(...parts.map((part) => part.copyleft));
  return {
    spdx: expressionText(ast),
    class: combinedClass(openness, copyleft, parts),
    openness,
    copyleft,
    attribution: parts.some((part) => part.attribution),
    expression: 'AND',
  };
}

/**
 * Classify a license string, including SPDX expressions.
 *   "A OR B"  -> the licensee may choose, so the MOST OPEN operand wins.
 *   "A AND B" -> both apply, so the MOST RESTRICTIVE operand wins.
 *   "X WITH e"-> exceptions loosen; classify the base license X.
 * Unknown / missing licenses are treated as `closed` (fail-safe): if we can't
 * prove it is open, we must not open it.
 */
export function classifyLicense(raw: unknown): LicenseClassification {
  if (!raw || typeof raw !== 'string' || !raw.trim()) {
    return { spdx: null, ...UNKNOWN_LICENSE, reason: 'no license declared' };
  }
  const expr = raw.trim();
  const hasExpressionSyntax = /[()]|\b(?:AND|OR|WITH)\b/i.test(expr);
  if (hasExpressionSyntax) {
    const ast = parseSpdxExpression(expr);
    return ast
      ? classifyAst(ast)
      : { spdx: expr, ...UNKNOWN_LICENSE, reason: 'invalid SPDX expression' };
  }
  const spdx = normalizeSpdx(expr);
  if (!spdx) return { spdx: null, ...UNKNOWN_LICENSE, reason: 'no license declared' };
  return classifyId(spdx);
}

// --- lattice primitives -----------------------------------------------------

export function opennessRank(v: unknown): number {
  return typeof v === 'string' ? OPENNESS_RANK.get(v) ?? 0 : 0; // unknown => closed
}
export function visibilityRank(v: unknown): number {
  return typeof v === 'string' ? VISIBILITY_RANK.get(v) ?? 0 : 0; // unknown => private
}

/** MEET of openness values — the most restrictive wins. */
export function meetOpenness(values: readonly Openness[]): Openness {
  if (!values.length) return 'closed';
  let rank = Infinity;
  for (const v of values) rank = Math.min(rank, opennessRank(v));
  return OPENNESS[Number.isFinite(rank) ? rank : 0] ?? 'closed';
}

/** MEET of visibility values — the least visible wins. */
export function meetVisibility(values: readonly Visibility[]): Visibility {
  if (!values.length) return 'private';
  let rank = Infinity;
  for (const v of values) rank = Math.min(rank, visibilityRank(v));
  return VISIBILITY[Number.isFinite(rank) ? rank : 0] ?? 'private';
}

/**
 * Combine component licenses into the effective license class of a composed
 * work. Returns the effective openness, the strongest copyleft obligation,
 * whether attribution is required, and any hard conflicts.
 *
 * components: [{ brick_id, spdx }]
 */
export function combineLicenses(components: readonly LicenseComponent[]) {
  const classified = (components || []).map((c) => ({
    brick_id: c.brick_id,
    ...classifyLicense(c.spdx),
  }));

  const opennessValues = classified.map((c) => c.openness);
  const effectiveOpenness = meetOpenness(opennessValues.length ? opennessValues : ['closed']);

  let strongestCopyleft = 0;
  let copyleftSource: string | null = null;
  let attributionRequired = false;
  const proprietary: string[] = [];
  for (const c of classified) {
    if (c.copyleft > strongestCopyleft) {
      strongestCopyleft = c.copyleft;
      copyleftSource = c.brick_id;
    }
    if (c.attribution) attributionRequired = true;
    if (c.class === 'proprietary' || c.class === 'unknown') proprietary.push(c.brick_id);
  }

  const conflicts: { code: string; message: string }[] = [];
  // A strong/network copyleft component in the same work as a proprietary one
  // is a genuine legal conflict (cannot be combined and redistributed).
  if (strongestCopyleft >= 2 && proprietary.length) {
    conflicts.push({
      code: 'COPYLEFT_PROPRIETARY_CONFLICT',
      message: `copyleft component ${String(copyleftSource)} cannot be combined with proprietary/unknown components ${proprietary.join(', ')}`,
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
// eslint-disable-next-line max-lines-per-function, complexity -- Declarative report, compatibility, or fixture assembly stays contiguous so field order and side-effect order remain auditable; splitting would not reduce conceptual complexity.
export function checkComposition(declared: CompositionDeclaration, components: readonly LicenseComponent[]) {
  const declaredVisibility = declared.visibility || 'private';
  const declaredOpenness = declared.openness || opennessOfLicense(declared.license);
  const combined = combineLicenses(components);

  const meetVis = meetVisibility(
    (components || []).flatMap((component) => component.visibility ? [component.visibility] : []),
  );
  const effectiveOpenness = combined.effective_openness;

  const violations: {
    code: string; severity: 'block' | 'warn'; message: string;
    components?: string[]; limit?: string; declared?: string;
  }[] = [];

  const declaredTier: LicenseTier = declared.license_tier && LICENSE_TIERS.includes(declared.license_tier)
    ? declared.license_tier
    : 'open';
  const commercialComponents = (components || []).filter((component) => component.license_tier === 'commercial');
  if (declaredTier === 'open' && commercialComponents.length && !declared.commercial_waiver) {
    violations.push({
      code: 'COMMERCIAL_TIER_WAIVER_REQUIRED',
      severity: 'block',
      message: `open canonical composition depends on commercial brick(s) ${commercialComponents.map((c) => c.brick_id).join(', ')} without an explicit commercial waiver`,
      components: commercialComponents.map((c) => c.brick_id),
    });
  }
  for (const component of commercialComponents) {
    if (!component.commercial_terms) {
      violations.push({
        code: 'COMMERCIAL_TERMS_MISSING',
        severity: 'block',
        message: `commercial brick ${component.brick_id} does not declare commercial_terms`,
      });
    }
  }

  // 1. Visibility escalation — declared more visible than the least-visible brick.
  if (components?.length && visibilityRank(declaredVisibility) > visibilityRank(meetVis)) {
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
        message: `component ${String(combined.copyleft_source)} imposes copyleft that the declared license "${declared.license || 'none'}" does not satisfy`,
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
      license_tier: commercialComponents.length ? 'commercial' : declaredTier,
    },
    violations,
  };
}

function opennessOfLicense(license: unknown): Openness {
  return classifyLicense(license).openness;
}

function describeEffectiveLicense(combined: LicenseCombination): string {
  if (combined.effective_openness === 'closed') return 'proprietary';
  if (combined.strongest_copyleft >= 3) return 'network-copyleft';
  if (combined.strongest_copyleft === 2) return 'strong-copyleft';
  if (combined.strongest_copyleft === 1) return 'weak-copyleft';
  if (combined.effective_openness === 'source-available') return 'source-available';
  return 'permissive';
}
