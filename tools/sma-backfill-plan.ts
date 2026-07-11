#!/usr/bin/env node
/**
 * WHAT: Selects and ranks the most valuable bricks for provenance backfill.
 * WHY: Large portfolios need a deterministic work order instead of attempting every brick blindly.
 * HOW: Scores registry records with dependency, status, recency, and source-resolution evidence.
 * INPUTS: The portfolio registry, dependents index, filters, score threshold, phase, and limit.
 * OUTPUTS: A persisted backfill plan or human-readable plan statistics and previews.
 * CALLERS: Backfill operators generate this plan before passing it to the run command.
 * @example node tools/sma-backfill-plan.ts --help
 */
/**
 * sma-backfill-plan.ts — selects the bricks-that-matter and emits a
 * deterministic backfill plan.
 *
 * Reads:
 *   scans/all-projects/latest.registry.json     (full brick registry, ~3500)
 *   registry/dependents.generated.json           (inverted dependents index)
 *
 * Writes (default):
 *   handoffs/backfill/plan.generated.json
 *
 * Subcommands:
 *   generate [--limit 500] [--phase N] [--project <id>] [--status <s>]
 *            [--min-composite-score <n>] [--out <path>]
 *
 *   show     --plan <path> [--top 20] [--json]
 *
 *   stats    --plan <path> [--json]
 *
 * Selection: composite_score from a weighted signal table. See
 * See docs/MULTI_AGENT_OPERATIONS.md for the operating model.
 *
 * The plan file does NOT include the actual git commit lookup — that's done
 * lazily by sma-backfill-run.ts to keep planning fast and deterministic.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { argv, exit } from 'node:process';
import { execFileSync } from 'node:child_process';
import { resolveBrickPath } from './lib/source-path-resolver.ts';
import { resolveProjectRoot as canonicalProjectRoot } from './lib/project-paths.ts';
import {  SMA_ROOT } from "./lib/sma-paths.ts";
import type { GlobalRegistry } from './lib/schema-types/global.registry.schema.d.ts';

type RegistryBrick = GlobalRegistry['bricks'][number] & { test_commands?: string[] };
interface CliArgs { json?: boolean; limit?: string; minCompositeScore?: string; out?: string; phase?: string; plan?: string; project?: string; registry?: string; status?: string; top?: string }
interface Signal { name: string; weight: number }
interface PlanBrick { composite_score: number; data_classes: string[]; id: string; kind?: string; manifest_path?: string; name?: string; phase?: number; project: string; score: number | null; signals: Signal[]; source_paths: string[]; status?: string }
interface RecencyCache { entries: Record<string, Recency>; generated_at: string; schema_version: string }
type Recency = 'lt90' | 'lt365' | 'old' | 'no-git' | 'unknown';
interface ResolvedPath { gitRelativePath: string; source: string }

const DEFAULT_REGISTRY = resolve(SMA_ROOT, 'scans/all-projects/latest.registry.json');
const DEFAULT_DEPENDENTS = resolve(SMA_ROOT, 'registry/dependents.generated.json');
const DEFAULT_OUT = resolve(SMA_ROOT, 'handoffs/backfill/plan.generated.json');
const RECENCY_CACHE_PATH = resolve(SMA_ROOT, 'handoffs/backfill/recency-cache.json');

const PRIORITY_TIER = new Set([
  'acme-desktop', 'acme-factory', 'acme-studio', 'acme-cms', 'acme-travel',
]);

const TOP10_BY_BRICK_COUNT = new Set([
  'acme-desktop', 'acme-studio', 'acme-factory', 'acme-agent',
  'acme-mcc', 'acme-agent-standalone', 'acme-labs', 'acme-cleaner', 'acme-strudel',
]);

// Lazy-loaded recency cache (declared up here to avoid TDZ when reached
// from the top-level switch via scoreBrick → checkRecency).
let recencyCache: RecencyCache | null = null;

const cmd = argv[2];
const args = parseArgs(argv.slice(3));

try {
  switch (cmd) {
    case 'generate':
      runGenerate();
      break;
    case 'show':
      runShow();
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
} catch (err: unknown) {
  console.error(`sma-backfill-plan: ${err instanceof Error ? err.message : String(err)}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-backfill-plan.ts generate [--limit 500] [--phase <n>] [--project <id>]
                                 [--status <s>] [--min-composite-score <n>]
                                 [--registry <path>] [--out <path>]
  sma-backfill-plan.ts show     --plan <path> [--top 20] [--json]
  sma-backfill-plan.ts stats    --plan <path> [--json]
`);
}

function runGenerate() {
  const registryPath = args.registry ? resolve(args.registry) : DEFAULT_REGISTRY;
  if (!existsSync(registryPath)) throw new Error(`registry not found: ${registryPath}`);
  const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as GlobalRegistry;
  const dependents: { dependents?: Record<string, unknown>; dependents_by_source_brick?: Record<string, unknown> } = existsSync(DEFAULT_DEPENDENTS)
    ? JSON.parse(readFileSync(DEFAULT_DEPENDENTS, 'utf8')) as { dependents?: Record<string, unknown>; dependents_by_source_brick?: Record<string, unknown> }
    : { dependents_by_source_brick: {} };

  const dependentsByBrick = buildDependentsLookup(dependents);
  const limit = Number(args.limit ?? 500);
  const minScore = Number(args.minCompositeScore ?? 0);

  const allBricks = Array.isArray(registry.bricks) ? registry.bricks : [];

  /** @type {Array<{
   * id: any,
   * name: any,
   * kind: any,
   * status: any,
   * project: any,
   * score: any,
   * manifest_path: any,
   * source_paths: any[],
   * data_classes: any[],
   * composite_score: number,
   * signals: any[],
   * phase?: number
   * }>} */
  const ranked: PlanBrick[] = [];
  for (const brick of allBricks) {
    if (args.project && brick.project !== args.project) continue;
    if (args.status && brick.status !== args.status) continue;
    const evaluation = scoreBrick(brick, dependentsByBrick);
    if (evaluation.excluded) continue;
    if (evaluation.composite_score < minScore) continue;
    ranked.push({
      id: brick.id,
      name: brick.name,
      kind: brick.kind,
      status: brick.status,
      project: brick.project ?? 'unknown',
      score: brick.score ?? null,
      manifest_path: brick.manifest_path,
      source_paths: brick.source_paths ?? [],
      data_classes: brick.data_classes ?? [],
      composite_score: evaluation.composite_score,
      signals: evaluation.signals,
    });
  }

  // Stable sort: composite_score desc, then id asc for determinism.
  ranked.sort((a, b) => {
    if (b.composite_score !== a.composite_score) return b.composite_score - a.composite_score;
    return a.id.localeCompare(b.id);
  });

  const selected = ranked.slice(0, Number.isFinite(limit) && limit > 0 ? limit : ranked.length);

  // Phase assignment (1-4): defined in the ultraplan.
  for (let i = 0; i < selected.length; i++) {
    const b = selected[i];
    if (b.status === 'canonical' || (i < 50 && PRIORITY_TIER.has(b.project))) b.phase = 1;
    else if (i < 250) b.phase = 2;
    else if (i < 500) b.phase = 3;
    else b.phase = 4;
  }

  const filteredByPhase = args.phase
    ? selected.filter((b) => String(b.phase) === String(args.phase))
    : selected;

  const plan = {
    schema_version: '1.0.0',
    generated_at: new Date().toISOString(),
    registry: registryPath,
    selection: {
      considered: allBricks.length,
      after_filters: ranked.length,
      selected: filteredByPhase.length,
      limit,
      min_composite_score: minScore,
      project_filter: args.project ?? null,
      status_filter: args.status ?? null,
      phase_filter: args.phase ? Number(args.phase) : null,
    },
    by_phase: bucket(selected, 'phase'),
    by_status: bucket(selected, 'status'),
    by_project_top: topBucket(selected, 'project', 12),
    bricks: filteredByPhase,
  };

  const outPath = args.out ? resolve(args.out) : DEFAULT_OUT;
  if (!existsSync(dirname(outPath))) mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(plan, null, 2) + '\n');
  saveRecencyCache();

  if (args.json) {
    console.log(JSON.stringify(plan.selection, null, 2));
  } else {
    console.log(`wrote ${outPath}`);
    console.log(`considered:       ${String(plan.selection.considered)}`);
    console.log(`after filters:    ${String(plan.selection.after_filters)}`);
    console.log(`selected:         ${String(plan.selection.selected)}`);
    console.log(`by phase:         ${JSON.stringify(plan.by_phase)}`);
    console.log(`by status:        ${JSON.stringify(plan.by_status)}`);
  }
}

