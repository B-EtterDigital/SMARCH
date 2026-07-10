/**
 * license-evidence.mjs — scan source files for LICENSE EVIDENCE so a brick's
 * DECLARED license can be checked against what its code actually contains.
 *
 * The rest of the system (ledger, export-guard, lattice) TRUSTS the repo's
 * self-declared license. That trust is exactly the laundering hole: a brick can
 * declare "MIT" while shipping AGPL headers or copied GPL source. This module
 * reads the actual bytes and reports the license evidence found, then compares
 * it to the declaration.
 *
 * Two evidence channels:
 *   (a) SPDX-License-Identifier tags — machine-readable, authoritative.
 *   (b) well-known license-text signatures — the boilerplate of famous licenses.
 *
 * Pure detection + a small policy check on top of license-lattice's
 * classifyLicense. Fail toward FLAGGING: if the evidence contradicts (or fails
 * to corroborate) an open declaration, we flag it.
 */

import { readdirSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';

import { classifyLicense, opennessRank } from './license-lattice.mjs';

// ---------------------------------------------------------------------------
// Well-known license-text signatures. Lowercased substring -> canonical SPDX.
// Extend here as new license boilerplates need recognizing.
// ---------------------------------------------------------------------------
export const TEXT_SIGNATURES = [
  ['gnu affero', 'AGPL-3.0'],
  ['gnu general public', 'GPL-3.0'],
  ['gnu lesser', 'LGPL-3.0'],
  ['mozilla public license', 'MPL-2.0'],
  ['apache license', 'Apache-2.0'],
  ['permission is hereby granted, free of charge', 'MIT'],
  ['redistribution and use in source and binary', 'BSD-3-Clause'],
  ['business source license', 'BUSL-1.1'],
  ['this is free and unencumbered', 'Unlicense'],
  ['creative commons attribution', 'CC-BY-4.0'],
];

const SPDX_RE = /SPDX-License-Identifier:\s*([^\n\r]+)/gi;

// Directories never worth scanning (deps, VCS, build output).
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

// Binary / image extensions we never treat as text.
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tiff', 'svgz', 'pdf',
  'zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar', 'jar', 'class', 'wasm',
  'woff', 'woff2', 'ttf', 'eot', 'otf', 'mp3', 'wav', 'flac', 'ogg', 'mp4',
  'mov', 'mkv', 'avi', 'webm', 'exe', 'dll', 'so', 'dylib', 'bin', 'node',
]);

// Top-level license-file names (LICENSE, COPYING, LICENCE, with any extension).
const LICENSE_FILE_RE = /^(licen[cs]e|copying|copyleft|unlicense)($|\.)/i;

const MAX_READ_BYTES = 128 * 1024; // license evidence lives near the top of a file

/**
 * Detect license evidence in a single file's text.
 * @returns {{ spdxTags: string[], textMatches: string[] }}
 */
export function scanText(text) {
  const spdxTags = [];
  const textMatches = [];
  if (typeof text !== 'string' || !text) return { spdxTags, textMatches };

  for (const m of text.matchAll(SPDX_RE)) {
    const expr = cleanSpdxExpr(m[1]);
    if (expr) spdxTags.push(expr);
  }

  const lower = text.toLowerCase();
  for (const [phrase, spdx] of TEXT_SIGNATURES) {
    if (lower.includes(phrase)) textMatches.push(spdx);
  }

  return { spdxTags: uniq(spdxTags), textMatches: uniq(textMatches) };
}

