#!/usr/bin/env node
/**
 * WHAT: Finds near-duplicate brick source across projects.
 * WHY: Exact hashes miss copied code after small edits, renames, or reformatting.
 * HOW: Reads the global registry and resolved brick files, then compares compact fingerprints.
 * OUTPUTS: Writes security/similarity-scan.generated.json and prints text or structured data.
 * CALLERS: Security reviewers and provenance checks use the cross-owner findings.
 * USAGE: `node tools/sma-similarity-scan.ts --threshold 0.85 --limit 200 --json`
 * Glossary: [SMA](../docs/GLOSSARY.md).
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBrickPath } from './lib/source-path-resolver.ts';
import { normalizeSource, kGramShingles, simhash, hamming, winnow, jaccard } from './lib/similarity.ts';
import { canonicalIdentity, ownerFor, sameIdentity } from './lib/ownership.ts';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = resolve(SMA_ROOT, 'scans/all-projects/latest.registry.json');
const PROV_LEDGER = resolve(SMA_ROOT, 'registry/provenance-ledger.generated.json');
const FP_LEDGER = resolve(SMA_ROOT, 'security/brick-fingerprints.generated.json');
const OUT = resolve(SMA_ROOT, 'security/similarity-scan.generated.json');

const TEXT_RE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sql|sh|css|scss|html?|vue|svelte|json|ya?ml|toml|md)$/i;
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo', 'vendor']);

interface CliArgs {
  json?: boolean;
  limit?: string;
  minTokens?: string;
  project?: string;
  threshold?: string;
}

interface RegistryBrick {
  id: string;
  manifest_path?: string;
  project: string;
  source_paths?: string[];
}

interface RegistryData {
  bricks?: RegistryBrick[];
  scanned_project_roots?: { id: string; root: string }[];
}

interface BrickSignature {
  brick_id: string;
  content_hash: string | null;
  project: string;
  simhash: string;
  winnow: Set<string>;
}

interface FindingSide {
  author: string | null;
  brick_id: string;
  owner: string | null;
  project: string;
}

interface SimilarityFinding {
  a: FindingSide;
  b: FindingSide;
  near_duplicate: true;
  similarity: number;
  theft_risk: boolean;
}

interface SimilarityReport {
  bricks_scanned: number;
  findings: SimilarityFinding[];
  generated_at: string;
  near_duplicate_pairs: number;
  schema_version: string;
  theft_risk_pairs: number;
  threshold: number;
}

const args = parseArgs(process.argv.slice(2));
const THRESHOLD = Number(args.threshold) || 0.9;      // winnowing-Jaccard, not simhash
const MIN_TOKENS = Number(args.minTokens) || 400;     // ignore tiny/boilerplate bricks

try { main(); } catch (err: unknown) { console.error(`sma-similarity-scan: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); }

function main() {
  if (!existsSync(REGISTRY)) throw new Error(`registry not found: ${REGISTRY}`);
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8')) as RegistryData;
  const roots = new Map<string, string>((registry.scanned_project_roots ?? []).map((root) => [root.id, root.root]));
  const authorOf = loadAuthors();
  const hashOf = loadHashes();

  let bricks = registry.bricks ?? [];
  if (args.project) bricks = bricks.filter((b) => b.project === args.project);
  if (args.limit) bricks = bricks.slice(0, Number(args.limit));

  // Pass 1: simhash every brick (reads source once).
  const sigs: BrickSignature[] = [];
  let processed = 0;
  for (const brick of bricks) {
    processed += 1;
    if (!args.json && processed % 400 === 0) process.stderr.write(`  …${String(processed)}/${String(bricks.length)}\n`);
    const projectAbs = roots.get(brick.project);
    const resolved = projectAbs ? resolveBrickPath(brick, projectAbs) : null;
    if (!resolved?.absolutePath) continue;
    const text = readBrickText(resolved.absolutePath);
    if (!text) continue;
    const tokens = normalizeSource(text);
    if (tokens.length < MIN_TOKENS) continue; // skip tiny/boilerplate — simhash is meaningless there
    const shingles = kGramShingles(tokens, 5);
    if (!shingles.length) continue;
    // simhash for cheap LSH candidate generation; winnowing set for precise scoring.
    sigs.push({ brick_id: brick.id, project: brick.project, simhash: simhash(shingles), winnow: winnow(shingles, 4), content_hash: hashOf.get(brick.id) ?? null });
  }

  // Pass 2: LSH bucketing on 4 x 16-bit bands — only compare within a shared band.
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < sigs.length; i += 1) {
    for (const band of bands(sigs[i].simhash)) {
      if (!buckets.has(band)) buckets.set(band, []);
      buckets.get(band)?.push(i);
    }
  }

  const seenPair = new Set<string>();
  const findings: SimilarityFinding[] = [];
  for (const idxs of buckets.values()) {
    if (idxs.length < 2) continue;
    for (let a = 0; a < idxs.length; a += 1) {
      for (let b = a + 1; b < idxs.length; b += 1) {
        const x = sigs[idxs[a]];
        const y = sigs[idxs[b]];
        if (x.project === y.project) continue;                 // cross-project only
        if (x.content_hash && x.content_hash === y.content_hash) continue; // exact dup already reported
        const key = [x.brick_id, y.brick_id].sort().join('|');
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        // cheap prefilter on simhash, then PRECISE winnowing-Jaccard score.
        if (1 - hamming(x.simhash, y.simhash) / 64 < 0.8) continue;
        const sim = jaccard(x.winnow, y.winnow);
        if (sim < THRESHOLD) continue;
        // Theft = a near-duplicate across DIFFERENT OWNERS. Same-owner reuse
        // across one's own projects is legitimate and not flagged. Owner comes
        // from registry/owners.json (identity-alias aware).
        const ox = ownerFor(x.brick_id, x.project).owner;
        const oy = ownerFor(y.brick_id, y.project).owner;
        const crossOwner = !ox || !oy || !sameIdentity(ox, oy);
        findings.push({
          similarity: Number(sim.toFixed(3)),
          near_duplicate: true,
          theft_risk: crossOwner,
          a: { brick_id: x.brick_id, project: x.project, owner: ox ?? null, author: canonicalIdentity(authorOf.get(x.brick_id)) ?? null },
          b: { brick_id: y.brick_id, project: y.project, owner: oy ?? null, author: canonicalIdentity(authorOf.get(y.brick_id)) ?? null },
        });
      }
    }
  }
  findings.sort((p, q) => q.similarity - p.similarity);

  const report: SimilarityReport = {
    schema_version: '1.0.0',
    generated_at: new Date().toISOString(),
    threshold: THRESHOLD,
    bricks_scanned: sigs.length,
    near_duplicate_pairs: findings.length,
    theft_risk_pairs: findings.filter((f) => f.theft_risk).length,
    findings: findings.slice(0, 500),
  };
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);

  if (args.json) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log('SMA similarity (fuzzy theft) scan');
  console.log(`  bricks scanned:      ${String(report.bricks_scanned)}`);
  console.log(`  threshold:           ${String(THRESHOLD)}`);
  console.log(`  near-duplicate pairs:${String(report.near_duplicate_pairs)} (${String(report.theft_risk_pairs)} cross-owner theft-risk)`);
  for (const f of findings.slice(0, 15)) {
    console.log(`    ${f.theft_risk ? 'THEFT-RISK' : 'near-dup  '} sim=${String(f.similarity)} ${f.a.project} ~ ${f.b.project}`);
  }
  console.log(`\nwrote: ${relative(SMA_ROOT, OUT).split(sep).join('/')}`);
}

function bands(hex: string): string[] {
  // 64-bit simhash = 16 hex chars → 4 bands of 4 hex chars each.
  return [0, 4, 8, 12].map((i, n) => `${String(n)}:${hex.slice(i, i + 4)}`);
}

function readBrickText(absPath: string): string {
  const st = safeStat(absPath);
  if (!st) return '';
  const files = st.isFile() ? [absPath] : collectText(absPath);
  const parts: string[] = [];
  let bytes = 0;
  for (const f of files.sort()) {
    try {
      const buf = readFileSync(f);
      if (buf.includes(0)) continue; // binary
      parts.push(buf.toString('utf8'));
      bytes += buf.length;
      if (bytes > 2_000_000) break; // cap per brick
    } catch { /* skip */ }
  }
  return parts.join('\n');
}

