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
import { resolve, relative, sep } from 'node:path';

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
interface SourceFingerprint {
  algo: string;
  content_hash: string | null;
  resolved: boolean;
  file_count: number;
  byte_count: number;
  truncated: boolean;
  files?: FingerprintedFile[];
}

const IGNORE_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.turbo',
  '.venv', '__pycache__', '.cache', 'out', '.output', 'vendor',
]);
// Skip ONLY non-executable media/binaries that cannot carry code or supply-chain
// intent. Crucially we now HASH .min.js/.map/.wasm and lockfiles: a brick can be
// backdoored through a bundled/minified/wasm artifact or a lockfile dependency
// pivot, and that must change the brick's identity.
const IGNORE_FILE = /(\.png|\.jpe?g|\.gif|\.webp|\.ico|\.svg|\.bmp|\.avif|\.woff2?|\.ttf|\.otf|\.eot|\.mp4|\.mov|\.webm|\.mp3|\.wav|\.flac|\.pdf|\.zip|\.gz|\.tar|\.tgz|\.7z|\.rar|\.jar)$/i;

function sha256(buf: BinaryLike): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Hash a single file's content with line endings normalized to LF. */
function hashFileContent(absPath: string): string {
  const buf = readFileSync(absPath);
  // Normalize CRLF/CR -> LF so a pure line-ending change is not a new identity.
  const normalized = buf.includes(0x00)
    ? buf // binary: hash raw bytes
    : Buffer.from(buf.toString('utf8').replace(/\r\n?/g, '\n'), 'utf8');
  return sha256(normalized);
}

/** Collect every eligible file under root, sorted. Truncation (if any) drops
 *  the LAST files in sorted order — deterministic, not filesystem-traversal
 *  dependent, so an attacker cannot flood an early directory to push a target
 *  file out of the hashed set. */
function walkFiles(root: string, { maxFiles = 20000 }: { maxFiles?: number } = {}): { files: string[]; truncated: boolean } {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      console.error(JSON.stringify({ area: 'provenance-seal.walk', severity: 'warning', hint: 'Check the source directory and its permissions.', error: error instanceof Error ? error.message : String(error) }));
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        stack.push(resolve(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (IGNORE_FILE.test(entry.name)) continue;
      out.push(resolve(dir, entry.name));
    }
  }
  out.sort();
  const truncated = out.length > maxFiles;
  return { files: truncated ? out.slice(0, maxFiles) : out, truncated };
}

/**
 * Fingerprint a brick's source directory (or single file).
 * Returns { algo, content_hash, file_count, byte_count, truncated, files? }.
 * `content_hash` is order-independent: files are sorted by relative path.
 * `truncated` MUST be treated as a hard error by verifiers — a truncated
 * fingerprint only covers part of the source.
 */
export function fingerprintSource(absPath: string, { includeFiles = false, maxFiles = 20000 }: { includeFiles?: boolean; maxFiles?: number } = {}): SourceFingerprint {
  if (!absPath || !existsSync(absPath)) {
    return { algo: FINGERPRINT_ALGO, content_hash: null, resolved: false, file_count: 0, byte_count: 0, truncated: false };
  }
  const st = statSync(absPath);
  let fileList: string[];
  let truncated = false;
  if (st.isFile()) {
    fileList = [absPath];
  } else {
    const walked = walkFiles(absPath, { maxFiles });
    fileList = walked.files;
    truncated = walked.truncated;
  }

  const base = st.isFile() ? resolve(absPath, '..') : absPath;
  const perFile: FingerprintedFile[] = [];
  let byteCount = 0;
  const hasher = createHash('sha256');
  hasher.update(`${FINGERPRINT_ALGO}${SEP}`);
  for (const file of fileList) {
    const rel = relative(base, file).split(sep).join('/');
    let fileHash;
    let bytes = 0;
    try {
      fileHash = hashFileContent(file);
      bytes = statSync(file).size;
    } catch (error) {
      console.error(JSON.stringify({ area: 'provenance-seal.fingerprint-file', severity: 'warning', hint: 'Check the source file and its permissions.', error: error instanceof Error ? error.message : String(error) }));
      continue;
    }
    byteCount += bytes;
    hasher.update(`${rel}${SEP}${fileHash}${SEP}`);
    if (includeFiles) perFile.push({ path: rel, sha256: fileHash, bytes });
  }

  const result: SourceFingerprint = {
    algo: FINGERPRINT_ALGO,
    content_hash: hasher.digest('hex'),
    resolved: true,
    file_count: fileList.length,
    byte_count: byteCount,
    truncated,
  };
  if (includeFiles) result.files = perFile;
  return result;
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
