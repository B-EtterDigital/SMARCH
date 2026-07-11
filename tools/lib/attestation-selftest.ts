#!/usr/bin/env node
/**
 * WHAT: Exercises attestation exporters and the stand-alone verifier as one deterministic test program.
 * WHY: A document that looks valid can still omit required fields or accept tampered provenance evidence.
 * HOW: The test builds a synthetic brick, writes temporary bundles, verifies success, then verifies tamper failures.
 * It consumes the public attestation and Merkle helpers and removes every temporary directory afterward.
 * A successful run prints an assertion count; any failed assertion exits nonzero.
 * Format terms are defined in docs/GLOSSARY.md.
 * Usage: node tools/lib/attestation-selftest.ts
 */
/**
 * Self-test for the attestation exporters + stand-alone verifier. Proves:
 *   - intotoStatement / spdxDocument / cyclonedxDocument carry every required
 *     field for their format (in-toto v1, SPDX 2.3, CycloneDX 1.5).
 *   - a full attest -> verify round trip PASSES on a synthetic brick (the same
 *     library code the CLI uses, written to a temp bundle and verified with only
 *     merkle.ts).
 *   - tampering with the content hash makes verification FAIL.
 * Run: node tools/lib/attestation-selftest.ts
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { intotoStatement, spdxDocument, cyclonedxDocument } from './attestation.ts';
import { leafHash, buildMerkle, inclusionProof } from './merkle.ts';
import { verifyBundle } from '../sma-attest-verify.mjs';

const h = (s) => createHash('sha256').update(s).digest('hex');
let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n += 1; };
const eq = (a, b, msg) => { assert.equal(a, b, msg); n += 1; };

const contentHash = h('synthetic-brick-source');
const timestamp = '2026-07-01T00:00:00Z';

const brick = {
  brick_id: 'demo-proj.demo-proj.frontend-module.web-src-modules-widget',
  project: 'demo-proj',
  content_hash: contentHash,
  file_count: 3,
  byte_count: 4096,
  spdx: 'MIT',
  license_class: 'permissive',
  openness: 'open',
  visibility: 'public',
  attribution_required: true,
  seal: {
    algo: 'sha256-chain-v2',
    anchor: h('anchor'),
    head: h('seal-head'),
    chain_length: 4,
  },
  created_by: {
    actor_kind: 'human', actor_id: 'dev@example.com', role: 'architect',
    timestamp: '2026-01-01T00:00:00Z', commit: 'a'.repeat(40),
  },
  contributors: [
    { actor_id: 'dev@example.com', name: 'Dev One', commits: 4, first: '2026-01-01T00:00:00Z', last: '2026-02-01T00:00:00Z' },
  ],
  commit_count: 4,
};
const components = [
  { brick_id: 'demo-proj.lib.util', name: 'util', spdx: 'Apache-2.0', content_hash: h('util-source'), version: '1.2.3' },
];

// --- in-toto Statement v1 required fields ----------------------------------
const st = intotoStatement(brick, components, timestamp);
eq(st._type, 'https://in-toto.io/Statement/v1', 'intoto _type');
eq(st.predicateType, 'https://slsa.dev/provenance/v1', 'intoto predicateType');
eq(st.subject[0].name, brick.brick_id, 'intoto subject name');
eq(st.subject[0].digest.sha256, contentHash, 'intoto subject sha256');
eq(st.predicate.runDetails.builder.id, 'https://sma.local/brick-scanner', 'intoto builder id');
eq(st.predicate.runDetails.metadata.invocationId, brick.seal.head, 'intoto records seal head');
const deps = st.predicate.buildDefinition.resolvedDependencies;
ok(deps.length >= 3, 'intoto materials include commit + contributor + component');
ok(deps.some((d) => d.uri.includes('dev@example.com')), 'intoto materials include contributor');
ok(deps.some((d) => d.digest?.sha256 === components[0].content_hash), 'intoto materials include component digest');

// --- SPDX 2.3 required fields ----------------------------------------------
const spdx = spdxDocument(brick, components, timestamp);
eq(spdx.spdxVersion, 'SPDX-2.3', 'spdx version');
eq(spdx.SPDXID, 'SPDXRef-DOCUMENT', 'spdx document id');
eq(spdx.dataLicense, 'CC0-1.0', 'spdx dataLicense');
ok(typeof spdx.documentNamespace === 'string' && spdx.documentNamespace.length > 0, 'spdx documentNamespace');
eq(spdx.creationInfo.created, timestamp, 'spdx creationInfo.created uses passed timestamp');
eq(spdx.packages.length, 1 + components.length, 'spdx one package per brick + component');
eq(spdx.packages[0].licenseDeclared, 'MIT', 'spdx licenseDeclared from ledger spdx');
eq(spdx.packages[0].checksums[0].algorithm, 'SHA256', 'spdx checksum algorithm');
eq(spdx.packages[0].checksums[0].checksumValue, contentHash, 'spdx checksum value');

// licenseDeclared falls back to NOASSERTION when no spdx
const spdxNoLicense = spdxDocument({ ...brick, spdx: null }, [], timestamp);
eq(spdxNoLicense.packages[0].licenseDeclared, 'NOASSERTION', 'spdx NOASSERTION fallback');

// --- CycloneDX 1.5 required fields -----------------------------------------
const cdx = cyclonedxDocument(brick, components, timestamp);
eq(cdx.bomFormat, 'CycloneDX', 'cdx bomFormat');
eq(cdx.specVersion, '1.5', 'cdx specVersion');
ok(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cdx.serialNumber), 'cdx serialNumber urn:uuid');
eq(cdx.components.length, 1 + components.length, 'cdx one component per brick + component');
eq(cdx.components[0].type, 'library', 'cdx component type library');
eq(cdx.components[0].hashes[0].alg, 'SHA-256', 'cdx hash alg');
eq(cdx.components[0].hashes[0].content, contentHash, 'cdx hash content');
ok(Array.isArray(cdx.components[0].licenses) && cdx.components[0].licenses.length >= 1, 'cdx licenses present');

// --- round trip: attest -> verify (bundle + merkle.ts only) ---------------
const rows = [
  { brick_id: 'aaa-first', head: h('aaa') },
  { brick_id: brick.brick_id, head: brick.seal.head },
  { brick_id: 'zzz-last', head: h('zzz') },
].sort((a, b) => a.brick_id.localeCompare(b.brick_id));
const leaves = rows.map((r) => leafHash(r.brick_id, r.head));
const { root, layers } = buildMerkle(leaves);
const idx = rows.findIndex((r) => r.brick_id === brick.brick_id);
const proof = inclusionProof(layers, idx);

const dir = mkdtempSync(resolve(tmpdir(), 'sma-attest-'));
try {
  writeJson(dir, 'intoto.json', st);
  writeJson(dir, 'sbom.spdx.json', spdx);
  writeJson(dir, 'sbom.cdx.json', cdx);
  writeJson(dir, 'inclusion-proof.json', {
    brick_id: brick.brick_id, seal_head: brick.seal.head, content_hash: contentHash, proof, root, anchor_digest: h('anchor-digest'),
  });

  const res = verifyBundle(dir);
  ok(res.ok, `round-trip verify PASS (failing: ${res.checks.filter((c) => !c.ok).map((c) => c.name).join(', ')})`);
  eq(res.brick_id, brick.brick_id, 'verify reports brick_id');
  ok(res.checks.length >= 7, 'verify runs the full check set');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// --- negative: tampered content hash must FAIL -----------------------------
const badDir = mkdtempSync(resolve(tmpdir(), 'sma-attest-bad-'));
try {
  const tamperedSpdx = spdxDocument({ ...brick, content_hash: h('EVIL') }, components, timestamp);
  writeJson(badDir, 'intoto.json', st);
  writeJson(badDir, 'sbom.spdx.json', tamperedSpdx);
  writeJson(badDir, 'sbom.cdx.json', cdx);
  writeJson(badDir, 'inclusion-proof.json', {
    brick_id: brick.brick_id, seal_head: brick.seal.head, content_hash: contentHash, proof, root, anchor_digest: h('anchor-digest'),
  });
  const bad = verifyBundle(badDir);
  ok(!bad.ok, 'tampered content hash must FAIL verification');
} finally {
  rmSync(badDir, { recursive: true, force: true });
}

// --- negative: forged inclusion proof must FAIL ----------------------------
const forgeDir = mkdtempSync(resolve(tmpdir(), 'sma-attest-forge-'));
try {
  writeJson(forgeDir, 'intoto.json', st);
  writeJson(forgeDir, 'sbom.spdx.json', spdx);
  writeJson(forgeDir, 'sbom.cdx.json', cdx);
  writeJson(forgeDir, 'inclusion-proof.json', {
    brick_id: brick.brick_id, seal_head: 'FORGED-head', content_hash: contentHash, proof, root, anchor_digest: h('anchor-digest'),
  });
  const forged = verifyBundle(forgeDir);
  ok(!forged.ok, 'forged seal head must FAIL Merkle inclusion');
} finally {
  rmSync(forgeDir, { recursive: true, force: true });
}

console.log(`attestation-selftest: OK (${n} assertions)`);

function writeJson(dir, name, v) {
  writeFileSync(resolve(dir, name), `${JSON.stringify(v, null, 2)}\n`);
}
