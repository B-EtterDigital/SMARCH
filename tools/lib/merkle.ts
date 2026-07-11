/**
 * WHAT: Builds and verifies a domain-separated binary Merkle tree over ordered brick provenance seals.
 * WHY: One anchored root must prove any brick without anchoring every record or revealing sibling content.
 * HOW: Callers hash brick identifiers and seal heads, build layers, derive proofs, and verify them against a root.
 * Leaf and internal-node prefixes prevent one kind of hash from being reinterpreted as the other.
 * Odd layers duplicate the final node; all functions are deterministic and perform no input or output operations.
 * Merkle terminology is defined in docs/GLOSSARY.md.
 * @example node --input-type=module -e "import { leafHash, buildMerkle } from './tools/lib/merkle.ts'; console.log(buildMerkle([leafHash('demo', 'seal')]).root)"
 */
/**
 * merkle.ts — a domain-separated binary Merkle tree over brick seals.
 *
 * One Merkle ROOT commits to every brick's provenance seal at once, so a single
 * external anchor (Sigstore/Rekor, OpenTimestamps, Solana, …) timestamps the
 * whole ledger. Any individual brick is then proven against that root with a
 * small inclusion proof — no need to anchor 3,148 things, and no need to reveal
 * any other brick (privacy: proofs disclose sibling hashes, never content).
 *
 * Domain separation: leaves are prefixed 'leaf\0', internal nodes 'node\0', so
 * a node hash can never be reinterpreted as a leaf (second-preimage defense).
 * Odd layers duplicate the last node (Bitcoin-style). Pure + deterministic.
 */

import { createHash } from 'node:crypto';

type MerkleProofStep = { hash: string; side: 'left' | 'right' };
type MerkleTree = { root: string; layers: string[][] };

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Leaf hash binds a brick id to its seal head. */
export function leafHash(brickId: string, sealHead: string): string {
  return sha256(`leaf\0${brickId || ''}\0${sealHead || ''}`);
}

function nodeHash(a: string, b: string): string {
  return sha256(`node\0${a}\0${b}`);
}

/**
 * Build a Merkle tree from ordered leaf hashes.
 * Returns { root, layers } where layers[0] === leaves and the last layer is [root].
 */
export function buildMerkle(leaves: readonly string[]): MerkleTree {
  if (!leaves || !leaves.length) return { root: sha256('empty\0'), layers: [[]] };
  const layers = [leaves.slice()];
  while ((layers.at(-1)?.length ?? 0) > 1) {
    const prev = layers.at(-1) ?? [];
    const next: string[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      const a = prev[i];
      const b = i + 1 < prev.length ? prev[i + 1] : prev[i]; // duplicate last if odd
      if (a && b) next.push(nodeHash(a, b));
    }
    layers.push(next);
  }
  return { root: layers.at(-1)?.[0] ?? sha256('empty\0'), layers };
}

/**
 * Inclusion proof for the leaf at `index`: an ordered list of
 * { hash, side } siblings from leaf up to (but excluding) the root.
 */
export function inclusionProof(layers: readonly (readonly string[])[], index: number): MerkleProofStep[] {
  const proof: MerkleProofStep[] = [];
  let idx = index;
  for (let l = 0; l < layers.length - 1; l += 1) {
    const layer = layers[l];
    if (!layer) continue;
    const isRight = idx % 2 === 1;
    const sibIdx = isRight ? idx - 1 : (idx + 1 < layer.length ? idx + 1 : idx);
    const sibling = layer[sibIdx];
    if (sibling) proof.push({ hash: sibling, side: isRight ? 'left' : 'right' });
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/** Low-level: verify a leaf + proof reproduce the root. Callers MUST have
 *  derived `leaf` themselves via leafHash — passing an untrusted leaf lets a
 *  caller "prove" an internal node. Prefer verifyBrickInclusion below. */
export function verifyProof(leaf: string, proof: readonly MerkleProofStep[], root: string): boolean {
  let h = leaf;
  for (const step of proof) {
    h = step.side === 'left' ? nodeHash(step.hash, h) : nodeHash(h, step.hash);
  }
  return h === root;
}

/** Safe inclusion check: re-derives the leaf from (brickId, sealHead) so an
 *  attacker cannot substitute an internal-node hash as the "leaf". This is the
 *  entry point external verifiers should use. */
export function verifyBrickInclusion(brickId: string, sealHead: string, proof: readonly MerkleProofStep[], root: string): boolean {
  return verifyProof(leafHash(brickId, sealHead), proof, root);
}

export { sha256 as _sha256 };
