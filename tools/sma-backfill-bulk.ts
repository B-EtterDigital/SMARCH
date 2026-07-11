#!/usr/bin/env node
/**
 * WHAT: Applies reviewed provenance intents to many bricks or prepares templates for missing intents.
 * WHY: Bricks without usable history cannot be backfilled automatically one at a time.
 * HOW: Parses comma-separated or structured intent files and delegates each accepted row to the touch tool.
 * INPUTS: An intent file or failure report, optional registry and project filters, and dry-run controls.
 * OUTPUTS: Per-row results, reusable templates, statistics, and optional manifest and context updates.
 * CALLERS: Backfill operators use this after the automated history pass leaves unresolved bricks.
 * @example node tools/sma-backfill-bulk.ts --help
 */
/**
 * sma-backfill-bulk.ts — apply hand-written touch_event intents to many
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
const TOUCH_TOOL = resolve(TOOLS_DIR, 'sma-touch-backfill.ts');
const SMA_ROOT = resolve(TOOLS_DIR, '..');
const DEFAULT_REGISTRY = resolve(SMA_ROOT, 'scans/all-projects/latest.registry.json');

interface BulkArgs {
  input?: string;
  registry?: string;
  dryRun?: boolean;
  limit?: string;
  project?: string;
  noContext?: boolean;
  report?: string;
  out?: string;
  csvOut?: boolean;
}
type BulkRow = Record<string, string>;
interface RegistryBrick { id: string; project: string; manifest_path: string }
interface BulkResults { processed: number; applied: number; skipped: number; failed: number; missing_brick: number; by_project: Record<string, number> }
interface ApplyContext { byId: Map<string, RegistryBrick>; results: BulkResults; dryRun: boolean; projectFilter: string | null; noContext: boolean }

const cmd = argv.at(2);
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
  console.error(`sma-backfill-bulk: ${err instanceof Error ? err.message : String(err)}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-backfill-bulk.ts apply --input <path.{json,csv}> [--registry <path>]
                              [--dry-run] [--limit <n>] [--project <id>]
                              [--no-context]
  sma-backfill-bulk.ts template-from-failures --report <failures.json>
                              --out <path.json> [--csv-out]
  sma-backfill-bulk.ts stats --input <path>
`);
}

// ── apply ────────────────────────────────────────────────────────────────────

function runApply() {
  requireArg('input', '--input');
  const rows = loadRows(String(args.input));
  console.log(`[bulk] loaded ${String(rows.length)} rows from ${String(args.input)}`);
  const registryPath = args.registry ? resolve(args.registry) : DEFAULT_REGISTRY;
  if (!existsSync(registryPath)) throw new Error(`registry not found: ${registryPath}`);
  const byId = readRegistryBricks(registryPath);

  const limit = args.limit ? Number(args.limit) : Infinity;
  const dryRun = !!args.dryRun;
  const projectFilter = args.project ?? null;
  const noContext = !!args.noContext;

  const results: BulkResults = { processed: 0, applied: 0, skipped: 0, failed: 0, missing_brick: 0, by_project: {} };
  const context: ApplyContext = { byId, results, dryRun, projectFilter, noContext };
  let i = 0;
  for (const row of rows) {
    if (results.processed >= limit) break;
    applyBulkRow(row, i, context);
    i += 1;

    if (results.processed > 0 && results.processed % 50 === 0) {
      console.log(`[bulk] ${String(results.processed)}/${String(rows.length)} processed (${String(results.applied)} applied, ${String(results.failed)} failed)`);
    }
  }

  console.log('');
  console.log(`[bulk] DONE`);
  console.log(`[bulk] processed:      ${String(results.processed)}`);
  console.log(`[bulk] applied:        ${String(results.applied)}`);
  console.log(`[bulk] skipped:        ${String(results.skipped)}`);
  console.log(`[bulk] missing brick:  ${String(results.missing_brick)}`);
  console.log(`[bulk] failed:         ${String(results.failed)}`);
  console.log(`[bulk] by project:`, results.by_project);
}

function applyBulkRow(row: BulkRow, index: number, context: ApplyContext) {
  const brickId = row.brick_id || row.brick;
  if (!brickId) {
    recordRowFailure(context.results, index, 'missing brick_id');
    return;
  }
  if (!row.intent || row.intent.length < 4) {
    recordRowFailure(context.results, index, 'intent missing or too short');
    return;
  }
  const brick = context.byId.get(brickId);
  if (!brick) {
    context.results.missing_brick += 1;
    console.error(`row ${String(index)}: brick not in registry: ${brickId}`);
    return;
  }
  const project = row.project || brick.project;
  if (context.projectFilter && project !== context.projectFilter) {
    context.results.skipped += 1;
    return;
  }
  if (context.dryRun) {
    console.log(`[dry-run] ${brickId} ← intent="${row.intent.slice(0, 60)}..."`);
    recordApplied(context.results, project);
    return;
  }
  const result = spawnSync('node', buildTouchArgs(row, brick, project, context.noContext), { encoding: 'utf8' });
  if (result.status === 0) recordApplied(context.results, project);
  else {
    context.results.failed += 1;
    console.error(`row ${String(index)} (${brickId}): touch-backfill failed:`, result.stderr.slice(0, 200));
  }
}

function buildTouchArgs(row: BulkRow, brick: RegistryBrick, project: string, noContext: boolean) {
  const actor = row.actor || (process.env.SMA_AGENT ?? process.env.USER ?? 'unknown');
  const command = [TOUCH_TOOL, 'add', '--manifest', brick.manifest_path, '--intent', row.intent, '--role', row.role || 'implementer',
    '--actor-kind', row.actor_kind || 'human', '--actor', actor];
  if (row.model) command.push('--model', row.model);
  if (row.decision) command.push('--decision', row.decision);
  for (const rejected of splitValues(row.rejected)) command.push('--rejected', rejected);
  for (const backlog of splitValues(row.linked_backlog)) command.push('--linked-backlog', backlog);
  if (!noContext) command.push('--project', project);
  else command.push('--no-context');
  return command;
}

function splitValues(value: string | undefined) {
  return value ? value.split(';').map((item) => item.trim()).filter(Boolean) : [];
}

function recordApplied(results: BulkResults, project: string) {
  results.applied += 1;
  results.processed += 1;
  results.by_project[project] = (results.by_project[project] ?? 0) + 1;
}

function recordRowFailure(results: BulkResults, index: number, message: string) {
  results.failed += 1;
  console.error(`row ${String(index)}: ${message}`);
}

// ── template-from-failures ──────────────────────────────────────────────────

function runTemplateFromFailures() {
  requireArg('report', '--report');
  requireArg('out', '--out');
  const failures = readFailureReport(resolve(String(args.report)));
  const rows: BulkRow[] = failures
    .filter((failure) => failure.reason === 'no-git-history-for-source-path')
    .map((failure) => {
      const project = (failure.brick ?? '').split('.')[0];
      return {
        brick_id: failure.brick ?? '',
        project,
        intent: `manual: bootstrap touch_event for ${failure.brick ?? ''} (no git history available)`,
        role: 'implementer',
        actor_kind: 'human',
        decision: '',
        rejected: '',
        linked_backlog: '',
      };
    });
  const outPath = resolve(String(args.out));
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
  console.log(`wrote ${String(rows.length)} rows to ${outPath}`);
  console.log('Edit the intent column for each row, then run:');
  console.log(`  sma backfill-bulk apply --input ${outPath}`);
}

// ── stats ────────────────────────────────────────────────────────────────────

function runStats() {
  requireArg('input', '--input');
  const rows = loadRows(String(args.input));
  const byProject: Record<string, number> = {}, byRole: Record<string, number> = {}, withIntent = rows.filter((r) => r.intent && r.intent.length >= 4).length;
  for (const r of rows) {
    const proj = r.project || '?';
    byProject[proj] = (byProject[proj] ?? 0) + 1;
    byRole[r.role || 'implementer'] = (byRole[r.role || 'implementer'] ?? 0) + 1;
  }
  console.log(`total:           ${String(rows.length)}`);
  console.log(`with intent ≥4:  ${String(withIntent)}`);
  console.log('');
  console.log('by project:');
  for (const [k, v] of Object.entries(byProject).sort((a, b) => b[1] - a[1])) console.log(`  ${pad(k, 28)} ${String(v)}`);
  console.log('');
  console.log('by role:');
  for (const [k, v] of Object.entries(byRole).sort((a, b) => b[1] - a[1])) console.log(`  ${pad(k, 28)} ${String(v)}`);
}

// ── i/o ──────────────────────────────────────────────────────────────────────

function loadRows(path: string): BulkRow[] {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`input not found: ${abs}`);
  const ext = extname(abs).toLowerCase();
  if (ext === '.json') {
    const data: unknown = JSON.parse(readFileSync(abs, 'utf8'));
    if (!Array.isArray(data)) throw new Error('JSON input must be an array');
    return data.map(parseBulkRow);
  }
  if (ext === '.csv') {
    return parseCsv(readFileSync(abs, 'utf8'));
  }
  throw new Error(`unsupported input format: ${ext}`);
}

function parseBulkRow(value: unknown): BulkRow {
  if (!isRecord(value)) throw new Error('every bulk row must be an object');
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key,
    typeof field === 'string' || typeof field === 'number' || typeof field === 'boolean' ? String(field) : '']));
}

function readRegistryBricks(filePath: string) {
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!isRecord(parsed) || !Array.isArray(parsed.bricks)) throw new Error(`invalid registry: ${filePath}`);
  const bricks = parsed.bricks.map(parseRegistryBrick).filter((brick): brick is RegistryBrick => brick !== null);
  return new Map(bricks.map((brick): [string, RegistryBrick] => [brick.id, brick]));
}

function parseRegistryBrick(value: unknown): RegistryBrick | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.project !== 'string' || typeof value.manifest_path !== 'string') return null;
  return { id: value.id, project: value.project, manifest_path: value.manifest_path };
}

function readFailureReport(filePath: string): { reason?: string; brick?: string }[] {
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!isRecord(parsed) || !Array.isArray(parsed.failures)) return [];
  return parsed.failures.filter(isRecord).map((failure) => ({
    reason: typeof failure.reason === 'string' ? failure.reason : undefined,
    brick: typeof failure.brick === 'string' ? failure.brick : undefined,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseCsv(text: string): BulkRow[] {
  const lines = text.split('\n').filter((l: string) => l.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  const rows: BulkRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: BulkRow = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? '';
    }
    rows.push(row);
  }
  return rows;
}

function parseCsvLine(line: string) {
  const out: string[] = [];
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

function csvEscape(s: unknown) {
  const v = typeof s === 'string' || typeof s === 'number' ? String(s) : '';
  if (v.includes('"') || v.includes(',') || v.includes('\n')) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

function requireArg(key: keyof BulkArgs, flag: string) {
  if (args[key] === undefined || args[key] === '') {
    throw new Error(`missing ${flag}`);
  }
}

function pad(s: string, n: number) { return s.slice(0, n).padEnd(n); }

function parseArgs(list: string[]): BulkArgs {
  const out: BulkArgs = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_match: string, character: string) => character.toUpperCase());
    const next = list.at(i + 1);
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) {
      if (camel === 'dryRun' || camel === 'noContext' || camel === 'csvOut') out[camel] = true;
      continue;
    }
    if (camel === 'input' || camel === 'registry' || camel === 'limit' || camel === 'project'
      || camel === 'report' || camel === 'out') out[camel] = next;
    i += 1;
  }
  return out;
}
