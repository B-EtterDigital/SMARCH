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
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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
  content?: { artifacts?: { path?: unknown }[] };
}

interface CloneAction {
  kind?: string;
  dst?: string;
}

interface ClonePlan {
  actions: CloneAction[];
  control_plane?: Record<string, string>;
}

interface CloneOutput {
  plan?: ClonePlan;
  output?: string;
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
  const targetRoot = canonicalTargetRoot(target);
  validateReleaseArtifacts(release, targetRoot);

  // sma-clone remains the source of truth for placement, lock writes, and
  // integration_recipe stamping. Both the CLI and MCP now reach it through
  // this single validated store API.
  const cloneArgs = [
    resolve(root, 'tools/sma-clone.ts'),
    '--brick',
    brick,
    '--target',
    targetRoot,
  ];
  if (options.force) cloneArgs.push('--force');
  const cloneRunner = options.runClone ?? runClone;

  options.logger?.log?.(`install ${brick}@${version} → ${target}${options.write ? ' (writing)' : ' (dry-run)'}`);
  const previewPlan = previewClonePlan(options, cloneRunner, cloneArgs, targetRoot);
  const res = cloneRunner(options.write ? [...cloneArgs, '--write'] : cloneArgs, options.stdio);

  // The preview and write are separate clone processes. Re-resolve the exact
  // previewed destinations after the write so a directory swapped to an
  // escaping symlink in that interval cannot produce a successful install.
  if (options.write) validateCloneWritePlan(targetRoot, previewPlan);

  const clone = parseCloneOutput(res.stdout, false);
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

function validateReleaseArtifacts(release: ReleaseDocument, targetRoot: string): void {
  for (const [index, artifact] of (release.content?.artifacts ?? []).entries()) {
    validateArtifactDestination(targetRoot, artifact.path, index);
  }
}

function previewClonePlan(options: InstallOptions, cloneRunner: CloneRunner, cloneArgs: string[], targetRoot: string): ClonePlan | null {
  if (!options.write) return null;
  const preview = cloneRunner(cloneArgs, 'pipe');
  const previewPlan = parseCloneOutput(preview.stdout)?.plan ?? null;
  validateCloneWritePlan(targetRoot, previewPlan);
  return previewPlan;
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
  const root = mkdtempSync(resolve(tmpdir(), 'sma-store-race-'));
  try {
    const brick = 'race-fixture';
    const version = '1.0.0';
    const releaseDir = resolve(root, 'releases', brick);
    const target = resolve(root, 'target');
    const safeParent = resolve(target, 'safe');
    const outside = resolve(root, 'outside');
    mkdirSync(releaseDir, { recursive: true });
    mkdirSync(safeParent, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(resolve(releaseDir, `${version}.json`), JSON.stringify({
      release: { artifact_id: brick, version, status: 'published' },
      content: { artifacts: [{ path: 'safe/payload.txt' }] },
    }));

    const plan: ClonePlan = {
      actions: [{ kind: 'copy_file', dst: resolve(safeParent, 'payload.txt') }],
      control_plane: {},
    };
    let cloneCalls = 0;
    const runCloneFixture: CloneRunner = (cloneArgs: string[]) => {
      cloneCalls += 1;
      if (cloneArgs.includes('--write')) {
        rmSync(safeParent, { recursive: true, force: true });
        symlinkSync(outside, safeParent, 'dir');
      }
      return { status: 0, stdout: JSON.stringify({ plan }), stderr: '' };
    };

    assert.throws(
      () => installRelease({
        root,
        brick,
        version,
        target,
        write: true,
        runClone: runCloneFixture,
        logger: null,
      }),
      (error) => error instanceof StoreInstallRefusedError
        && error.details.reason === 'write-symlink-outside-target',
    );
    assert.equal(cloneCalls, 2);
    process.stdout.write('sma-store install-race selftest: PASS\n');
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

function validateArtifactDestination(targetRoot: string, artifactPath: unknown, index: number): void {
  const value = typeof artifactPath === 'string' ? artifactPath.trim() : '';
  const details = { artifact_index: index, artifact_path: artifactPath ?? null, target_root: targetRoot };
  if (!value) throw new StoreInstallRefusedError('artifact-path-missing', details);
  if (isAbsolute(value)) throw new StoreInstallRefusedError('artifact-path-absolute', details);

  const segments = value.split(/[\\/]+/);
  if (segments.includes('..')) throw new StoreInstallRefusedError('artifact-path-traversal', details);

  const lexicalDestination = resolve(targetRoot, value);
  if (!isContainedPath(targetRoot, lexicalDestination)) {
    throw new StoreInstallRefusedError('artifact-path-outside-target', {
      ...details,
      resolved_path: lexicalDestination,
    });
  }

  let canonicalCursor = targetRoot;
  for (const segment of segments.filter((part) => part && part !== '.')) {
    const next = resolve(canonicalCursor, segment);
    if (!existsSync(next)) {
      canonicalCursor = next;
      continue;
    }
    try {
      canonicalCursor = realpathSync(next);
    } catch (error) {
      throw new StoreInstallRefusedError('artifact-path-unresolvable', {
        ...details,
        resolved_path: next,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (!isContainedPath(targetRoot, canonicalCursor)) {
      throw new StoreInstallRefusedError('artifact-symlink-outside-target', {
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
  const releaseArgs: string[] = [
    RELEASE_TOOL,
    '--manifest',
    resolve(manifest),
    '--version',
    version,
  ];
  if (args.status) releaseArgs.push('--status', args.status);
  if (args.searchRoot) releaseArgs.push('--search-root', args.searchRoot);
  const res = spawnSync('node', releaseArgs, { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`sma-release exited with status ${String(res.status)}`);
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
