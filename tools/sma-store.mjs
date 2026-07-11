#!/usr/bin/env node
/**
 * WHAT: Creates, resolves, lists, and installs versioned releases from the local store.
 * WHY: Consumers need stable brick-and-version addressing without depending on source checkout layout.
 * HOW: Reads release records and manifests, then delegates installs to the local clone path.
 * OUTPUTS: Prints release data and optionally writes release records or target-project files.
 * CALLERS: The sma command router and propagation workflows use this local release interface.
 * USAGE: `node tools/sma-store.mjs list-bricks --json`
 * Glossary: [SMA](../docs/GLOSSARY.md).
 */

import { SMA_ROOT } from "./lib/sma-paths.mjs";
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { argv, exit } from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';


const RELEASE_TOOL = resolve(SMA_ROOT, 'tools/sma-release.mjs');

let args = {};

function main(cliArgs = argv.slice(2)) {
  const [cmd, ...rawArgs] = cliArgs;
  args = parseArgs(rawArgs);

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
      case undefined:
        usage();
        exit(cmd ? 0 : 2);
        break;
      default:
        console.error(`unknown subcommand: ${cmd}`);
        usage();
        exit(2);
    }
  } catch (err) {
    console.error(`sma-store: ${err.message}`);
    exit(1);
  }
}

function usage() {
  console.log(`Usage:
  sma-store.mjs list-versions   --brick <id> [--json]
  sma-store.mjs version-graph   --brick <id> [--json]
  sma-store.mjs resolve         --brick <id> --version <v> [--json]
  sma-store.mjs install         --brick <id> --version <v> --target <project_path>
                                [--write] [--force]
  sma-store.mjs create-release  --manifest <path> --version <v>
                                [--status draft|published] [--search-root <path>]
  sma-store.mjs list-bricks     [--json]
`);
}

// ── list-versions ────────────────────────────────────────────────────────────