function collectText(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name)) stack.push(resolve(dir, e.name)); continue; }
      if (e.isFile() && TEXT_RE.test(e.name)) out.push(resolve(dir, e.name));
    }
  }
  return out;
}

function loadAuthors(): Map<string, string | null> {
  const map = new Map<string, string | null>();
  if (!existsSync(PROV_LEDGER)) return map;
  try {
    const data = JSON.parse(readFileSync(PROV_LEDGER, 'utf8')) as { provenance?: { brick_id: string; created_by?: { actor_id?: string }; owner?: string }[] };
    for (const provenance of data.provenance ?? []) map.set(provenance.brick_id, provenance.created_by?.actor_id ?? provenance.owner ?? null);
  } catch { /* ignore */ }
  return map;
}

function loadHashes(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(FP_LEDGER)) return map;
  try {
    const data = JSON.parse(readFileSync(FP_LEDGER, 'utf8')) as { fingerprints?: { brick_id: string; content_hash: string }[] };
    for (const fingerprint of data.fingerprints ?? []) map.set(fingerprint.brick_id, fingerprint.content_hash);
  } catch { /* ignore */ }
  return map;
}

function safeStat(filePath: string): Stats | null { try { return statSync(filePath); } catch { return null; } }

function parseArgs(list: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, character: string) => character.toUpperCase());
    const n = list[i + 1];
    if (n === undefined || n.startsWith('--')) {
      if (key === 'json') out.json = true;
      continue;
    }
    if (key === 'limit' || key === 'minTokens' || key === 'project' || key === 'threshold') out[key] = n;
    i += 1;
  }
  return out;
}
