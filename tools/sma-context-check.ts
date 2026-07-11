#!/usr/bin/env node
/**
 * WHAT: Checks that changed brick manifests have timely agent-context evidence.
 * WHY: A manifest change without recorded intent and verification breaks safe handoff and weakens auditability.
 * HOW: Reads repository changes plus per-brick context logs, emits coverage findings, and is called by continuous-integration and pre-commit gates.
 * Usage: `node tools/sma-context-check.ts audit --project sma`
 */
/**
 * sma-context-check.ts — gate that ensures every modified brick manifest
 * has a corresponding entry in the agent-context log.
 *
 * Designed to be invoked from CI (sma-ci) or a pre-commit hook. By default it
 * warns; with --strict it fails. Walks the project's git status (or a supplied
 * range) for `module.sweetspot.json` files, resolves the brick id from each,
 * and checks that the per-brick agent-context NDJSON contains at least one
 * event in the configured window.
 *
 * Subcommands:
 *   check    --project <id> [--since <iso|git-ref>] [--strict] [--json]
 *            [--max-age-minutes <n>]
 *
 *   audit    --project <id> [--json]
 *            → list every brick manifest in the project, report whether it
 *              has any context events at all (lifetime).
 *
 * Exit codes:
 *   0  — all checked bricks have context coverage
 *   3  — at least one brick is missing context (only in --strict mode; otherwise 0)
 *   1  — invocation error
 */

import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { resolve, relative } from 'node:path';
import { argv, exit } from 'node:process';
import { execFileSync } from 'node:child_process';
import {
  readContextLog,
  projectRoot,
} from './lib/context-log.ts';

const cmd = argv[2];
const args = parseArgs(argv.slice(3));

try {
  switch (cmd) {
    case 'check':
      runCheck();
      break;
    case 'audit':
      runAudit();
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
  console.error(`sma-context-check: ${err.message}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-context-check.ts check  --project <id> [--since <iso|ref>] [--max-age-minutes <n>]
                               [--strict] [--json]
  sma-context-check.ts audit  --project <id> [--json]

  --since takes either an ISO timestamp or a git ref (e.g. HEAD~1, origin/main).
  When --since is a ref, modified manifests are computed via git diff.
  When --since is an ISO timestamp or omitted, modified manifests are computed
  via git status (uncommitted) and only events newer than --max-age-minutes
  (default: window since the timestamp, or 1440 = 24h) count.
`);
}

function runCheck() {
  requireArg('project', '--project');
  const root = projectRoot(args.project);
  const modified = listModifiedManifests(root, args.since);

  const windowStart = computeWindowStart(args.since, args.maxAgeMinutes);
  const results = [];
  for (const manifestPath of modified) {
    const brickId = readBrickId(manifestPath);
    if (!brickId) {
      results.push({ manifest: relative(root, manifestPath), brick: null, status: 'unknown_brick_id', events_in_window: 0 });
      continue;
    }
    const events = readContextLog(args.project, brickId);
    const inWindow = events.filter((e) => Date.parse(e.timestamp) >= windowStart);
    results.push({
      manifest: relative(root, manifestPath),
      brick: brickId,
      status: inWindow.length ? 'covered' : 'missing_context',
      events_in_window: inWindow.length,
      lifetime_events: events.length,
    });
  }

  const missing = results.filter((r) => r.status !== 'covered');
  if (args.json) {
    console.log(JSON.stringify({
      project: args.project,
      window_start: new Date(windowStart).toISOString(),
      total_modified: results.length,
      covered: results.length - missing.length,
      missing: missing.length,
      results,
    }, null, 2));
  } else {
    console.log(`project:        ${args.project}`);
    console.log(`window starts:  ${new Date(windowStart).toISOString()}`);
    console.log(`modified:       ${results.length} manifest(s)`);
    console.log(`covered:        ${results.length - missing.length}`);
    console.log(`missing:        ${missing.length}`);
    if (missing.length) {
      console.log(`\nbricks missing context:`);
      for (const r of missing) {
        console.log(`  · ${r.brick ?? '<unknown>'}  (${r.manifest})  events_in_window=${r.events_in_window} lifetime=${r.lifetime_events ?? 0}`);
      }
      console.log(`\nfix with:`);
      for (const r of missing) {
        if (!r.brick) continue;
        console.log(`  node tools/sma-context.ts append --project ${args.project} --brick ${r.brick} --kind edit_applied --intent "<what you did>" --decision "<why>"`);
      }
    }
  }

  if (missing.length && args.strict) exit(3);
}

function runAudit() {
  requireArg('project', '--project');
  const root = projectRoot(args.project);
  const manifests = findAllManifests(root);
  const rows = [];
  for (const path of manifests) {
    const brickId = readBrickId(path);
    if (!brickId) continue;
    const events = readContextLog(args.project, brickId);
    rows.push({
      brick: brickId,
      manifest: relative(root, path),
      lifetime_events: events.length,
      last_event_at: events.length ? events[events.length - 1].timestamp : null,
    });
  }
  rows.sort((a, b) => a.lifetime_events - b.lifetime_events);
  if (args.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(`${pad('brick', 70)} ${pad('events', 8)} last_event`);
  console.log('-'.repeat(120));
  for (const r of rows) {
    console.log(`${pad(r.brick, 70)} ${pad(String(r.lifetime_events), 8)} ${r.last_event_at ?? '(none)'}`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function listModifiedManifests(root, since) {
  // If `since` looks like a git ref, use git diff; otherwise git status.
  const isRef = since && !/^\d{4}-\d{2}-\d{2}/.test(since);
  try {
    if (isRef) {
      const out = execFileSync('git', ['diff', '--name-only', `${since}...HEAD`], { cwd: root, encoding: 'utf8' });
      return out.split('\n')
        .filter((p) => p.endsWith('module.sweetspot.json') || p.endsWith('build.sweetspot.json'))
        .map((p) => resolve(root, p))
        .filter(existsSync);
    }
    // Untracked + modified
    const out = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    const paths = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const file = line.slice(3); // skip status flags
      if (file.endsWith('module.sweetspot.json') || file.endsWith('build.sweetspot.json')) {
        paths.push(resolve(root, file));
      }
    }
    return paths.filter(existsSync);
  } catch {
    // git not available or not a repo. Fall back to scanning all manifests
    // newer than mtime cutoff (1 day default).
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return findAllManifests(root).filter((p) => statSync(p).mtimeMs >= cutoff);
  }
}

function findAllManifests(root) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 12) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.git' || ent.name.startsWith('.next')) continue;
      const full = resolve(dir, ent.name);
      if (ent.isDirectory()) walk(full, depth + 1);
      else if (ent.isFile() && (ent.name === 'module.sweetspot.json' || ent.name === 'build.sweetspot.json')) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

function readBrickId(manifestPath) {
  try {
    const data = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return data?.brick?.id ?? data?.build?.id ?? null;
  } catch {
    return null;
  }
}

function computeWindowStart(since, maxAgeMinutes) {
  if (since && /^\d{4}-\d{2}-\d{2}/.test(since)) return Date.parse(since);
  if (maxAgeMinutes) return Date.now() - Number(maxAgeMinutes) * 60 * 1000;
  return Date.now() - 24 * 60 * 60 * 1000;
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
  const out: Record<string, any> = {};
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
