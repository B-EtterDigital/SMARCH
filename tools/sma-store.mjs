#!/usr/bin/env node
/**
 * sma-store.mjs — local release-store API. The Pierre / code.storage shape,
 * scoped to your machine first.
 *
 * The point: today, "install a brick" requires `sma-clone --brick X --target Y`,
 * which assumes the source repo is already on disk and resolved by id from a
 * registry scan. This tool exposes the same operation but addressed by
 * (brick_id, version) — same shape Pierre's `store.installRelease(id, version)`
 * pitches. Hosted Supabase variant is deferred until a second instance exists;
 * everything below is local-only.
 *
 * Subcommands:
 *   list-versions   --brick <id> [--json]
 *   version-graph   --brick <id> [--json]
 *   resolve         --brick <id> --version <v> [--json]
 *   install         --brick <id> --version <v> --target <project_path>
 *                   [--write] [--force]
 *   create-release  --manifest <path/to/module.sweetspot.json|build.sweetspot.json>
 *                   --version <v> [--status draft|published] [--search-root <path>]
 *   list-bricks     [--json]      → brick ids that have at least one release
 *
 * "Brick id" here matches release artifact_id, which mirrors the brick manifest
 * brick.id. Releases live at: releases/<artifact_id>/<version>.json.
 *
 * Hosted variant (deferred): a Supabase edge function with the same API surface,
 * backed by a storage bucket of release JSONs.
 */

import { SMA_ROOT } from "./lib/sma-paths.mjs";
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { spawnSync } from 'node:child_process';


const RELEASES_DIR = resolve(SMA_ROOT, 'releases');
const CLONE_TOOL = resolve(SMA_ROOT, 'tools/sma-clone.mjs');
const RELEASE_TOOL = resolve(SMA_ROOT, 'tools/sma-release.mjs');

const cmd = argv[2];
const args = parseArgs(argv.slice(3));

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
  const dir = resolve(RELEASES_DIR, args.brick);
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
  const dir = resolve(RELEASES_DIR, args.brick);
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

  const path = releasePath(args.brick, args.version);
  if (!existsSync(path)) throw new Error(`release not found: ${args.brick}@${args.version}`);
  const release = JSON.parse(readFileSync(path, 'utf8'));
  const r = release.release ?? {};
  if (r.status === 'yanked') {
    if (!args.force) throw new Error(`refusing to install yanked release ${args.brick}@${args.version}; pass --force to override`);
    console.warn(`warn: installing YANKED release ${args.brick}@${args.version}`);
  }

  // Delegate the actual file copy to sma-clone.mjs. It is the source of truth
  // for placement, .smarch lock writes, and integration_recipe stamping.
  const cloneArgs = [
    CLONE_TOOL,
    '--brick',
    args.brick,
    '--target',
    args.target,
  ];
  if (args.write) cloneArgs.push('--write');
  if (args.force) cloneArgs.push('--force');

  console.log(`install ${args.brick}@${args.version} → ${args.target}${args.write ? ' (writing)' : ' (dry-run)'}`);
  const res = spawnSync('node', cloneArgs, { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`sma-clone exited with status ${res.status}`);
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
  if (!existsSync(RELEASES_DIR)) {
    if (args.json) console.log('[]');
    else console.log('(no releases dir)');
    return;
  }
  const entries = readdirSync(RELEASES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = resolve(RELEASES_DIR, d.name);
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

function releasePath(brick, version) {
  return resolve(RELEASES_DIR, brick, `${version}.json`);
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
