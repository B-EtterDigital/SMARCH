#!/usr/bin/env node
/**
 * WHAT: Creates, resolves, lists, and installs versioned releases from the local store.
 * WHY: Consumers need stable brick-and-version addressing without depending on source checkout layout.
 * HOW: Reads release records and manifests, then delegates installs to the local clone path.
 * OUTPUTS: Prints release data and optionally writes release records or target-project files.
 * CALLERS: The sma command router and propagation workflows use this local release interface.
 * USAGE: `node tools/sma-store.ts list-bricks --json`
 * Glossary: [SMA](../docs/GLOSSARY.md).
 */

import { SMA_ROOT } from "./lib/sma-paths.ts";
import crypto from 'node:crypto';
import {
  copyFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { argv, exit } from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';


const RELEASE_TOOL = resolve(SMA_ROOT, 'tools/sma-release.ts');

interface CliArgs extends Record<string, string | boolean | undefined> {
  brick?: string;
  version?: string;
  target?: string;
  manifest?: string;
  status?: string;
  searchRoot?: string;
  json?: boolean;
  write?: boolean;
  force?: boolean;
}

interface ReleaseMetadata {
  artifact_id?: string;
  version?: string;
  status?: string;
  channel?: string;
  previous_release?: string;
  breaking?: boolean;
  published_at?: string;
  content_hash?: string;
  source_project?: string;
  source_manifest_path?: string;
  source_commit?: string;
}

interface ReleaseDocument {
  release?: ReleaseMetadata;
  contracts?: { runtimes?: string[] };
  content?: { artifacts?: { path?: unknown; kind?: unknown; sha256?: unknown }[] };
}

interface ReleaseSnapshot {
  schema_version?: string;
  artifact_id?: string;
  version?: string;
  content_hash?: string;
  manifest?: { path?: unknown; sha256?: unknown };
  artifacts?: { path?: unknown; kind?: unknown; sha256?: unknown }[];
  seal?: { algorithm?: unknown; value?: unknown };
}

interface CloneAction {
  kind?: string;
  dst?: string;
}

interface ClonePlan {
  actions: CloneAction[];
  control_plane?: Record<string, string>;
  plan_hash?: string;
}

interface CloneOutput {
  plan?: ClonePlan;
  output?: string;
  applied_plan_hash?: string;
}

interface CloneExecution {
  status: number | null;
  stdout?: unknown;
  stderr?: unknown;
}

type CloneRunner = (cloneArgs: string[], stdio?: 'pipe' | 'inherit') => CloneExecution;

interface InstallLogger {
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

interface InstallOptions {
  root?: string;
  brick?: string;
  version?: string;
  target?: string;
  write?: boolean;
  force?: boolean;
  stdio?: 'pipe' | 'inherit';
  logger?: InstallLogger | null;
  runClone?: CloneRunner;
}

let args: CliArgs = {};

function main(cliArgs: string[] = argv.slice(2)): void {
  const [cmd, ...rawArgs] = cliArgs;
  args = parseArgs(rawArgs);
  if (!cmd) {
    usage();
    exit(2);
  }

  try {
    switch (cmd) {
      case 'list-versions':
        runListVersions();
        break;
      case 'version-graph':
        runVersionGraph();
        break;
      case 'resolve':
        runResolve();
        break;
      case 'install':
        runInstall();
        break;
      case 'create-release':
        runCreateRelease();
        break;
      case 'list-bricks':
        runListBricks();
        break;
      case 'help':
      case '--help':
      case '-h':
      default:
        console.error(`unknown subcommand: ${cmd}`);
        usage();
        exit(2);
    }
  } catch (err: unknown) {
    console.error(`sma-store: ${err instanceof Error ? err.message : String(err)}`);
    exit(1);
  }
}

function usage(): void {
  console.log(`Usage:
  sma-store.ts list-versions   --brick <id> [--json]
  sma-store.ts version-graph   --brick <id> [--json]
  sma-store.ts resolve         --brick <id> --version <v> [--json]
  sma-store.ts install         --brick <id> --version <v> --target <project_path>
                                [--write] [--force]
  sma-store.ts create-release  --manifest <path> --version <v>
                                [--status draft|published] [--search-root <path>]
  sma-store.ts list-bricks     [--json]
`);
}

// ── list-versions ────────────────────────────────────────────────────────────

function runListVersions() {
  const brick = requiredArg('brick', '--brick');
  const dir = resolve(SMA_ROOT, 'releases', brick);
  if (!existsSync(dir)) {
    if (args.json) console.log('[]');
    else console.log(`(no releases for ${brick})`);
    return;
  }
  const versions = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort(semverCompare);
  if (args.json) {
    console.log(JSON.stringify(versions, null, 2));
    return;
  }
  for (const v of versions) console.log(v);
}

// ── version-graph ────────────────────────────────────────────────────────────

function runVersionGraph() {
  const brick = requiredArg('brick', '--brick');
  const dir = resolve(SMA_ROOT, 'releases', brick);
  if (!existsSync(dir)) {
    if (args.json) console.log('[]');
    else console.log(`(no releases for ${brick})`);
    return;
  }
  const nodes = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const data = JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as ReleaseDocument;
      return {
        version: data.release?.version,
        status: data.release?.status,
        channel: data.release?.channel,
        previous_release: data.release?.previous_release,
        breaking: !!data.release?.breaking,
        published_at: data.release?.published_at,
        content_hash: data.release?.content_hash,
      };
    })
    .sort((a, b) => semverCompare(a.version, b.version));
  if (args.json) {
    console.log(JSON.stringify(nodes, null, 2));
    return;
  }
  for (const n of nodes) {
    const arrow = n.previous_release ? ` ← ${n.previous_release}` : '';
    const flag = n.breaking ? ' (breaking)' : '';
    console.log(`${pad(n.version, 16)} ${pad(n.status ?? '', 12)} ${pad(n.channel ?? '', 12)}${flag}${arrow}`);
  }
}

