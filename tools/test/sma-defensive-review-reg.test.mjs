import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installRelease, StoreInstallRefusedError } from "../sma-store.ts";
import { SecureCloneTransaction } from "../lib/secure-clone-transaction.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");

/** @param {crypto.BinaryLike} value */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * @param {string} tool
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv}} [options]
 */
function runTool(tool, args, options = {}) {
  return spawnSync("node", [path.join(repoRoot, "tools", tool), ...args], {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

/** @param {string} root @param {string[]} sourcePaths */
async function writeCloneFixture(root, sourcePaths) {
  const source = path.join(root, "source");
  const manifest = path.join(source, "module.sweetspot.json");
  const registry = path.join(root, "registry.json");
  await mkdir(source, { recursive: true });
  await writeFile(manifest, `${JSON.stringify({
    schema_version: "1.0.0",
    brick: { id: "fixture.brick", version: "1.0.0" },
    source: { paths: sourcePaths, project: "fixture" },
    semantics: { purpose: "security regression fixture" },
  }, null, 2)}\n`);
  await writeFile(registry, `${JSON.stringify({
    bricks: [{
      id: "fixture.brick",
      name: "Fixture Brick",
      project: "fixture",
      status: "canonical",
      kind: "module",
      version: "1.0.0",
      manifest_path: manifest,
      source_paths: sourcePaths,
    }],
  }, null, 2)}\n`);
  return { source, manifest, registry };
}

/**
 * @param {string} root
 * @param {{brick?: string, version?: string, contentHash?: string}} [options]
 */
async function writeRelease(root, { brick = "fixture.brick", version = "1.0.0", contentHash = "b".repeat(64) } = {}) {
  const releaseDir = path.join(root, "releases", brick);
  await mkdir(releaseDir, { recursive: true });
  await writeFile(path.join(releaseDir, `${version}.json`), `${JSON.stringify({
    release: { artifact_id: brick, version, status: "published", content_hash: contentHash },
    content: { artifacts: [{ path: "src/payload.txt", kind: "file", sha256: sha256("immutable release payload\n") }] },
  }, null, 2)}\n`);
  return { brick, version, contentHash };
}

/**
 * @param {string} root
 * @param {{brick: string, version: string, contentHash: string}} release
 */
async function writeSnapshot(root, release) {
  const snapshotRoot = path.join(root, "releases", ".artifacts", release.contentHash);
  const payload = "immutable release payload\n";
  const manifest = `${JSON.stringify({
    schema_version: "1.0.0",
    brick: { id: release.brick, version: release.version },
    source: { paths: ["src/payload.txt"], project: "fixture" },
    semantics: { purpose: "immutable release fixture" },
  }, null, 2)}\n`;
  const descriptor = {
    schema_version: "1.0.0",
    artifact_id: release.brick,
    version: release.version,
    content_hash: release.contentHash,
    manifest: { path: "manifest.json", sha256: sha256(manifest) },
    artifacts: [{ path: "src/payload.txt", kind: "file", sha256: sha256(payload) }],
  };
  const sealed = { ...descriptor, seal: { algorithm: "sha256", value: sha256(JSON.stringify(descriptor)) } };
  await mkdir(path.join(snapshotRoot, "payload", "src"), { recursive: true });
  await writeFile(path.join(snapshotRoot, "manifest.json"), manifest);
  await writeFile(path.join(snapshotRoot, "payload", "src", "payload.txt"), payload);
  await writeFile(path.join(snapshotRoot, "snapshot.json"), `${JSON.stringify(sealed, null, 2)}\n`);
  return path.join(snapshotRoot, "snapshot.json");
}

test("scan preserves schema validation diagnostics without a misleading scan failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sma-scan-invalid-"));
  try {
    const project = path.join(root, "project");
    const out = path.join(root, "registry.json");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "package.json"), '{"name":"invalid-project"}\n');
    await writeFile(path.join(project, "module.sweetspot.json"), '{"schema_version":"1.0.0","brick":{"id":"invalid.brick"}}\n');
    const result = runTool("sma-scan.ts", ["--root", root, "--out", out, "--force"]);
    assert.equal(result.status, 0, result.stderr);
    const registry = JSON.parse(await readFile(out, "utf8"));
    assert.equal(registry.failure_count, 0);
    assert.ok(registry.validation_error_count > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clone rejects traversal source paths before resolving source or destination", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sma-clone-traversal-"));
  try {
    const { registry } = await writeCloneFixture(root, ["../secret.txt"]);
    await writeFile(path.join(root, "secret.txt"), "secret\n");
    const target = path.join(root, "target");
    const result = runTool("sma-clone.ts", ["--registry", registry, "--brick", "fixture.brick", "--target", target]);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /relative path|traversal|outside/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clone rejects a symlinked target parent immediately before promotion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sma-clone-target-symlink-"));
  try {
    const { source, registry } = await writeCloneFixture(root, ["linked/payload.txt"]);
    await mkdir(path.join(source, "linked"), { recursive: true });
    await writeFile(path.join(source, "linked", "payload.txt"), "payload\n");
    const target = path.join(root, "target");
    const outside = path.join(root, "outside");
    await mkdir(target, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(target, "linked"), "dir");
    const result = runTool("sma-clone.ts", ["--registry", registry, "--brick", "fixture.brick", "--target", target, "--write", "--force", "--allow-closed"]);
    assert.notEqual(result.status, 0);
    await assert.rejects(readFile(path.join(outside, "payload.txt"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clone transaction serializes concurrent writers for one target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sma-clone-lock-"));
  try {
    const target = path.join(root, "target");
    const first = await SecureCloneTransaction.create(target, "a".repeat(64));
    await assert.rejects(SecureCloneTransaction.create(target, "b".repeat(64)), /locked/);
    await first.abort();
    const next = await SecureCloneTransaction.create(target, "c".repeat(64));
    await next.abort();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store refuses a version that has no immutable content-addressed snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sma-store-snapshot-missing-"));
  try {
    const release = await writeRelease(root);
    assert.throws(
      () => installRelease({ root, ...release, target: path.join(root, "target"), logger: null, runClone: () => ({ status: 0, stdout: "{}" }) }),
      (error) => error instanceof StoreInstallRefusedError && error.details.reason === "immutable-artifact-missing",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store binds one write invocation to the verified immutable snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sma-store-single-apply-"));
  try {
    const release = await writeRelease(root);
    const snapshot = await writeSnapshot(root, release);
    /** @type {string[][]} */
    const calls = [];
    const result = installRelease({
      root,
      ...release,
      target: path.join(root, "target"),
      write: true,
      logger: null,
      runClone: (cloneArgs) => {
        calls.push(cloneArgs);
        return { status: 0, stdout: JSON.stringify({ plan: { actions: [], control_plane: {}, plan_hash: "c".repeat(64) }, applied_plan_hash: "c".repeat(64) }) };
      },
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("--write"));
    assert.deepEqual(calls[0].slice(calls[0].indexOf("--release-snapshot"), calls[0].indexOf("--release-snapshot") + 2), ["--release-snapshot", snapshot]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("store installs the sealed historical payload instead of mutable registry content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sma-store-historical-"));
  try {
    const release = await writeRelease(root);
    await writeSnapshot(root, release);
    const target = path.join(root, "target");
    const result = installRelease({
      root,
      ...release,
      target,
      write: true,
      logger: null,
      runClone: (cloneArgs) => {
        const spawned = spawnSync("node", [path.join(repoRoot, "tools", "sma-clone.ts"), ...cloneArgs.slice(1)], { encoding: "utf8" });
        if (spawned.status !== 0) throw new Error(String(spawned.stderr));
        return spawned;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(await readFile(path.join(target, "src", "payload.txt"), "utf8"), "immutable release payload\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("clone restores overwritten destinations when a later promotion fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sma-clone-rollback-"));
  try {
    const { source, registry } = await writeCloneFixture(root, ["a.txt", "z/payload.txt"]);
    await mkdir(path.join(source, "z"), { recursive: true });
    await writeFile(path.join(source, "a.txt"), "new payload\n");
    await writeFile(path.join(source, "z", "payload.txt"), "late payload\n");
    const target = path.join(root, "target");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "a.txt"), "original payload\n");
    await writeFile(path.join(target, "z"), "blocking parent\n");
    const result = runTool("sma-clone.ts", ["--registry", registry, "--brick", "fixture.brick", "--target", target, "--write", "--force", "--allow-closed"]);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(path.join(target, "a.txt"), "utf8"), "original payload\n");
    assert.equal(await readFile(path.join(target, "z"), "utf8"), "blocking parent\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
