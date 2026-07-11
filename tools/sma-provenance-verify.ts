#!/usr/bin/env node
/**
 * What: Verifies stored provenance chains and optionally rechecks live source fingerprints.
 * Why: Edited history, changed source, or invalid signatures must not retain trusted status.
 * How: Reads provenance records, keys, and optional source files, then reports failures or gates.
 * Callers: Trust audits and release checks run it after ledger generation.
 * Example: `node tools/sma-provenance-verify.ts --json`
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
 *   node tools/sma-provenance-verify.ts
 *   node tools/sma-provenance-verify.ts --gate
 *   node tools/sma-provenance-verify.ts --recheck-source
 *   node tools/sma-provenance-verify.ts --json
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBrickPath } from './lib/source-path-resolver.ts';
import { verifySeal, verifySealSignature, fingerprintSource } from './lib/provenance-seal.ts';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROV_LEDGER = resolve(SMA_ROOT, 'registry/provenance-ledger.generated.json');
const FINGERPRINT_LEDGER = resolve(SMA_ROOT, 'security/brick-fingerprints.generated.json');
const DEFAULT_REGISTRY = 'scans/all-projects/latest.registry.json';
const KEY_DIR = resolve(SMA_ROOT, 'security/keys');

type CliArgs = { registry?: string; json?: boolean; recheckSource?: boolean; coverage?: boolean; requireSigned?: boolean; gate?: boolean };
type StoredSeal = Parameters<typeof verifySeal>[0] & { signature?: string };
type ProvenanceEvent = NonNullable<Parameters<typeof verifySeal>[1]['events']>[number];
type LedgerEntry = { brick_id: string; project?: string; created_by?: ProvenanceEvent; touched_by: ProvenanceEvent[]; seal: StoredSeal };
type ProvenanceLedger = { signed: boolean; signing_key_id: string | null; provenance: LedgerEntry[] };
type RegistryBrick = { id: string; project: string; manifest_path?: string; source_paths?: string[] };
type RegistryEntry = { brick: RegistryBrick; projectAbs: string | null };
type VerifyFailure = { brick_id: string; project: string | null; reasons: string[] };
type Coverage = { registry_bricks: number; ledgered: number; missing: number; missing_sample: string[] };
type VerifyReport = { status: string; warning?: string; total: number; verified: number; failed: number; signed: boolean; signature_checked: number; source_rechecked: number; coverage: Coverage | null; trust_notes: string[]; failures: VerifyFailure[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLedger(value: unknown): ProvenanceLedger {
  if (!isRecord(value)) throw new Error('provenance ledger must be an object');
  const provenance: LedgerEntry[] = [];
  for (const raw of Array.isArray(value.provenance) ? value.provenance : []) {
    if (!isRecord(raw) || typeof raw.brick_id !== 'string' || !isRecord(raw.seal)) continue;
    const seal: StoredSeal = {
      anchor: typeof raw.seal.anchor === 'string' ? raw.seal.anchor : undefined,
      head: typeof raw.seal.head === 'string' ? raw.seal.head : undefined,
      chain_length: typeof raw.seal.chain_length === 'number' ? raw.seal.chain_length : undefined,
      signature: typeof raw.seal.signature === 'string' ? raw.seal.signature : undefined,
    };
    const touchedBy = Array.isArray(raw.touched_by) ? raw.touched_by.filter(isRecord) as ProvenanceEvent[] : [];
    provenance.push({
      brick_id: raw.brick_id,
      project: typeof raw.project === 'string' ? raw.project : undefined,
      created_by: isRecord(raw.created_by) ? raw.created_by as ProvenanceEvent : undefined,
      touched_by: touchedBy,
      seal,
    });
  }
  return {
    signed: value.signed === true,
    signing_key_id: typeof value.signing_key_id === 'string' ? value.signing_key_id : null,
    provenance,
  };
}

const args = parseArgs(process.argv.slice(2));

try {
  main();
} catch (err) {
  console.error(`sma-provenance-verify: ${err instanceof Error ? err.message : String(err)}`);
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
    throw new Error(`provenance ledger not found: ${relative(SMA_ROOT, PROV_LEDGER)}. Run: node tools/sma-provenance-ledger.ts`);
  }
  const ledger = parseLedger(JSON.parse(readFileSync(PROV_LEDGER, 'utf8')) as unknown);
  const fpMap = loadFingerprints();
  const publicPem = ledger.signed ? loadPublicKey(ledger.signing_key_id) : null;
  const brickMap = (args.recheckSource || args.coverage) ? discoveredBricks : null;

  const failures: VerifyFailure[] = [];
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
    if (ledger.signed && seal?.signature && seal.head) {
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
      failures.push({ brick_id: entry.brick_id, project: entry.project ?? null, reasons });
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
      const rev: unknown = JSON.parse(readFileSync(revPath, 'utf8'));
      if (!isRecord(rev)) throw new Error('revocation list must be an object');
      const revokedKeyIds = Array.isArray(rev.revoked_key_ids) ? rev.revoked_key_ids.filter((id): id is string => typeof id === 'string') : [];
      if (ledger.signing_key_id && revokedKeyIds.includes(ledger.signing_key_id)) {
        failures.push({ brick_id: '(ledger)', project: null, reasons: [`signing key ${ledger.signing_key_id} is REVOKED — signatures are no longer trusted`] });
      }
      const revokedBricks = new Set((Array.isArray(rev.revoked_bricks) ? rev.revoked_bricks : []).flatMap((entry) =>
        typeof entry === 'string' ? [entry] : isRecord(entry) && typeof entry.brick_id === 'string' ? [entry.brick_id] : []));
      if (revokedBricks.size) {
        const hit = ledger.provenance.filter((entry) => revokedBricks.has(entry.brick_id)).map((entry) => entry.brick_id);
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

function recheckSource(brickId: string, brickMap: Map<string, RegistryEntry>, seal: StoredSeal): string | null {
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

function loadFingerprints(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(FINGERPRINT_LEDGER)) return map;
  try {
    const data: unknown = JSON.parse(readFileSync(FINGERPRINT_LEDGER, 'utf8'));
    if (!isRecord(data) || !Array.isArray(data.fingerprints)) return map;
    for (const fp of data.fingerprints) {
      if (isRecord(fp) && typeof fp.brick_id === 'string' && typeof fp.content_hash === 'string') map.set(fp.brick_id, fp.content_hash);
    }
  } catch { /* ignore */ }
  return map;
}

