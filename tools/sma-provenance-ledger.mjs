#!/usr/bin/env node
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
 *   node tools/sma-provenance-ledger.mjs                 # full backfill
 *   node tools/sma-provenance-ledger.mjs --limit 50      # sample run
 *   node tools/sma-provenance-ledger.mjs --project acme-desktop
 *   node tools/sma-provenance-ledger.mjs --sign          # sign seals (needs key)
 *   node tools/sma-provenance-ledger.mjs --keygen        # create a signing key
 *   node tools/sma-provenance-ledger.mjs --json
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync, statSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBrickPath } from './lib/source-path-resolver.mjs';
import { writeJsonIfMeaningfulChanged } from './lib/stable-generated.mjs';
import { fingerprintSource, computeSeal, signSealHead, generateSealKeypair } from './lib/provenance-seal.mjs';
import { classifyLicense } from './lib/license-lattice.mjs';
import { canonicalIdentity, sameIdentity, ownerFor } from './lib/ownership.mjs';
import { scanDirectory, evaluateDeclarationMismatch } from './lib/license-evidence.mjs';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_REGISTRY = 'scans/all-projects/latest.registry.json';
const KEY_DIR = resolve(SMA_ROOT, 'security/keys');
const TOUCHED_CAP = 40;
const PROV_OUT = 'registry/provenance-ledger.generated.json';
const LIC_OUT = 'registry/license-ledger.generated.json';
const FP_OUT = 'security/brick-fingerprints.generated.json';

const args = parseArgs(process.argv.slice(2));
const NOW = new Date().toISOString();

try {
  if (args.keygen) {
    doKeygen();
  } else {
    main();
  }
} catch (err) {
  console.error(`sma-provenance-ledger: ${err.message}`);
  process.exit(1);
}

