#!/usr/bin/env node
/**
 * WHAT: Verifies one exported brick attestation bundle without reading repository ledgers.
 * WHY: Portable evidence is useful only if an independent recipient can detect mismatched content or proofs.
 * HOW: Parses the bundle documents, cross-checks identities and hashes, and verifies Merkle inclusion.
 * INPUTS: A bundle directory containing the emitted provenance, bill-of-materials, and proof files.
 * OUTPUTS: Per-check pass or fail lines, or a structured verification result and process status.
 * CALLERS: Recipients, release gates, and provenance self-tests run this stand-alone verifier.
 * @example bundle="$(find releases/attestations -mindepth 1 -maxdepth 1 -type d | sort | head -1)"; node tools/sma-attest-verify.mjs --dir "$bundle"
 */
/**
 * SMA attest-verify — STAND-ALONE attestation bundle verifier.
 *
 * Proves a third party can verify a single brick with ONLY the bundle plus
 * tools/lib/merkle.ts — the full provenance/license/fingerprint ledgers are
 * never read. Given a bundle directory it checks:
 *
 *   (a) sbom.spdx.json, sbom.cdx.json, intoto.json are well-formed JSON with the
 *       required fields for their format (SPDX 2.3 / CycloneDX 1.5 / in-toto v1).
 *   (b) the content sha256 is identical across all three documents AND the
 *       inclusion proof.
 *   (c) the brick_id and seal head agree across the documents, and the Merkle
 *       inclusion proof reproduces the committed root
 *       (verifyBrickInclusion(brick_id, seal_head, proof, root)).
 *
 * Each check prints PASS/FAIL; the process exits non-zero if any check fails.
 *
 * Usage:
 *   node tools/sma-attest-verify.mjs --dir releases/attestations/<brick_id>
 *   node tools/sma-attest-verify.mjs --dir <bundle> --json
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyBrickInclusion } from './lib/merkle.ts';

const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
const PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';
const BUILDER_ID = 'https://sma.local/brick-scanner';

/**
 * Verify a bundle directory. Returns { ok, dir, brick_id, checks:[{name,ok,detail}] }.
 * Reads only the four bundle files; imports only merkle.ts.
 */
