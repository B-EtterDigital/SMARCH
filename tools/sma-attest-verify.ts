#!/usr/bin/env node
/* Defensive external-input guards and JavaScript coercion semantics are intentional in this behavior-preserving strict-type pass. */
/* eslint @typescript-eslint/no-unnecessary-boolean-literal-compare: "off", @typescript-eslint/no-unnecessary-condition: "off", @typescript-eslint/no-useless-default-assignment: "off", @typescript-eslint/prefer-nullish-coalescing: "off", @typescript-eslint/array-type: "off", max-lines-per-function: "off", complexity: "off", @typescript-eslint/prefer-optional-chain: "off", @typescript-eslint/no-base-to-string: "off", @typescript-eslint/no-unnecessary-type-conversion: "off", @typescript-eslint/restrict-template-expressions: "off", @typescript-eslint/use-unknown-in-catch-callback-variable: "off" */
/**
 * WHAT: Verifies one exported brick attestation bundle against separately trusted anchor material.
 * WHY: Portable evidence is useful only if consistency is distinguished from externally rooted authenticity.
 * HOW: Cross-checks documents and Merkle inclusion, then binds the proof root to a pinned root or anchor.
 * INPUTS: A bundle directory plus a trusted root digest or trusted anchor document.
 * OUTPUTS: Per-check pass or fail lines, or a structured verification result and process status.
 * CALLERS: Recipients, release gates, and provenance self-tests run this stand-alone verifier.
 * @example bundle="$(find releases/attestations -mindepth 1 -maxdepth 1 -type d | sort | head -1)"; node tools/sma-attest-verify.ts --dir "$bundle"
 */
/**
 * SMA attest-verify — portable attestation bundle verifier.
 *
 * Proves a third party can verify a single brick with the bundle, merkle.ts,
 * and separately obtained trust material — the full provenance/license/
 * fingerprint ledgers are never read. Given those inputs it checks:
 *
 *   (a) sbom.spdx.json, sbom.cdx.json, intoto.json are well-formed JSON with the
 *       required fields for their format (SPDX 2.3 / CycloneDX 1.5 / in-toto v1).
 *   (b) the content sha256 is identical across all three documents AND the
 *       inclusion proof.
 *   (c) the brick_id and seal head agree across the documents, and the Merkle
 *       inclusion proof reproduces the committed root
 *       (verifyBrickInclusion(brick_id, seal_head, proof, root)).
 *
 * Structural checks alone never produce a trust verdict. Each check prints
 * PASS/FAIL; the process exits non-zero if consistency or authenticity fails.
 *
 * Usage:
 *   node tools/sma-attest-verify.ts --dir releases/attestations/<brick_id> --trusted-root <sha256>
 *   node tools/sma-attest-verify.ts --dir <bundle> --trusted-anchor registry/anchor.generated.json --json
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyBrickInclusion } from './lib/merkle.ts';
import { resolveAnchorBinding } from './lib/attestation.ts';

const STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
const PREDICATE_TYPE = 'https://slsa.dev/provenance/v1';
const BUILDER_ID = 'https://sma.local/brick-scanner';

type CliArgs = Record<string, string | boolean>;
type JsonObject = Record<string, unknown>;
type SpdxDocument = JsonObject & {
  spdxVersion?: unknown;
  SPDXID?: unknown;
  packages?: { name?: unknown; checksums?: { algorithm?: unknown; checksumValue?: unknown }[] }[];
  creationInfo?: unknown;
  documentNamespace?: unknown;
};
type CycloneDxDocument = JsonObject & {
  bomFormat?: unknown;
  specVersion?: unknown;
  components?: { name?: unknown; hashes?: { alg?: unknown; content?: unknown }[] }[];
};
type InTotoDocument = JsonObject & {
  _type?: unknown;
  predicateType?: unknown;
  subject?: { name?: unknown; digest?: { sha256?: unknown } }[];
  predicate?: {
    buildDefinition?: unknown;
    runDetails?: { builder?: { id?: unknown }; metadata?: { invocationId?: unknown } };
  };
};
type InclusionProofDocument = JsonObject & {
  brick_id?: unknown;
  seal_head?: unknown;
  content_hash?: unknown;
  proof?: { hash: string; side: 'left' | 'right' }[];
  root?: unknown;
  anchor_digest?: unknown;
};
interface BundleCheck { name: string; ok: boolean; detail: string }
interface TrustedAnchorDocument {
  root?: unknown; anchor_digest?: unknown; algo?: unknown;
  leaf_count?: unknown; ledger_digest?: unknown; audit_digest?: unknown;
}
interface TrustOptions { trustedRoot?: string; trustedAnchor?: TrustedAnchorDocument }

/**
 * Verify a bundle directory. Returns { ok, dir, brick_id, checks:[{name,ok,detail}] }.
 * Reads only the four bundle files plus caller-supplied trust material and shared attestation/Merkle primitives.
 */