function runShow() {
  requireArg('plan', '--plan');
  const plan = JSON.parse(readFileSync(resolve(args.plan ?? ''), 'utf8')) as { bricks: PlanBrick[] };
  const top = Number(args.top ?? 20);
  const rows = plan.bricks.slice(0, Math.max(top, 0));
  if (args.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log(`top ${String(rows.length)} of ${String(plan.bricks.length)}:`);
  console.log(`${pad('rank', 5)} ${pad('score', 6)} ${pad('phase', 6)} ${pad('status', 14)} ${pad('project', 22)} ${pad('id', 60)} signals`);
  console.log('-'.repeat(160));
  rows.forEach((b, i) => {
    console.log(
      `${pad(String(i + 1), 5)} ${pad(String(b.composite_score), 6)} ${pad(String(b.phase), 6)} ${pad(b.status, 14)} ${pad(b.project, 22)} ${pad(b.id, 60)} ${b.signals.map((s) => `${s.name}+${String(s.weight)}`).join(',')}`,
    );
  });
}

function runStats() {
  requireArg('plan', '--plan');
  const plan = JSON.parse(readFileSync(resolve(args.plan ?? ''), 'utf8')) as { bricks: PlanBrick[]; selection: unknown };
  const stats = {
    selection: plan.selection,
    by_phase: bucket(plan.bricks, 'phase'),
    by_status: bucket(plan.bricks, 'status'),
    by_project_top: topBucket(plan.bricks, 'project', 15),
    by_kind: bucket(plan.bricks, 'kind'),
    score_distribution: histogram(plan.bricks.map((b) => b.composite_score), [60, 100, 140, 180, 220]),
  };
  if (args.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }
  console.log(JSON.stringify(stats, null, 2));
}

// ── scoring ──────────────────────────────────────────────────────────────────

function scoreBrick(brick: RegistryBrick, dependentsByBrick: Map<string, number>): { composite_score: number; excluded: boolean; signals: Signal[] } {
  const signals: Signal[] = [];
  let composite = 0;
  let excluded = false;

  // Status
  switch (brick.status) {
    case 'canonical': add('status:canonical', 100); break;
    case 'candidate': add('status:candidate', 60); break;
    case 'variant':   add('status:variant', 30); break;
    case 'experimental': add('status:experimental', 10); break;
    case 'legacy':
    case 'duplicate':
      excluded = true;
      signals.push({ name: `status:${brick.status}`, weight: -100 });
      composite -= 100;
      break;
    default: /* unknown: 0 */ break;
  }

  // Score band
  const score = (brick.score ?? 0);
  if (score >= 80) add('score:80+', 40);
  else if (score >= 60) add('score:60-79', 30);
  else if (score >= 40) add('score:40-59', 15);
  else if (score >= 20) add('score:20-39', 5);

  // Project priority
  if (brick.project && PRIORITY_TIER.has(brick.project)) add('project:priority-tier', 30);
  else if (brick.project && TOP10_BY_BRICK_COUNT.has(brick.project)) add('project:top10', 15);

  // Dependents
  const dependents = dependentsByBrick.get(brick.id) ?? 0;
  if (dependents > 0) add(`dependents:${String(dependents)}`, 25);

  // Tests
  const testCommands = Array.isArray(brick.test_commands) ? brick.test_commands.length : 0;
  if (testCommands > 0) add('tests:declared', 15);

  // Multiple source paths
  const srcCount = Array.isArray(brick.source_paths) ? brick.source_paths.length : 0;
  if (srcCount > 1) add('source_paths:>1', 5);

  // Source path resolvable on disk (manifest-path-derived; falls back to
  // source_paths[0] direct, then prefix-stripped).
  let resolvedPath = null;
  if (!srcCount && !brick.manifest_path) {
    excluded = true;
    signals.push({ name: 'source_path:missing', weight: -200 });
    composite -= 200;
  } else {
    const projectAbs = resolveProjectRootSync(brick.project);
    if (!projectAbs) {
      excluded = true;
      signals.push({ name: 'project:not-found', weight: -200 });
      composite -= 200;
    } else {
      resolvedPath = resolveBrickPath(brick, projectAbs);
      if (!resolvedPath) {
        excluded = true;
        signals.push({ name: 'source_path:not-on-disk', weight: -200 });
        composite -= 200;
      } else if (resolvedPath.source !== 'manifest' && resolvedPath.source !== 'src-direct') {
        // Track that we used a fallback (doubled-prefix strip)
        add('source_path:resolved-via-fallback', 0);
      }
    }
  }

  // Recency (one cheap git check per brick using the resolved git-relative path)
  if (!excluded && resolvedPath) {
    const recency = checkRecency(brick, resolvedPath);
    if (recency === 'lt90') add('recency:<90d', 30);
    else if (recency === 'lt365') add('recency:<365d', 15);
    else if (recency === 'old') add('recency:>365d', 0);
    // 'unknown' / 'no-git' → no signal
  }

  return { composite_score: composite, signals, excluded };

  function add(name: string, weight: number) {
    signals.push({ name, weight });
    composite += weight;
  }
}

// Single source of truth — delegates to lib/project-paths.ts which mirrors
// the portfolio override map. Adding a new project: edit project-paths.ts.
function resolveProjectRootSync(projectId: string|null|undefined) {
  return canonicalProjectRoot(projectId);
}

// Cached recency lookup. Cache key: project|gitPath. Cache value: 'lt90' |
// 'lt365' | 'old' | 'no-git' | 'unknown'. Persists to handoffs/backfill/
// recency-cache.json so subsequent regenerates skip the per-brick git log.
function loadRecencyCache(): RecencyCache {
  if (recencyCache) return recencyCache;
  if (existsSync(RECENCY_CACHE_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(RECENCY_CACHE_PATH, 'utf8')) as RecencyCache;
      // Honor a TTL of 7 days — git history could acquire new commits that move
      // a brick from 'old' → 'lt90'. Recompute on stale cache.
      const ageMs = Date.now() - Date.parse(raw.generated_at || '1970-01-01T00:00:00Z');
      if (Number.isFinite(ageMs) && ageMs < 7 * 86400000) {
        recencyCache = raw;
        return recencyCache;
      }
    } catch { /* fall through */ }
  }
  recencyCache = { schema_version: '1.0.0', generated_at: new Date().toISOString(), entries: {} };
  return recencyCache;
}
function saveRecencyCache(): void {
  if (!recencyCache) return;
  recencyCache.generated_at = new Date().toISOString();
  if (!existsSync(dirname(RECENCY_CACHE_PATH))) mkdirSync(dirname(RECENCY_CACHE_PATH), { recursive: true });
  writeFileSync(RECENCY_CACHE_PATH, JSON.stringify(recencyCache, null, 2) + '\n');
}

