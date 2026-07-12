/* eslint-disable @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-base-to-string, @typescript-eslint/no-unnecessary-type-conversion -- Provenance canonicalization preserves historical truthy fallbacks and exact JavaScript coercion for seal compatibility. */
/**
 * WHAT: Fingerprints source trees and builds verifiable provenance hash chains and signatures.
 * WHY: Exact source identity and recorded authorship must reveal later code or history tampering.
 * HOW: Normalizes eligible files, hashes ordered events, and optionally signs the resulting chain head.
 * INPUTS: A file or directory, brick identity, content hash, provenance events, and optional keys.
 * OUTPUTS: Fingerprints, seals, verification reasons, key pairs, signatures, and stable key identifiers.
 * CALLERS: Provenance ledger, verification, anchor, attestation, and self-test tools share these primitives.
 * @example node --input-type=module -e "import { computeSeal } from './tools/lib/provenance-seal.ts'; console.log(computeSeal({ brick_id: 'demo', content_hash: 'abc', events: [] }).head);"
 */
/**
 * provenance-seal.ts — content fingerprints + tamper-evident provenance seals.
 *
 * Two independent integrity primitives:
 *
 *   1. CONTENT FINGERPRINT — a deterministic sha256 over a brick's source
 *      (line-ending normalized, order-independent). This is the brick's
 *      identity. If the same fingerprint shows up under a different owner or
 *      project, the code was copied — that is how theft becomes visible.
 *
 *   2. PROVENANCE SEAL — an append-only hash chain over the ordered provenance
 *      events, anchored to the content fingerprint. Editing history (to erase
 *      an author or forge a creator) breaks the chain: the recomputed head no
 *      longer matches the stored head. Optionally the head is signed with an
 *      ed25519 key so the chain cannot simply be recomputed by a forger.
 *
 * Trust note: the seal is tamper-EVIDENT, not tamper-PROOF. A repo-writer who
 * re-runs the ledger tool recomputes a consistent head; only an ed25519
 * signature verified against an OUT-OF-BAND pinned key, plus an external
 * transparency anchor (Rekor/OTS), makes it tamper-proof. See
 * sma-provenance-verify.mjs --trusted-keys and sma-anchor.mjs.
 *
 * All separators are the NUL byte via the explicit escape SEP ('\u0000') — git
 * fields and POSIX paths cannot contain NUL, so field framing is injective.
 */

import { createHash, sign as edSign, verify as edVerify, generateKeyPairSync, createPrivateKey, createPublicKey, type BinaryLike } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { basename, extname, resolve, relative, sep } from 'node:path';

const FINGERPRINT_ALGO = 'sha256-tree-v2';
const SEAL_ALGO = 'sha256-chain-v2';
const SEP = '\u0000';                       // explicit NUL — never a raw byte in source
const SIGN_CONTEXT = `sma-provenance-seal-v1${SEP}`; // domain-tag signed messages

interface ProvenanceEvent {
  actor_kind?: unknown;
  actor_id?: unknown;
  role?: unknown;
  timestamp?: unknown;
  commit?: unknown;
  summary?: unknown;
}

interface SealInput { brick_id?: string | null; content_hash?: string | null; events?: ProvenanceEvent[] }
interface ProvenanceSeal {
  algo: string;
  brick_id: string | null;
  anchor: string;
  head: string;
  chain_length: number;
  events_digest: string;
}

type StoredSeal = Partial<Pick<ProvenanceSeal, 'anchor' | 'head' | 'chain_length'>> | null | undefined;
interface FingerprintedFile { path: string; sha256: string; bytes: number }
type FingerprintFileResult =
  | { file: FingerprintedFile; failedPath: null }
  | { file: null; failedPath: string };
interface SourceFingerprint {
  algo: string;
  content_hash: string | null;
  resolved: boolean;
  file_count: number;
  byte_count: number;
  truncated: boolean;
  files?: FingerprintedFile[];
  failed_paths?: string[];
}

interface FingerprintOptions {
  includeFiles?: boolean;
  maxFiles?: number;
  /** Exact root-relative files/directories known to be generated and therefore out of scope. */
  excludedPaths?: readonly string[];
}

const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.conf', '.cpp', '.css', '.csv', '.env', '.go', '.h', '.hpp',
  '.html', '.ini', '.java', '.js', '.json', '.jsx', '.kt', '.lock', '.md',
  '.mjs', '.mts', '.php', '.properties', '.py', '.rb', '.rs', '.scss', '.sh',
  '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
]);
const TEXT_BASENAMES = new Set(['dockerfile', 'gemfile', 'makefile', 'procfile']);

function sha256(buf: BinaryLike): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Hash text with stable line endings and every other format byte-for-byte. */
function hashFileContent(absPath: string): string {
  const buf = readFileSync(absPath);
  const extension = extname(absPath).toLowerCase();
  const isText = TEXT_EXTENSIONS.has(extension) || TEXT_BASENAMES.has(basename(absPath).toLowerCase());
  let normalized = buf;
  if (isText && !buf.includes(0x00)) {
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      normalized = Buffer.from(decoded.replace(/\r\n?/g, '\n'), 'utf8');
    } catch {
      normalized = buf;
    }
  }
  return sha256(normalized);
}

