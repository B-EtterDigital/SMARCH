/**
 * WHAT: Validates clone paths and stages target writes as a rollback-capable transaction.
 * WHY: Registry and manifest paths are untrusted, and sequential clone writes can escape or leave partial installs.
 * HOW: Rejects non-relative paths and symlinks, stages verified files off-target, then promotes with backups.
 */
import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

const ignoredDirectories = new Set(["node_modules", "dist", "build", ".next", ".turbo"]);

export function normalizedRelativePath(value: unknown, label = "path"): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw new Error(`${label} must be a non-empty relative path`);
  if (path.isAbsolute(raw) || path.win32.isAbsolute(raw)) throw new Error(`${label} must be a relative path: ${raw}`);
  const segments = raw.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => segment === "..")) throw new Error(`${label} contains traversal: ${raw}`);
  const normalized = path.posix.normalize(segments.filter((segment) => segment && segment !== ".").join("/"));
  if (!normalized || normalized === "." || normalized.startsWith("../")) throw new Error(`${label} must stay inside its root: ${raw}`);
  return normalized;
}

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function assertNoSymlinkPath(root: string, candidate: string, includeLeaf: boolean): Promise<void> {
  if (!isContainedPath(root, candidate)) throw new Error(`path resolves outside root: ${candidate}`);
  const relative = path.relative(root, candidate);
  const segments = relative.split(path.sep).filter(Boolean);
  const checked = includeLeaf ? segments : segments.slice(0, -1);
  let cursor = root;
  for (const segment of checked) {
    cursor = path.join(cursor, segment);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error(`symlink path component is not allowed: ${cursor}`);
      if (!stat.isDirectory() && cursor !== candidate) throw new Error(`non-directory path component: ${cursor}`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export async function resolveContainedSource(root: string, value: unknown, label = "source path"): Promise<string> {
  const relative = normalizedRelativePath(value, label);
  const canonicalRoot = await fs.realpath(root);
  const candidate = path.resolve(canonicalRoot, relative);
  if (!isContainedPath(canonicalRoot, candidate)) throw new Error(`${label} resolves outside source root: ${String(value)}`);
  await assertNoSymlinkPath(canonicalRoot, candidate, true);
  const canonicalCandidate = await fs.realpath(candidate);
  if (!isContainedPath(canonicalRoot, canonicalCandidate)) throw new Error(`${label} resolves outside source root: ${String(value)}`);
  return canonicalCandidate;
}

export function resolveContainedDestination(root: string, value: unknown, label = "target path"): string {
  const relative = normalizedRelativePath(value, label);
  const candidate = path.resolve(root, relative);
  if (!isContainedPath(path.resolve(root), candidate)) throw new Error(`${label} resolves outside target root: ${String(value)}`);
  return candidate;
}

function digest(value: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

interface StagedEntry { relative: string; staged: string; mode?: number }

export class SecureCloneTransaction {
  readonly targetRoot: string;
  readonly planHash: string;
  readonly transactionRoot: string;
  private readonly stageRoot: string;
  private readonly backupRoot: string;
  private readonly lockPath: string;
  private readonly lockHandle: FileHandle;
  private readonly entries = new Map<string, StagedEntry>();
  private completed = false;

  private constructor(targetRoot: string, planHash: string, transactionRoot: string, lockPath: string, lockHandle: FileHandle) {
    this.targetRoot = targetRoot;
    this.planHash = planHash;
    this.transactionRoot = transactionRoot;
    this.stageRoot = path.join(transactionRoot, "stage");
    this.backupRoot = path.join(transactionRoot, "backup");
    this.lockPath = lockPath;
    this.lockHandle = lockHandle;
  }

  static async create(targetRoot: string, planHash: string): Promise<SecureCloneTransaction> {
    const resolvedTarget = path.resolve(targetRoot);
    await fs.mkdir(resolvedTarget, { recursive: true });
    const canonicalTarget = await fs.realpath(resolvedTarget);
    const lockPath = path.join(path.dirname(canonicalTarget), `.${path.basename(canonicalTarget)}.sma-clone.lock`);
    let lockHandle: FileHandle;
    try {
      lockHandle = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, plan_hash: planHash, target: canonicalTarget })}\n`, "utf8");
    } catch (error: unknown) {
      throw new Error(`clone target is locked: ${lockPath}`, { cause: error });
    }
    let transactionRoot: string;
    try {
      transactionRoot = await fs.mkdtemp(path.join(path.dirname(canonicalTarget), ".sma-clone-txn-"));
    } catch (error: unknown) {
      await lockHandle.close();
      await fs.rm(lockPath, { force: true });
      throw error;
    }
    const transaction = new SecureCloneTransaction(canonicalTarget, planHash, transactionRoot, lockPath, lockHandle);
    await fs.mkdir(transaction.stageRoot, { recursive: true });
    await fs.mkdir(transaction.backupRoot, { recursive: true });
    await fs.writeFile(path.join(transactionRoot, "transaction.json"), `${JSON.stringify({ plan_hash: planHash, target: canonicalTarget, status: "staging" }, null, 2)}\n`);
    return transaction;
  }

  private relativeDestination(destination: string): string {
    const absolute = path.resolve(destination);
    if (!isContainedPath(this.targetRoot, absolute)) throw new Error(`write destination resolves outside target: ${destination}`);
    const relative = normalizedRelativePath(path.relative(this.targetRoot, absolute), "write destination");
    return relative;
  }

  private async stagedPath(destination: string): Promise<{ relative: string; staged: string }> {
    const relative = this.relativeDestination(destination);
    const staged = path.join(this.stageRoot, relative);
    await fs.mkdir(path.dirname(staged), { recursive: true });
    return { relative, staged };
  }

  async stageFile(source: string, destination: string): Promise<void> {
    const sourceStat = await fs.lstat(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`clone source must be a regular non-symlink file: ${source}`);
    const { relative, staged } = await this.stagedPath(destination);
    await fs.copyFile(source, staged);
    if (digest(await fs.readFile(source)) !== digest(await fs.readFile(staged))) throw new Error(`staged file hash mismatch: ${relative}`);
    this.entries.set(relative, { relative, staged, mode: sourceStat.mode });
  }

  async stageDirectory(source: string, destination: string): Promise<void> {
    const sourceStat = await fs.lstat(source);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error(`clone source must be a regular non-symlink directory: ${source}`);
    const entries = await fs.readdir(source, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error(`symlink clone source is not allowed: ${path.join(source, entry.name)}`);
      if (entry.isDirectory()) {
        if (ignoredDirectories.has(entry.name)) continue;
        await this.stageDirectory(path.join(source, entry.name), path.join(destination, entry.name));
      } else if (entry.isFile()) {
        await this.stageFile(path.join(source, entry.name), path.join(destination, entry.name));
      }
    }
  }

  async stageText(destination: string, value: string): Promise<void> {
    const { relative, staged } = await this.stagedPath(destination);
    await fs.writeFile(staged, value, "utf8");
    this.entries.set(relative, { relative, staged });
  }

  async stageAppend(destination: string, value: string): Promise<void> {
    const { relative, staged } = await this.stagedPath(destination);
    let current = "";
    const existing = this.entries.get(relative);
    if (existing) current = await fs.readFile(existing.staged, "utf8");
    else {
      try {
        const stat = await fs.lstat(destination);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`append destination must be a regular non-symlink file: ${destination}`);
        current = await fs.readFile(destination, "utf8");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await fs.writeFile(staged, `${current}${value}`, "utf8");
    this.entries.set(relative, { relative, staged });
  }

  private async createSafeParents(destination: string): Promise<void> {
    const relative = this.relativeDestination(destination);
    const segments = relative.split(path.sep).slice(0, -1);
    let cursor = this.targetRoot;
    for (const segment of segments) {
      cursor = path.join(cursor, segment);
      try {
        const stat = await fs.lstat(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe target parent: ${cursor}`);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await fs.mkdir(cursor);
      }
    }
  }

  private async openSafeParent(destination: string): Promise<{ handle: FileHandle; descriptorDestination: string }> {
    const relative = this.relativeDestination(destination);
    const segments = relative.split(path.sep);
    const fileName = segments.pop();
    if (!fileName) throw new Error(`write destination has no filename: ${destination}`);
    let handle = await fs.open(this.targetRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const segment of segments) {
        const next = await fs.open(`/proc/self/fd/${String(handle.fd)}/${segment}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        await handle.close();
        handle = next;
      }
      return { handle, descriptorDestination: `/proc/self/fd/${String(handle.fd)}/${fileName}` };
    } catch (error: unknown) {
      await handle.close();
      throw error;
    }
  }

  async commit(validatedPlanHash: string): Promise<void> {
    if (validatedPlanHash !== this.planHash) throw new Error("clone plan hash changed before apply");
    const committed: { descriptorDestination: string; backup: string | null; parentHandle: FileHandle }[] = [];
    try {
      await fs.writeFile(path.join(this.transactionRoot, "transaction.json"), `${JSON.stringify({ plan_hash: this.planHash, target: this.targetRoot, status: "committing" }, null, 2)}\n`);
      for (const entry of [...this.entries.values()].sort((left, right) => left.relative.localeCompare(right.relative))) {
        const destination = path.join(this.targetRoot, entry.relative);
        const backup = path.join(this.backupRoot, entry.relative);
        await this.createSafeParents(destination);
        await assertNoSymlinkPath(this.targetRoot, destination, true);
        const { handle: parentHandle, descriptorDestination } = await this.openSafeParent(destination);
        let backupPath: string | null = null;
        try {
          await fs.lstat(descriptorDestination);
          await fs.mkdir(path.dirname(backup), { recursive: true });
          await fs.rename(descriptorDestination, backup);
          backupPath = backup;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            await parentHandle.close();
            throw error;
          }
        }
        committed.push({ descriptorDestination, backup: backupPath, parentHandle });
        await fs.rename(entry.staged, descriptorDestination);
        if (entry.mode !== undefined) await fs.chmod(descriptorDestination, entry.mode);
      }
      await Promise.all(committed.map(async (entry) => entry.parentHandle.close()));
      await fs.rm(this.transactionRoot, { recursive: true, force: true });
      await this.releaseLock();
      this.completed = true;
    } catch (error: unknown) {
      let rollbackError: unknown = null;
      for (const entry of committed.reverse()) {
        try {
          await fs.rm(entry.descriptorDestination, { recursive: true, force: true });
          if (entry.backup) {
            await fs.rename(entry.backup, entry.descriptorDestination);
          }
        } catch (caught: unknown) {
          rollbackError = caught;
        } finally {
          await entry.parentHandle.close();
        }
      }
      if (rollbackError) {
        const rollbackMessage = rollbackError instanceof Error
          ? rollbackError.message
          : typeof rollbackError === "string" ? rollbackError : JSON.stringify(rollbackError);
        await fs.writeFile(path.join(this.transactionRoot, "INCOMPLETE.json"), `${JSON.stringify({ plan_hash: this.planHash, error: error instanceof Error ? error.message : String(error), rollback_error: rollbackMessage }, null, 2)}\n`);
      } else {
        await fs.rm(this.transactionRoot, { recursive: true, force: true });
      }
      await this.releaseLock();
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (this.completed) return;
    await fs.rm(this.transactionRoot, { recursive: true, force: true });
    await this.releaseLock();
    this.completed = true;
  }

  private async releaseLock(): Promise<void> {
    try {
      await this.lockHandle.close();
    } finally {
      await fs.rm(this.lockPath, { force: true });
    }
  }
}
