#!/usr/bin/env node
/**
 * What: Builds source fingerprints plus creator, license, and provenance ledgers.
 * Why: Reused code needs verifiable attribution, visibility, and tamper evidence across projects.
 * How: Reads the scan registry, source trees, and Git history, then writes generated ledgers.
 * Callers: Trust, publishing, and provenance-verification workflows consume these ledgers.
 * Example: `node tools/sma-provenance-ledger.ts --limit 1 --json`
 */
/**
 * SMA provenance ledger — the backfill engine for the creator trail, license
 * lattice, and provenance seals.
 *
 * For every brick in the scan registry it:
 *   1. resolves the source on disk and computes a content FINGERPRINT
 *   2. reconstructs the CREATOR TRAIL + MOD HISTORY from git (created_by,
 *      touched_by, contributor ledger)
 *   3. resolves the brick's LICENSE + OPENNESS + VISIBILITY (fail-safe: closed
 *      / private when it cannot be proven open)
 *   4. computes a tamper-evident SEAL (hash chain), optionally ed25519-signed
 *   5. detects cross-project COPIES (same fingerprint, different origin) — the
 *      signal that a brick may have been lifted without attribution.
 *
 * Outputs (generated, keyed by brick_id):
 *   security/brick-fingerprints.generated.json   fingerprints + collision groups
 *   registry/provenance-ledger.generated.json    creator trail, mod history, seals
 *   registry/license-ledger.generated.json        license / openness / visibility
 *
 * The ledgers are SELF-VERIFYING: sma-provenance-verify recomputes each seal
 * from the events stored here, so tampering with the ledger is detectable even
 * without the original source. Signing closes the recompute-forgery gap.
 *
 * Usage:
 *   node tools/sma-provenance-ledger.ts                 # full backfill
 *   node tools/sma-provenance-ledger.ts --limit 50      # sample run
 *   node tools/sma-provenance-ledger.ts --project acme-desktop
 *   node tools/sma-provenance-ledger.ts --sign          # sign seals (needs key)
 *   node tools/sma-provenance-ledger.ts --keygen        # create a signing key
 *   node tools/sma-provenance-ledger.ts --json
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBrickPath } from './lib/source-path-resolver.ts';
import { writeJsonIfMeaningfulChanged } from './lib/stable-generated.ts';
import { fingerprintSource, computeSeal, signSealHead, generateSealKeypair } from './lib/provenance-seal.ts';
import { classifyLicense } from './lib/license-lattice.ts';
import { canonicalIdentity, sameIdentity, ownerFor } from './lib/ownership.ts';
import { scanDirectory, evaluateDeclarationMismatch } from './lib/license-evidence.ts';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REGISTRY = 'scans/all-projects/latest.registry.json';
const KEY_DIR = resolve(SMA_ROOT, 'security/keys');
const TOUCHED_CAP = 40;
const PROV_OUT = 'registry/provenance-ledger.generated.json';
const LIC_OUT = 'registry/license-ledger.generated.json';
const FP_OUT = 'security/brick-fingerprints.generated.json';

interface CliArgs extends Record<string, string | boolean | undefined> {
  keygen?: boolean;
  registry?: string;
  sign?: boolean;
  full?: boolean;
  project?: string;
  limit?: string;
  evidence?: boolean;
  json?: boolean;
}

interface Brick {
  id: string;
  project: string;
  manifest_path?: string;
  source_paths?: string[];
  license?: string;
  licenses?: unknown[];
}

interface RegistryDocument {
  bricks?: Brick[];
  scanned_project_roots?: { id: string; root: string }[];
}

interface GitCommit {
  hash: string;
  name: string;
  email: string;
  iso: string;
  subject: string;
}

interface TouchEvent {
  actor_kind: 'human';
  actor_id: string;
  role: string;
  timestamp: string;
  commit: string;
  summary: string;
  attestation: { method: 'git_commit'; reference: string; hash: string };
}

interface Contributor {
  actor_id: string;
  name: string;
  commits: number;
  first: string;
  last: string;
}

interface CreatorTrail {
  created_by: TouchEvent | null;
  touched_by: TouchEvent[];
  contributors: Contributor[];
  commit_count: number;
}

interface SignedSeal extends ReturnType<typeof computeSeal> {
  signature?: string;
  key_id?: string;
}

interface LicenseEvidenceSummary {
  mismatch: boolean;
  severity: string;
  detected: string[];
}

interface LicenseEntry {
  brick_id?: string;
  project?: string;
  spdx: string | null;
  license_class: string;
  openness: string;
  visibility: string;
  attribution_required: boolean;
  source_of_truth: string;
  reason?: string;
  license_evidence?: LicenseEvidenceSummary;
}

interface FingerprintEntry {
  brick_id: string;
  project: string;
  content_hash: string | null;
  resolved: boolean;
  file_count: number;
  byte_count: number;
  truncated: boolean;
  copy_group?: string;
  copy_of?: string | null;
  theft_risk?: boolean;
}

interface ProvenanceEntry {
  brick_id: string;
  project: string;
  owner: string | null;
  owner_team: string | null;
  created_by: TouchEvent | null;
  touched_by: TouchEvent[];
  contributors: Contributor[];
  commit_count: number;
  seal: SignedSeal;
}

interface HashMember {
  entry: FingerprintEntry;
  trail: CreatorTrail;
  brick: Brick;
}

interface CollisionMember {
  brick_id: string;
  project: string;
  created_by: string | null;
  created_at: string | null;
}

interface Collision {
  content_hash: string;
  copies: number;
  projects: string[];
  distinct_authors: string[];
  origin: CollisionMember;
  theft_risk: boolean;
  members: CollisionMember[];
}

interface PriorLedgers {
  prov: Map<string, ProvenanceEntry>;
  fp: Map<string, FingerprintEntry>;
  lic: Map<string, LicenseEntry>;
}

interface ProjectLicense {
  spdx: string | null;
  source: string | null;
}

interface Signer {
  privatePem: string;
  key_id: string;
}

interface LedgerHeader extends Record<string, unknown> {
  schema_version: string;
  generated_at: string;
  source_registry: string;
  brick_count: number;
  signed: boolean;
  signing_key_id: string | null;
}

interface LedgerSummary {
  bricks: number;
  resolved_on_disk: number;
  with_git_history: number;
  reused_unchanged: number;
  recomputed: number;
  signed: boolean;
  copy_groups: number;
  theft_risk_groups: number;
  open_bricks: number;
  closed_bricks: number;
  source_available_bricks: number;
}

interface BrickProvenanceData {
  trail: CreatorTrail;
  license: LicenseEntry;
  seal: SignedSeal;
  reused: boolean;
}

interface LedgerCollection {
  fingerprints: FingerprintEntry[];
  provenance: ProvenanceEntry[];
  licenses: LicenseEntry[];
  byHash: Map<string, HashMember[]>;
  resolvedCount: number;
  gitCount: number;
  reusedCount: number;
}

const args = parseArgs(process.argv.slice(2));
const NOW = new Date().toISOString();

try {
  if (args.keygen) {
    doKeygen();
  } else {
    main();
  }
} catch (err: unknown) {
  console.error(`sma-provenance-ledger: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

function main(): void {
  const REGISTRY = resolve(SMA_ROOT, args.registry ?? DEFAULT_REGISTRY);
  if (!existsSync(REGISTRY)) throw new Error(`registry not found: ${REGISTRY}`);
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8')) as RegistryDocument;
  const bricks = registry.bricks ?? [];
  const rootMap = new Map<string, string>((registry.scanned_project_roots ?? []).map((record: { id: string; root: string }) => [record.id, record.root]));

  const signer = args.sign ? loadSigner() : null;
  const licenseCache = new Map<string, ProjectLicense>();
  const repoRootCache = new Map<string, string | null>();

  // Incremental (default): reuse prior entries whose source fingerprint is
  // unchanged, so a refresh only pays the git/seal cost for new or edited
  // bricks. --full forces a complete recompute.
  const prior: PriorLedgers = args.full ? {
    prov: new Map<string, ProvenanceEntry>(),
    fp: new Map<string, FingerprintEntry>(),
    lic: new Map<string, LicenseEntry>(),
  } : loadPrior();

  let selected = bricks;
  if (args.project) selected = selected.filter((b) => b.project === args.project);
  if (args.limit) selected = selected.slice(0, Number(args.limit));

  const collection = collectLedgerEntries(selected, rootMap, prior, signer, licenseCache, repoRootCache);
  const { fingerprints, provenance, licenses, byHash, resolvedCount, gitCount, reusedCount } = collection;

  // 5. cross-project copy / theft detection
  const collisions = detectCollisions(byHash);
  annotateCopies(fingerprints, collisions);

  const header = {
    schema_version: '1.0.0',
    generated_at: NOW,
    source_registry: relative(SMA_ROOT, REGISTRY).split(sep).join('/'),
    brick_count: selected.length,
    signed: Boolean(signer),
    signing_key_id: signer?.key_id ?? null,
  };

  writeLedgers({ header, fingerprints, provenance, licenses, collisions, resolvedCount, gitCount });

  const summary = {
    bricks: selected.length,
    resolved_on_disk: resolvedCount,
    with_git_history: gitCount,
    reused_unchanged: reusedCount,
    recomputed: selected.length - reusedCount,
    signed: Boolean(signer),
    copy_groups: collisions.length,
    theft_risk_groups: collisions.filter((c) => c.theft_risk).length,
    open_bricks: licenses.filter((l) => l.openness === 'open').length,
    closed_bricks: licenses.filter((l) => l.openness === 'closed').length,
    source_available_bricks: licenses.filter((l) => l.openness === 'source-available').length,
  };

  if (args.json) {
    console.log(JSON.stringify({ header, summary, collisions }, null, 2));
  } else {
    printSummary(summary, collisions);
  }
}

function collectLedgerEntries(
  selected: Brick[],
  rootMap: Map<string, string>,
  prior: PriorLedgers,
  signer: Signer | null,
  licenseCache: Map<string, ProjectLicense>,
  repoRootCache: Map<string, string | null>,
): LedgerCollection {
  const result: LedgerCollection = {
    fingerprints: [], provenance: [], licenses: [], byHash: new Map(),
    resolvedCount: 0, gitCount: 0, reusedCount: 0,
  };
  selected.forEach((brick, index) => {
    reportLedgerProgress(index + 1, selected.length);
    const projectAbs = rootMap.get(brick.project) ?? guessProjectRoot(brick);
    const abs = projectAbs ? resolveBrickPath(brick, projectAbs)?.absolutePath ?? null : null;
    const fingerprint = fingerprintSource(abs ?? '', { maxFiles: 4000 });
    const data = provenanceDataForBrick(brick, projectAbs, abs, fingerprint.content_hash, prior, signer, licenseCache, repoRootCache);
    const fingerprintEntry = buildFingerprintEntry(brick, fingerprint);
    result.fingerprints.push(fingerprintEntry);
    result.provenance.push(buildProvenanceEntry(brick, data));
    result.licenses.push(data.license);
    addHashMember(result.byHash, fingerprintEntry, data.trail, brick);
    if (fingerprint.resolved) result.resolvedCount += 1;
    if (data.trail.commit_count > 0) result.gitCount += 1;
    if (data.reused) result.reusedCount += 1;
  });
  return result;
}

function reportLedgerProgress(processed: number, total: number): void {
  if (!args.json && processed % 250 === 0) process.stderr.write(`  …${String(processed)}/${String(total)}\n`);
}

function provenanceDataForBrick(
  brick: Brick,
  projectAbs: string | null,
  abs: string | null,
  contentHash: string | null,
  prior: PriorLedgers,
  signer: Signer | null,
  licenseCache: Map<string, ProjectLicense>,
  repoRootCache: Map<string, string | null>,
): BrickProvenanceData {
  const priorFingerprint = prior.fp.get(brick.id);
  const reusable = !args.full && Boolean(contentHash) && priorFingerprint?.content_hash === contentHash;
  if (reusable && prior.prov.has(brick.id) && prior.lic.has(brick.id)) return reusedProvenanceData(brick, prior, signer);
  const trail = abs ? gitTrail(abs, repoRootCache) : emptyTrail();
  const license = { brick_id: brick.id, project: brick.project, ...resolveLicense(brick, projectAbs, licenseCache, { evidence: args.evidence, absPath: abs }) };
  const events = trail.created_by ? [trail.created_by, ...trail.touched_by] : [...trail.touched_by];
  const seal: SignedSeal = computeSeal({ brick_id: brick.id, content_hash: contentHash, events });
  signSeal(seal, signer);
  return { trail, license, seal, reused: false };
}

function reusedProvenanceData(brick: Brick, prior: PriorLedgers, signer: Signer | null): BrickProvenanceData {
  const previous = prior.prov.get(brick.id);
  const license = prior.lic.get(brick.id);
  if (!previous || !license) throw new Error(`prior ledger is incomplete for ${brick.id}`);
  const trail: CreatorTrail = {
    created_by: previous.created_by,
    touched_by: previous.touched_by,
    contributors: previous.contributors,
    commit_count: previous.commit_count,
  };
  const seal = { ...previous.seal };
  signSeal(seal, signer);
  return { trail, license: { ...license }, seal, reused: true };
}

function signSeal(seal: SignedSeal, signer: Signer | null): void {
  if (!signer || seal.key_id === signer.key_id) return;
  seal.signature = signSealHead(seal.head, signer.privatePem);
  seal.key_id = signer.key_id;
}

function buildFingerprintEntry(brick: Brick, fingerprint: ReturnType<typeof fingerprintSource>): FingerprintEntry {
  return {
    brick_id: brick.id, project: brick.project, content_hash: fingerprint.content_hash,
    resolved: fingerprint.resolved, file_count: fingerprint.file_count,
    byte_count: fingerprint.byte_count, truncated: fingerprint.truncated,
  };
}

function buildProvenanceEntry(brick: Brick, data: BrickProvenanceData): ProvenanceEntry {
  const ownership = ownerFor(brick.id, brick.project);
  return {
    brick_id: brick.id, project: brick.project, owner: ownership.owner, owner_team: ownership.team,
    created_by: data.trail.created_by, touched_by: data.trail.touched_by,
    contributors: data.trail.contributors, commit_count: data.trail.commit_count, seal: data.seal,
  };
}

function addHashMember(byHash: Map<string, HashMember[]>, entry: FingerprintEntry, trail: CreatorTrail, brick: Brick): void {
  if (!entry.content_hash) return;
  const members = byHash.get(entry.content_hash) ?? [];
  members.push({ entry, trail, brick });
  byHash.set(entry.content_hash, members);
}

// --- git creator trail ------------------------------------------------------

function emptyTrail(): CreatorTrail {
  return { created_by: null, touched_by: [], contributors: [], commit_count: 0 };
}

function repoRootFor(abs: string, cache: Map<string, string | null>): string | null {
  const dir = existsSync(abs) ? (isDir(abs) ? abs : dirname(abs)) : dirname(abs);
  if (cache.has(dir)) return cache.get(dir) ?? null;
  let root: string | null = null;
  try {
    root = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    root = null;
  }
  cache.set(dir, root);
  return root;
}

function gitTrail(abs: string, cache: Map<string, string | null>): CreatorTrail {
  const repoRoot = repoRootFor(abs, cache);
  if (!repoRoot) return emptyTrail();
  const rel = relative(repoRoot, abs).split(sep).join('/') || '.';
  let raw: string;
  try {
    raw = execFileSync('git', [
      '-C', repoRoot, 'log', '--no-merges', '-n', '500',
      '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s', '--', rel,
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return emptyTrail();
  }
  const commits: GitCommit[] = raw.split('\n').filter(Boolean).map((line: string) => {
    const fields = line.split('\x1f');
    return {
      hash: fields.at(0) ?? '',
      name: fields.at(1) ?? '',
      email: fields.at(2) ?? '',
      iso: fields.at(3) ?? '',
      subject: fields.at(4) ?? '',
    };
  });
  if (!commits.length) return emptyTrail();

  // git log is newest-first; oldest = creation.
  const oldest = commits.at(-1);
  if (!oldest) return emptyTrail();
  const created_by = touchEvent(oldest, 'architect', 'created brick source');

  // touched_by: newest-first, capped, excluding the creation commit.
  const touched_by = commits
    .slice(0, TOUCHED_CAP)
    .filter((c) => c.hash !== oldest.hash)
    .map((c) => touchEvent(c, 'implementer', c.subject || 'modified brick'));

  // contributor ledger — aggregate by identity.
  const agg = new Map<string, Contributor>();
  for (const c of commits) {
    const id = c.email || c.name || 'unknown';
    if (!agg.has(id)) agg.set(id, { actor_id: id, name: c.name, commits: 0, first: c.iso, last: c.iso });
    const row = agg.get(id);
    if (!row) continue;
    row.commits += 1;
    if (c.iso < row.first) row.first = c.iso;
    if (c.iso > row.last) row.last = c.iso;
  }
  const contributors = [...agg.values()].sort((a, b) => b.commits - a.commits);

  return { created_by, touched_by, contributors, commit_count: commits.length };
}

function touchEvent(commit: GitCommit, role: string, summary: string): TouchEvent {
  return {
    actor_kind: 'human',
    actor_id: commit.email || commit.name || 'unknown',
    role,
    timestamp: commit.iso,
    commit: commit.hash,
    summary,
    attestation: { method: 'git_commit', reference: commit.hash, hash: commit.hash },
  };
}

// --- license resolution -----------------------------------------------------

function resolveLicense(brick: Brick, projectAbs: string | null, cache: Map<string, ProjectLicense>, { evidence, absPath }: { evidence?: boolean; absPath?: string | null } = {}): Omit<LicenseEntry, 'brick_id' | 'project'> {
  // Precedence: brick-level declaration > project LICENSE/package.json > fail-safe.
  const declared = brickDeclaredLicense(brick);
  let spdx = declared;
  let sourceOfTruth: string | null = declared ? 'brick' : null;

  if (!spdx && projectAbs) {
    const proj = projectLicense(projectAbs, cache);
    if (proj.spdx) { spdx = proj.spdx; sourceOfTruth = proj.source; }
  }

  const cls = classifyLicense(spdx);

  // License-evidence check: verify a DECLARED-open license against what the
  // source actually contains. A brick declaring MIT while its files carry AGPL
  // headers is laundering — fail safe to closed. Only runs for open/
  // source-available claims (the laundering direction) to bound cost.
  const evidenceResult = licenseEvidenceFor(cls, evidence, absPath);
  if (evidenceResult.override) return evidenceResult.override;
  const licenseEvidence = evidenceResult.summary;

  // Visibility fail-safe: unknown/closed => private; open => internal by default
  // (never auto-public; publishing to community/public is an explicit act).
  let visibility = 'private';
  if (cls.openness === 'open') visibility = 'internal';
  else if (cls.openness === 'source-available') visibility = 'internal';

  return {
    spdx: cls.spdx,
    license_class: cls.class,
    openness: cls.openness,
    visibility,
    attribution_required: cls.attribution,
    source_of_truth: sourceOfTruth ?? 'fail-safe-default',
    reason: cls.reason,
    ...(licenseEvidence ? { license_evidence: licenseEvidence } : {}),
  };
}

function licenseEvidenceFor(
  classification: ReturnType<typeof classifyLicense>,
  enabled: boolean | undefined,
  absPath: string | null | undefined,
): { override: Omit<LicenseEntry, 'brick_id' | 'project'> | null; summary: LicenseEvidenceSummary | null } {
  if (!enabled || !absPath || (classification.openness !== 'open' && classification.openness !== 'source-available')) {
    return { override: null, summary: null };
  }
  try {
    const evidence = scanDirectory(absPath, { maxFiles: 1500 });
    const mismatch = evaluateDeclarationMismatch(classification.spdx ?? '', evidence);
    const summary = { mismatch: mismatch.mismatch, severity: mismatch.severity, detected: evidence.detected };
    if (!mismatch.mismatch || mismatch.severity !== 'high') return { override: null, summary };
    return {
      summary,
      override: {
        spdx: classification.spdx, license_class: classification.class, openness: 'closed', visibility: 'private',
        attribution_required: true, source_of_truth: 'evidence-mismatch', reason: mismatch.message, license_evidence: summary,
      },
    };
  } catch {
    return { override: null, summary: null };
  }
}

function brickDeclaredLicense(brick: Brick): string | null {
  if (brick.license && typeof brick.license === 'string') return brick.license;
  const firstLicense = brick.licenses?.[0];
  if (typeof firstLicense === 'string') return firstLicense;
  return null;
}

function projectLicense(projectAbs: string, cache: Map<string, ProjectLicense>): ProjectLicense {
  const cached = cache.get(projectAbs);
  if (cached) return cached;
  let result: ProjectLicense = { spdx: null, source: null };
  try {
    const pkgPath = resolve(projectAbs, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { license?: string | { type?: string } };
      const lic = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type;
      if (lic) result = { spdx: lic, source: 'project-package.json' };
    }
    if (!result.spdx) {
      for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']) {
        const p = resolve(projectAbs, name);
        if (existsSync(p)) {
          const spdx = sniffLicenseText(readFileSync(p, 'utf8'));
          if (spdx) { result = { spdx, source: 'project-LICENSE' }; break; }
        }
      }
    }
  } catch {
    // fall through to fail-safe
  }
  cache.set(projectAbs, result);
  return result;
}

function sniffLicenseText(text: string): string | null {
  const head = text.slice(0, 400).toLowerCase();
  if (head.includes('gnu affero')) return 'AGPL-3.0';
  if (head.includes('gnu general public')) return 'GPL-3.0';
  if (head.includes('gnu lesser')) return 'LGPL-3.0';
  if (head.includes('mozilla public license')) return 'MPL-2.0';
  if (head.includes('apache license')) return 'Apache-2.0';
  if (head.includes('permission is hereby granted, free of charge')) return 'MIT';
  if (head.includes('redistribution and use in source and binary')) return 'BSD-3-Clause';
  if (head.includes('business source license')) return 'BUSL-1.1';
  if (head.includes('this is free and unencumbered software')) return 'Unlicense';
  return null;
}

// --- copy / theft detection -------------------------------------------------

function detectCollisions(byHash: Map<string, HashMember[]>): Collision[] {
  const collisions: Collision[] = [];
  for (const [hash, members] of byHash) {
    if (members.length < 2) continue;
    const projects = new Set(members.map((m) => m.brick.project));
    // Canonicalize authors so one person's multiple emails count as one identity.
    const authors = new Set(
      members
        .map((member: HashMember) => canonicalIdentity(member.trail.created_by?.actor_id))
        .filter((author: string | null | undefined): author is string => typeof author === 'string' && author.length > 0),
    );
    if (projects.size < 2) continue; // same-project duplicate, not a cross-project copy

    // canonical origin = earliest WITNESSED creation timestamp. A copy with no
    // creation time (null) can never be the origin, so nulls sort LAST. NOTE:
    // git author dates are forgeable (GIT_AUTHOR_DATE), so this ordering is only
    // trustworthy once origin is bound to an external anchor time — see
    // docs/PROVENANCE_SEAL_LICENSE_LATTICE.md "Roots of trust".
    const ranked = members
      .map((member: HashMember): CollisionMember => ({
        brick_id: member.brick.id,
        project: member.brick.project,
        created_by: member.trail.created_by?.actor_id ?? null,
        created_at: member.trail.created_by?.timestamp ?? null,
      }))
      .sort((a, b) => {
        if (!a.created_at && !b.created_at) return a.brick_id.localeCompare(b.brick_id);
        if (!a.created_at) return 1; // null timestamp is never the origin
        if (!b.created_at) return -1;
        if (a.created_at < b.created_at) return -1;
        if (a.created_at > b.created_at) return 1;
        return a.brick_id.localeCompare(b.brick_id);
      });
    // Prefer the earliest copy that actually has a witnessed timestamp.
    const origin = ranked.find((member: CollisionMember) => member.created_at) ?? ranked.at(0);
    if (!origin) continue;
    const originAuthor = origin.created_by;

    // theft-risk: a byte-identical copy in another project held by a DIFFERENT
    // identity (alias-aware) or unknown author. Still exact-match and identity
    // is spoofable — fuzzy/AST similarity + verified identity strengthen this.
    const theftRisk = ranked.some((member: CollisionMember) => member.brick_id !== origin.brick_id
      && (!member.created_by || !originAuthor || !sameIdentity(member.created_by, originAuthor)));

    collisions.push({
      content_hash: hash,
      copies: ranked.length,
      projects: [...projects],
      distinct_authors: [...authors],
      origin,
      theft_risk: theftRisk,
      members: ranked,
    });
  }
  return collisions.sort((a, b) => b.copies - a.copies);
}

function annotateCopies(fingerprints: FingerprintEntry[], collisions: Collision[]): void {
  const map = new Map<string, Pick<FingerprintEntry, 'copy_group' | 'copy_of' | 'theft_risk'>>();
  for (const c of collisions) {
    for (const m of c.members) {
      map.set(m.brick_id, {
        copy_group: c.content_hash.slice(0, 12),
        copy_of: c.origin.brick_id === m.brick_id ? null : c.origin.brick_id,
        theft_risk: c.theft_risk && c.origin.brick_id !== m.brick_id,
      });
    }
  }
  for (const fp of fingerprints) {
    const info = map.get(fp.brick_id);
    if (info) Object.assign(fp, info);
  }
}

// --- output -----------------------------------------------------------------

function loadPrior(): PriorLedgers {
  const readMap = <T extends { brick_id?: string }>(relPath: string, field: string): Map<string, T> => {
    const p = resolve(SMA_ROOT, relPath);
    const map = new Map<string, T>();
    if (!existsSync(p)) return map;
    try {
      const data = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
      const rows = data[field];
      if (!Array.isArray(rows)) return map;
      for (const row of rows as T[]) {
        if (row.brick_id) map.set(row.brick_id, row);
      }
    } catch { /* corrupt prior ledger → treat as empty (full recompute) */ }
    return map;
  };
  return {
    prov: readMap<ProvenanceEntry>(PROV_OUT, 'provenance'),
    fp: readMap<FingerprintEntry>(FP_OUT, 'fingerprints'),
    lic: readMap<LicenseEntry>(LIC_OUT, 'licenses'),
  };
}