/** Strip trailing comment closers / noise from a captured SPDX expression. */
function cleanSpdxExpr(raw) {
  return String(raw)
    .replace(/\*\/\s*$/, '') // C block comment close
    .replace(/-->\s*$/, '') // HTML comment close
    .replace(/\s+(#|\/\/).*$/, '') // trailing line comment
    .trim();
}

/**
 * Walk a directory tree and gather all license evidence.
 * @param {string} absDir
 * @param {{maxFiles?: number}} [opts]
 * @returns {{
 *   detected: string[],
 *   byLicense: Record<string, string[]>,
 *   hasLicenseFile: boolean,
 *   primary: string|null,
 *   confidence: 'high'|'medium'|'low',
 *   fileCount: number,
 * }}
 */
export function scanDirectory(absDir, { maxFiles = 2000 } = {}) {
  const byLicense = Object.create(null);
  let fileCount = 0;
  let spdxTagFiles = 0;
  let evidenceFiles = 0;
  let hasLicenseFile = false;
  const licenseFileLicenses = [];

  const record = (spdx, relPath) => {
    if (!byLicense[spdx]) byLicense[spdx] = [];
    byLicense[spdx].push(relPath);
  };

  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (fileCount >= maxFiles) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isBinaryName(entry.name)) continue;

      const text = readHead(full);
      if (text === null) continue; // unreadable or binary content
      fileCount += 1;

      const rel = full.startsWith(absDir) ? full.slice(absDir.length).replace(/^[/\\]/, '') : full;
      const { spdxTags, textMatches } = scanText(text);
      const all = uniq([...spdxTags, ...textMatches]);

      if (spdxTags.length) spdxTagFiles += 1;
      if (all.length) evidenceFiles += 1;
      for (const spdx of all) record(spdx, rel);

      const isTopLevelLicense = depth === 0 && LICENSE_FILE_RE.test(basename(entry.name));
      if (isTopLevelLicense) {
        hasLicenseFile = true;
        for (const spdx of all) licenseFileLicenses.push(spdx);
      }
    }
  };

  walk(absDir, 0);

  const detected = Object.keys(byLicense);

  // Primary: prefer what the top-level LICENSE file declares (strongest wins,
  // so an AGPL file that also references the GPL resolves to AGPL); else the
  // most-common license across the tree.
  let primary = null;
  if (licenseFileLicenses.length) {
    primary = pickStrongest(licenseFileLicenses);
  } else if (detected.length) {
    primary = mostCommon(byLicense);
  }

  /** @type {'low'|'medium'|'high'} */
  let confidence = 'low';
  if (hasLicenseFile && (spdxTagFiles > 0 || evidenceFiles > 1)) confidence = 'high';
  else if (hasLicenseFile || spdxTagFiles > 0 || evidenceFiles > 0) confidence = 'medium';

  return { detected, byLicense, hasLicenseFile, primary, confidence, fileCount };
}

/**
 * Declared-vs-actual laundering check. Flags when the DECLARED license is MORE
 * PERMISSIVE than the strongest evidence actually found in the source (e.g.
 * declared MIT but AGPL/GPL headers present, or declared open with no/only
 * proprietary evidence). Fails toward FLAGGING.
 *
 * "More permissive" is decided on the license-lattice axes:
 *   1. openness  (closed < source-available < open)  — more open  = more permissive
 *   2. copyleft  (0 none < 1 weak < 2 strong < 3 net) — less copyleft = more permissive
 * A license is more permissive if it is strictly MORE OPEN, or equally open but
 * carries STRICTLY WEAKER copyleft obligations.
 *
 * @param {string} declaredSpdx
 * @param {string[] | {detected?: string[], hasLicenseFile?: boolean}} evidence
 * @returns {{ mismatch: boolean, severity: 'high'|'medium'|'low'|'none', message: string }}
 */
