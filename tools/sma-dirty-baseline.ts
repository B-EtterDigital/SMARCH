#!/usr/bin/env node
/**
 * WHAT: Saves and compares repository dirty-state baselines outside the repository.
 * WHY: Agents need to separate their own changes from pre-existing work without adding noise.
 * HOW: Captures short repository status records and calculates later path-level deltas.
 * INPUTS: A project or root, a baseline label, and a save, delta, list, clean, or path command.
 * OUTPUTS: Cached baseline records and concise dirty-state summaries.
 * CALLERS: Edit start and end workflows plus operators auditing task ownership.
 * Usage: `node tools/sma-dirty-baseline.ts save --project sma --label example`
 */
/**
 * sma-dirty-baseline.ts — local dirty-tree baseline/delta helper.
 *
 * The cache lives outside every repo (~/.cache/sma-gen3/dirty-baselines) so the
 * act of reducing dirty status noise never creates more dirty files.
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { argv, env, exit } from 'node:process';
import { projectRoot } from './lib/context-log.ts';

const args = parseArgs(argv.slice(2));
const DEFAULT_LIMIT = 12;
const CACHE_ROOT = resolve(
  env.SMA_DIRTY_BASELINE_DIR || env.XDG_CACHE_HOME || resolve(homedir(), '.cache'),
  env.SMA_DIRTY_BASELINE_DIR ? '' : 'sma-gen3/dirty-baselines',
);

try {
  if (args.help || !args.command) {
    usage();
    exit(args.command ? 0 : 2);
  }

  switch (args.command) {
    case 'save':
    case 'start':
    case 'baseline':
      saveBaseline();
      break;
    case 'delta':
    case 'diff':
      printDelta();
      break;
    case 'list':
      listBaselines();
      break;
    case 'path':
      printCachePath();
      break;
    case 'clean':
      cleanBaselines();
      break;
    default:
      throw new Error(`unknown command: ${args.command}`);
  }
} catch (err) {
  console.error(`sma-dirty-baseline: ${err.message}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-dirty-baseline.ts save  --project <id>|--root <path> [--label <name>] [--json]
  sma-dirty-baseline.ts delta --project <id>|--root <path> [--baseline <id>] [--label <name>] [--limit <n>] [--json]
  sma-dirty-baseline.ts list  --project <id>|--root <path> [--label <name>] [--json]
  sma-dirty-baseline.ts clean --project <id>|--root <path> [--keep <n>]
  sma-dirty-baseline.ts path

Use save at task start, then delta before status/final reports. Delta prints
only new/cleared/status-changed paths plus one count for unchanged unrelated
dirty work. Baselines are local cache files outside the repo.`);
}

function saveBaseline() {
  const project = resolveProject();
  const baseline = buildBaseline(project);
  const dir = projectCacheDir(project);
  mkdirSync(dir, { recursive: true });

  const file = baselinePath(project, baseline.id);
  writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
  writeFileSync(latestPath(project, baseline.label), `${JSON.stringify({
    id: baseline.id,
    path: file,
    created_at: baseline.created_at,
    project: baseline.project,
    root: baseline.root,
    label: baseline.label,
  }, null, 2)}\n`);

  if (args.json) {
    console.log(JSON.stringify({ ok: true, baseline, path: file }, null, 2));
    return;
  }

  console.log('SMA dirty baseline saved');
  console.log(`project:        ${baseline.project}`);
  console.log(`root:           ${baseline.root}`);
  console.log(`label:          ${baseline.label}`);
  console.log(`baseline:       ${baseline.id}`);
  console.log(`dirty at start: ${formatDirtyCounts(baseline.summary)}`);
  console.log(`delta command:  npm run dirty:delta -- --project ${shellArg(baseline.project)} --baseline ${shellArg(baseline.id)}`);
}

function printDelta() {
  const project = resolveProject();
  const baseline = readBaseline(project);
  const current = buildBaseline(project, { id: 'current' });
  const delta = diffStatuses(baseline, current);
  const report = {
    ok: true,
    project: project.id,
    root: project.root,
    label: baseline.label,
    baseline_id: baseline.id,
    baseline_created_at: baseline.created_at,
    generated_at: current.created_at,
    baseline: baseline.summary,
    current: current.summary,
    delta,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const limit = numberArg(args.limit, DEFAULT_LIMIT);
  console.log('SMA dirty delta');
  console.log(`project:          ${project.id}`);
  console.log(`baseline:         ${baseline.id} (${baseline.created_at})`);
  console.log(`baseline dirty:   ${formatDirtyCounts(baseline.summary)}`);
  console.log(`current dirty:    ${formatDirtyCounts(current.summary)}`);
  console.log(`new since start:  ${delta.new.length}`);
  console.log(`cleared:          ${delta.cleared.length}`);
  console.log(`status changed:   ${delta.status_changed.length}`);
  console.log(`unchanged dirty:  ${delta.unchanged_count} hidden`);
  printSample('New paths', delta.new, limit);
  printSample('Cleared paths', delta.cleared, limit);
  printSample('Status changed', delta.status_changed, limit);
}

function listBaselines() {
  const project = resolveProject();
  const dir = projectCacheDir(project);
  const label = labelName();
  const entries = existsSync(dir)
    ? readdirSync(dir).filter((name) => name.endsWith('.json') && !name.startsWith('_latest-')).sort()
    : [];
  const baselines = entries
    .map((name) => safeReadJson(resolve(dir, name)))
    .filter((item) => item && (!args.label || item.label === label))
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));

  if (args.json) {
    console.log(JSON.stringify({ project: project.id, root: project.root, baselines }, null, 2));
    return;
  }

  console.log(`SMA dirty baselines for ${project.id}`);
  if (!baselines.length) {
    console.log('none');
    return;
  }
  for (const item of baselines.slice(0, numberArg(args.limit, 20))) {
    console.log(`- ${item.id} ${item.created_at} ${item.label} ${formatDirtyCounts(item.summary)}`);
  }
}

function printCachePath() {
  console.log(CACHE_ROOT);
}

function cleanBaselines() {
  const project = resolveProject();
  const dir = projectCacheDir(project);
  if (!existsSync(dir)) {
    console.log(`no baselines for ${project.id}`);
    return;
  }

  const keep = numberArg(args.keep, 20);
  const entries = readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.startsWith('_latest-'))
    .map((name) => ({ name, item: safeReadJson(resolve(dir, name)) }))
    .filter(({ item }) => item)
    .sort((left, right) => String(right.item.created_at).localeCompare(String(left.item.created_at)));

  const remove = entries.slice(keep);
  for (const entry of remove) rmSync(resolve(dir, entry.name), { force: true });
  console.log(`removed ${remove.length} old baseline${remove.length === 1 ? '' : 's'} for ${project.id}; kept ${Math.min(entries.length, keep)}`);
}

function buildBaseline(project, overrides: Record<string, any> = {}) {
  const status = readGitStatus(project.root);
  const label = labelName();
  return {
    schema_version: '1.0.0',
    id: overrides.id || `${timestampId()}-${randomBytes(3).toString('hex')}`,
    created_at: new Date().toISOString(),
    project: project.id,
    root: project.root,
    label,
    branch: status.branch,
    summary: summarizeRecords(status.records),
    records: status.records,
  };
}

function readGitStatus(root) {
  const raw = execFileSync('git', ['status', '--short', '--branch'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
  });
  const lines = raw.split(/\r?\n/).filter(Boolean);
  return {
    branch: lines[0] || '',
    records: lines.slice(1).map(statusRecord),
  };
}

function statusRecord(line) {
  const path = statusPath(line);
  return {
    line,
    status: line.slice(0, 2),
    path,
    untracked: line.startsWith('??'),
  };
}

function statusPath(line) {
  const raw = line.slice(3).trim();
  return raw.includes(' -> ') ? raw.split(' -> ').pop().trim() : raw;
}

function summarizeRecords(records) {
  return {
    dirty_count: records.length,
    modified_count: records.filter((record) => !record.untracked).length,
    untracked_count: records.filter((record) => record.untracked).length,
  };
}

function diffStatuses(baseline, current) {
  const before = new Map<string, any>(baseline.records.map((record) => [record.path, record]));
  const after = new Map<string, any>(current.records.map((record) => [record.path, record]));
  const added = [];
  const cleared = [];
  const changed = [];
  let unchangedCount = 0;

  for (const record of current.records) {
    const previous = before.get(record.path);
    if (!previous) {
      added.push(record);
    } else if (previous.status !== record.status || previous.line !== record.line) {
      changed.push({ before: previous, after: record });
    } else {
      unchangedCount += 1;
    }
  }

  for (const record of baseline.records) {
    if (!after.has(record.path)) cleared.push(record);
  }

  return {
    new: added,
    cleared,
    status_changed: changed,
    unchanged_count: unchangedCount,
  };
}

function readBaseline(project) {
  const requested = args.baseline;
  const label = labelName();
  if (requested) {
    const direct = isAbsolute(requested) ? requested : baselinePath(project, requested);
    if (!existsSync(direct)) throw new Error(`baseline not found: ${requested}`);
    return JSON.parse(readFileSync(direct, 'utf8'));
  }

  const latest = latestPath(project, label);
  if (!existsSync(latest)) {
    throw new Error(`no latest baseline for ${project.id}/${label}; run npm run dirty:save -- --project ${project.id}`);
  }
  const pointer = JSON.parse(readFileSync(latest, 'utf8'));
  if (!pointer.path || !existsSync(pointer.path)) throw new Error(`latest baseline pointer is stale for ${project.id}/${label}`);
  return JSON.parse(readFileSync(pointer.path, 'utf8'));
}

function resolveProject() {
  const id = args.project || (args.root ? basename(resolve(args.root)) : 'sma');
  const root = args.root ? resolve(args.root) : projectRoot(id);
  return { id: String(id), root };
}

function projectCacheDir(project) {
  return resolve(CACHE_ROOT, slug(project.id || basename(project.root)));
}

function baselinePath(project, id) {
  return resolve(projectCacheDir(project), `${slug(id)}.json`);
}

function latestPath(project, label) {
  return resolve(projectCacheDir(project), `_latest-${slug(label)}.json`);
}

function labelName() {
  return String(args.label || env.SMA_AGENT || env.USER || 'agent');
}

function printSample(title, items, limit) {
  if (!items.length) return;
  const sample = items.slice(0, limit);
  console.log(`${title}:`);
  for (const item of sample) {
    if (item.before && item.after) {
      console.log(`  - ${item.before.status.trim() || '--'} -> ${item.after.status.trim() || '--'} ${item.after.path}`);
    } else {
      console.log(`  - ${item.line}`);
    }
  }
  const hidden = items.length - sample.length;
  if (hidden > 0) console.log(`  ... ${hidden} more hidden; use --limit ${items.length}`);
}

function formatDirtyCounts(summary) {
  return `${summary.dirty_count} dirty (${summary.modified_count} modified, ${summary.untracked_count} untracked)`;
}

function safeReadJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function timestampId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
}

function slug(value) {
  return String(value || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 140) || 'default';
}

function shellArg(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function numberArg(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function parseArgs(list) {
  const out: Record<string, any> = { command: '' };
  const args = [...list];
  out.command = args.shift() || '';
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}
