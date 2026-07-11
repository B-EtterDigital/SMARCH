#!/usr/bin/env node
/**
 * What: Verifies stored provenance chains and optionally rechecks live source fingerprints.
 * Why: Edited history, changed source, or invalid signatures must not retain trusted status.
 * How: Reads provenance records, keys, and optional source files, then reports failures or gates.
 * Callers: Trust audits and release checks run it after ledger generation.
 * Example: `node tools/sma-provenance-verify.mjs --json`
 */
/**
 * SMA provenance-verify — tamper detection for the creator trail.
 *
 * Recomputes every brick's provenance SEAL from the events stored in the
 * ledger (created_by + touched_by) anchored to its content fingerprint, and
 * compares against the stored head. Any of these break the seal:
 *   - an author/event was edited, removed, or reordered  -> head mismatch
 *   - the source was modified after sealing               -> anchor mismatch
 *   - the ledger was rewritten wholesale                  -> signature mismatch
 *     (only if the ledger was signed; unsigned seals catch inconsistent edits
 *      but not a forger who recomputes the whole chain — sign to close that).
 *
 * With --recheck-source it re-fingerprints each brick on disk and compares to
 * the sealed anchor, catching drift between the ledger and the live source.
 *
 * Report mode by default; --gate exits non-zero if any seal fails.
 *
 * Usage:
 *   node tools/sma-provenance-verify.mjs
 *   node tools/sma-provenance-verify.mjs --gate
 *   node tools/sma-provenance-verify.mjs --recheck-source
 *   node tools/sma-provenance-verify.mjs --json
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBrickPath } from './lib/source-path-resolver.ts';
import { verifySeal, verifySealSignature, fingerprintSource } from './lib/provenance-seal.mjs';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROV_LEDGER = resolve(SMA_ROOT, 'registry/provenance-ledger.generated.json');
const FINGERPRINT_LEDGER = resolve(SMA_ROOT, 'security/brick-fingerprints.generated.json');
const DEFAULT_REGISTRY = 'scans/all-projects/latest.registry.json';
const KEY_DIR = resolve(SMA_ROOT, 'security/keys');

const args = parseArgs(process.argv.slice(2));

try {
  main();
} catch (err) {
  console.error(`sma-provenance-verify: ${err.message}`);
  process.exit(1);
}

function main() {
  const registryPath = resolve(SMA_ROOT, args.registry || DEFAULT_REGISTRY);
  const discoveredBricks = loadRegistry(registryPath);
  if (!existsSync(PROV_LEDGER)) {
    if (discoveredBricks.size === 0) {
      const report = emptyReport();
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else printReport(report);
      return;
    }
    throw new Error(`provenance ledger not found: ${relative(SMA_ROOT, PROV_LEDGER)}. Run: node tools/sma-provenance-ledger.mjs`);
  }
  const ledger = JSON.parse(readFileSync(PROV_LEDGER, 'utf8'));
  const fpMap = loadFingerprints();
  const publicPem = ledger.signed ? loadPublicKey(ledger.signing_key_id) : null;
  const brickMap = (args.recheckSource || args.coverage) ? discoveredBricks : null;

  const failures = [];
  let signatureChecked = 0;
  let sourceChecked = 0;

  for (const entry of ledger.provenance || []) {
    const events = [];
    if (entry.created_by) events.push(entry.created_by);
    events.push(...(entry.touched_by || []));
    const contentHash = fpMap.get(entry.brick_id) ?? null;

    const seal = entry.seal;
    const check = verifySeal(seal, { brick_id: entry.brick_id, content_hash: contentHash, events });
    const reasons = [...check.reasons];

    // signature check
    if (ledger.signed && seal?.signature) {
      signatureChecked += 1;
      if (!publicPem) {
        reasons.push('ledger is signed but the public key is unavailable');
      } else if (!verifySealSignature(seal.head, seal.signature, publicPem)) {
        reasons.push('ed25519 signature does not verify against the recorded key');
      }
    } else if (ledger.signed && !seal?.signature) {
      reasons.push('ledger marked signed but this entry has no signature');
    }

    // optional source drift check
    if (args.recheckSource && brickMap) {
      const drift = recheckSource(entry.brick_id, brickMap, seal);
      if (drift) { reasons.push(drift); }
      sourceChecked += 1;
    }

    if (reasons.length) {
      failures.push({ brick_id: entry.brick_id, project: entry.project, reasons });
    }
  }

  // Coverage: every brick in the registry must have a ledger entry. This is the
  // gate that stops a NEW brick from slipping through unledgered — it fails CI
  // until `npm run provenance:ledger` is run.
  let coverage = null;
  if (args.coverage && brickMap) {
    const ledgerIds = new Set((ledger.provenance || []).map((e) => e.brick_id));
    const missing = [...brickMap.keys()].filter((id) => !ledgerIds.has(id));
    coverage = {
      registry_bricks: brickMap.size,
      ledgered: ledgerIds.size,
      missing: missing.length,
      missing_sample: missing.slice(0, 20),
    };
    for (const id of missing) {
      failures.push({
        brick_id: id,
        project: brickMap.get(id)?.brick?.project || null,
        reasons: ['brick is in the registry but missing from the provenance ledger — run: npm run provenance:ledger'],
      });
    }
  }

  // Trust posture (F1): an unsigned ledger is only tamper-EVIDENT; a signed one
  // is only trustworthy if the signing key is pinned OUT-OF-BAND. Without a pin,
  // a forger can self-generate a key, re-sign, and pass. security/keys/trusted.json
  // (committed) lists the key_ids we accept.
  const trustNotes = [];
  const trustedKeysPath = resolve(KEY_DIR, 'trusted.json');
  let trustedKeyIds = null;
  if (existsSync(trustedKeysPath)) {
    try { trustedKeyIds = JSON.parse(readFileSync(trustedKeysPath, 'utf8')).key_ids || []; } catch { /* ignore */ }
  }
  if (!ledger.signed) {
    trustNotes.push('ledger is UNSIGNED — a repo-writer can recompute a consistent head. Sign (sma-provenance-ledger --sign) + anchor externally for tamper-proofing.');
    if (args.requireSigned) failures.push({ brick_id: '(ledger)', project: null, reasons: ['--require-signed is set but the ledger is unsigned'] });
  } else if (Array.isArray(trustedKeyIds)) {
    if (!trustedKeyIds.includes(ledger.signing_key_id)) {
      failures.push({ brick_id: '(ledger)', project: null, reasons: [`ledger signed by key "${ledger.signing_key_id}" which is NOT in security/keys/trusted.json — possible key substitution`] });
    } else {
      trustNotes.push(`ledger signed by trusted key ${ledger.signing_key_id}`);
    }
  } else {
    trustNotes.push(`ledger signed by ${ledger.signing_key_id} but no security/keys/trusted.json pin exists — the key is not verified out-of-band (pin it to close the key-substitution gap).`);
  }

  // Revocation: a revoked signing key invalidates the ledger; revoked bricks are flagged.
  const revPath = resolve(SMA_ROOT, 'security/revocations.json');
  if (existsSync(revPath)) {
    try {
      const rev = JSON.parse(readFileSync(revPath, 'utf8'));
      if (ledger.signing_key_id && (rev.revoked_key_ids || []).includes(ledger.signing_key_id)) {
        failures.push({ brick_id: '(ledger)', project: null, reasons: [`signing key ${ledger.signing_key_id} is REVOKED — signatures are no longer trusted`] });
      }
      const revokedBricks = new Set((rev.revoked_bricks || []).map((r) => (typeof r === 'string' ? r : r.brick_id)));
      if (revokedBricks.size) {
        const hit = (ledger.provenance || []).filter((e) => revokedBricks.has(e.brick_id)).map((e) => e.brick_id);
        for (const id of hit) trustNotes.push(`brick ${id} is REVOKED`);
      }
    } catch { /* ignore malformed revocation list */ }
  }

  const total = (ledger.provenance || []).length;
  const status = failures.length ? 'failed' : 'passed';
  const report = {
    status,
    total,
    verified: total - failures.length,
    failed: failures.length,
    signed: Boolean(ledger.signed),
    signature_checked: signatureChecked,
    source_rechecked: sourceChecked,
    coverage,
    trust_notes: trustNotes,
    failures,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }

  if (args.gate && status === 'failed') process.exit(4);
}

