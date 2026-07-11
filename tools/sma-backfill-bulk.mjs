#!/usr/bin/env node
/**
 * WHAT: Applies reviewed provenance intents to many bricks or prepares templates for missing intents.
 * WHY: Bricks without usable history cannot be backfilled automatically one at a time.
 * HOW: Parses comma-separated or structured intent files and delegates each accepted row to the touch tool.
 * INPUTS: An intent file or failure report, optional registry and project filters, and dry-run controls.
 * OUTPUTS: Per-row results, reusable templates, statistics, and optional manifest and context updates.
 * CALLERS: Backfill operators use this after the automated history pass leaves unresolved bricks.
 * @example node tools/sma-backfill-bulk.mjs --help
 */
/**
 * sma-backfill-bulk.mjs — apply hand-written touch_event intents to many
 * bricks at once. The fix for bricks with no git history (the 255 leftover
 * Category-A/B/C failures from the main backfill).
 *
 * Input formats:
 *   JSON (.json):  array of objects [{ brick_id, intent, ... }]
 *   CSV  (.csv):   first row = headers; comma-separated; supports quoted fields
 *
 * Required columns/fields:
 *   brick_id    or  brick    — the registry brick id
 *   intent                   — what the touch_event should record
 *
 * Optional columns/fields:
 *   role                     — implementer | architect | reviewer | refactor | release | scanner | tester | security
 *                              (default: implementer)
 *   actor_kind               — human | ai_model | agent | automation | tool   (default: human)
 *   actor                    — actor id; defaults to $SMA_AGENT or $USER
 *   model                    — model name when actor_kind=ai_model
 *   decision                 — decision_rationale
 *   rejected                 — semicolon-separated "alt::reason" pairs
 *   linked_backlog           — semicolon-separated backlog ids
 *   project                  — overrides registry's project lookup
 *
 * Subcommands:
 *   apply --input <path> [--registry <path>] [--dry-run] [--limit <n>]
 *         [--project <id>] [--no-context]
 *
 *   template-from-failures --report <handoffs/backfill/...failures.json>
 *                          --out <path.json>  (or --csv-out for CSV)
 *         → emits a stub input file with one row per failure, intent prefilled
 *           from a placeholder. Edit it, then run `apply --input <stub>`.
 *
 *   stats --input <path>     → counts rows by project + role; sanity check
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { argv, exit } from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const TOUCH_TOOL = resolve(TOOLS_DIR, 'sma-touch-backfill.mjs');
const SMA_ROOT = resolve(TOOLS_DIR, '..');
const DEFAULT_REGISTRY = resolve(SMA_ROOT, 'scans/all-projects/latest.registry.json');

const cmd = argv[2];
const args = parseArgs(argv.slice(3));

try {
  switch (cmd) {
    case 'apply':
      runApply();
      break;
    case 'template-from-failures':
      runTemplateFromFailures();
      break;
    case 'stats':
      runStats();
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
  console.error(`sma-backfill-bulk: ${err.message}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-backfill-bulk.mjs apply --input <path.{json,csv}> [--registry <path>]
                              [--dry-run] [--limit <n>] [--project <id>]
                              [--no-context]
  sma-backfill-bulk.mjs template-from-failures --report <failures.json>
                              --out <path.json> [--csv-out]
  sma-backfill-bulk.mjs stats --input <path>
`);
}

// ── apply ────────────────────────────────────────────────────────────────────

function runApply() {
  requireArg('input', '--input');
  const rows = loadRows(args.input);
  console.log(`[bulk] loaded ${rows.length} rows from ${args.input}`);
  const registryPath = args.registry ? resolve(args.registry) : DEFAULT_REGISTRY;
  if (!existsSync(registryPath)) throw new Error(`registry not found: ${registryPath}`);
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const byId = new Map();
  for (const b of registry.bricks || []) byId.set(b.id, b);

  const limit = args.limit ? Number(args.limit) : Infinity;
  const dryRun = !!args.dryRun;
  const projectFilter = args.project ?? null;
  const noContext = !!args.noContext;

  const results = { processed: 0, applied: 0, skipped: 0, failed: 0, missing_brick: 0, by_project: {} };
  let i = 0;
  for (const row of rows) {
    if (results.processed >= limit) break;
    const brickId = row.brick_id || row.brick;
    if (!brickId) { results.failed += 1; console.error(`row ${i}: missing brick_id`); i += 1; continue; }
    if (!row.intent || String(row.intent).length < 4) { results.failed += 1; console.error(`row ${i}: intent missing or too short`); i += 1; continue; }
    const brick = byId.get(brickId);
    if (!brick) { results.missing_brick += 1; console.error(`row ${i}: brick not in registry: ${brickId}`); i += 1; continue; }

    const project = row.project || brick.project;
    if (projectFilter && project !== projectFilter) { results.skipped += 1; i += 1; continue; }

    if (dryRun) {
      console.log(`[dry-run] ${brickId} ← intent="${String(row.intent).slice(0, 60)}..."`);
      results.processed += 1;
      results.applied += 1;
      results.by_project[project] = (results.by_project[project] ?? 0) + 1;
      i += 1;
      continue;
    }

    const role = row.role || 'implementer';
    const actorKind = row.actor_kind || 'human';
    const actor = row.actor || process.env.SMA_AGENT || process.env.USER || 'unknown';

    const cmdArgs = [
      TOUCH_TOOL, 'add',
      '--manifest', brick.manifest_path,
      '--intent', String(row.intent),
      '--role', role,
      '--actor-kind', actorKind,
      '--actor', actor,
    ];
    if (row.model) cmdArgs.push('--model', row.model);
    if (row.decision) cmdArgs.push('--decision', String(row.decision));
    if (row.rejected) {
      for (const r of String(row.rejected).split(';').map((x) => x.trim()).filter(Boolean)) {
        cmdArgs.push('--rejected', r);
      }
    }
    if (row.linked_backlog) {
      for (const b of String(row.linked_backlog).split(';').map((x) => x.trim()).filter(Boolean)) {
        cmdArgs.push('--linked-backlog', b);
      }
    }
    if (project && !noContext) cmdArgs.push('--project', project);
    if (noContext) cmdArgs.push('--no-context');

    const res = spawnSync('node', cmdArgs, { encoding: 'utf8' });
    if (res.status === 0) {
      results.applied += 1;
      results.processed += 1;
      results.by_project[project] = (results.by_project[project] ?? 0) + 1;
    } else {
      results.failed += 1;
      console.error(`row ${i} (${brickId}): touch-backfill failed:`, (res.stderr || '').slice(0, 200));
    }
    i += 1;

    if (results.processed > 0 && results.processed % 50 === 0) {
      console.log(`[bulk] ${results.processed}/${rows.length} processed (${results.applied} applied, ${results.failed} failed)`);
    }
  }

  console.log('');
  console.log(`[bulk] DONE`);
  console.log(`[bulk] processed:      ${results.processed}`);
  console.log(`[bulk] applied:        ${results.applied}`);
  console.log(`[bulk] skipped:        ${results.skipped}`);
  console.log(`[bulk] missing brick:  ${results.missing_brick}`);
  console.log(`[bulk] failed:         ${results.failed}`);
  console.log(`[bulk] by project:`, results.by_project);
}

// ── template-from-failures ──────────────────────────────────────────────────

function runTemplateFromFailures() {
  requireArg('report', '--report');
  requireArg('out', '--out');
  const data = JSON.parse(readFileSync(resolve(args.report), 'utf8'));
  const failures = data.failures || [];
  const rows = failures
    .filter((f) => f.reason === 'no-git-history-for-source-path')
    .map((f) => {
      const project = (f.brick || '').split('.')[0];
      return {
        brick_id: f.brick,
        project,
        intent: `manual: bootstrap touch_event for ${f.brick} (no git history available)`,
        role: 'implementer',
        actor_kind: 'human',
        decision: '',
        rejected: '',
        linked_backlog: '',
      };
    });
  const outPath = resolve(args.out);
  if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
  if (args.csvOut || extname(outPath) === '.csv') {
    const header = ['brick_id', 'project', 'intent', 'role', 'actor_kind', 'decision', 'rejected', 'linked_backlog'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push(header.map((h) => csvEscape(r[h] ?? '')).join(','));
    }
    writeFileSync(outPath, lines.join('\n') + '\n');
  } else {
    writeFileSync(outPath, JSON.stringify(rows, null, 2) + '\n');
  }
  console.log(`wrote ${rows.length} rows to ${outPath}`);
  console.log('Edit the intent column for each row, then run:');
  console.log(`  sma backfill-bulk apply --input ${outPath}`);
}

// ── stats ────────────────────────────────────────────────────────────────────

function runStats() {
  requireArg('input', '--input');
  const rows = loadRows(args.input);
  const byProject = {}, byRole = {}, withIntent = rows.filter((r) => r.intent && r.intent.length >= 4).length;
  for (const r of rows) {
    const proj = r.project || '?';
    byProject[proj] = (byProject[proj] ?? 0) + 1;
    byRole[r.role || 'implementer'] = (byRole[r.role || 'implementer'] ?? 0) + 1;
  }
  console.log(`total:           ${rows.length}`);
  console.log(`with intent ≥4:  ${withIntent}`);
  console.log('');
  console.log('by project:');
  for (const [k, v] of Object.entries(byProject).sort((a, b) => b[1] - a[1])) console.log(`  ${pad(k, 28)} ${v}`);
  console.log('');
  console.log('by role:');
  for (const [k, v] of Object.entries(byRole).sort((a, b) => b[1] - a[1])) console.log(`  ${pad(k, 28)} ${v}`);
}

// ── i/o ──────────────────────────────────────────────────────────────────────

function loadRows(path) {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`input not found: ${abs}`);
  const ext = extname(abs).toLowerCase();
  if (ext === '.json') {
    const data = JSON.parse(readFileSync(abs, 'utf8'));
    if (!Array.isArray(data)) throw new Error('JSON input must be an array');
    return data;
  }
  if (ext === '.csv') {
    return parseCsv(readFileSync(abs, 'utf8'));
  }
  throw new Error(`unsupported input format: ${ext}`);
}

function parseCsv(text) {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuote = false;
      else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQuote = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function csvEscape(s) {
  const v = String(s ?? '');
  if (v.includes('"') || v.includes(',') || v.includes('\n')) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

function requireArg(key, flag) {
  if (args[key] === undefined || args[key] === null || args[key] === '') {
    throw new Error(`missing ${flag}`);
  }
}

function pad(s, n) { return String(s ?? '').slice(0, n).padEnd(n); }

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
    out[camel] = next;
    i += 1;
  }
  return out;
}