export function verifyBundle(dir: string, trust: TrustOptions = {}) {
  const checks: BundleCheck[] = [];
  const add = (name: string, ok: unknown, detail = '') => checks.push({ name, ok: !!ok, detail });

  const spdx = readBundleFile(dir, 'sbom.spdx.json') as SpdxDocument;
  const cdx = readBundleFile(dir, 'sbom.cdx.json') as CycloneDxDocument;
  const intoto = readBundleFile(dir, 'intoto.json') as InTotoDocument;
  const proof = readBundleFile(dir, 'inclusion-proof.json') as InclusionProofDocument;

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
  const intotoHash = intotoOk && typeof intoto.subject?.[0]?.digest?.sha256 === 'string'
    ? intoto.subject[0].digest.sha256
    : null;
  const proofHash = proofOk && typeof proof.content_hash === 'string' ? proof.content_hash : null;

  // (b) content_hash consistency across all three + the proof ---------------
  const hashes = [spdxHash, cdxHash, intotoHash, proofHash];
  const present = hashes.filter((h): h is string => typeof h === 'string' && h.length > 0);
  const hashConsistent = present.length === 4 && new Set(present).size === 1;
  add('content sha256 consistent across SPDX / CycloneDX / in-toto / proof', hashConsistent,
    hashConsistent
      ? `sha256:${present[0].slice(0, 16)}…`
      : `spdx=${short(spdxHash)} cdx=${short(cdxHash)} intoto=${short(intotoHash)} proof=${short(proofHash)}`);

  // brick_id consistency ----------------------------------------------------
  const ids = [
    intotoOk ? intoto.subject?.[0]?.name : null,
    spdxOk ? spdx.packages?.[0]?.name : null,
    cdxOk ? cdx.components?.[0]?.name : null,
    proofOk ? proof.brick_id : null,
  ].filter((x): x is string => typeof x === 'string' && x.length > 0);
  const idConsistent = ids.length === 4 && new Set(ids).size === 1;
  add('brick_id consistent across all documents', idConsistent, idConsistent ? ids[0] : ids.join(' | '));

  // seal head consistency (in-toto invocationId == proof seal_head) ---------
  const intotoHead = intotoOk ? (intoto.predicate?.runDetails?.metadata?.invocationId || null) : null;
  const headConsistent = proofOk && typeof intotoHead === 'string' && intotoHead === proof.seal_head;
  add('seal head consistent (in-toto invocationId == proof)', headConsistent, proofOk ? short(proof.seal_head) : '');

  // (c) Merkle inclusion: proof reproduces the committed root ---------------
  let inclusionOk = false;
  if (proofOk && typeof proof.brick_id === 'string' && typeof proof.seal_head === 'string'
    && Array.isArray(proof.proof) && typeof proof.root === 'string') {
    inclusionOk = verifyBrickInclusion(proof.brick_id, proof.seal_head, proof.proof, proof.root);
  }
  add('Merkle inclusion proof reproduces committed root', inclusionOk, proofOk ? `root ${short(proof.root)}…` : '');

  const structural_ok = checks.length > 0 && checks.every((c) => c.ok);

  // Structural consistency is attacker-producible. Authenticity requires a
  // root or anchor record obtained through an independently trusted channel.
  const trustChecks: BundleCheck[] = [];
  const addTrust = (name: string, ok: unknown, detail = ''): void => {
    const check = { name, ok: !!ok, detail };
    trustChecks.push(check);
    checks.push(check);
  };
  const hasTrustedRoot = typeof trust.trustedRoot === 'string' && trust.trustedRoot.length > 0;
  const hasTrustedAnchor = isObj(trust.trustedAnchor);
  if (!hasTrustedRoot && !hasTrustedAnchor) {
    addTrust('external trust material supplied', false, 'provide --trusted-root or --trusted-anchor');
  }
  if (hasTrustedRoot) {
    const trustedRootValid = /^[0-9a-f]{64}$/i.test(trust.trustedRoot ?? '');
    addTrust('proof root matches trusted root', trustedRootValid && proofOk && proof.root === trust.trustedRoot,
      trustedRootValid ? `trusted root ${short(trust.trustedRoot)}…` : 'trusted root is not a sha256 digest');
  }
  if (hasTrustedAnchor) {
    const anchorRoot = trust.trustedAnchor?.root;
    const anchorDigest = trust.trustedAnchor?.anchor_digest;
    const anchorBinding = proofOk && typeof proof.root === 'string'
      ? resolveAnchorBinding(trust.trustedAnchor ?? {}, proof.root, { unanchoredDiagnostic: true })
      : { anchored: false, anchor_digest: null, reason: 'root-mismatch' };
    addTrust('trusted anchor metadata cryptographically binds proof root', anchorBinding.anchored,
      anchorBinding.anchored ? `anchor root ${short(anchorRoot)}…` : String(anchorBinding.reason));
    addTrust('proof anchor_digest matches trusted anchor', typeof anchorDigest === 'string'
      && proofOk && typeof proof.anchor_digest === 'string' && proof.anchor_digest === anchorDigest,
    `anchor digest ${short(anchorDigest)}…`);
  }
  const authentic = trustChecks.length > 0 && trustChecks.every((check) => check.ok);
  const ok = structural_ok && authentic;
  return { ok, structural_ok, authentic, dir, brick_id: proofOk ? proof.brick_id : null, checks };
}

