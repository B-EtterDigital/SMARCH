#!/usr/bin/env node
/**
 * What: Simulates recent brick edit cycles to demonstrate the coordination pipeline.
 * Why: New adopters need realistic context and a smoke test without waiting for live edits.
 * How: Reads project manifests and Git history, then previews or commits lease and context events.
 * Callers: Onboarding demos and coordination smoke tests run it explicitly.
 * Example: `node tools/sma-seed.ts --help`
 */
/**
 * sma-seed.ts — adoption demo. Pick N recently-touched bricks in a project
 * and simulate the full edit cycle for each (lease + edit_planned +
 * edit_applied + release) using intents derived from real git commit
 * messages.
 *
 * Use cases:
 *   - Demo the multi-agent layer to a teammate without waiting for adoption
 *   - Seed a fresh project with a believable starter context log
 *   - Smoke-test the lease + context + dashboard pipeline end-to-end
 *
 * Usage:
 *   sma seed --project <id> [--bricks 5] [--ttl 60] [--commit]
 *            [--actor <id>] [--model <name>] [--dry-run]
 *
 * Default is --dry-run. Without --commit, prints what it would do; nothing
 * is appended or written. Pass --commit to actually populate the agent-
 * context log (this is the OPPOSITE convention from sma-backfill — seed is
 * a demo so we want it explicit).
 *
 * Per brick:
 *   1. Read manifest, find brick_id from disk
 *   2. git log -n 3 --pretty="%H %s" -- <source_path>
 *   3. lease acquire (resource_kind=brick, ttl=N, intent=most-recent-subject)
 *   4. context append edit_planned (intent=most-recent-subject, decision=body)
 *   5. context append edit_applied (intent=most-recent-subject)
 *   6. lease release
 *
 * Picks bricks by most-recent commit on their source_paths[0] across the
 * registry. No score/priority filtering — just recency.
 */

import { argv, exit } from 'node:process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECTS_ROOT } from "./lib/sma-paths.ts";
import { PROJECT_PATH_OVERRIDES } from "./lib/project-paths.ts";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const SMA_ROOT = resolve(TOOLS_DIR, '..');

const REGISTRY_PATH = resolve(SMA_ROOT, 'scans/all-projects/latest.registry.json');

// Project id → relative path overrides come from registry/portfolio.config.json.
const PROJECT_OVERRIDES = PROJECT_PATH_OVERRIDES;

interface SeedArgs {
  help?: boolean;
  project?: string;
  bricks?: string;
  ttl?: string;
  commit?: boolean;
  dryRun?: boolean;
  actor?: string;
  model?: string;
}
interface RegistryBrick { id: string; project: string; source_paths?: string[] }
interface SeedLease { lease_id: string }

const args = parseArgs(argv.slice(2));

if (args.help || !args.project) {
  usage();
  exit(args.help ? 0 : 2);
}

const numBricks = Number(args.bricks ?? 5);
const ttl = Number(args.ttl ?? 60);
const doCommit = !!args.commit && !args.dryRun;
const actor = args.actor ?? process.env.SMA_AGENT ?? 'sma-seed-demo';
const model = args.model ?? '';

