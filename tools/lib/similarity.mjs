/**
 * similarity.mjs — near-duplicate ("fuzzy") source-code detection.
 *
 * The existing theft signal (sma-provenance-ledger detectCollisions) groups
 * bricks only by IDENTICAL content_hash, so a thief who edits one character,
 * reformats, or renames a variable slips right past it. This module is the
 * SIMILARITY PRIMITIVE a later step wires into the ledger: it scores two source
 * texts (or two file sets) on a 0..1 scale where 1.0 means indistinguishable
 * after structural normalization.
 *
 * The pipeline, all pure + deterministic + language-agnostic (no external deps):
 *
 *   normalizeSource  strip comments, collapse whitespace, fold string/number
 *                    literals to placeholders, fold identifiers to `v` while
 *                    keeping a generic control-flow keyword set — so reformats
 *                    and consistent renames become NO-OPs.
 *   kGramShingles    overlapping k-token windows (structural substrings).
 *   winnow           Schleimer/Wilcox-O'Hearn winnowing fingerprints: hash each
 *                    shingle, slide a window, keep the min per window. Robust,
 *                    position-independent document fingerprint.
 *   simhash          64-bit locality-sensitive hash (bit-voting over shingles).
 *   similarity       winnowing-Jaccard (primary) blended with simhash-Hamming
 *                    (secondary). Identical-after-normalization short-circuits
 *                    to exactly 1.0.
 *
 * Rename invariance: because identifiers fold to `v`, a full consistent rename
 * yields an identical token stream -> similarity 1.0 (see selftest). Partial or
 * keyword-colliding renames degrade gracefully via the k-gram/winnow overlap.
 */

/* ------------------------------------------------------------------ hashing */

// FNV-1a 32-bit (integer math) — fingerprints for winnowing.
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

// FNV-1a 64-bit (BigInt) — feeds the simhash bit vote.
function hash64(str) {
  let h = FNV64_OFFSET;
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    h = ((h ^ BigInt(c & 0xff)) * FNV64_PRIME) & MASK64;
    h = ((h ^ BigInt((c >> 8) & 0xff)) * FNV64_PRIME) & MASK64;
  }
  return h;
}

/* -------------------------------------------------------------- normalize */

// Generic union of control-flow / declaration keywords across common languages.
// Kept literally (they carry structure); every OTHER identifier folds to `v`.
const KEYWORDS = new Set([
  'if', 'else', 'elif', 'elseif', 'for', 'foreach', 'while', 'do', 'switch',
  'case', 'default', 'break', 'continue', 'return', 'goto', 'function', 'func',
  'def', 'fn', 'class', 'struct', 'interface', 'enum', 'trait', 'impl',
  'import', 'from', 'export', 'require', 'include', 'using', 'namespace',
  'package', 'module', 'public', 'private', 'protected', 'internal', 'static',
  'final', 'abstract', 'const', 'let', 'var', 'val', 'new', 'delete', 'try',
  'catch', 'finally', 'throw', 'throws', 'raise', 'except', 'async', 'await',
  'yield', 'void', 'this', 'self', 'super', 'extends', 'implements', 'in', 'of',
  'is', 'as', 'and', 'or', 'not', 'true', 'false', 'null', 'none', 'nil',
  'undefined', 'lambda', 'with', 'match', 'when', 'where', 'select', 'end',
]);

const isWordStart = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
const isWordPart = (c) => isWordStart(c) || (c >= '0' && c <= '9');
const isDigit = (c) => c >= '0' && c <= '9';
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
const isNumPart = (c) => isDigit(c) || c === '.' || c === '_'
  || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') || c === 'x' || c === 'X';

/**
 * normalizeSource(text) -> lowercased structural token stream (array).
 * Strips // , /* *\/ and # comments generically; collapses whitespace; folds
 * string and number literals to `str` / `num`; folds identifiers to `v` while
 * preserving a generic keyword set and single-character punctuation/operators.
 */
export function normalizeSource(text) {
  if (typeof text !== 'string') return [];
  const src = text;
  const n = src.length;
  const out = [];
  let i = 0;
  while (i < n) {
    const ch = src[i];
    // line comments: //  and  #
    if (ch === '/' && src[i + 1] === '/') { i += 2; while (i < n && src[i] !== '\n') i += 1; continue; }
    if (ch === '#') { i += 1; while (i < n && src[i] !== '\n') i += 1; continue; }
    // block comment /* ... */
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    // string / template literals
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i += 1;
      while (i < n && src[i] !== q) { if (src[i] === '\\') i += 1; i += 1; }
      i += 1;
      out.push('str');
      continue;
    }
    // number literals (incl. hex / decimals / separators)
    if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1] || ''))) {
      i += 1;
      while (i < n && isNumPart(src[i])) i += 1;
      out.push('num');
      continue;
    }
    // identifiers / keywords
    if (isWordStart(ch)) {
      let j = i + 1;
      while (j < n && isWordPart(src[j])) j += 1;
      const word = src.slice(i, j).toLowerCase();
      i = j;
      out.push(KEYWORDS.has(word) ? word : 'v');
      continue;
    }
    // whitespace collapses away
    if (isSpace(ch)) { i += 1; continue; }
    // punctuation / operator -> single-char token (whitespace-robust)
    out.push(ch);
    i += 1;
  }
  return out;
}

/* ------------------------------------------------------------- shingles */

/** kGramShingles(tokens, k=5) -> array of k-gram strings. */
export function kGramShingles(tokens, k = 5) {
  const out = [];
  if (!Array.isArray(tokens) || tokens.length === 0) return out;
  const kk = Math.max(1, k | 0);
  if (tokens.length < kk) { out.push(tokens.join(' ')); return out; }
  for (let i = 0; i + kk <= tokens.length; i += 1) {
    out.push(tokens.slice(i, i + kk).join(' '));
  }
  return out;
}