// ── resolve ──────────────────────────────────────────────────────────────────

function runResolve() {
  const brick = requiredArg('brick', '--brick');
  const version = requiredArg('version', '--version');
  const path = releasePath(brick, version);
  if (!existsSync(path)) throw new Error(`release not found: ${brick}@${version} (looked at ${path})`);
  const release = JSON.parse(readFileSync(path, 'utf8')) as ReleaseDocument;
  if (args.json) {
    console.log(JSON.stringify(release, null, 2));
    return;
  }
  const r = release.release ?? {};
  console.log(`brick:        ${r.artifact_id ?? ''}`);
  console.log(`version:      ${r.version ?? ''}`);
  console.log(`status:       ${r.status ?? ''}`);
  console.log(`channel:      ${r.channel ?? ''}`);
  console.log(`source_proj:  ${r.source_project ?? ''}`);
  console.log(`source_path:  ${r.source_manifest_path ?? ''}`);
  console.log(`commit:       ${r.source_commit ?? ''}`);
  console.log(`hash:         ${r.content_hash ?? ''}`);
  if (r.previous_release) console.log(`previous:     ${r.previous_release}`);
  if (release.contracts?.runtimes) console.log(`runtimes:     ${release.contracts.runtimes.join(', ')}`);
}

// ── install ──────────────────────────────────────────────────────────────────

function runInstall() {
  const brick = requiredArg('brick', '--brick');
  const version = requiredArg('version', '--version');
  const target = requiredArg('target', '--target');

  installRelease({
    root: SMA_ROOT,
    brick,
    version,
    target,
    write: Boolean(args.write),
    force: Boolean(args.force),
    stdio: 'inherit',
    logger: console,
  });
}

export class StoreInstallRefusedError extends Error {
  declare code: string;
  declare details: Record<string, unknown>;

  constructor(reason: string, details: Record<string, unknown> = {}) {
    super(`MCP_RELEASE_INSTALL_REFUSED: ${reason}`);
    this.name = 'StoreInstallRefusedError';
    this.code = 'MCP_RELEASE_INSTALL_REFUSED';
    this.details = { reason, ...details };
  }
}

/**
 * Programmatic release install entry point shared by the CLI and MCP tool.
 * Destination validation happens before sma-clone can inspect or write the
 * target, so a hostile release cannot redirect a copy through path syntax or
 * a pre-existing symlink in the target project.
 */