function writeLedgers({ header, fingerprints, provenance, licenses, collisions, resolvedCount, gitCount }: {
  header: LedgerHeader;
  fingerprints: FingerprintEntry[];
  provenance: ProvenanceEntry[];
  licenses: LicenseEntry[];
  collisions: Collision[];
  resolvedCount: number;
  gitCount: number;
}): void {
  const normalize = (value: Record<string, unknown>): Record<string, unknown> => ({ ...value, generated_at: '<generated_at>' });
  void writeJsonIfMeaningfulChanged(
    resolve(SMA_ROOT, 'security/brick-fingerprints.generated.json'),
    { ...header, resolved_on_disk: resolvedCount, collision_groups: collisions.length, collisions, fingerprints },
    { normalize },
  );
  void writeJsonIfMeaningfulChanged(
    resolve(SMA_ROOT, 'registry/provenance-ledger.generated.json'),
    { ...header, with_git_history: gitCount, provenance },
    { normalize },
  );
  void writeJsonIfMeaningfulChanged(
    resolve(SMA_ROOT, 'registry/license-ledger.generated.json'),
    { ...header, licenses },
    { normalize },
  );
}

function printSummary(summary: LedgerSummary, collisions: Collision[]): void {
  console.log('SMA provenance ledger');
  console.log(`  bricks:            ${String(summary.bricks)}`);
  console.log(`  resolved on disk:  ${String(summary.resolved_on_disk)}`);
  console.log(`  reused unchanged:  ${String(summary.reused_unchanged)} | recomputed: ${String(summary.recomputed)}`);
  console.log(`  with git history:  ${String(summary.with_git_history)}`);
  console.log(`  seals signed:      ${summary.signed ? 'yes' : 'no (unsigned hash-chain)'}`);
  console.log(`  openness:          open=${String(summary.open_bricks)} source-available=${String(summary.source_available_bricks)} closed=${String(summary.closed_bricks)}`);
  console.log(`  copy groups:       ${String(summary.copy_groups)} (${String(summary.theft_risk_groups)} with theft risk)`);
  for (const c of collisions.slice(0, 10)) {
    const flag = c.theft_risk ? 'THEFT-RISK' : 'copy';
    console.log(`    ${flag} ${c.content_hash.slice(0, 12)} ×${String(c.copies)} across ${c.projects.join(', ')} — origin ${c.origin.brick_id}`);
  }
  console.log('\nwrote:');
  console.log('  security/brick-fingerprints.generated.json');
  console.log('  registry/provenance-ledger.generated.json');
  console.log('  registry/license-ledger.generated.json');
}

