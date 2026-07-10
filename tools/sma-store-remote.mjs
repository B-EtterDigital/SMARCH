#!/usr/bin/env node
/**
 * sma-store-remote.mjs — SKELETON for the hosted release-store.
 *
 * Status: stub. NO network calls. NO Supabase deployment. This file exists
 * to (a) define the API surface for the hosted variant of sma-store, and
 * (b) be the seam we wire up the day a second SMARCH instance exists.
 *
 * Why a stub now:
 *   The Pierre / code.storage shape is `store.installRelease(id, version)` —
 *   programmatic, low-latency, no source repo required. sma-store.mjs already
 *   implements this locally. The hosted variant would let a second machine
 *   resolve a release purely by id+version against a shared HTTP endpoint.
 *   The federation primitives (registry_origin field, schema support) ship
 *   in batches 1+4. This file documents what's left.
 *
 * Subcommands (all currently --dry-run only):
 *   resolve   --brick <id> --version <v> --origin <url>
 *             → would: GET <origin>/v1/releases/<id>/<v>.json
 *
 *   install   --brick <id> --version <v> --target <project> --origin <url>
 *             → would: resolve, then delegate to local sma-clone with the
 *               fetched release artifact
 *
 *   list-versions --brick <id> --origin <url>
 *             → would: GET <origin>/v1/releases/<id>/
 *
 *   publish   --release-path releases/<brick>/<v>.json --origin <url>
 *             → would: PUT release JSON + content artifacts to <origin>
 *
 * Hosted backend shape (Supabase, deferred):
 *   - Edge Function: GET /v1/releases/:brick/:version → returns release JSON
 *   - Edge Function: PUT /v1/releases/:brick/:version → upserts (auth required)
 *   - Storage bucket: releases/<brick>/<version>/{release.json, artifacts/...}
 *   - Postgres: a `releases` table mirrors the JSON for query/index
 *   - Postgres: a `release_attestations` table records who installed what where
 *   - RLS: read public; write requires service_role or signed token
 *
 * Auth shape (deferred):
 *   - SMA_REGISTRY_TOKEN env var — short-lived bearer for write
 *   - Public read by default; private repos pass a read token
 *
 * Federation rules (already enforced today by sma-import-verify):
 *   - Every release JSON SHOULD have `release.registry_origin`
 *   - Every import-lock SHOULD have `lock.registry_origin`
 *   - When env SMA_REGISTRY_ORIGIN is set, mismatches warn
 *
 * To turn this into a working tool:
 *   1. Decide the host (Supabase project, Cloudflare Worker, etc.)
 *   2. Replace the `simulate*` helpers below with real fetch calls
 *   3. Add request signing for PUT
 *   4. Wire into sma-store.mjs as `--origin <url>` to delegate hosted lookups
 */

import { argv, exit, env } from 'node:process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertExportAllowed, ExportBlockedError } from './lib/export-guard.mjs';

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
