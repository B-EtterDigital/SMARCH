#!/usr/bin/env node
/**
 * WHAT: Checks coordination artifacts against the project's Gen3 contracts.
 * WHY: Malformed leases, context events, or merge proposals make collision evidence unreliable.
 * HOW: Reads active leases and project context or proposal files and applies lightweight schema checks.
 * OUTPUTS: Prints pass, warning, and failure totals; strict mode exits nonzero on failures.
 * CALLERS: The sma command router and Gen3 continuous-integration gate run it.
 * USAGE: `node tools/sma-validate-gen3.mjs all --project sma --strict`
 * Glossary: [Gen3](../docs/GLOSSARY.md).
 */

import { argv, exit } from 'node:process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectRoot } from './lib/context-log.ts';
import { PROJECTS_ROOT, SMA_ROOT } from "./lib/sma-paths.ts";


const LEASES_PATH = resolve(SMA_ROOT, 'registry/active-leases.generated.json');

const ACTIVE_LEASE_KINDS = new Set([
  'brick','build','release','registry-regen','wiki-regen','state-regen',
  'import-lock','backlog','other',
]);
const ACTOR_KINDS = new Set(['human','ai_model','agent','automation','tool']);
const CONTEXT_KINDS = new Set([
  'lease_acquired','lease_renewed','lease_released','lease_expired','lease_force_acquired',
  'edit_planned','edit_applied','decision_recorded','alternative_rejected',
  'verification_run','proof_recorded','promotion_attempted','promotion_blocked','release_cut',
  'merge_proposed','merge_resolved','conflict_detected','conflict_resolved','note',
]);
const RESOLUTION_KINDS = new Set([
  'accepted_a','accepted_b','manual_merge','discarded_a','discarded_b','fork',
]);
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

const cmd = argv[2];
const args = parseArgs(argv.slice(3));

let totalFails = 0;
let totalWarns = 0;
let totalChecked = 0;
const fails = [];

