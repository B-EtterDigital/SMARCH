/**
 * WHAT: Loads and verifies immutable content-addressed release snapshots for clone installs.
 * WHY: A requested historical release must never resolve back to mutable registry or source content.
 * HOW: Verifies descriptor identity, seal, manifest hash, artifact paths, and payload hashes before returning a synthetic registry.
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizedRelativePath, resolveContainedSource } from "./secure-clone-transaction.ts";

interface ReleaseSnapshot {
  schema_version?: string;
  artifact_id?: string;
  version?: string;
  content_hash?: string;
  manifest?: { path?: string; sha256?: string };
  artifacts?: { path?: string; kind?: string; sha256?: string }[];
  seal?: { algorithm?: string; value?: string };
}

interface SnapshotRegistry {
  bricks: {
    id: string; name: string; project: string; status: string; kind: string;
    manifest_path: string; source_paths: string[]; version: string;
  }[];
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  return sha256(await fs.readFile(filePath));
}

async function directoryDigest(root: string): Promise<string> {
  const files: { path: string; sha256: string }[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`release snapshot contains a symlink: ${absolute}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push({ path: path.relative(root, absolute).split(path.sep).join("/"), sha256: await sha256File(absolute) });
      else throw new Error(`release snapshot contains an unsupported entry: ${absolute}`);
    }
  }
  await walk(root);
  return sha256(JSON.stringify(files));
}

async function verifySnapshotPath(root: string, relative: unknown, expectedHash: unknown, label: string): Promise<string> {
  const absolute = await resolveContainedSource(root, relative, label);
  const stat = await fs.lstat(absolute);
  const actual = stat.isDirectory() ? await directoryDigest(absolute) : await sha256File(absolute);
  if (typeof expectedHash !== "string" || actual !== expectedHash) throw new Error(`${label} hash mismatch`);
  return absolute;
}

export async function loadReleaseSnapshot(snapshotPath: string, requestedBrick: string): Promise<{ registry: SnapshotRegistry; sourceRoot: string; snapshot: ReleaseSnapshot }> {
  const snapshotRoot = await fs.realpath(path.dirname(snapshotPath));
  const canonicalSnapshot = await resolveContainedSource(snapshotRoot, path.basename(snapshotPath), "release snapshot descriptor");
  const snapshot = JSON.parse(await fs.readFile(canonicalSnapshot, "utf8")) as ReleaseSnapshot;
  if (!snapshot.artifact_id || snapshot.artifact_id !== requestedBrick) throw new Error("release snapshot artifact_id does not match --brick");
  if (!snapshot.version || !snapshot.content_hash) throw new Error("release snapshot identity is incomplete");
  const sealInput = { ...snapshot };
  delete sealInput.seal;
  if (snapshot.seal?.algorithm !== "sha256" || snapshot.seal.value !== sha256(JSON.stringify(sealInput))) throw new Error("release snapshot seal mismatch");
  const manifestRelative = normalizedRelativePath(snapshot.manifest?.path, "release snapshot manifest path");
  const manifestPath = await verifySnapshotPath(snapshotRoot, manifestRelative, snapshot.manifest?.sha256, "release snapshot manifest");
  const sourceRoot = await fs.realpath(path.join(snapshotRoot, "payload"));
  const sourcePaths: string[] = [];
  for (const artifact of snapshot.artifacts ?? []) {
    const artifactPath = normalizedRelativePath(artifact.path, "release snapshot artifact path");
    await verifySnapshotPath(sourceRoot, artifactPath, artifact.sha256, `release snapshot artifact ${artifactPath}`);
    sourcePaths.push(artifactPath);
  }
  if (sourcePaths.length === 0) throw new Error("release snapshot has no artifacts");
  return {
    sourceRoot,
    snapshot,
    registry: { bricks: [{ id: snapshot.artifact_id, name: snapshot.artifact_id, project: "release-snapshot", status: "canonical", kind: "module", manifest_path: manifestPath, source_paths: sourcePaths, version: snapshot.version }] },
  };
}