function runListVersions() {
  requireArg('brick', '--brick');
  const dir = resolve(SMA_ROOT, 'releases', args.brick);
  if (!existsSync(dir)) {
    if (args.json) console.log('[]');
    else console.log(`(no releases for ${args.brick})`);
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
  requireArg('brick', '--brick');
  const dir = resolve(SMA_ROOT, 'releases', args.brick);
  if (!existsSync(dir)) {
    if (args.json) console.log('[]');
    else console.log(`(no releases for ${args.brick})`);
    return;
  }
  const nodes = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const data = JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
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
  requireArg('brick', '--brick');
  requireArg('version', '--version');
  const path = releasePath(args.brick, args.version);
  if (!existsSync(path)) throw new Error(`release not found: ${args.brick}@${args.version} (looked at ${path})`);
  const release = JSON.parse(readFileSync(path, 'utf8'));
  if (args.json) {
    console.log(JSON.stringify(release, null, 2));
    return;
  }
  const r = release.release ?? {};
  console.log(`brick:        ${r.artifact_id}`);
  console.log(`version:      ${r.version}`);
  console.log(`status:       ${r.status}`);
  console.log(`channel:      ${r.channel}`);
  console.log(`source_proj:  ${r.source_project ?? ''}`);
  console.log(`source_path:  ${r.source_manifest_path ?? ''}`);
  console.log(`commit:       ${r.source_commit ?? ''}`);
  console.log(`hash:         ${r.content_hash ?? ''}`);
  if (r.previous_release) console.log(`previous:     ${r.previous_release}`);
  if (release.contracts?.runtimes) console.log(`runtimes:     ${release.contracts.runtimes.join(', ')}`);
}

// ── install ──────────────────────────────────────────────────────────────────

function runInstall() {
  requireArg('brick', '--brick');
  requireArg('version', '--version');
  requireArg('target', '--target');

  installRelease({
    root: SMA_ROOT,
    brick: args.brick,
    version: args.version,
    target: args.target,
    write: Boolean(args.write),
    force: Boolean(args.force),
    stdio: 'inherit',
    logger: console,
  });
}

export class StoreInstallRefusedError extends Error {
  constructor(reason, details = {}) {
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
export function installRelease(options = {}) {
  const root = resolve(options.root || SMA_ROOT);
  const brick = String(options.brick || '').trim();
  const version = String(options.version || '').trim();
  const target = String(options.target || '').trim();
  if (!brick) throw new Error('missing --brick');
  if (!version) throw new Error('missing --version');
  if (!target) throw new Error('missing --target');

  const path = releasePath(brick, version, root);
  if (!existsSync(path)) throw new Error(`release not found: ${brick}@${version}`);
  const release = JSON.parse(readFileSync(path, 'utf8'));
  const releaseMeta = release.release ?? {};
  if (releaseMeta.status === 'yanked') {
    if (!options.force) throw new Error(`refusing to install yanked release ${brick}@${version}; pass --force to override`);
    options.logger?.warn?.(`warn: installing YANKED release ${brick}@${version}`);
  }

  const targetRoot = canonicalTargetRoot(target);
  const artifacts = Array.isArray(release.content?.artifacts)
    ? release.content.artifacts
    : [];
  for (const [index, artifact] of artifacts.entries()) {
    validateArtifactDestination(targetRoot, artifact?.path, index);
  }

  // sma-clone remains the source of truth for placement, lock writes, and
  // integration_recipe stamping. Both the CLI and MCP now reach it through
  // this single validated store API.
  const cloneArgs = [
    resolve(root, 'tools/sma-clone.mjs'),
    '--brick',
    brick,
    '--target',
    targetRoot,
  ];
  if (options.force) cloneArgs.push('--force');
  const cloneRunner = options.runClone || runClone;

  options.logger?.log?.(`install ${brick}@${version} → ${target}${options.write ? ' (writing)' : ' (dry-run)'}`);
  let previewPlan = null;
  if (options.write) {
    const preview = cloneRunner(cloneArgs, 'pipe');
    const previewClone = parseCloneOutput(preview.stdout);
    validateCloneWritePlan(targetRoot, previewClone?.plan);
    previewPlan = previewClone.plan;
  }
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
    write: options.write === true,
    force: options.force === true,
    clone,
  };
}

function canonicalTargetRoot(target) {
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

function runClone(cloneArgs, stdio = 'pipe') {
  const inherit = stdio === 'inherit';
  const result = spawnSync('node', cloneArgs, {
    encoding: inherit ? undefined : 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || '').trim();
    throw new Error(`sma-clone exited with status ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function parseCloneOutput(stdout, required = true) {
  if (typeof stdout !== 'string' || !stdout.trim()) {
    if (!required) return null;
    throw new StoreInstallRefusedError('write-plan-missing');
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    if (!required) return { output: stdout.trim() };
    throw new StoreInstallRefusedError('write-plan-invalid', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function validateCloneWritePlan(targetRoot, plan) {
  validateTargetRootIdentity(targetRoot);
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.actions)) {
    throw new StoreInstallRefusedError('write-plan-invalid');
  }

  for (const [index, action] of plan.actions.entries()) {
    if (typeof action?.dst !== 'string' || !action.dst.trim()) continue;
    validateWriteDestination(targetRoot, action.dst, `action[${index}].dst`);
  }

  if (plan.control_plane !== undefined && (
    !plan.control_plane
    || typeof plan.control_plane !== 'object'
    || Array.isArray(plan.control_plane)
  )) {
    throw new StoreInstallRefusedError('write-plan-invalid');
  }
  for (const [name, destination] of Object.entries(plan.control_plane || {})) {
    if (typeof destination !== 'string' || !destination.trim()) {
      throw new StoreInstallRefusedError('write-plan-invalid', {
        write_label: `control_plane.${name}`,
      });
    }
    validateWriteDestination(targetRoot, destination, `control_plane.${name}`);
  }
}

function validateTargetRootIdentity(targetRoot) {
  let currentRoot;
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

function runSelftest() {
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

    const plan = {
      actions: [{ kind: 'copy_file', dst: resolve(safeParent, 'payload.txt') }],
      control_plane: {},
    };
    let cloneCalls = 0;
    const runCloneFixture = (cloneArgs) => {
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

function validateWriteDestination(targetRoot, destination, label) {
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

function validateArtifactDestination(targetRoot, artifactPath, index) {
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

function isContainedPath(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

// ── create-release ───────────────────────────────────────────────────────────

function runCreateRelease() {
  requireArg('manifest', '--manifest');
  requireArg('version', '--version');
  const releaseArgs = [
    RELEASE_TOOL,
    '--manifest',
    resolve(args.manifest),
    '--version',
    args.version,
  ];
  if (args.status) releaseArgs.push('--status', args.status);
  if (args.searchRoot) releaseArgs.push('--search-root', args.searchRoot);
  const res = spawnSync('node', releaseArgs, { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`sma-release exited with status ${res.status}`);
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
  for (const e of entries) console.log(`${pad(e.brick, 80)} ${e.versions} version(s)`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function releasePath(brick, version, root = SMA_ROOT) {
  const releasesDir = resolve(root, 'releases');
  const candidate = resolve(releasesDir, brick, `${version}.json`);
  if (!isContainedPath(releasesDir, candidate)) {
    throw new StoreInstallRefusedError('release-path-outside-store', { brick, version });
  }
  return candidate;
}

function semverCompare(a, b) {
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

function requireArg(key, flag) {
  if (args[key] === undefined || args[key] === null || args[key] === '') {
    throw new Error(`missing ${flag}`);
  }
}

function pad(s, n) {
  return String(s ?? '').slice(0, n).padEnd(n);
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = list[i + 1];
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