// --- extraction helpers ----------------------------------------------------

function spdxSha256(spdx: SpdxDocument): string | null {
  const pkg = spdx.packages?.[0] || {};
  const ck = (pkg.checksums || []).find((c) => c && c.algorithm === 'SHA256');
  return typeof ck?.checksumValue === 'string' ? ck.checksumValue : null;
}

function cdxSha256(cdx: CycloneDxDocument): string | null {
  const comp = cdx.components?.[0] || {};
  const h = (comp.hashes || []).find((x) => x && x.alg === 'SHA-256');
  return typeof h?.content === 'string' ? h.content : null;
}

function readBundleFile(dir: string, name: string): unknown {
  const p = resolve(dir, name);
  if (!existsSync(p)) return { __error: 'missing', __file: name };
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (error: unknown) {
    return { __error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`, __file: name };
  }
}

function fileNote(v: unknown): string {
  if (isObj(v) && v.__error) return `${String(v.__file)}: ${String(v.__error)}`;
  return '';
}

function isObj(v: unknown): v is JsonObject {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !('__error' in v);
}

function short(s: unknown): string {
  return s ? String(s).slice(0, 12) : '(none)';
}

// --- CLI -------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir || args.dir === true) {
    console.error('usage: sma-attest-verify --dir <bundle-dir> (--trusted-root <sha256> | --trusted-anchor <file>) [--json]');
    process.exit(2);
  }
  const dir = resolve(process.cwd(), String(args.dir));
  const trustedAnchor = typeof args.trustedAnchor === 'string'
    ? readTrustedAnchor(resolve(process.cwd(), args.trustedAnchor))
    : undefined;
  const res = verifyBundle(dir, {
    trustedRoot: typeof args.trustedRoot === 'string' ? args.trustedRoot : undefined,
    trustedAnchor,
  });

  if (args.json) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log(`sma-attest-verify: ${res.brick_id || '(unknown brick)'}`);
    for (const c of res.checks) {
      console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
    }
    console.log(`\nstructural consistency: ${res.structural_ok ? 'PASS' : 'FAIL'}`);
    console.log(`authenticity: ${res.authentic ? 'PASS' : 'FAIL'}`);
    console.log(`${res.ok ? 'PASS — bundle is structurally valid and externally trusted' : 'FAIL — bundle trust verdict failed'}: ${dir}`);
  }
  process.exit(res.ok ? 0 : 1);
}

function readTrustedAnchor(path: string): TrustedAnchorDocument {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isObj(parsed)) throw new Error(`trusted anchor must be a JSON object: ${path}`);
  return parsed;
}

function parseArgs(list: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_match, c: string) => c.toUpperCase());
    const next = list[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next; i += 1;
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