function normalizedRelative(root: string, target: string): string {
  const rel = relative(root, target).split(sep).join('/');
  return rel || '.';
}

function exclusionSet(paths: readonly string[]): Set<string> {
  return new Set(paths.map((path) => path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')).filter(Boolean));
}

function isExplicitlyExcluded(rel: string, excluded: ReadonlySet<string>): boolean {
  for (const path of excluded) {
    if (rel === path || rel.startsWith(`${path}/`)) return true;
  }
  return false;
}

/** Collect every eligible file under root, sorted. Truncation (if any) drops
 *  the LAST files in sorted order — deterministic, not filesystem-traversal
 *  dependent, so an attacker cannot flood an early directory to push a target
 *  file out of the hashed set. */
function walkFiles(root: string, { maxFiles = 20000, excludedPaths = [] }: FingerprintOptions = {}): { files: string[]; truncated: boolean; failedPaths: string[] } {
  const out: string[] = [];
  const failedPaths: string[] = [];
  const excluded = exclusionSet(excludedPaths);
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      const failedPath = normalizedRelative(root, dir);
      failedPaths.push(failedPath);
      console.error(JSON.stringify({ area: 'provenance-seal.walk', severity: 'error', path: failedPath, hint: 'Fingerprint generation failed closed; restore read access before sealing.', error: error instanceof Error ? error.message : String(error) }));
      continue;
    }
    for (const entry of entries) {
      const absolute = resolve(dir, entry.name);
      const rel = normalizedRelative(root, absolute);
      if (isExplicitlyExcluded(rel, excluded)) continue;
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push(absolute);
    }
  }
  out.sort();
  const truncated = out.length > maxFiles;
  return { files: truncated ? out.slice(0, maxFiles) : out, truncated, failedPaths };
}

function fingerprintFile(file: string, base: string): FingerprintFileResult {
  const path = relative(base, file).split(sep).join('/');
  try {
    return { file: { path, sha256: hashFileContent(file), bytes: statSync(file).size }, failedPath: null };
  } catch (error) {
    console.error(JSON.stringify({ area: 'provenance-seal.fingerprint-file', severity: 'error', path, hint: 'Fingerprint generation failed closed; restore read access before sealing.', error: error instanceof Error ? error.message : String(error) }));
    return { file: null, failedPath: path };
  }
}

function sourceFiles(absPath: string, isFile: boolean, options: FingerprintOptions): { base: string; files: string[]; truncated: boolean; failedPaths: string[] } {
  if (isFile) return { base: resolve(absPath, '..'), files: [absPath], truncated: false, failedPaths: [] };
  const walked = walkFiles(absPath, options);
  return { base: absPath, files: walked.files, truncated: walked.truncated, failedPaths: walked.failedPaths };
}

function completeFingerprint(result: SourceFingerprint, includeFiles: boolean, files: FingerprintedFile[], failedPaths: string[]): SourceFingerprint {
  if (includeFiles) result.files = files;
  if (failedPaths.length) result.failed_paths = [...new Set(failedPaths)].sort();
  return result;
}

/**
 * Fingerprint a brick's source directory (or single file).
 * Returns { algo, content_hash, file_count, byte_count, truncated, files? }.
 * `content_hash` is order-independent: files are sorted by relative path.
 * `truncated` MUST be treated as a hard error by verifiers — a truncated
 * fingerprint only covers part of the source.
 */
export function fingerprintSource(absPath: string, { includeFiles = false, maxFiles = 20000, excludedPaths = [] }: FingerprintOptions = {}): SourceFingerprint {
  if (!absPath || !existsSync(absPath)) {
    return { algo: FINGERPRINT_ALGO, content_hash: null, resolved: false, file_count: 0, byte_count: 0, truncated: false };
  }
  let st;
  try {
    st = statSync(absPath);
  } catch (error) {
    console.error(JSON.stringify({ area: 'provenance-seal.stat', severity: 'error', path: absPath, hint: 'Fingerprint generation failed closed; restore read access before sealing.', error: error instanceof Error ? error.message : String(error) }));
    return { algo: FINGERPRINT_ALGO, content_hash: null, resolved: false, file_count: 0, byte_count: 0, truncated: false, failed_paths: [absPath] };
  }
  const source = sourceFiles(absPath, st.isFile(), { maxFiles, excludedPaths });
  const { base, files: fileList, truncated, failedPaths } = source;
  const perFile: FingerprintedFile[] = [];
  let byteCount = 0;
  let hashedFileCount = 0;
  const hasher = createHash('sha256');
  hasher.update(`${FINGERPRINT_ALGO}${SEP}`);
  for (const file of fileList) {
    const classified = fingerprintFile(file, base);
    if (!classified.file) {
      failedPaths.push(classified.failedPath);
      continue;
    }
    const { path, sha256: fileHash, bytes } = classified.file;
    byteCount += bytes;
    hashedFileCount += 1;
    hasher.update(`${path}${SEP}${fileHash}${SEP}`);
    if (includeFiles) perFile.push(classified.file);
  }

  const resolved = failedPaths.length === 0 && !truncated;
  const result: SourceFingerprint = {
    algo: FINGERPRINT_ALGO,
    content_hash: resolved ? hasher.digest('hex') : null,
    resolved,
    file_count: hashedFileCount,
    byte_count: byteCount,
    truncated,
  };
  return completeFingerprint(result, includeFiles, perFile, failedPaths);
}