try {
  const projectAbs = resolveProjectRoot(args.project);
  if (!projectAbs) throw new Error(`project not found: ${args.project}`);

  console.log(`[seed] project: ${args.project} (${projectAbs})`);
  console.log(`[seed] mode:    ${doCommit ? 'COMMIT (will append events)' : 'dry-run'}`);
  console.log(`[seed] bricks:  ${String(numBricks)}`);
  console.log('');

  const registry = readRegistry();
  const allBricks = registry.bricks.filter((brick) => brick.project === args.project);
  if (!allBricks.length) {
    console.log(`(no bricks for project ${args.project} in registry)`);
    exit(0);
  }

  const ranked = [];
  for (const brick of allBricks) {
    const src = brick.source_paths?.[0];
    if (!src) continue;
    const abs = resolve(projectAbs, src);
    if (!existsSync(abs)) continue;
    const commits = lastCommits(projectAbs, src, 3);
    if (!commits.length) continue;
    const headTs = commitTimestamp(projectAbs, commits[0].sha);
    ranked.push({ brick, source: src, commits, head_ts: headTs });
  }
  ranked.sort((a, b) => b.head_ts - a.head_ts);
  const picked = ranked.slice(0, numBricks);

  if (!picked.length) {
    console.log('(no bricks with resolvable source paths and git history)');
    exit(0);
  }

  for (const entry of picked) {
    const brick = entry.brick;
    const head = entry.commits[0];
    console.log(`-- ${brick.id}`);
    console.log(`   source: ${entry.source}`);
    console.log(`   commit: ${head.sha} ${head.subject}`);
    if (!doCommit) {
      console.log(`   would: lease acquire → edit_planned → edit_applied → lease release`);
      console.log('');
      continue;
    }

    // Real flow
    const acquired = run(
      'sma-lease.ts',
      [
        'acquire',
        '--resource-kind', 'brick',
        '--resource', brick.id,
        '--project', args.project,
        '--brick', brick.id,
        '--intent', head.subject,
        '--rationale', 'sma-seed demo — derived from most recent commit',
        '--ttl', String(ttl),
        '--auto-context',
        '--actor', actor,
        ...(model ? ['--model', model] : []),
        '--actor-kind', 'tool',
        '--json',
      ],
    );
    if (!acquired) { console.log('   FAILED to acquire'); console.log(''); continue; }
    const lease = parseLease(acquired);

    run(
      'sma-context.ts',
      [
        'append',
        '--project', args.project,
        '--brick', brick.id,
        '--kind', 'edit_planned',
        '--intent', head.subject,
        '--decision', 'replaying recent commit so the brick has a baseline edit_planned event',
        '--lease', lease.lease_id,
        '--actor', actor,
        '--actor-kind', 'tool',
        ...(model ? ['--model', model] : []),
        '--commit', head.sha,
      ],
    );

    run(
      'sma-context.ts',
      [
        'append',
        '--project', args.project,
        '--brick', brick.id,
        '--kind', 'edit_applied',
        '--intent', head.subject,
        '--decision', 'commit landed; closing the loop with edit_applied',
        '--lease', lease.lease_id,
        '--actor', actor,
        '--actor-kind', 'tool',
        ...(model ? ['--model', model] : []),
        '--commit', head.sha,
      ],
    );

    run(
      'sma-lease.ts',
      [
        'release',
        '--lease', lease.lease_id,
        '--project', args.project,
        '--brick', brick.id,
        '--auto-context',
        '--reason', 'sma-seed demo complete',
      ],
    );

    console.log(`   ✓ acquired ${lease.lease_id}, logged 4 events, released`);
    console.log('');
  }

  if (doCommit) {
    console.log(`[seed] done. Inspect with:`);
    console.log(`  sma context-replay --project ${args.project} --brick ${picked[0].brick.id}`);
    console.log(`  sma context summarize --project ${args.project} --brick ${picked[0].brick.id}`);
    console.log(`  sma gen3 dashboard`);
  } else {
    console.log(`[seed] dry-run complete. Re-run with --commit to actually append.`);
  }
} catch (err) {
  console.error(`sma-seed: ${err instanceof Error ? err.message : String(err)}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-seed.ts --project <id> [--bricks 5] [--ttl 60] [--commit]
               [--actor <id>] [--model <name>] [--dry-run]

Picks N most-recently-touched bricks and replays their last commit as a full
lease + edit_planned + edit_applied + release cycle. Default is dry-run; pass
--commit to actually append events.
`);
}

function readRegistry(): { bricks: RegistryBrick[] } {
  const parsed: unknown = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  if (!isRecord(parsed)) throw new Error('registry must be a JSON object');
  const bricks = Array.isArray(parsed.bricks) ? parsed.bricks.filter(isRegistryBrick) : [];
  return { bricks };
}

function parseLease(raw: string): SeedLease {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || typeof parsed.lease_id !== 'string') throw new Error('lease command returned an invalid lease');
  return { lease_id: parsed.lease_id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRegistryBrick(value: unknown): value is RegistryBrick {
  return isRecord(value) && typeof value.id === 'string' && typeof value.project === 'string'
    && (value.source_paths === undefined || (Array.isArray(value.source_paths) && value.source_paths.every((item) => typeof item === 'string')));
}

function resolveProjectRoot(projectId: string) {
  const direct = resolve(PROJECTS_ROOT, projectId);
  if (existsSync(direct)) return direct;
  const overridden = PROJECT_OVERRIDES[projectId];
  if (overridden) {
    const cand = resolve(PROJECTS_ROOT, overridden);
    if (existsSync(cand)) return cand;
  }
  try {
    for (const ent of readdirSync(PROJECTS_ROOT)) {
      if (ent.toLowerCase() === projectId.toLowerCase()) return resolve(PROJECTS_ROOT, ent);
    }
  } catch { /* ignore */ }
  return null;
}

function lastCommits(cwd: string, sourcePath: string, n: number) {
  try {
    const out = execFileSync('git',
      ['log', '-n', String(n), '--pretty=%H%x09%s', '--', sourcePath],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean).map((line) => {
      const [sha, ...rest] = line.split('\t');
      return { sha, subject: rest.join('\t') };
    });
  } catch {
    return [];
  }
}

function commitTimestamp(cwd: string, sha: string) {
  try {
    const out = execFileSync('git',
      ['show', '-s', '--format=%ct', sha],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return Number(out.trim()) || 0;
  } catch { return 0; }
}

function run(script: string, scriptArgs: string[]) {
  const res = spawnSync('node', [resolve(TOOLS_DIR, script), ...scriptArgs], { encoding: 'utf8' });
  if (res.status !== 0) {
    process.stderr.write(res.stderr);
    return null;
  }
  return res.stdout;
}

function parseArgs(list: string[]): SeedArgs {
  const out: SeedArgs = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_match: string, character: string) => character.toUpperCase());
    const next = list.at(i + 1);
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) {
      if (camel === 'help' || camel === 'commit' || camel === 'dryRun') out[camel] = true;
      continue;
    }
    if (camel === 'project' || camel === 'bricks' || camel === 'ttl' || camel === 'actor' || camel === 'model') {
      out[camel] = next;
    }
    i += 1;
  }
  return out;
}