/* ------------------------------------------------------------- winnowing */

/**
 * winnow(shingles, window=4) -> Set of selected fingerprints (8-hex strings).
 * Schleimer/Wilcox-O'Hearn winnowing: hash each k-gram, slide a window of size
 * `window`, select the (rightmost) minimum hash in each window. The rightmost
 * rule minimizes redundant selections across overlapping windows.
 */
export function winnow(shingles, window = 4) {
  const out = new Set();
  if (!Array.isArray(shingles) || shingles.length === 0) return out;
  const hashes = shingles.map(hash32);
  const w = Math.max(1, window | 0);
  const asHex = (h) => (h >>> 0).toString(16).padStart(8, '0');
  if (hashes.length < w) {
    let m = 0;
    for (let j = 1; j < hashes.length; j += 1) if (hashes[j] <= hashes[m]) m = j;
    out.add(asHex(hashes[m]));
    return out;
  }
  let lastPos = -1;
  for (let i = 0; i + w <= hashes.length; i += 1) {
    let m = i;
    for (let j = i + 1; j < i + w; j += 1) if (hashes[j] <= hashes[m]) m = j;
    if (m !== lastPos) { out.add(asHex(hashes[m])); lastPos = m; }
  }
  return out;
}

/* ------------------------------------------------------------- simhash */

/** simhash(shingles) -> 64-bit simhash as a 16-char hex string. */
export function simhash(shingles) {
  const bits = new Array(64).fill(0);
  if (Array.isArray(shingles)) {
    for (const s of shingles) {
      const h = hash64(s);
      for (let b = 0; b < 64; b += 1) {
        bits[b] += ((h >> BigInt(b)) & 1n) === 1n ? 1 : -1;
      }
    }
  }
  let out = 0n;
  for (let b = 0; b < 64; b += 1) if (bits[b] > 0) out |= (1n << BigInt(b));
  return out.toString(16).padStart(16, '0');
}

/** hamming(aHex, bHex) -> bit distance between two hex simhashes. */
export function hamming(aHex, bHex) {
  let x = BigInt(`0x${aHex}`) ^ BigInt(`0x${bHex}`);
  let c = 0;
  while (x > 0n) { c += Number(x & 1n); x >>= 1n; }
  return c;
}

/* ------------------------------------------------------------- jaccard */

/** jaccard(setA, setB) -> |A∩B| / |A∪B|. Two empty sets are defined as 1. */
export function jaccard(setA, setB) {
  if (!(setA instanceof Set) || !(setB instanceof Set)) return 0;
  if (setA.size === 0 && setB.size === 0) return 1;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let inter = 0;
  for (const x of small) if (large.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 1 : inter / union;
}

/* ------------------------------------------------------------- similarity */

const K_DEFAULT = 5;
const WIN_DEFAULT = 4;
// winnowing-Jaccard is the primary signal; simhash-Hamming backs it up.
const W_JACCARD = 0.8;
const W_SIMHASH = 0.2;

/**
 * similarity(textA, textB) -> 0..1. Exactly 1.0 when the two texts are
 * identical after structural normalization (covers exact copies, pure
 * reformats, and consistent renames). Otherwise a blend of winnowing-Jaccard
 * (primary) and simhash-Hamming (secondary). Symmetric in its arguments.
 */
export function similarity(textA, textB) {
  const ta = normalizeSource(textA);
  const tb = normalizeSource(textB);
  if (ta.length === tb.length && ta.join(' ') === tb.join(' ')) return 1;
  const sa = kGramShingles(ta, K_DEFAULT);
  const sb = kGramShingles(tb, K_DEFAULT);
  const j = jaccard(winnow(sa, WIN_DEFAULT), winnow(sb, WIN_DEFAULT));
  const simHam = 1 - hamming(simhash(sa), simhash(sb)) / 64;
  const score = W_JACCARD * j + W_SIMHASH * simHam;
  return Math.max(0, Math.min(1, score));
}

/**
 * fileSetSimilarity(filesA, filesB) where each file is { path, text } -> 0..1.
 *
 * Choice: symmetric length-weighted BEST-MATCH (not concatenation). For each
 * file in A we take its best similarity to any file in B, weight it by the
 * file's normalized token length, and average; likewise B->A; then average the
 * two directions. Best-match beats concatenation because a thief who lifts a
 * few files into a larger project would be diluted to zero by concatenation,
 * whereas per-file best-match still surfaces the stolen files. Averaging both
 * directions keeps the result symmetric.
 */
export function fileSetSimilarity(filesA, filesB) {
  const A = (Array.isArray(filesA) ? filesA : []).filter((f) => f && typeof f.text === 'string');
  const B = (Array.isArray(filesB) ? filesB : []).filter((f) => f && typeof f.text === 'string');
  if (A.length === 0 && B.length === 0) return 1;
  if (A.length === 0 || B.length === 0) return 0;
  const direction = (X, Y) => {
    let wsum = 0;
    let acc = 0;
    for (const x of X) {
      const weight = Math.max(1, normalizeSource(x.text).length);
      let best = 0;
      for (const y of Y) {
        const s = similarity(x.text, y.text);
        if (s > best) best = s;
        if (best === 1) break;
      }
      acc += weight * best;
      wsum += weight;
    }
    return wsum === 0 ? 0 : acc / wsum;
  };
  return (direction(A, B) + direction(B, A)) / 2;
}