export function installRelease(options: InstallOptions = {}) {
  const { root, brick, version, target } = installRequest(options);
  const path = releasePath(brick, version, root);
  if (!existsSync(path)) throw new Error(`release not found: ${brick}@${version}`);
  const release = JSON.parse(readFileSync(path, 'utf8')) as ReleaseDocument;
  assertInstallableRelease(release, options, brick, version);
  assertReleaseIdentity(release, brick, version);
  const releaseSnapshot = verifiedReleaseSnapshot(root, release, brick, version);
  const targetRoot = canonicalTargetRoot(target);
  const cloneArgs = [
    resolve(root, 'tools/sma-clone.ts'),
    '--brick',
    brick,
    '--release-snapshot',
    releaseSnapshot,
    '--target',
    targetRoot,
  ];
  if (options.force) cloneArgs.push('--force');
  const cloneRunner = options.runClone ?? runClone;

  options.logger?.log?.(`install ${brick}@${version} → ${target}${options.write ? ' (writing)' : ' (dry-run)'}`);
  const res = cloneRunner(options.write ? [...cloneArgs, '--write'] : cloneArgs, 'pipe');
  const clone = parseCloneOutput(res.stdout);
  validateCloneResult(clone, Boolean(options.write), targetRoot);
  if (options.stdio === 'inherit' && typeof res.stdout === 'string') process.stdout.write(res.stdout);
  return {
    ok: true,
    brick,
    version,
    target: targetRoot,
    write: options.write,
    force: options.force,
    clone,
  };
}

function assertReleaseIdentity(release: ReleaseDocument, brick: string, version: string): void {
  if (release.release?.artifact_id !== brick || release.release.version !== version) {
    throw new StoreInstallRefusedError('release-identity-mismatch', {
      requested_artifact_id: brick,
      requested_version: version,
      release_artifact_id: release.release?.artifact_id ?? null,
      release_version: release.release?.version ?? null,
    });
  }
}

function installRequest(options: InstallOptions): { root: string; brick: string; version: string; target: string } {
  const root = resolve(options.root ?? SMA_ROOT);
  const brick = (options.brick ?? '').trim();
  const version = (options.version ?? '').trim();
  const target = (options.target ?? '').trim();
  if (!brick) throw new Error('missing --brick');
  if (!version) throw new Error('missing --version');
  if (!target) throw new Error('missing --target');
  return { root, brick, version, target };
}

function assertInstallableRelease(release: ReleaseDocument, options: InstallOptions, brick: string, version: string): void {
  if (release.release?.status !== 'yanked') return;
  if (!options.force) throw new Error(`refusing to install yanked release ${brick}@${version}; pass --force to override`);
  options.logger?.warn?.(`warn: installing YANKED release ${brick}@${version}`);
}

function hashBytes(value: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizedArtifactPath(value: unknown, label: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new StoreInstallRefusedError('artifact-path-missing', { artifact_path: value ?? null, path_label: label });
  if (isAbsolute(raw) || win32.isAbsolute(raw)) throw new StoreInstallRefusedError('artifact-path-absolute', { artifact_path: raw, path_label: label });
  const segments = raw.replace(/\\/g, '/').split('/');
  if (segments.includes('..')) throw new StoreInstallRefusedError('artifact-path-traversal', { artifact_path: raw, path_label: label });
  const normalized = segments.filter((segment) => segment && segment !== '.').join('/');
  if (!normalized) throw new StoreInstallRefusedError('artifact-path-missing', { artifact_path: raw, path_label: label });
  return normalized;
}

function pathDigestSync(artifactPath: string): string {
  const stat = lstatSync(artifactPath);
  if (stat.isSymbolicLink()) throw new StoreInstallRefusedError('immutable-artifact-symlink', { artifact_path: artifactPath });
  if (stat.isFile()) return hashBytes(readFileSync(artifactPath));
  if (!stat.isDirectory()) throw new StoreInstallRefusedError('immutable-artifact-type', { artifact_path: artifactPath });
  const files: { path: string; sha256: string }[] = [];
  const walk = (root: string, current: string): void => {
    const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new StoreInstallRefusedError('immutable-artifact-symlink', { artifact_path: absolute });
      if (entry.isDirectory()) walk(root, absolute);
      else if (entry.isFile()) files.push({ path: relative(root, absolute).split(sep).join('/'), sha256: hashBytes(readFileSync(absolute)) });
      else throw new StoreInstallRefusedError('immutable-artifact-type', { artifact_path: absolute });
    }
  };
  walk(artifactPath, artifactPath);
  return hashBytes(JSON.stringify(files));
}