export function evaluateDeclarationMismatch(declaredSpdx, evidence) {
  const { detected, hasLicenseFile } = normalizeEvidence(evidence);
  const declared = classifyLicense(declaredSpdx);
  const strongest = strongestEvidence(detected); // null when no evidence
  const actual = strongest || classifyLicense(null); // fail-safe: unknown => closed
  const hasEvidence = detected.length > 0;

  if (!isMorePermissive(declared, actual)) {
    return {
      mismatch: false,
      severity: 'none',
      message: hasEvidence
        ? `declared "${declared.spdx || declaredSpdx || 'none'}" is consistent with the strongest evidence "${actual.spdx}"`
        : `declared "${declared.spdx || declaredSpdx || 'none'}" makes no openness claim beyond the (absent) evidence`,
    };
  }

  // Mismatch. Grade it.
  if (!hasEvidence) {
    return {
      mismatch: true,
      severity: hasLicenseFile ? 'medium' : 'medium',
      message: `declared "${declared.spdx || declaredSpdx}" claims openness "${declared.openness}" but NO license evidence (SPDX tags or license text) was found in the source to corroborate it`,
    };
  }

  const opennessEscalation = opennessRank(declared.openness) > opennessRank(actual.openness);
  /** @type {'high'|'medium'} */
  let severity;
  if (opennessEscalation) {
    // declaring open/source-available over closed/source-available evidence
    severity = 'high';
  } else if (actual.copyleft >= 2) {
    // strong/network copyleft evidence laundered as something more permissive
    severity = 'high';
  } else {
    severity = 'medium';
  }

  const reason = opennessEscalation
    ? `more open ("${declared.openness}" vs evidence "${actual.openness}")`
    : `weaker copyleft (declared copyleft ${declared.copyleft} vs evidence copyleft ${actual.copyleft})`;

  return {
    mismatch: true,
    severity,
    message: `declared "${declared.spdx || declaredSpdx}" is MORE PERMISSIVE than the strongest evidence "${actual.spdx}" — ${reason}. Possible license laundering.`,
  };
}

// --- helpers ----------------------------------------------------------------

function normalizeEvidence(evidence) {
  if (Array.isArray(evidence)) return { detected: uniq(evidence), hasLicenseFile: false };
  if (evidence && typeof evidence === 'object') {
    return {
      detected: uniq(Array.isArray(evidence.detected) ? evidence.detected : []),
      hasLicenseFile: Boolean(evidence.hasLicenseFile),
    };
  }
  return { detected: [], hasLicenseFile: false };
}

/** The most restrictive license among the evidence (min openness, max copyleft). */
function strongestEvidence(spdxList) {
  let best = null;
  for (const spdx of spdxList) {
    const c = classifyLicense(spdx);
    if (!best) { best = c; continue; }
    const rc = opennessRank(c.openness);
    const rb = opennessRank(best.openness);
    if (rc < rb || (rc === rb && c.copyleft > best.copyleft)) best = c;
  }
  return best;
}

/** The strongest (most restrictive) license label from a list — for primary. */
function pickStrongest(spdxList) {
  const c = strongestEvidence(spdxList);
  return c ? c.spdx : null;
}

/** Is license `a` strictly MORE PERMISSIVE than license `b`? */
function isMorePermissive(a, b) {
  const ra = opennessRank(a.openness);
  const rb = opennessRank(b.openness);
  if (ra > rb) return true; // more open
  if (ra < rb) return false; // less open
  return a.copyleft < b.copyleft; // same openness, weaker copyleft
}

function mostCommon(byLicense) {
  let bestKey = null;
  let bestCount = -1;
  for (const [key, files] of Object.entries(byLicense)) {
    const n = files.length;
    if (n > bestCount) { bestKey = key; bestCount = n; continue; }
    // tie-break: prefer the stronger (more restrictive) license
    if (n === bestCount && bestKey && isMorePermissive(classifyLicense(bestKey), classifyLicense(key))) {
      bestKey = key;
    }
  }
  return bestKey;
}

function isBinaryName(name) {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return BINARY_EXT.has(name.slice(dot + 1).toLowerCase());
}

/** Read the head of a file as UTF-8; return null for binary or unreadable. */
function readHead(filePath, maxBytes = MAX_READ_BYTES) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    const slice = buf.subarray(0, bytes);
    // binary sniff: a NUL byte in the first chunk => not text
    const sniff = slice.subarray(0, Math.min(bytes, 8000));
    if (sniff.includes(0)) return null;
    return slice.toString('utf8');
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

function uniq(arr) {
  return [...new Set(arr)];
}