// --- signing key management --------------------------------------------------

function doKeygen(): void {
  const { key_id, publicPem, privatePem } = generateSealKeypair();
  mkdirSync(KEY_DIR, { recursive: true });
  const pubPath = resolve(KEY_DIR, `seal.${key_id}.pub.pem`);
  const privPath = resolve(KEY_DIR, `seal.${key_id}.key.pem`);
  writeFileSync(pubPath, publicPem);
  writeFileSync(privPath, privatePem);
  try { chmodSync(privPath, 0o600); } catch { /* best effort */ }
  console.log(`Generated ed25519 seal key ${key_id}`);
  console.log(`  public  (commit this): ${relative(SMA_ROOT, pubPath).split(sep).join('/')}`);
  console.log(`  private (DO NOT COMMIT): ${relative(SMA_ROOT, privPath).split(sep).join('/')}`);
  console.log('\nAdd to .gitignore:  security/keys/*.key.pem');
  console.log(`Then sign with:     SMA_SEAL_PRIVATE_KEY=${relative(SMA_ROOT, privPath).split(sep).join('/')} node tools/sma-provenance-ledger.ts --sign`);
}

function loadSigner(): Signer {
  const explicit = process.env.SMA_SEAL_PRIVATE_KEY;
  let privPath = explicit ? resolve(SMA_ROOT, explicit) : null;
  if (!privPath && existsSync(KEY_DIR)) {
    // pick the first key.pem found
    try {
      const found = readdirSync(KEY_DIR).find((n) => n.endsWith(".key.pem"));
      if (found) privPath = resolve(KEY_DIR, found);
    } catch { /* ignore */ }
  }
  if (!privPath || !existsSync(privPath)) {
    throw new Error('--sign requested but no private key found. Run --keygen or set SMA_SEAL_PRIVATE_KEY.');
  }
  const privatePem = readFileSync(privPath, 'utf8');
  const key_id = ((/seal\.([a-f0-9]{16})\./.exec(privPath)) ?? [])[1] || 'unknown';
  return { privatePem, key_id };
}

// --- misc -------------------------------------------------------------------

function guessProjectRoot(brick: Brick): string | null {
  if (brick.manifest_path && existsSync(brick.manifest_path)) {
    try {
      return execFileSync('git', ['-C', dirname(brick.manifest_path), 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch { return null; }
  }
  return null;
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function parseArgs(list: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_match: string, character: string) => character.toUpperCase());
    const next = list.at(i + 1);
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next; i += 1;
  }
  return out;
}