export function verifyBundle(dir) {
  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: !!ok, detail });

  const spdx = readBundleFile(dir, 'sbom.spdx.json');
  const cdx = readBundleFile(dir, 'sbom.cdx.json');
  const intoto = readBundleFile(dir, 'intoto.json');
  const proof = readBundleFile(dir, 'inclusion-proof.json');

  // (a) well-formedness -----------------------------------------------------
  const spdxOk = isObj(spdx)
    && spdx.spdxVersion === 'SPDX-2.3'
    && spdx.SPDXID === 'SPDXRef-DOCUMENT'
    && Array.isArray(spdx.packages) && spdx.packages.length >= 1
    && isObj(spdx.creationInfo)
    && typeof spdx.documentNamespace === 'string' && spdx.documentNamespace.length > 0;
  add('SPDX 2.3 well-formed', spdxOk, fileNote(spdx));

  const cdxOk = isObj(cdx)
    && cdx.bomFormat === 'CycloneDX'
    && cdx.specVersion === '1.5'
    && Array.isArray(cdx.components) && cdx.components.length >= 1;
  add('CycloneDX 1.5 well-formed', cdxOk, fileNote(cdx));

  const intotoOk = isObj(intoto)
    && intoto._type === STATEMENT_TYPE
    && intoto.predicateType === PREDICATE_TYPE
    && Array.isArray(intoto.subject) && intoto.subject.length >= 1
    && isObj(intoto.predicate?.buildDefinition)
    && intoto.predicate?.runDetails?.builder?.id === BUILDER_ID;
  add('in-toto Statement v1 + SLSA provenance well-formed', intotoOk, fileNote(intoto));

  const proofOk = isObj(proof)
    && typeof proof.brick_id === 'string'
    && typeof proof.seal_head === 'string'
    && Array.isArray(proof.proof)
    && typeof proof.root === 'string';
  add('inclusion-proof well-formed', proofOk, fileNote(proof));

  // extract cross-check values (guarded on well-formedness) ------------------
  const spdxHash = spdxOk ? spdxSha256(spdx) : null;
  const cdxHash = cdxOk ? cdxSha256(cdx) : null;
  const intotoHash = intotoOk ? (intoto.subject[0]?.digest?.sha256 || null) : null;
  const proofHash = proofOk ? (proof.content_hash ?? null) : null;

  // (b) content_hash consistency across all three + the proof ---------------
  const hashes = [spdxHash, cdxHash, intotoHash, proofHash];
  const present = hashes.filter((h) => typeof h === 'string' && h.length > 0);
  const hashConsistent = present.length === 4 && new Set(present).size === 1;
  add('content sha256 consistent across SPDX / CycloneDX / in-toto / proof', hashConsistent,
    hashConsistent
      ? `sha256:${present[0].slice(0, 16)}…`
      : `spdx=${short(spdxHash)} cdx=${short(cdxHash)} intoto=${short(intotoHash)} proof=${short(proofHash)}`);

  // brick_id consistency ----------------------------------------------------
  const ids = [
    intotoOk ? intoto.subject[0]?.name : null,
    spdxOk ? spdx.packages[0]?.name : null,
    cdxOk ? cdx.components[0]?.name : null,
    proofOk ? proof.brick_id : null,
  ].filter((x) => typeof x === 'string' && x.length > 0);
  const idConsistent = ids.length === 4 && new Set(ids).size === 1;
  add('brick_id consistent across all documents', idConsistent, idConsistent ? ids[0] : ids.join(' | '));

  // seal head consistency (in-toto invocationId == proof seal_head) ---------
  const intotoHead = intotoOk ? (intoto.predicate?.runDetails?.metadata?.invocationId || null) : null;
  const headConsistent = proofOk && !!intotoHead && intotoHead === proof.seal_head;
  add('seal head consistent (in-toto invocationId == proof)', headConsistent, proofOk ? short(proof.seal_head) : '');

  // (c) Merkle inclusion: proof reproduces the committed root ---------------
  let inclusionOk = false;
  if (proofOk) {
    inclusionOk = verifyBrickInclusion(proof.brick_id, proof.seal_head, proof.proof, proof.root) === true;
  }
  add('Merkle inclusion proof reproduces committed root', inclusionOk, proofOk ? `root ${short(proof.root)}…` : '');

  const ok = checks.length > 0 && checks.every((c) => c.ok);
  return { ok, dir, brick_id: proofOk ? proof.brick_id : null, checks };
}

// --- extraction helpers ----------------------------------------------------

function spdxSha256(spdx) {
  const pkg = spdx.packages[0] || {};
  const ck = (pkg.checksums || []).find((c) => c && c.algorithm === 'SHA256');
  return ck?.checksumValue || null;
}

function cdxSha256(cdx) {
  const comp = cdx.components[0] || {};
  const h = (comp.hashes || []).find((x) => x && x.alg === 'SHA-256');
  return h?.content || null;
}

function readBundleFile(dir, name) {
  const p = resolve(dir, name);
  if (!existsSync(p)) return { __error: 'missing', __file: name };
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    return { __error: `invalid JSON: ${e.message}`, __file: name };
  }
}

function fileNote(v) {
  if (isObj(v) && v.__error) return `${v.__file}: ${v.__error}`;
  return '';
}

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) && !v.__error;
}

function short(s) {
  return s ? String(s).slice(0, 12) : '(none)';
}

// --- CLI -------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir || args.dir === true) {
    console.error('usage: sma-attest-verify --dir <bundle-dir> [--json]');
    process.exit(2);
  }
  const dir = resolve(process.cwd(), String(args.dir));
  const res = verifyBundle(dir);

  if (args.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`sma-attest-verify: ${res.brick_id || '(unknown brick)'}`);
    for (const c of res.checks) {
      console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
    }
    console.log(`\n${res.ok ? 'PASS — bundle verified with just merkle.ts' : 'FAIL — bundle did not verify'}: ${dir}`);
  }
  process.exit(res.ok ? 0 : 1);
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

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