try {
  switch (cmd) {
    case 'all':
      validateLeases();
      for (const p of resolveProjects()) {
        validateContext(p);
        validateProposals(p);
      }
      break;
    case 'leases':
      validateLeases();
      break;
    case 'context':
      requireArg('project', '--project');
      validateContext(args.project);
      break;
    case 'proposals':
      requireArg('project', '--project');
      validateProposals(args.project);
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
  console.error(`sma-validate-gen3: ${err.message}`);
  exit(1);
}

reportSummary();
exit((args.strict && totalFails > 0) ? 3 : 0);

function usage() {
  console.log(`Usage:
  sma-validate-gen3.mjs all       [--project <id>]... [--strict]
  sma-validate-gen3.mjs leases    [--strict]
  sma-validate-gen3.mjs context   --project <id> [--brick <id>] [--strict]
  sma-validate-gen3.mjs proposals --project <id> [--strict]
`);
}

// ── leases ───────────────────────────────────────────────────────────────────

function validateLeases() {
  if (!existsSync(LEASES_PATH)) {
    note(`leases: registry not present at ${LEASES_PATH} (ok if no agents have run yet)`);
    return;
  }
  let parsed;
  try { parsed = JSON.parse(readFileSync(LEASES_PATH, 'utf8')); }
  catch (e) { fail(`leases: registry is not valid JSON: ${e.message}`); return; }

  if (parsed.schema_version !== '1.0.0') warn(`leases: unexpected schema_version ${parsed.schema_version}`);
  if (!isDateTime(parsed.generated_at)) warn(`leases: generated_at not ISO8601`);
  if (!Array.isArray(parsed.leases)) { fail(`leases: .leases is not an array`); return; }

  let i = 0;
  for (const l of parsed.leases) {
    totalChecked += 1;
    const ctx = `leases[${i}]`;
    requireField(l, 'lease_id', ctx);
    requireField(l, 'resource_kind', ctx);
    requireField(l, 'resource_id', ctx);
    requireField(l, 'agent_id', ctx);
    requireField(l, 'acquired_at', ctx);
    requireField(l, 'expires_at', ctx);
    requireField(l, 'intent', ctx);
    if (l.resource_kind && !ACTIVE_LEASE_KINDS.has(l.resource_kind)) fail(`${ctx}.resource_kind: ${l.resource_kind} not in enum`);
    if (l.actor_kind && !ACTOR_KINDS.has(l.actor_kind)) fail(`${ctx}.actor_kind: ${l.actor_kind} not in enum`);
    if (l.acquired_at && !isDateTime(l.acquired_at)) fail(`${ctx}.acquired_at: not ISO8601`);
    if (l.expires_at && !isDateTime(l.expires_at)) fail(`${ctx}.expires_at: not ISO8601`);
    if (l.renewals !== undefined && (!Number.isInteger(l.renewals) || l.renewals < 0)) fail(`${ctx}.renewals: not non-negative int`);
    if (l.intent && String(l.intent).length < 4) fail(`${ctx}.intent: too short (min 4 chars)`);
    i += 1;
  }
  ok(`leases: validated ${parsed.leases.length} entries`);
}

// ── context ──────────────────────────────────────────────────────────────────

function validateContext(projectId) {
  let root;
  try { root = projectRoot(projectId); }
  catch { warn(`context[${projectId}]: project not found, skipping`); return; }

  const dir = resolve(root, '.smarch/agent-context');
  if (!existsSync(dir)) {
    note(`context[${projectId}]: no agent-context dir`);
    return;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.ndjson'))
    .filter((f) => !args.brick || f.replace(/\.ndjson$/, '') === args.brick.replace(/[^a-z0-9._-]/gi, '_'));

  let totalLines = 0;
  for (const fname of files) {
    const path = resolve(dir, fname);
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
    let lineNo = 0;
    for (const line of lines) {
      lineNo += 1;
      totalLines += 1;
      totalChecked += 1;
      const ctx = `context[${projectId}/${fname}:${lineNo}]`;
      let parsed;
      try { parsed = JSON.parse(line); }
      catch (e) { fail(`${ctx}: not valid JSON: ${e.message}`); continue; }
      requireField(parsed, 'event_id', ctx);
      requireField(parsed, 'brick_id', ctx);
      requireField(parsed, 'actor_kind', ctx);
      requireField(parsed, 'actor_id', ctx);
      requireField(parsed, 'kind', ctx);
      requireField(parsed, 'intent', ctx);
      requireField(parsed, 'timestamp', ctx);
      if (parsed.actor_kind && !ACTOR_KINDS.has(parsed.actor_kind)) fail(`${ctx}.actor_kind: ${parsed.actor_kind} not in enum`);
      if (parsed.kind && !CONTEXT_KINDS.has(parsed.kind)) fail(`${ctx}.kind: ${parsed.kind} not in enum`);
      if (parsed.timestamp && !isDateTime(parsed.timestamp)) fail(`${ctx}.timestamp: not ISO8601`);
      if (parsed.intent && String(parsed.intent).length < 4) fail(`${ctx}.intent: too short (min 4 chars)`);
      if (parsed.verification?.status && !['pass','fail','skipped','blocked'].includes(parsed.verification.status)) {
        fail(`${ctx}.verification.status: ${parsed.verification.status} not in enum`);
      }
      if (parsed.proof !== undefined && !Array.isArray(parsed.proof)) fail(`${ctx}.proof: not an array`);
      if (parsed.gain_percent !== undefined && typeof parsed.gain_percent !== 'number') fail(`${ctx}.gain_percent: not a number`);
    }
  }
  ok(`context[${projectId}]: validated ${totalLines} events across ${files.length} files`);
}

// ── proposals ────────────────────────────────────────────────────────────────

function validateProposals(projectId) {
  let root;
  try { root = projectRoot(projectId); }
  catch { warn(`proposals[${projectId}]: project not found, skipping`); return; }

  const dir = resolve(root, '.smarch/merge-proposals');
  if (!existsSync(dir)) {
    note(`proposals[${projectId}]: no merge-proposals dir`);
    return;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  for (const fname of files) {
    totalChecked += 1;
    const path = resolve(dir, fname);
    const ctx = `proposals[${projectId}/${fname}]`;
    let p;
    try { p = JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) { fail(`${ctx}: not valid JSON: ${e.message}`); continue; }
    requireField(p, 'proposal_id', ctx);
    requireField(p, 'brick_id', ctx);
    requireField(p, 'generated_at', ctx);
    requireField(p, 'chains', ctx);
    requireField(p, 'files', ctx);
    requireField(p, 'recommendation', ctx);
    if (!Array.isArray(p.chains) || p.chains.length < 2) fail(`${ctx}.chains: must have ≥2 entries`);
    if (p.resolution_kind && !RESOLUTION_KINDS.has(p.resolution_kind)) fail(`${ctx}.resolution_kind: ${p.resolution_kind} not in enum`);
    if (p.generated_at && !isDateTime(p.generated_at)) fail(`${ctx}.generated_at: not ISO8601`);
  }
  ok(`proposals[${projectId}]: validated ${files.length} proposals`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function resolveProjects() {
  if (Array.isArray(args.project)) return args.project;
  if (args.project) return [args.project];
  // Discover projects with .smarch dirs
  const out = [];
  try {
    for (const ent of readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (existsSync(resolve(PROJECTS_ROOT, ent.name, '.smarch'))) out.push(ent.name);
    }
  } catch { /* empty */ }
  return out;
}

function requireField(obj, field, ctx) {
  if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
    fail(`${ctx}.${field}: missing`);
  }
}

function isDateTime(s) { return typeof s === 'string' && DATETIME_RE.test(s); }

function fail(msg) { totalFails += 1; fails.push(msg); console.error(`FAIL ${msg}`); }
function warn(msg) { totalWarns += 1; console.error(`warn ${msg}`); }
function ok(msg)   { console.log(`ok   ${msg}`); }
function note(msg) { console.log(`note ${msg}`); }

function reportSummary() {
  console.log('');
  console.log(`summary: checked=${totalChecked} fail=${totalFails} warn=${totalWarns}`);
}

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
    if (isBool) { out[camel] = true; continue; }
    if (camel === 'project') {
      // Support --project repeated
      if (Array.isArray(out.project)) out.project.push(next);
      else if (out.project) out.project = [out.project, next];
      else out.project = next;
    } else {
      out[camel] = next;
    }
    i += 1;
  }
  return out;
}
