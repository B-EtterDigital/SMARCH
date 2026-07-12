#!/usr/bin/env node
/**
 * WHAT: Emits a self-contained verification bundle for one or all registered bricks.
 * WHY: A third party should verify a brick without receiving the repository's internal ledgers.
 * HOW: Joins fingerprint, license, provenance, and anchor records into standard documents and an inclusion proof.
 * INPUTS: A brick selector plus generated ledger and anchor files already present in the repository.
 * OUTPUTS: Per-brick attestation directories containing provenance, bill-of-materials, and proof documents.
 * CALLERS: Release operators run this after provenance generation and anchoring.
 * @example node tools/sma-attest.ts --all --json
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
 *                        anchored root (same leaf ordering as sma-anchor.ts).
 *
 * The four generated ledgers are the inputs; the emitted bundle is fully
 * self-contained. Verify a bundle later with:  node tools/sma-attest-verify.ts
 *
 * Usage:
 *   node tools/sma-attest.ts --brick <brick_id>
 *   node tools/sma-attest.ts --all
 *   node tools/sma-attest.ts --brick <brick_id> --json
 *   node tools/sma-attest.ts --brick <brick_id> --timestamp 2026-07-01T00:00:00Z
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

interface CliArgs {
  all?: boolean;
  brick?: string;
  json?: boolean;
  timestamp?: string;
}
interface Seal { head?: string; [key: string]: unknown }
interface ProvenanceRow {
  brick_id: string;
  project?: string | null;
  seal?: Seal;
  created_by?: Record<string, unknown> | null;
  contributors?: Record<string, unknown>[];
  commit_count?: number | null;
}
interface LicenseRow {
  brick_id: string;
  spdx?: string | null;
  license_class?: string | null;
  openness?: string | null;
  visibility?: string | null;
  attribution_required?: boolean | null;
}
interface FingerprintRow {
  brick_id: string;
  project?: string | null;
  content_hash?: string | null;
  file_count?: number | null;
  byte_count?: number | null;
}
interface Ledger<T> { provenance?: T[]; licenses?: T[]; fingerprints?: T[] }
interface Anchor { root?: string | null; anchor_digest?: string | null }

const args = parseArgs(process.argv.slice(2));

try {
  main();
} catch (err) {
  console.error(`sma-attest: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

// eslint-disable-next-line max-lines-per-function, complexity -- Attestation creation is one ledger-to-proof transaction; validation and output ordering must remain atomic.
function main() {
  const prov = loadJson(PROV_LEDGER, 'provenance ledger', 'sma-provenance-ledger.ts') as Ledger<ProvenanceRow>;
  const lic = loadJson(LICENSE_LEDGER, 'license ledger', 'sma-provenance-ledger.ts') as Ledger<LicenseRow>;
  const fp = loadJson(FINGERPRINT_LEDGER, 'fingerprint ledger', 'sma-provenance-ledger.ts') as Ledger<FingerprintRow>;
  const anchor = loadJson(ANCHOR, 'anchor', 'sma-anchor.ts') as Anchor;

  const provIndex = indexBy(prov.provenance);
  const licIndex = indexBy(lic.licenses);
  const fpIndex = indexBy(fp.fingerprints);

  // Merkle basis — EXACTLY as sma-anchor.ts: sealed rows only, sorted by brick_id.
  const rows = (prov.provenance ?? [])
    .filter((p): p is ProvenanceRow & { seal: Seal & { head: string } } => typeof p.seal?.head === 'string')
    .map((p) => ({ brick_id: p.brick_id, head: p.seal.head }))
    .sort((a, b) => a.brick_id.localeCompare(b.brick_id));
  const leaves = rows.map((r) => leafHash(r.brick_id, r.head));
  const { root, layers } = buildMerkle(leaves);
  const rowIndex = new Map(rows.map((r, i) => [r.brick_id, i]));

  if (anchor.root && anchor.root !== root && !args.json) {
    console.error(`warning: computed root ${short(root)} != anchor.root ${short(anchor.root)} — anchor may be stale (re-run tools/sma-anchor.ts)`);
  }

  const timestamp = args.timestamp ?? new Date().toISOString();

  let targets;
  if (args.all) targets = rows.map((r) => r.brick_id);
  else if (args.brick) targets = [args.brick];
  else throw new Error('specify --brick <brick_id> or --all');

  const summary = [];
  for (const brickId of targets) {
    const provRow = provIndex.get(brickId);
    if (!provRow) throw new Error(`brick not found in provenance ledger: ${brickId}`);
    if (!provRow.seal?.head) {
      throw new Error(`brick has no provenance seal — cannot build inclusion proof: ${brickId}`);
    }
    const idx = rowIndex.get(brickId);
    if (idx === undefined) throw new Error(`brick not present in sealed set: ${brickId}`);

    const fpRow = fpIndex.get(brickId);
    const licRow = licIndex.get(brickId);
    const brick = {
      brick_id: brickId,
      project: (provRow.project ?? fpRow?.project) ?? null,
      content_hash: fpRow?.content_hash ?? null,
      file_count: fpRow?.file_count ?? null,
      byte_count: fpRow?.byte_count ?? null,
      spdx: licRow?.spdx ?? null,
      license_class: licRow?.license_class ?? null,
      openness: licRow?.openness ?? null,
      visibility: licRow?.visibility ?? null,
      attribution_required: licRow?.attribution_required ?? null,
      seal: provRow.seal,
      created_by: provRow.created_by ?? null,
      contributors: provRow.contributors ?? [],
      commit_count: provRow.commit_count ?? null,
    };
    const components: Parameters<typeof intotoStatement>[1] = []; // no sub-component source in these ledgers

    const proof = inclusionProof(layers, idx);
    if (!verifyBrickInclusion(brickId, provRow.seal.head, proof, root)) {
      throw new Error(`internal: inclusion proof failed to self-verify for ${brickId}`);
    }

    const dir = resolve(OUT_ROOT, sanitizeDir(brickId));
    mkdirSync(dir, { recursive: true });
    const attestationBrick = brick as unknown as Parameters<typeof intotoStatement>[0];
    writeJson(resolve(dir, 'intoto.json'), intotoStatement(attestationBrick, components, timestamp));
    writeJson(resolve(dir, 'sbom.spdx.json'), spdxDocument(attestationBrick, components, timestamp));
    writeJson(resolve(dir, 'sbom.cdx.json'), cyclonedxDocument(attestationBrick, components, timestamp));
    writeJson(resolve(dir, 'inclusion-proof.json'), {
      brick_id: brickId,
      seal_head: provRow.seal.head,
      content_hash: brick.content_hash,
      proof,
      root,
      anchor_digest: anchor.anchor_digest ?? null,
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
      anchor_digest: anchor.anchor_digest ?? null,
      count: summary.length,
      attestations: summary,
    }, null, 2));
  } else {
    console.log(`sma-attest: wrote ${String(summary.length)} attestation bundle(s)`);
    console.log(`  merkle root: ${root}`);
    for (const s of summary) {
      console.log(`  ${s.brick_id}`);
      console.log(`    -> ${s.dir}/ (${s.files.join(', ')})`);
    }
    console.log('\nVerify a bundle stand-alone (no ledgers needed) with:');
    console.log(`  node tools/sma-attest-verify.ts --dir ${summary[0]?.dir || 'releases/attestations/<brick_id>'}`);
  }
}

// --- helpers ---------------------------------------------------------------

function loadJson(path: string, label: string, producer: string): unknown {
  if (!existsSync(path)) {
    throw new Error(`${label} not found: ${rel(path)}. Run: node tools/${producer}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function indexBy<T extends { brick_id: string }>(arr: T[] | undefined): Map<string, T> {
  const m = new Map<string, T>();
  for (const row of arr ?? []) if (row.brick_id) m.set(row.brick_id, row);
  return m;
}

function sanitizeDir(id: unknown): string {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

function short(s: unknown): string {
  return legacyString(s ?? '').slice(0, 12);
}

function writeJson(p: string, v: unknown): void {
  writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
}

function rel(p: string): string {
  return relative(SMA_ROOT, p).split(sep).join('/');
}

function parseArgs(list: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_match: string, c: string) => c.toUpperCase());
    const next = list.at(i + 1);
    if (next === undefined || next.startsWith('--')) {
      if (key === 'all' || key === 'json') out[key] = true;
      continue;
    }
    if (key === 'brick' || key === 'timestamp') out[key] = next;
    i += 1;
  }
  return out;
}

function legacyString(value: unknown): string {
  return String(value);
}