function checkRecency(brick: RegistryBrick, resolvedPath: ResolvedPath): Recency {
  const projectAbs = resolveProjectRootSync(brick.project);
  if (!projectAbs) return 'unknown';
  const gitPath = resolvedPath.gitRelativePath;
  if (!gitPath) return 'unknown';

  const cache = loadRecencyCache();
  const key = `${String(brick.project)}|${gitPath}`;
  if (cache.entries[key] !== undefined) return cache.entries[key];

  let result: Recency = 'no-git';
  try {
    const lt90 = execFileSync('git',
      ['log', '--since=90.days.ago', '-n', '1', '--pretty=%H', '--', gitPath],
      { cwd: projectAbs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (lt90) {
      result = 'lt90';
    } else {
      const lt365 = execFileSync('git',
        ['log', '--since=365.days.ago', '-n', '1', '--pretty=%H', '--', gitPath],
        { cwd: projectAbs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      result = lt365 ? 'lt365' : 'old';
    }
  } catch {
    result = 'no-git';
  }
  cache.entries[key] = result;
  return result;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function buildDependentsLookup(dependentsIndex: { dependents?: Record<string, unknown>; dependents_by_source_brick?: Record<string, unknown> }): Map<string, number> {
  const out = new Map<string, number>();
  const entries = dependentsIndex.dependents_by_source_brick
    ?? dependentsIndex.dependents
    ?? {};
  for (const [brickId, deps] of Object.entries(entries)) {
    const count = Array.isArray(deps) ? deps.length : Object.keys(deps ?? {}).length;
    if (count) out.set(brickId, count);
  }
  return out;
}

function bucket<T>(arr: T[], key: keyof T): Record<string, number> {
  return arr.reduce<Record<string, number>>((counts, entry) => {
    const label = String(entry[key] ?? 'unknown');
    counts[label] = (counts[label] ?? 0) + 1;
    return counts;
  }, {});
}

function topBucket<T>(arr: T[], key: keyof T, n: number): Record<string, number> {
  const all: Record<string, number> = bucket(arr, key);
  return Object.fromEntries(Object.entries(all).sort((a, b) => b[1] - a[1]).slice(0, n));
}

function histogram(values: number[], edges: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    const band = edges.find((e: number) => v < e) ?? `>=${String(edges[edges.length - 1])}`;
    const label = typeof band === 'number' ? `<${String(band)}` : band;
    out[label] = (out[label] ?? 0) + 1;
  }
  return out;
}

function requireArg(key: keyof CliArgs, flag: string): void {
  if (args[key] === undefined || args[key] === null || args[key] === '') {
    throw new Error(`missing ${flag}`);
  }
}

function pad(s: unknown, n: number|undefined) {
  const width = n ?? 0;
  return String(s ?? '').slice(0, width).padEnd(width);
}

function parseArgs(list: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_, character: string) => character.toUpperCase()) as keyof CliArgs;
    const next = list[i + 1];
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) {
      if (camel === 'json') out.json = true;
      continue;
    }
    if (camel !== 'json') out[camel] = next;
    i += 1;
  }
  return out;
}
