#!/usr/bin/env node
/**
 * WHAT: Simulates the command contract for a future hosted release store.
 * WHY: Federation needs a stable seam before a second deployed store justifies networking.
 * HOW: Parses remote-store inputs and prints planned requests without making network calls.
 * OUTPUTS: Emits stub actions for resolve, install, list, publish, and health operations.
 * CALLERS: The sma command router exposes it for contract testing and deployment planning.
 * USAGE: `node tools/sma-store-remote.mjs health --origin http://127.0.0.1:54321`
 * Glossary: [SMA](../docs/GLOSSARY.md).
 */

import { argv, exit, env } from 'node:process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertExportAllowed, ExportBlockedError } from './lib/export-guard.ts';

const cmd = argv[2];
const args = parseArgs(argv.slice(3));

try {
  switch (cmd) {
    case 'resolve':       runResolve(); break;
    case 'install':       runInstall(); break;
    case 'list-versions': runListVersions(); break;
    case 'publish':       runPublish(); break;
    case 'health':        runHealth(); break;
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
  console.error(`sma-store-remote: ${err.message}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-store-remote.mjs resolve       --brick <id> --version <v> --origin <url>
  sma-store-remote.mjs install       --brick <id> --version <v> --target <project> --origin <url>
  sma-store-remote.mjs list-versions --brick <id> --origin <url>
  sma-store-remote.mjs publish       --release-path <path> --origin <url>
  sma-store-remote.mjs health        --origin <url>

NOTE: This is a stub. No network calls happen. See file header for the
deployment shape (Supabase edge function + storage bucket).
`);
}

// ── stubs ────────────────────────────────────────────────────────────────────

function runResolve() {
  requireArg('brick', '--brick');
  requireArg('version', '--version');
  const origin = resolveOrigin();
  const url = `${origin.replace(/\/$/, '')}/v1/releases/${enc(args.brick)}/${enc(args.version)}.json`;
  console.log('[stub] would GET', url);
  emitStub('resolve', { url });
}

function runInstall() {
  requireArg('brick', '--brick');
  requireArg('version', '--version');
  requireArg('target', '--target');
  const origin = resolveOrigin();
  const url = `${origin.replace(/\/$/, '')}/v1/releases/${enc(args.brick)}/${enc(args.version)}.json`;
  console.log('[stub] would GET', url);
  console.log('[stub] would write release JSON to a temp path');
  console.log('[stub] would invoke sma-clone --brick', args.brick, '--target', args.target, '--write');
  console.log('[stub] would record registry_origin into the import-lock');
  emitStub('install', { url, target: args.target });
}

function runListVersions() {
  requireArg('brick', '--brick');
  const origin = resolveOrigin();
  const url = `${origin.replace(/\/$/, '')}/v1/releases/${enc(args.brick)}/`;
  console.log('[stub] would GET', url);
  emitStub('list-versions', { url });
}

function runPublish() {
  requireArg('releasePath', '--release-path');
  const origin = resolveOrigin();
  const path = resolve(args.releasePath);
  if (!existsSync(path)) throw new Error(`release artifact not found: ${path}`);
  let release;
  try { release = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`could not parse release JSON: ${e.message}`); }

  const id = release?.release?.artifact_id;
  const version = release?.release?.version;
  if (!id || !version) throw new Error('release is missing artifact_id or version');

  // Export choke-point (defense-in-depth): never upload a closed/private
  // artifact to a remote origin. Creation is already guarded in sma-release;
  // this stops a pre-existing closed release JSON from being pushed out.
  try {
    const componentIds = (release?.composition?.brick_refs || release?.release?.derived_from_bricks || [])
      .map((r) => r?.brick_id).filter(Boolean);
    assertExportAllowed({
      operation: 'store-remote-publish',
      brickIds: componentIds.length ? componentIds : [id],
      project: release?.release?.source_project || null,
      targetVisibility: 'public',
      allowClosed: Boolean(args.allowClosed),
    });
  } catch (err) {
    if (err instanceof ExportBlockedError) { console.error(err.message); exit(3); }
    throw err;
  }

  const url = `${origin.replace(/\/$/, '')}/v1/releases/${enc(id)}/${enc(version)}.json`;
  console.log('[stub] would PUT', url);
  console.log('[stub] would attach signed token from SMA_REGISTRY_TOKEN');
  console.log('[stub] would upload artifacts under /v1/releases/' + id + '/' + version + '/artifacts/');
  emitStub('publish', { url, brick: id, version });
}

function runHealth() {
  const origin = resolveOrigin();
  const url = `${origin.replace(/\/$/, '')}/v1/health`;
  console.log('[stub] would GET', url);
  emitStub('health', { url });
}

function emitStub(action, info) {
  const out = {
    stub: true,
    action,
    info,
    notice: 'No network call made. Replace simulate*() helpers in this file to enable.',
  };
  if (args.json) console.log(JSON.stringify(out, null, 2));
}

function resolveOrigin() {
  const origin = args.origin || env.SMA_REGISTRY_ORIGIN;
  if (!origin) throw new Error('missing --origin or SMA_REGISTRY_ORIGIN');
  if (!/^https?:\/\//.test(origin)) throw new Error(`origin must be an http(s) URL: ${origin}`);
  return origin;
}

function enc(s) { return encodeURIComponent(String(s)); }

function requireArg(key, flag) {
  if (args[key] === undefined || args[key] === null || args[key] === '') {
    throw new Error(`missing ${flag}`);
  }
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
