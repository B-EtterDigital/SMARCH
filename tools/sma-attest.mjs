#!/usr/bin/env node
/**
 * WHAT: Emits a self-contained verification bundle for one or all registered bricks.
 * WHY: A third party should verify a brick without receiving the repository's internal ledgers.
 * HOW: Joins fingerprint, license, provenance, and anchor records into standard documents and an inclusion proof.
 * INPUTS: A brick selector plus generated ledger and anchor files already present in the repository.
 * OUTPUTS: Per-brick attestation directories containing provenance, bill-of-materials, and proof documents.
 * CALLERS: Release operators run this after provenance generation and anchoring.
 * @example node tools/sma-attest.mjs --all --json
 */
/**
 * SMA attest — emit STANDARD-FORMAT attestation bundles per brick so a third
 * party can verify a single brick WITHOUT the rest of the repo.
 *
 * For each brick it writes releases/attestations/<brick_id>/:
 *   intoto.json          in-toto Statement v1 + SLSA Provenance v1 predicate
 *   sbom.spdx.json       SPDX 2.3 SBOM
 *   sbom.cdx.json        CycloneDX 1.5 SBOM
 *   inclusion-proof.json Merkle inclusion proof of the brick's seal against the
 *                        anchored root (same leaf ordering as sma-anchor.mjs).
 *
 * The four generated ledgers are the inputs; the emitted bundle is fully
 * self-contained. Verify a bundle later with:  node tools/sma-attest-verify.mjs
 *
 * Usage:
 *   node tools/sma-attest.mjs --brick <brick_id>
 *   node tools/sma-attest.mjs --all
 *   node tools/sma-attest.mjs --brick <brick_id> --json
 *   node tools/sma-attest.mjs --brick <brick_id> --timestamp 2026-07-01T00:00:00Z
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { leafHash, buildMerkle, inclusionProof, verifyBrickInclusion } from './lib/merkle.ts';
import { intotoStatement, spdxDocument, cyclonedxDocument } from './lib/attestation.ts';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROV_LEDGER = resolve(SMA_ROOT, 'registry/provenance-ledger.generated.json');
const LICENSE_LEDGER = resolve(SMA_ROOT, 'registry/license-ledger.generated.json');
const FINGERPRINT_LEDGER = resolve(SMA_ROOT, 'security/brick-fingerprints.generated.json');
const ANCHOR = resolve(SMA_ROOT, 'registry/anchor.generated.json');
const OUT_ROOT = resolve(SMA_ROOT, 'releases/attestations');

const args = parseArgs(process.argv.slice(2));

try {
  main();
} catch (err) {
  console.error(`sma-attest: ${err.message}`);
  process.exit(1);
}

function main() {
  const prov = loadJson(PROV_LEDGER, 'provenance ledger', 'sma-provenance-ledger.mjs');
  const lic = loadJson(LICENSE_LEDGER, 'license ledger', 'sma-provenance-ledger.mjs');
  const fp = loadJson(FINGERPRINT_LEDGER, 'fingerprint ledger', 'sma-provenance-ledger.mjs');
  const anchor = loadJson(ANCHOR, 'anchor', 'sma-anchor.mjs');

  const provIndex = indexBy(prov.provenance, 'brick_id');
  const licIndex = indexBy(lic.licenses, 'brick_id');
  const fpIndex = indexBy(fp.fingerprints, 'brick_id');

  // Merkle basis — EXACTLY as sma-anchor.mjs: sealed rows only, sorted by brick_id.
  const rows = (prov.provenance || [])
    .filter((p) => p.seal && p.seal.head)
    .map((p) => ({ brick_id: p.brick_id, head: p.seal.head }))
    .sort((a, b) => a.brick_id.localeCompare(b.brick_id));
  const leaves = rows.map((r) => leafHash(r.brick_id, r.head));
  const { root, layers } = buildMerkle(leaves);
  const rowIndex = new Map(rows.map((r, i) => [r.brick_id, i]));

  if (anchor.root && anchor.root !== root && !args.json) {
    console.error(`warning: computed root ${short(root)} != anchor.root ${short(anchor.root)} — anchor may be stale (re-run tools/sma-anchor.mjs)`);
  }

  const timestamp = args.timestamp ? String(args.timestamp) : new Date().toISOString();

  let targets;
  if (args.all) targets = rows.map((r) => r.brick_id);
  else if (args.brick) targets = [String(args.brick)];
  else throw new Error('specify --brick <brick_id> or --all');

  const summary = [];
  for (const brickId of targets) {
    const provRow = provIndex.get(brickId);
    if (!provRow) throw new Error(`brick not found in provenance ledger: ${brickId}`);
    if (!provRow.seal || !provRow.seal.head) {
      throw new Error(`brick has no provenance seal — cannot build inclusion proof: ${brickId}`);
    }
    const idx = rowIndex.get(brickId);
    if (idx === undefined) throw new Error(`brick not present in sealed set: ${brickId}`);

    const fpRow = fpIndex.get(brickId) || {};
    const licRow = licIndex.get(brickId) || {};
    const brick = {
      brick_id: brickId,
      project: provRow.project || fpRow.project || null,
      content_hash: fpRow.content_hash || null,
      file_count: fpRow.file_count ?? null,
      byte_count: fpRow.byte_count ?? null,
      spdx: licRow.spdx || null,
      license_class: licRow.license_class || null,
      openness: licRow.openness || null,
      visibility: licRow.visibility || null,
      attribution_required: licRow.attribution_required ?? null,
      seal: provRow.seal,
      created_by: provRow.created_by || null,
      contributors: provRow.contributors || [],
      commit_count: provRow.commit_count ?? null,
    };
    const components = []; // no sub-component source in these ledgers

    const proof = inclusionProof(layers, idx);
    if (!verifyBrickInclusion(brickId, provRow.seal.head, proof, root)) {
      throw new Error(`internal: inclusion proof failed to self-verify for ${brickId}`);
    }

    const dir = resolve(OUT_ROOT, sanitizeDir(brickId));
    mkdirSync(dir, { recursive: true });
    writeJson(resolve(dir, 'intoto.json'), intotoStatement(brick, components, timestamp));
    writeJson(resolve(dir, 'sbom.spdx.json'), spdxDocument(brick, components, timestamp));
    writeJson(resolve(dir, 'sbom.cdx.json'), cyclonedxDocument(brick, components, timestamp));
    writeJson(resolve(dir, 'inclusion-proof.json'), {
      brick_id: brickId,
      seal_head: provRow.seal.head,
      content_hash: brick.content_hash,
      proof,
      root,
      anchor_digest: anchor.anchor_digest || null,
    });

    summary.push({
      brick_id: brickId,
      dir: rel(dir),
      content_hash: brick.content_hash,
      seal_head: provRow.seal.head,
      files: ['intoto.json', 'sbom.spdx.json', 'sbom.cdx.json', 'inclusion-proof.json'],
    });
  }

  if (args.json) {
    console.log(JSON.stringify({
      generated_at: timestamp,
      root,
      anchor_digest: anchor.anchor_digest || null,
      count: summary.length,
      attestations: summary,
    }, null, 2));
  } else {
    console.log(`sma-attest: wrote ${summary.length} attestation bundle(s)`);
    console.log(`  merkle root: ${root}`);
    for (const s of summary) {
      console.log(`  ${s.brick_id}`);
      console.log(`    -> ${s.dir}/ (${s.files.join(', ')})`);
    }
    console.log('\nVerify a bundle stand-alone (no ledgers needed) with:');
    console.log(`  node tools/sma-attest-verify.mjs --dir ${summary[0]?.dir || 'releases/attestations/<brick_id>'}`);
  }
}

// --- helpers ---------------------------------------------------------------

function loadJson(path, label, producer) {
  if (!existsSync(path)) {
    throw new Error(`${label} not found: ${rel(path)}. Run: node tools/${producer}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function indexBy(arr, key) {
  const m = new Map();
  for (const row of arr || []) if (row && row[key] != null) m.set(row[key], row);
  return m;
}

function sanitizeDir(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

function short(s) {
  return String(s || '').slice(0, 12);
}

function writeJson(p, v) {
  writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
}

function rel(p) {
  return relative(SMA_ROOT, p).split(sep).join('/');
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