// eslint-disable-next-line complexity -- Immutable snapshot verification is one fail-closed checklist; splitting it would weaken the identity-to-payload audit trail.
function verifiedReleaseSnapshot(root: string, release: ReleaseDocument, brick: string, version: string): string {
  const contentHash = release.release?.content_hash;
  if (typeof contentHash !== 'string' || !/^[a-f0-9]{64}$/i.test(contentHash)) {
    throw new StoreInstallRefusedError('release-content-hash-invalid', { brick, version, content_hash: contentHash ?? null });
  }
  const artifactStore = resolve(root, 'releases', '.artifacts');
  const snapshotPath = resolve(artifactStore, contentHash, 'snapshot.json');
  if (!isContainedPath(artifactStore, snapshotPath) || !existsSync(snapshotPath)) {
    throw new StoreInstallRefusedError('immutable-artifact-missing', { brick, version, content_hash: contentHash, snapshot_path: snapshotPath });
  }
  if (realpathSync(snapshotPath) !== snapshotPath) {
    throw new StoreInstallRefusedError('immutable-artifact-symlink', { snapshot_path: snapshotPath });
  }
  const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8')) as ReleaseSnapshot;
  if (snapshot.artifact_id !== brick || snapshot.version !== version || snapshot.content_hash !== contentHash) {
    throw new StoreInstallRefusedError('immutable-artifact-identity-mismatch', {
      brick,
      version,
      content_hash: contentHash,
      snapshot_artifact_id: snapshot.artifact_id ?? null,
      snapshot_version: snapshot.version ?? null,
      snapshot_content_hash: snapshot.content_hash ?? null,
    });
  }
  const sealInput = { ...snapshot };
  delete sealInput.seal;
  if (snapshot.seal?.algorithm !== 'sha256' || snapshot.seal.value !== hashBytes(JSON.stringify(sealInput))) {
    throw new StoreInstallRefusedError('immutable-artifact-seal-mismatch', { snapshot_path: snapshotPath });
  }
  const snapshotRoot = dirname(snapshotPath);
  const manifestRelative = normalizedArtifactPath(snapshot.manifest?.path, 'snapshot.manifest.path');
  const manifestPath = resolve(snapshotRoot, manifestRelative);
  if (!isContainedPath(snapshotRoot, manifestPath) || !existsSync(manifestPath) || pathDigestSync(manifestPath) !== snapshot.manifest?.sha256) {
    throw new StoreInstallRefusedError('immutable-manifest-hash-mismatch', { manifest_path: manifestRelative });
  }
  const releaseArtifacts = new Map((release.content?.artifacts ?? []).map((artifact, index) => [
    normalizedArtifactPath(artifact.path, `release.content.artifacts[${String(index)}].path`),
    artifact,
  ]));
  const snapshotArtifacts = snapshot.artifacts ?? [];
  if (snapshotArtifacts.length !== releaseArtifacts.size) throw new StoreInstallRefusedError('immutable-artifact-set-mismatch');
  for (const [index, artifact] of snapshotArtifacts.entries()) {
    const relativePath = normalizedArtifactPath(artifact.path, `snapshot.artifacts[${String(index)}].path`);
    const releaseArtifact = releaseArtifacts.get(relativePath);
    if (!releaseArtifact || artifact.sha256 !== releaseArtifact.sha256 || artifact.kind !== releaseArtifact.kind) {
      throw new StoreInstallRefusedError('immutable-artifact-metadata-mismatch', { artifact_path: relativePath });
    }
    const payloadPath = resolve(snapshotRoot, 'payload', relativePath);
    if (!isContainedPath(resolve(snapshotRoot, 'payload'), payloadPath) || !existsSync(payloadPath) || pathDigestSync(payloadPath) !== artifact.sha256) {
      throw new StoreInstallRefusedError('immutable-artifact-hash-mismatch', { artifact_path: relativePath });
    }
  }
  return snapshotPath;
}

