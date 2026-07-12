import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  _sha256,
  buildMerkle,
  inclusionProof,
  leafHash,
  verifyBrickInclusion,
  verifyProof,
} from "../lib/merkle.ts";
import {
  canonicalEvent,
  computeSeal,
  fingerprintSource,
  generateSealKeypair,
  publicKeyId,
  signSealHead,
  verifySeal,
  verifySealSignature,
} from "../lib/provenance-seal.ts";

test("Merkle proofs handle empty, singleton, odd, and out-of-range trees", () => {
  const empty = buildMerkle([]);
  assert.deepEqual(empty.layers, [[]]);
  assert.equal(empty.root, _sha256("empty\0"));
  assert.deepEqual(inclusionProof(empty.layers, 0), []);

  const singletonLeaf = leafHash("only", "head");
  const singleton = buildMerkle([singletonLeaf]);
  assert.equal(singleton.root, singletonLeaf);
  assert.deepEqual(inclusionProof(singleton.layers, 0), []);
  assert.equal(verifyBrickInclusion("only", "head", [], singleton.root), true);

  const leaves = ["a", "b", "c"].map((id) => leafHash(id, `head-${id}`));
  const odd = buildMerkle(leaves);
  const lastProof = inclusionProof(odd.layers, 2);
  assert.equal(lastProof[0].hash, leaves[2]);
  assert.equal(lastProof[0].side, "right");
  assert.equal(verifyProof(leaves[2], lastProof, odd.root), true);
  assert.equal(verifyProof(leafHash("missing", "head"), inclusionProof(odd.layers, 99), odd.root), false);
});

test("Merkle verification rejects altered sibling hashes, sides, order, and identity", () => {
  const leaves = [0, 1, 2, 3, 4].map((id) => leafHash(`brick-${id}`, `head-${id}`));
  const tree = buildMerkle(leaves);
  const proof = inclusionProof(tree.layers, 3);
  assert.equal(verifyBrickInclusion("brick-3", "head-3", proof, tree.root), true);
  assert.equal(verifyProof(leaves[3], [{ ...proof[0], hash: "0".repeat(64) }, ...proof.slice(1)], tree.root), false);
  assert.equal(verifyProof(leaves[3], [{ ...proof[0], side: proof[0].side === "left" ? "right" : "left" }, ...proof.slice(1)], tree.root), false);
  assert.equal(verifyProof(leaves[3], [...proof].reverse(), tree.root), false);
  assert.equal(verifyBrickInclusion("brick-3", "tampered", proof, tree.root), false);
  assert.notEqual(leafHash("node", "payload"), _sha256("node\0node\0payload"));
});

test("source fingerprints expose truncation, ignore media, and hash binary changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-seal-fingerprint-"));
  try {
    await writeFile(path.join(root, "a.ts"), "export const a = 1;\r\n");
    await writeFile(path.join(root, "b.bin"), Buffer.from([0, 1, 2]));
    await writeFile(path.join(root, "ignored.png"), "not source");
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "c.ts"), "export const c = 3;\n");
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "node_modules", "hidden.js"), "ignored");
    const first = fingerprintSource(root, { includeFiles: true, maxFiles: 1 });
    assert.equal(first.resolved, true);
    assert.equal(first.file_count, 1);
    assert.equal(first.truncated, true);
    assert.ok(first.files);
    assert.deepEqual(first.files.map((entry) => entry.path), ["a.ts"]);
    const complete = fingerprintSource(root, { includeFiles: true });
    assert.ok(complete.files);
    assert.deepEqual(complete.files.map((entry) => entry.path), ["a.ts", "b.bin", "nested/c.ts"]);
    await writeFile(path.join(root, "b.bin"), Buffer.from([0, 1, 3]));
    assert.notEqual(fingerprintSource(root).content_hash, complete.content_hash);
    const single = fingerprintSource(path.join(root, "a.ts"), { includeFiles: true });
    assert.equal(single.file_count, 1);
    assert.deepEqual(single.files?.map((entry) => entry.path), ["a.ts"]);
    assert.deepEqual(fingerprintSource(path.join(root, "missing")), {
      algo: "sha256-tree-v2", content_hash: null, resolved: false, file_count: 0, byte_count: 0, truncated: false,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source fingerprinting skips unreadable subtrees and files with a warning", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-seal-unreadable-"));
  const deniedDir = path.join(root, "denied");
  const deniedFile = path.join(root, "denied-file.ts");
  /** @type {string[]} */
  const errors = [];
  const originalError = console.error;
  try {
    await mkdir(deniedDir);
    await writeFile(path.join(deniedDir, "hidden.ts"), "hidden\n");
    await writeFile(deniedFile, "denied\n");
    await chmod(deniedDir, 0o000);
    await chmod(deniedFile, 0o000);
    console.error = (message) => errors.push(String(message));
    const result = fingerprintSource(root, { includeFiles: true });
    assert.equal(result.resolved, true);
    assert.ok(errors.some((message) => /provenance-seal\.(walk|fingerprint-file)/.test(message)));
  } finally {
    console.error = originalError;
    await chmod(deniedDir, 0o700).catch(() => {});
    await chmod(deniedFile, 0o600).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("seal verification reports anchor, history, and length tampering independently", () => {
  const events = [
    { actor_kind: "human", actor_id: "alice", role: "creator", timestamp: "2026-01-01T00:00:00Z", commit: "a", summary: " create " },
    { actor_kind: "agent", actor_id: "bot", role: "reviewer", timestamp: "2026-01-02T00:00:00Z", commit: "b", summary: "verify" },
  ];
  assert.equal(canonicalEvent(null), "");
  assert.equal(canonicalEvent(events[0]), canonicalEvent({ ...events[0], summary: "create" }));
  const seal = computeSeal({ brick_id: "brick", content_hash: "content", events });
  assert.equal(verifySeal(null, { brick_id: "brick", content_hash: "content", events }).reasons[0], "no seal recorded");

  const contentTamper = verifySeal(seal, { brick_id: "brick", content_hash: "changed", events });
  assert.equal(contentTamper.ok, false);
  assert.match(contentTamper.reasons.join("\n"), /anchor mismatch/);
  assert.match(contentTamper.reasons.join("\n"), /chain head mismatch/);

  const historyTamper = verifySeal(seal, { brick_id: "brick", content_hash: "content", events: [...events].reverse() });
  assert.deepEqual(historyTamper.reasons, ["provenance chain head mismatch — history was edited, reordered, or an author was removed"]);
  const lengthTamper = verifySeal({ ...seal, chain_length: 99 }, { brick_id: "brick", content_hash: "content", events });
  assert.deepEqual(lengthTamper.reasons, ["chain length changed (99 -> 2)"]);
  const headTamper = verifySeal({ ...seal, head: "forged" }, { brick_id: "brick", content_hash: "content", events });
  assert.match(headTamper.reasons[0], /chain head mismatch/);
});

test("seal signatures reject wrong heads, wrong keys, and malformed material", () => {
  const first = generateSealKeypair();
  const second = generateSealKeypair();
  const signature = signSealHead("head-a", first.privatePem);
  assert.equal(publicKeyId(first.publicPem), first.key_id);
  assert.equal(verifySealSignature("head-a", signature, first.publicPem), true);
  assert.equal(verifySealSignature("head-b", signature, first.publicPem), false);
  assert.equal(verifySealSignature("head-a", signature, second.publicPem), false);
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(verifySealSignature("head-a", "not-hex", "not-a-key"), false);
  } finally {
    console.error = originalError;
  }
});