function loadRegistry(registryPath: string): Map<string, RegistryEntry> {
  const map = new Map<string, RegistryEntry>();
  if (!existsSync(registryPath)) return map;
  const reg: unknown = JSON.parse(readFileSync(registryPath, 'utf8'));
  if (!isRecord(reg)) return map;
  const roots = new Map<string, string>();
  for (const root of Array.isArray(reg.scanned_project_roots) ? reg.scanned_project_roots : []) {
    if (isRecord(root) && typeof root.id === 'string' && typeof root.root === 'string') roots.set(root.id, root.root);
  }
  for (const raw of Array.isArray(reg.bricks) ? reg.bricks : []) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.project !== 'string') continue;
    const brick: RegistryBrick = {
      id: raw.id,
      project: raw.project,
      manifest_path: typeof raw.manifest_path === 'string' ? raw.manifest_path : undefined,
      source_paths: Array.isArray(raw.source_paths) ? raw.source_paths.filter((path): path is string => typeof path === 'string') : undefined,
    };
    map.set(brick.id, { brick, projectAbs: roots.get(brick.project) || null });
  }
  return map;
}

function loadPublicKey(keyId: string | null): string | null {
  if (!keyId) return null;
  const p = resolve(KEY_DIR, `seal.${keyId}.pub.pem`);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

function printReport(report: VerifyReport): void {
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

function parseArgs(list: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_match: string, c: string) => c.toUpperCase());
    const next = list[i + 1];
    if (key === 'registry' && next !== undefined && !next.startsWith('--')) {
      out.registry = next;
      i += 1;
      continue;
    }
    if (key === 'json' || key === 'recheckSource' || key === 'coverage' || key === 'requireSigned' || key === 'gate') out[key] = true;
  }
  return out;
}