function emptyReport() {
  return {
    status: 'warn',
    warning: 'nothing to check; run npm run scan to discover manifests, then rerun this gate',
    total: 0,
    verified: 0,
    failed: 0,
    signed: false,
    signature_checked: 0,
    source_rechecked: 0,
    coverage: { registry_bricks: 0, ledgered: 0, missing: 0, missing_sample: [] },
    trust_notes: [],
    failures: [],
  };
}

function recheckSource(brickId, brickMap, seal) {
  const brick = brickMap.get(brickId);
  if (!brick?.projectAbs) return null;
  const resolved = resolveBrickPath(brick.brick, brick.projectAbs);
  if (!resolved?.absolutePath) return null;
  const fp = fingerprintSource(resolved.absolutePath, { maxFiles: 4000 });
  if (!fp.content_hash) return null;
  // recompute anchor with the fresh fingerprint
  const fresh = verifySeal(seal, { brick_id: brickId, content_hash: fp.content_hash, events: [] });
  // if the anchor mismatches, the source drifted (independent of chain edits)
  if (fresh.recomputed && seal.anchor !== fresh.recomputed.anchor) {
    return 'live source no longer matches the sealed fingerprint (source drift)';
  }
  return null;
}

function loadFingerprints() {
  const map = new Map();
  if (!existsSync(FINGERPRINT_LEDGER)) return map;
  try {
    const data = JSON.parse(readFileSync(FINGERPRINT_LEDGER, 'utf8'));
    for (const fp of data.fingerprints || []) map.set(fp.brick_id, fp.content_hash);
  } catch { /* ignore */ }
  return map;
}