function validateCloneResult(clone: CloneOutput | null, write: boolean, targetRoot: string): void {
  if (!clone?.plan) throw new StoreInstallRefusedError('write-plan-invalid');
  validateCloneWritePlan(targetRoot, clone.plan);
  if (typeof clone.plan.plan_hash !== 'string' || !/^[a-f0-9]{64}$/i.test(clone.plan.plan_hash)) {
    throw new StoreInstallRefusedError('write-plan-hash-invalid');
  }
  if (write && clone.applied_plan_hash !== clone.plan.plan_hash) {
    throw new StoreInstallRefusedError('write-plan-hash-mismatch', {
      plan_hash: clone.plan.plan_hash,
      applied_plan_hash: clone.applied_plan_hash ?? null,
    });
  }
}

function canonicalTargetRoot(target: string): string {
  const requestedTarget = resolve(target);
  try {
    mkdirSync(requestedTarget, { recursive: true });
    return realpathSync(requestedTarget);
  } catch (error) {
    throw new StoreInstallRefusedError('target-root-unresolvable', {
      target,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function runClone(cloneArgs: string[], stdio: 'pipe' | 'inherit' = 'pipe'): CloneExecution {
  const inherit = stdio === 'inherit';
  const result = spawnSync('node', cloneArgs, {
    encoding: inherit ? undefined : 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || '').trim();
    throw new Error(`sma-clone exited with status ${String(result.status)}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function parseCloneOutput(stdout: unknown, required = true): CloneOutput | null {
  if (typeof stdout !== 'string' || !stdout.trim()) {
    if (!required) return null;
    throw new StoreInstallRefusedError('write-plan-missing');
  }
  try {
    return JSON.parse(stdout) as CloneOutput;
  } catch (error) {
    if (!required) return { output: stdout.trim() };
    throw new StoreInstallRefusedError('write-plan-invalid', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function validateCloneWritePlan(targetRoot: string, plan: ClonePlan | null | undefined): void {
  validateTargetRootIdentity(targetRoot);
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.actions)) {
    throw new StoreInstallRefusedError('write-plan-invalid');
  }

  for (const [index, action] of plan.actions.entries()) {
    if (typeof action.dst !== 'string' || !action.dst.trim()) continue;
    validateWriteDestination(targetRoot, action.dst, `action[${String(index)}].dst`);
  }

  if (plan.control_plane !== undefined && (
    typeof plan.control_plane !== 'object'
    || Array.isArray(plan.control_plane)
  )) {
    throw new StoreInstallRefusedError('write-plan-invalid');
  }
  for (const [name, destination] of Object.entries(plan.control_plane ?? {})) {
    if (typeof destination !== 'string' || !destination.trim()) {
      throw new StoreInstallRefusedError('write-plan-invalid', {
        write_label: `control_plane.${name}`,
      });
    }
    validateWriteDestination(targetRoot, destination, `control_plane.${name}`);
  }
}

function validateTargetRootIdentity(targetRoot: string): void {
  let currentRoot: string;
  try {
    currentRoot = realpathSync(targetRoot);
  } catch (error) {
    throw new StoreInstallRefusedError('target-root-unresolvable', {
      target_root: targetRoot,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (currentRoot !== targetRoot) {
    throw new StoreInstallRefusedError('target-root-changed', {
      target_root: targetRoot,
      resolved_path: currentRoot,
    });
  }
}

function runSelftest(): void {
  const root = mkdtempSync(resolve(tmpdir(), 'sma-store-immutable-'));
  try {
    const brick = 'immutable-fixture';
    const version = '1.0.0';
    const releaseDir = resolve(root, 'releases', brick);
    const target = resolve(root, 'target');
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(resolve(releaseDir, `${version}.json`), JSON.stringify({
      release: { artifact_id: brick, version, status: 'published', content_hash: 'a'.repeat(64) },
      content: { artifacts: [{ path: 'safe/payload.txt', kind: 'file', sha256: 'b'.repeat(64) }] },
    }));

    assert.throws(
      () => installRelease({
        root,
        brick,
        version,
        target,
        write: true,
        runClone: () => ({ status: 0, stdout: '{}' }),
        logger: null,
      }),
      (error) => error instanceof StoreInstallRefusedError
        && error.details.reason === 'immutable-artifact-missing',
    );
    process.stdout.write('sma-store immutable-install selftest: PASS\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function validateWriteDestination(targetRoot: string, destination: string, label: string): void {
  const lexicalDestination = resolve(targetRoot, destination);
  const details = {
    write_destination: destination,
    write_label: label,
    target_root: targetRoot,
    resolved_path: lexicalDestination,
  };
  if (!isContainedPath(targetRoot, lexicalDestination)) {
    throw new StoreInstallRefusedError('write-path-outside-target', details);
  }

  const segments = relative(targetRoot, lexicalDestination).split(sep).filter(Boolean);
  let canonicalCursor = targetRoot;
  for (const segment of segments) {
    const next = resolve(canonicalCursor, segment);
    if (!existsSync(next)) {
      canonicalCursor = next;
      continue;
    }
    try {
      canonicalCursor = realpathSync(next);
    } catch (error) {
      throw new StoreInstallRefusedError('write-path-unresolvable', {
        ...details,
        resolved_path: next,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (!isContainedPath(targetRoot, canonicalCursor)) {
      throw new StoreInstallRefusedError('write-symlink-outside-target', {
        ...details,
        resolved_path: canonicalCursor,
      });
    }
  }
}

function isContainedPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

// ── create-release ───────────────────────────────────────────────────────────

function runCreateRelease() {
  const manifest = requiredArg('manifest', '--manifest');
  const version = requiredArg('version', '--version');
  const manifestPath = resolve(manifest);
  const manifestDocument = JSON.parse(readFileSync(manifestPath, 'utf8')) as { brick?: { id?: string }; build?: { id?: string } };
  const artifactId = manifestDocument.brick?.id ?? manifestDocument.build?.id;
  if (!artifactId) throw new Error('manifest must declare brick.id or build.id');
  const releaseArgs: string[] = [
    RELEASE_TOOL,
    '--manifest',
    manifestPath,
    '--version',
    version,
  ];
  if (args.status) releaseArgs.push('--status', args.status);
  if (args.searchRoot) releaseArgs.push('--search-root', args.searchRoot);
  const res = spawnSync('node', releaseArgs, { stdio: 'inherit', cwd: SMA_ROOT });
  if (res.status !== 0) throw new Error(`sma-release exited with status ${String(res.status)}`);
  materializeReleaseSnapshot(releasePath(artifactId, version), manifestPath, typeof args.searchRoot === 'string' ? resolve(args.searchRoot) : null);
}

function safeSnapshotSource(relativePath: string, roots: string[]): string {
  for (const root of roots) {
    const canonicalRoot = realpathSync(root);
    const candidate = resolve(canonicalRoot, relativePath);
    if (!isContainedPath(canonicalRoot, candidate) || !existsSync(candidate)) continue;
    const canonicalCandidate = realpathSync(candidate);
    if (isContainedPath(canonicalRoot, canonicalCandidate) && canonicalCandidate === candidate) return candidate;
  }
  throw new StoreInstallRefusedError('immutable-artifact-source-missing', { artifact_path: relativePath });
}

function copySnapshotPath(source: string, destination: string): void {
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new StoreInstallRefusedError('immutable-artifact-symlink', { artifact_path: source });
  if (stat.isFile()) {
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    return;
  }
  if (!stat.isDirectory()) throw new StoreInstallRefusedError('immutable-artifact-type', { artifact_path: source });
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) throw new StoreInstallRefusedError('immutable-artifact-symlink', { artifact_path: join(source, entry.name) });
    copySnapshotPath(join(source, entry.name), join(destination, entry.name));
  }
}

function materializeReleaseSnapshot(releaseDocumentPath: string, manifestPath: string, searchRoot: string | null): void {
  const release = JSON.parse(readFileSync(releaseDocumentPath, 'utf8')) as ReleaseDocument;
  const brick = release.release?.artifact_id;
  const version = release.release?.version;
  const contentHash = release.release?.content_hash;
  if (!brick || !version || !contentHash || !/^[a-f0-9]{64}$/i.test(contentHash)) {
    throw new StoreInstallRefusedError('release-identity-mismatch', { release_path: releaseDocumentPath });
  }
  const artifactStore = resolve(SMA_ROOT, 'releases', '.artifacts');
  const destination = resolve(artifactStore, contentHash);
  mkdirSync(artifactStore, { recursive: true });
  if (existsSync(destination)) {
    verifiedReleaseSnapshot(SMA_ROOT, release, brick, version);
    return;
  }
  const transaction = mkdtempSync(resolve(artifactStore, '.snapshot-txn-'));
  try {
    const roots = [...new Set([searchRoot, dirname(manifestPath), SMA_ROOT].filter((value): value is string => typeof value === 'string' && existsSync(value)))];
    const artifacts = (release.content?.artifacts ?? []).map((artifact, index) => ({
      path: normalizedArtifactPath(artifact.path, `release.content.artifacts[${String(index)}].path`),
      kind: artifact.kind,
      sha256: artifact.sha256,
    }));
    for (const artifact of artifacts) {
      const source = safeSnapshotSource(artifact.path, roots);
      if (pathDigestSync(source) !== artifact.sha256) throw new StoreInstallRefusedError('immutable-artifact-source-hash-mismatch', { artifact_path: artifact.path });
      copySnapshotPath(source, resolve(transaction, 'payload', artifact.path));
    }
    const manifestContent = readFileSync(manifestPath);
    copyFileSync(manifestPath, resolve(transaction, 'manifest.json'));
    const descriptor: ReleaseSnapshot = {
      schema_version: '1.0.0',
      artifact_id: brick,
      version,
      content_hash: contentHash,
      manifest: { path: 'manifest.json', sha256: hashBytes(manifestContent) },
      artifacts,
    };
    descriptor.seal = { algorithm: 'sha256', value: hashBytes(JSON.stringify(descriptor)) };
    writeFileSync(resolve(transaction, 'snapshot.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
    renameSync(transaction, destination);
    verifiedReleaseSnapshot(SMA_ROOT, release, brick, version);
  } catch (error: unknown) {
    rmSync(transaction, { recursive: true, force: true });
    throw error;
  }
}

// ── list-bricks ──────────────────────────────────────────────────────────────

function runListBricks() {
  const releasesDir = resolve(SMA_ROOT, 'releases');
  if (!existsSync(releasesDir)) {
    if (args.json) console.log('[]');
    else console.log('(no releases dir)');
    return;
  }
  const entries = readdirSync(releasesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = resolve(releasesDir, d.name);
      const versions = readdirSync(dir).filter((f) => f.endsWith('.json'));
      return { brick: d.name, versions: versions.length };
    });
  if (args.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  if (!entries.length) {
    console.log('(no bricks have releases)');
    return;
  }
  for (const e of entries) console.log(`${pad(e.brick, 80)} ${String(e.versions)} version(s)`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function releasePath(brick: string, version: string, root = SMA_ROOT): string {
  const releasesDir = resolve(root, 'releases');
  const candidate = resolve(releasesDir, brick, `${version}.json`);
  if (!isContainedPath(releasesDir, candidate)) {
    throw new StoreInstallRefusedError('release-path-outside-store', { brick, version });
  }
  return candidate;
}

function semverCompare(a: string | undefined, b: string | undefined): number {
  const pa = String(a).split(/[.+-]/).map((p) => Number.isNaN(Number(p)) ? p : Number(p));
  const pb = String(b).split(/[.+-]/).map((p) => Number.isNaN(Number(p)) ? p : Number(p));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === typeof y) return x < y ? -1 : 1;
    return typeof x === 'number' ? -1 : 1;
  }
  return 0;
}

function requiredArg(key: keyof CliArgs, flag: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`missing ${flag}`);
  }
  return value;
}

function pad(s: unknown, n: number): string {
  const value = typeof s === 'string' || typeof s === 'number' || typeof s === 'boolean' ? String(s) : '';
  return value.slice(0, n).padEnd(n);
}

function parseArgs(list: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_match: string, character: string) => character.toUpperCase());
    const next = list.at(i + 1);
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) {
      out[camel] = true;
      continue;
    }
    out[camel] = next;
    i += 1;
  }
  return out;
}

if (argv[1] && resolve(argv[1]) === fileURLToPath(import.meta.url)) {
  if (argv[2] === '--selftest') runSelftest();
  else main();
}