function main() {
  const REGISTRY = resolve(SMA_ROOT, args.registry || DEFAULT_REGISTRY);
  if (!existsSync(REGISTRY)) throw new Error(`registry not found: ${REGISTRY}`);
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const bricks = registry.bricks || [];
  const rootMap = new Map((registry.scanned_project_roots || []).map((r) => [r.id, r.root]));

  const signer = args.sign ? loadSigner() : null;
  const licenseCache = new Map();
  const repoRootCache = new Map();

  // Incremental (default): reuse prior entries whose source fingerprint is
  // unchanged, so a refresh only pays the git/seal cost for new or edited
  // bricks. --full forces a complete recompute.
  const prior = args.full ? { prov: new Map(), fp: new Map(), lic: new Map() } : loadPrior();

  let selected = bricks;
  if (args.project) selected = selected.filter((b) => b.project === args.project);
  if (args.limit) selected = selected.slice(0, Number(args.limit));

  const fingerprints = [];
  const provenance = [];
  const licenses = [];
  const byHash = new Map();

  let resolvedCount = 0;
  let gitCount = 0;
  let reusedCount = 0;
  let processed = 0;

  for (const brick of selected) {
    processed += 1;
    if (!args.json && processed % 250 === 0) {
      process.stderr.write(`  …${processed}/${selected.length}\n`);
    }

    const projectAbs = rootMap.get(brick.project) || guessProjectRoot(brick);
    const resolvedPath = projectAbs ? resolveBrickPath(brick, projectAbs) : null;
    const abs = resolvedPath?.absolutePath || null;

    // 1. fingerprint (always — it is the change signal for incremental reuse)
    const fp = fingerprintSource(abs, { maxFiles: 4000 });
    if (fp.resolved) resolvedCount += 1;

    const priorFp = prior.fp.get(brick.id);
    const canReuse = !args.full && fp.content_hash && priorFp
      && priorFp.content_hash === fp.content_hash
      && prior.prov.has(brick.id) && prior.lic.has(brick.id);

    let trail;
    let lic;
    let seal;
    if (canReuse) {
      // fingerprint unchanged → provenance + seal are unchanged; reuse them.
      const pp = prior.prov.get(brick.id);
      trail = {
        created_by: pp.created_by || null,
        touched_by: pp.touched_by || [],
        contributors: pp.contributors || [],
        commit_count: pp.commit_count || 0,
      };
      seal = { ...pp.seal };
      lic = { ...prior.lic.get(brick.id) };
      reusedCount += 1;
      if (trail.commit_count > 0) gitCount += 1;
      // re-sign under the current key if signing and the reused seal is
      // unsigned or was signed by a different key.
      if (signer && seal.head && seal.key_id !== signer.key_id) {
        seal.signature = signSealHead(seal.head, signer.privatePem);
        seal.key_id = signer.key_id;
      }
    } else {
      // 2. creator trail from git
      trail = abs ? gitTrail(abs, repoRootCache) : emptyTrail();
      if (trail.commit_count > 0) gitCount += 1;
      // 3. license resolution (fail-safe closed/private) + optional evidence check
      lic = { brick_id: brick.id, project: brick.project, ...resolveLicense(brick, projectAbs, licenseCache, { evidence: Boolean(args.evidence), absPath: abs }) };
      // seal events = created_by + touched_by (self-contained, verifiable)
      const events = [];
      if (trail.created_by) events.push(trail.created_by);
      events.push(...trail.touched_by);
      seal = computeSeal({ brick_id: brick.id, content_hash: fp.content_hash, events });
      if (signer) {
        seal.signature = signSealHead(seal.head, signer.privatePem);
        seal.key_id = signer.key_id;
      }
    }

    const fpEntry = {
      brick_id: brick.id,
      project: brick.project,
      content_hash: fp.content_hash,
      resolved: fp.resolved,
      file_count: fp.file_count,
      byte_count: fp.byte_count,
      truncated: fp.truncated || false,
    };
    fingerprints.push(fpEntry);
    if (fp.content_hash) {
      if (!byHash.has(fp.content_hash)) byHash.set(fp.content_hash, []);
      byHash.get(fp.content_hash).push({ entry: fpEntry, trail, brick });
    }

    const ownership = ownerFor(brick.id, brick.project);
    provenance.push({
      brick_id: brick.id,
      project: brick.project,
      owner: ownership.owner,
      owner_team: ownership.team,
      created_by: trail.created_by,
      touched_by: trail.touched_by,
      contributors: trail.contributors,
      commit_count: trail.commit_count,
      seal,
    });

    licenses.push(lic);
  }

  // 5. cross-project copy / theft detection
  const collisions = detectCollisions(byHash);
  annotateCopies(fingerprints, collisions);

  const header = {
    schema_version: '1.0.0',
    generated_at: NOW,
    source_registry: relative(SMA_ROOT, REGISTRY).split(sep).join('/'),
    brick_count: selected.length,
    signed: Boolean(signer),
    signing_key_id: signer?.key_id || null,
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

// --- git creator trail ------------------------------------------------------

function emptyTrail() {
  return { created_by: null, touched_by: [], contributors: [], commit_count: 0 };
}

function repoRootFor(abs, cache) {
  const dir = existsSync(abs) ? (isDir(abs) ? abs : dirname(abs)) : dirname(abs);
  if (cache.has(dir)) return cache.get(dir);
  let root = null;
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

function gitTrail(abs, cache) {
  const repoRoot = repoRootFor(abs, cache);
  if (!repoRoot) return emptyTrail();
  const rel = relative(repoRoot, abs).split(sep).join('/') || '.';
  let raw;
  try {
    raw = execFileSync('git', [
      '-C', repoRoot, 'log', '--no-merges', '-n', '500',
      '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s', '--', rel,
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return emptyTrail();
  }
  const commits = raw.split('\n').filter(Boolean).map((line) => {
    const [hash, name, email, iso, subject] = line.split('\x1f');
    return { hash, name, email, iso, subject };
  });
  if (!commits.length) return emptyTrail();

  // git log is newest-first; oldest = creation.
  const oldest = commits[commits.length - 1];
  const created_by = touchEvent(oldest, 'architect', 'created brick source');

  // touched_by: newest-first, capped, excluding the creation commit.
  const touched_by = commits
    .slice(0, TOUCHED_CAP)
    .filter((c) => c.hash !== oldest.hash)
    .map((c) => touchEvent(c, 'implementer', c.subject || 'modified brick'));

  // contributor ledger — aggregate by identity.
  const agg = new Map();
  for (const c of commits) {
    const id = c.email || c.name || 'unknown';
    if (!agg.has(id)) agg.set(id, { actor_id: id, name: c.name, commits: 0, first: c.iso, last: c.iso });
    const row = agg.get(id);
    row.commits += 1;
    if (c.iso < row.first) row.first = c.iso;
    if (c.iso > row.last) row.last = c.iso;
  }
  const contributors = [...agg.values()].sort((a, b) => b.commits - a.commits);

  return { created_by, touched_by, contributors, commit_count: commits.length };
}

function touchEvent(commit, role, summary) {
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

function resolveLicense(brick, projectAbs, cache, { evidence = false, absPath = null } = {}) {
  // Precedence: brick-level declaration > project LICENSE/package.json > fail-safe.
  const declared = brickDeclaredLicense(brick);
  let spdx = declared;
  let sourceOfTruth = declared ? 'brick' : null;

  if (!spdx && projectAbs) {
    const proj = projectLicense(projectAbs, cache);
    if (proj.spdx) { spdx = proj.spdx; sourceOfTruth = proj.source; }
  }

  const cls = classifyLicense(spdx);

  // License-evidence check: verify a DECLARED-open license against what the
  // source actually contains. A brick declaring MIT while its files carry AGPL
  // headers is laundering — fail safe to closed. Only runs for open/
  // source-available claims (the laundering direction) to bound cost.
  let licenseEvidence = null;
  if (evidence && absPath && (cls.openness === 'open' || cls.openness === 'source-available')) {
    try {
      const ev = scanDirectory(absPath, { maxFiles: 1500 });
      const mm = evaluateDeclarationMismatch(cls.spdx, ev);
      // Only downgrade on a real CONTRADICTION (high severity: stronger-copyleft
      // or proprietary evidence found under an open declaration). Mere ABSENCE
      // of per-file headers (medium) is normal and must NOT flip a project's
      // declared license — that would close nearly everything.
      if (mm.mismatch && mm.severity === 'high') {
        return {
          spdx: cls.spdx,
          license_class: cls.class,
          openness: 'closed', // declared license contradicted by source evidence
          visibility: 'private',
          attribution_required: true,
          source_of_truth: 'evidence-mismatch',
          reason: mm.message,
          license_evidence: { mismatch: true, severity: mm.severity, detected: ev.detected },
        };
      }
      licenseEvidence = { mismatch: Boolean(mm.mismatch), severity: mm.severity, detected: ev.detected };
    } catch { /* evidence scan best-effort */ }
  }

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
    source_of_truth: sourceOfTruth || 'fail-safe-default',
    reason: cls.reason,
    ...(licenseEvidence ? { license_evidence: licenseEvidence } : {}),
  };
}

function brickDeclaredLicense(brick) {
  if (brick.license && typeof brick.license === 'string') return brick.license;
  if (Array.isArray(brick.licenses) && brick.licenses.length) return brick.licenses[0];
  return null;
}

function projectLicense(projectAbs, cache) {
  if (cache.has(projectAbs)) return cache.get(projectAbs);
  let result = { spdx: null, source: null };
  try {
    const pkgPath = resolve(projectAbs, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
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

function sniffLicenseText(text) {
  const head = text.slice(0, 400).toLowerCase();
  if (/gnu affero/.test(head)) return 'AGPL-3.0';
  if (/gnu general public/.test(head)) return 'GPL-3.0';
  if (/gnu lesser/.test(head)) return 'LGPL-3.0';
  if (/mozilla public license/.test(head)) return 'MPL-2.0';
  if (/apache license/.test(head)) return 'Apache-2.0';
  if (/permission is hereby granted, free of charge/.test(head)) return 'MIT';
  if (/redistribution and use in source and binary/.test(head)) return 'BSD-3-Clause';
  if (/business source license/.test(head)) return 'BUSL-1.1';
  if (/this is free and unencumbered software/.test(head)) return 'Unlicense';
  return null;
}

// --- copy / theft detection -------------------------------------------------

function detectCollisions(byHash) {
  const collisions = [];
  for (const [hash, members] of byHash) {
    if (members.length < 2) continue;
    const projects = new Set(members.map((m) => m.brick.project));
    // Canonicalize authors so one person's multiple emails count as one identity.
    const authors = new Set(
      members.map((m) => canonicalIdentity(m.trail.created_by?.actor_id)).filter(Boolean),
    );
    if (projects.size < 2) continue; // same-project duplicate, not a cross-project copy

    // canonical origin = earliest WITNESSED creation timestamp. A copy with no
    // creation time (null) can never be the origin, so nulls sort LAST. NOTE:
    // git author dates are forgeable (GIT_AUTHOR_DATE), so this ordering is only
    // trustworthy once origin is bound to an external anchor time — see
    // docs/PROVENANCE_SEAL_LICENSE_LATTICE.md "Roots of trust".
    const ranked = members
      .map((m) => ({
        brick_id: m.brick.id,
        project: m.brick.project,
        created_by: m.trail.created_by?.actor_id || null,
        created_at: m.trail.created_by?.timestamp || null,
      }))
      .sort((a, b) => {
        if (!a.created_at && !b.created_at) return String(a.brick_id).localeCompare(String(b.brick_id));
        if (!a.created_at) return 1; // null timestamp is never the origin
        if (!b.created_at) return -1;
        if (a.created_at < b.created_at) return -1;
        if (a.created_at > b.created_at) return 1;
        return String(a.brick_id).localeCompare(String(b.brick_id));
      });
    // Prefer the earliest copy that actually has a witnessed timestamp.
    const origin = ranked.find((r) => r.created_at) || ranked[0];
    const originAuthor = origin.created_by;

    // theft-risk: a byte-identical copy in another project held by a DIFFERENT
    // identity (alias-aware) or unknown author. Still exact-match and identity
    // is spoofable — fuzzy/AST similarity + verified identity strengthen this.
    const theftRisk = ranked.some((r) => r.brick_id !== origin.brick_id
      && (!r.created_by || !sameIdentity(r.created_by, originAuthor)));

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

function annotateCopies(fingerprints, collisions) {
  const map = new Map();
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

function loadPrior() {
  const readMap = (relPath, key = 'brick_id', field) => {
    const p = resolve(SMA_ROOT, relPath);
    const map = new Map();
    if (!existsSync(p)) return map;
    try {
      const data = JSON.parse(readFileSync(p, 'utf8'));
      for (const row of data[field] || []) map.set(row[key], row);
    } catch { /* corrupt prior ledger → treat as empty (full recompute) */ }
    return map;
  };
  return {
    prov: readMap(PROV_OUT, 'brick_id', 'provenance'),
    fp: readMap(FP_OUT, 'brick_id', 'fingerprints'),
    lic: readMap(LIC_OUT, 'brick_id', 'licenses'),
  };
}

function writeLedgers({ header, fingerprints, provenance, licenses, collisions, resolvedCount, gitCount }) {
  const normalize = (v) => ({ ...v, generated_at: '<generated_at>' });
  writeJsonIfMeaningfulChanged(
    resolve(SMA_ROOT, 'security/brick-fingerprints.generated.json'),
    { ...header, resolved_on_disk: resolvedCount, collision_groups: collisions.length, collisions, fingerprints },
    { normalize },
  );
  writeJsonIfMeaningfulChanged(
    resolve(SMA_ROOT, 'registry/provenance-ledger.generated.json'),
    { ...header, with_git_history: gitCount, provenance },
    { normalize },
  );
  writeJsonIfMeaningfulChanged(
    resolve(SMA_ROOT, 'registry/license-ledger.generated.json'),
    { ...header, licenses },
    { normalize },
  );
}

function printSummary(s, collisions) {
  console.log('SMA provenance ledger');
  console.log(`  bricks:            ${s.bricks}`);
  console.log(`  resolved on disk:  ${s.resolved_on_disk}`);
  console.log(`  reused unchanged:  ${s.reused_unchanged} | recomputed: ${s.recomputed}`);
  console.log(`  with git history:  ${s.with_git_history}`);
  console.log(`  seals signed:      ${s.signed ? 'yes' : 'no (unsigned hash-chain)'}`);
  console.log(`  openness:          open=${s.open_bricks} source-available=${s.source_available_bricks} closed=${s.closed_bricks}`);
  console.log(`  copy groups:       ${s.copy_groups} (${s.theft_risk_groups} with theft risk)`);
  for (const c of collisions.slice(0, 10)) {
    const flag = c.theft_risk ? 'THEFT-RISK' : 'copy';
    console.log(`    ${flag} ${c.content_hash.slice(0, 12)} ×${c.copies} across ${c.projects.join(', ')} — origin ${c.origin.brick_id}`);
  }
  console.log('\nwrote:');
  console.log('  security/brick-fingerprints.generated.json');
  console.log('  registry/provenance-ledger.generated.json');
  console.log('  registry/license-ledger.generated.json');
}

// --- signing key management --------------------------------------------------

function doKeygen() {
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
  console.log(`Then sign with:     SMA_SEAL_PRIVATE_KEY=${relative(SMA_ROOT, privPath).split(sep).join('/')} node tools/sma-provenance-ledger.mjs --sign`);
}

function loadSigner() {
  const explicit = process.env.SMA_SEAL_PRIVATE_KEY;
  let privPath = explicit ? resolve(SMA_ROOT, explicit) : null;
  if (!privPath && existsSync(KEY_DIR)) {
    // pick the first key.pem found
    try {
      const found = readdirSync(KEY_DIR).find((n) => /\.key\.pem$/.test(n));
      if (found) privPath = resolve(KEY_DIR, found);
    } catch { /* ignore */ }
  }
  if (!privPath || !existsSync(privPath)) {
    throw new Error('--sign requested but no private key found. Run --keygen or set SMA_SEAL_PRIVATE_KEY.');
  }
  const privatePem = readFileSync(privPath, 'utf8');
  const key_id = (privPath.match(/seal\.([a-f0-9]{16})\./) || [])[1] || 'unknown';
  return { privatePem, key_id };
}

// --- misc -------------------------------------------------------------------

function guessProjectRoot(brick) {
  if (brick.manifest_path && existsSync(brick.manifest_path)) {
    try {
      return execFileSync('git', ['-C', dirname(brick.manifest_path), 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch { return null; }
  }
  return null;
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
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