function loadRegistry(registryPath) {
  const map = new Map();
  if (!existsSync(registryPath)) return map;
  const reg = JSON.parse(readFileSync(registryPath, 'utf8'));
  const roots = new Map((reg.scanned_project_roots || []).map((r) => [r.id, r.root]));
  for (const brick of reg.bricks || []) {
    map.set(brick.id, { brick, projectAbs: roots.get(brick.project) || null });
  }
  return map;
}

function loadPublicKey(keyId) {
  if (!keyId) return null;
  const p = resolve(KEY_DIR, `seal.${keyId}.pub.pem`);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function printReport(report) {
  console.log(`SMA provenance-verify: ${report.status}`);
  if (report.warning) console.log(`  WARN — ${report.warning}`);
  console.log(`  seals: ${report.verified}/${report.total} verified` + (report.failed ? `, ${report.failed} FAILED` : ''));
  console.log(`  signed: ${report.signed ? `yes (${report.signature_checked} signatures checked)` : 'no (unsigned hash-chain)'}`);
  if (report.coverage) {
    console.log(`  coverage: ${report.coverage.ledgered}/${report.coverage.registry_bricks} registry bricks ledgered` + (report.coverage.missing ? `, ${report.coverage.missing} MISSING` : ''));
  }
  if (report.source_rechecked) console.log(`  source rechecked: ${report.source_rechecked}`);
  for (const note of report.trust_notes || []) console.log(`  trust: ${note}`);
  for (const f of report.failures.slice(0, 40)) {
    console.log(`  TAMPER ${f.brick_id}`);
    for (const r of f.reasons) console.log(`         - ${r}`);
  }
  if (report.failures.length > 40) console.log(`  … and ${report.failures.length - 40} more`);
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = list[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next; i += 1;
  }
  return out;
}