// --- provenance seal (hash chain) ------------------------------------------

/** Canonicalize a touch/provenance event into the stable subset we chain over.
 *  NUL-separated so field boundaries are unambiguous. */
export function canonicalEvent(ev: ProvenanceEvent | null | undefined): string {
  if (!ev || typeof ev !== 'object') return '';
  const parts = [
    ev.actor_kind || '',
    ev.actor_id || '',
    ev.role || '',
    ev.timestamp || '',
    ev.commit || '',
    typeof ev.summary === 'string' ? ev.summary.trim() : '',
  ];
  return parts.join(SEP);
}

/**
 * Compute a provenance seal: an append-only hash chain anchored to the content
 * fingerprint. events is the ordered list [created_by, ...touched_by, ...reviewed_by].
 * Returns { algo, brick_id, anchor, head, chain_length, events_digest }.
 */
export function computeSeal({ brick_id, content_hash, events }: SealInput): ProvenanceSeal {
  if (typeof content_hash !== 'string' || !content_hash) {
    throw new Error('cannot seal without a resolved content fingerprint');
  }
  const anchor = sha256(`${SEAL_ALGO}${SEP}${brick_id || ''}${SEP}${content_hash || 'unresolved'}`);
  let head = anchor;
  const list = Array.isArray(events) ? events : [];
  for (const ev of list) {
    head = sha256(`${head}${SEP}${canonicalEvent(ev)}`);
  }
  return {
    algo: SEAL_ALGO,
    brick_id: brick_id || null,
    anchor,
    head,
    chain_length: list.length,
    events_digest: sha256(list.map(canonicalEvent).join(SEP)),
  };
}

/**
 * Verify a stored seal against freshly-recomputed events + fingerprint.
 * Returns { ok, reasons:[] } where reasons explains any tamper detected.
 */
export function verifySeal(stored: StoredSeal, { brick_id, content_hash, events }: SealInput) {
  const reasons: string[] = [];
  if (!stored || typeof stored !== 'object') {
    return { ok: false, reasons: ['no seal recorded'] };
  }
  if (typeof content_hash !== 'string' || !content_hash) {
    return { ok: false, reasons: ['source fingerprint is unresolved — seal cannot be verified'] };
  }
  const recomputed = computeSeal({ brick_id, content_hash, events });
  if (stored.anchor && stored.anchor !== recomputed.anchor) {
    reasons.push('content fingerprint changed since sealing (anchor mismatch) — source was modified');
  }
  if (stored.head !== recomputed.head) {
    reasons.push('provenance chain head mismatch — history was edited, reordered, or an author was removed');
  }
  if (typeof stored.chain_length === 'number' && stored.chain_length !== recomputed.chain_length) {
    reasons.push(`chain length changed (${stored.chain_length} -> ${recomputed.chain_length})`);
  }
  return { ok: reasons.length === 0, reasons, recomputed };
}

// --- ed25519 signing --------------------------------------------------------

/** Generate an ed25519 keypair (PEM strings) + a short key id. */
export function generateSealKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const key_id = sha256(publicPem).slice(0, 16);
  return { key_id, publicPem, privatePem };
}

/** Sign a seal head (domain-tagged) with an ed25519 private key PEM. Returns hex. */
export function signSealHead(head: string, privatePem: string): string {
  const keyObj = createPrivateKey(privatePem);
  return edSign(null, Buffer.from(`${SIGN_CONTEXT}${head}`, 'utf8'), keyObj).toString('hex');
}

/** Verify a hex signature over a domain-tagged seal head with an ed25519 public PEM. */
export function verifySealSignature(head: string, signatureHex: string, publicPem: string): boolean {
  try {
    const keyObj = createPublicKey(publicPem);
    return edVerify(null, Buffer.from(`${SIGN_CONTEXT}${head}`, 'utf8'), keyObj, Buffer.from(signatureHex, 'hex'));
  } catch (error) {
    console.error(JSON.stringify({ area: 'provenance-seal.verify-signature', severity: 'warning', hint: 'Check the public key and signature encoding.', error: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}

/** Short, stable id for a public key PEM (matches generateSealKeypair). */
export function publicKeyId(publicPem: string): string {
  return sha256(String(publicPem)).slice(0, 16);
}
