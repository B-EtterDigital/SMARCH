#!/usr/bin/env node
/* Commit and context inputs cross runtime process and JSON boundaries, so defensive guards remain required. */
/* Git evidence selection is a linear fallback chain; complexity counts independent compatibility guards as nested flow. */
/* eslint @typescript-eslint/no-unnecessary-condition: "off", complexity: "off" */
/**
 * WHAT: Adds structured edit rationale to a brick manifest's touch history.
 * WHY: Thin commit metadata cannot explain intent, rejected alternatives, or backlog links.
 * HOW: Reads explicit inputs, a commit, or an existing context event and updates the manifest.
 * OUTPUTS: Writes aligned manifest touch data and, unless disabled, an agent-context event.
 * CALLERS: Maintainers use it to backfill provenance after manual or coordinated changes.
 * USAGE: `node tools/sma-touch-backfill.ts --help`
 * Glossary: [SMA](../docs/GLOSSARY.md).
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { argv, exit } from 'node:process';
import { execFileSync } from 'node:child_process';
import { appendContextEvent } from './lib/context-log.ts';

const ROLES = new Set(['architect', 'implementer', 'reviewer', 'security', 'tester', 'refactor', 'release', 'scanner']);
const ACTOR_KINDS = new Set(['human', 'ai_model', 'agent', 'automation', 'tool']);

interface CliArgs {
  manifest?: string; intent?: string; role?: string; actorKind?: string; actor?: string;
  summary?: string; decision?: string; rejected?: string[]; linkedBacklog?: string[];
  commit?: string; model?: string; session?: string; task?: string; lease?: string;
  project?: string; noContext?: boolean; intentFromMessage?: boolean; eventId?: string;
}
type StringArgKey = Exclude<keyof CliArgs, 'rejected' | 'linkedBacklog' | 'noContext' | 'intentFromMessage'>;
interface RejectedAlternative { alternative: string; reason: string }
type TouchEvent = Record<string, unknown> & {
  actor_kind: string; actor_id: string; role: string; timestamp: string; summary: string; intent: string;
  context_event_ids?: string[];
};
interface Manifest {
  brick?: { id?: string };
  build?: { id?: string };
  provenance?: { created_by?: TouchEvent; touched_by?: TouchEvent[] };
}
interface TouchInput {
  actorKind: string; actorId: string; role: string; intent: string; summary?: string;
  decisionRationale?: string; rejectedAlternatives?: RejectedAlternative[]; linkedBacklog?: string[];
  commit?: string; model?: string; sessionId?: string; taskId?: string; leaseId?: string;
  attestation?: { method: string; reference: string }; timestamp?: string;
}
interface GitCommit { sha: string; author_name: string; author_email: string; iso_date: string; subject: string; body: string }

const cmd = argv[2];
const args = parseArgs(argv.slice(3));

try {
  switch (cmd) {
    case 'add':
      runAdd();
      break;
    case 'from-git':
      runFromGit();
      break;
    case 'sync-touch':
      runSyncTouch();
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
  console.error(`sma-touch-backfill: ${err instanceof Error ? err.message : String(err)}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-touch-backfill.ts add        --manifest <path> --intent "..." --role <role>
                                     --actor-kind <kind> [--actor <id>] [--summary "..."]
                                     [--decision "..."] [--rejected "alt::reason"]...
                                     [--linked-backlog <id>]... [--commit <sha>]
                                     [--model <name>] [--session <id>] [--task <id>]
                                     [--lease <lease_id>] [--project <id>] [--no-context]

  sma-touch-backfill.ts from-git   --manifest <path> --commit <sha> [--role implementer]
                                     [--intent-from-message] [--linked-backlog <id>]...
                                     [--project <id>] [--no-context]

  sma-touch-backfill.ts sync-touch --manifest <path> --event-id <ctx-id>

Roles:       ${[...ROLES].join(', ')}
Actor kinds: ${[...ACTOR_KINDS].join(', ')}
`);
}

// ── add ──────────────────────────────────────────────────────────────────────

function runAdd() {
  const manifestPath = requireArg('manifest', '--manifest');
  const intent = requireArg('intent', '--intent');
  const role = requireArg('role', '--role');
  const actorKind = requireArg('actorKind', '--actor-kind');
  if (!ROLES.has(role)) throw new Error(`bad --role: ${role}`);
  if (!ACTOR_KINDS.has(actorKind)) throw new Error(`bad --actor-kind: ${actorKind}`);

  const manifest = loadManifest(manifestPath);
  const brickId = manifest.brick?.id ?? manifest.build?.id;
  if (!brickId) throw new Error('manifest has no brick.id or build.id');

  const touch = buildTouchEvent({
    actorKind,
    actorId: args.actor ?? process.env.SMA_AGENT ?? process.env.USER ?? 'unknown',
    role,
    intent,
    summary: args.summary ?? intent,
    decisionRationale: args.decision,
    rejectedAlternatives: parseRejected(args.rejected),
    linkedBacklog: args.linkedBacklog,
    commit: args.commit,
    model: args.model,
    sessionId: args.session,
    taskId: args.task,
    leaseId: args.lease,
  });

  // Optional: also append a matching agent-context event and cross-reference.
  if (!args.noContext && args.project) {
    try {
      const ctx = appendContextEvent({
        project: args.project,
        brick: brickId,
        kind: 'edit_applied',
        intent,
        actorKind,
        actorId: touch.actor_id,
        model: args.model,
        sessionId: args.session,
        taskId: args.task,
        leaseId: args.lease,
        decisionRationale: args.decision,
        rejectedAlternatives: parseRejected(args.rejected),
        linkedBacklog: args.linkedBacklog,
        commit: args.commit,
      });
      touch.context_event_ids = [String(ctx.event_id)];
    } catch (e) {
      console.error(`warn: could not append context event: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  appendTouch(manifest, touch);
  saveManifest(manifestPath, manifest);
  console.log(`added touch_event to ${brickId} (role=${role}, intent=${intent.slice(0, 40)}...)`);
}

// ── from-git ─────────────────────────────────────────────────────────────────

function runFromGit() {
  const manifestPath = requireArg('manifest', '--manifest');
  const commit = requireArg('commit', '--commit');
  const role = args.role ?? 'implementer';
  if (!ROLES.has(role)) throw new Error(`bad --role: ${role}`);

  const manifest = loadManifest(manifestPath);
  const brickId = manifest.brick?.id ?? manifest.build?.id;
  if (!brickId) throw new Error('manifest has no brick.id or build.id');

  const cwd = dirname(manifestPath);
  const meta = readGitCommit(cwd, commit);

  const intent = args.intentFromMessage ? meta.subject : (args.intent ?? meta.subject);
  if (!intent) throw new Error('could not derive intent (no --intent and empty commit subject)');

  const touch = buildTouchEvent({
    actorKind: 'human',
    actorId: meta.author_email,
    role,
    intent,
    summary: meta.subject,
    decisionRationale: meta.body || undefined,
    commit: meta.sha,
    timestamp: meta.iso_date,
    attestation: { method: 'git_commit', reference: meta.sha },
  });

  if (!args.noContext && args.project) {
    try {
      const ctx = appendContextEvent({
        project: args.project,
        brick: brickId,
        kind: 'edit_applied',
        intent,
        actorKind: 'human',
        actorId: meta.author_email,
        decisionRationale: meta.body || undefined,
        linkedBacklog: args.linkedBacklog,
        commit: meta.sha,
      });
      touch.context_event_ids = [String(ctx.event_id)];
    } catch (e) {
      console.error(`warn: could not append context event: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  appendTouch(manifest, touch);
  saveManifest(manifestPath, manifest);
  console.log(`added touch_event to ${brickId} from commit ${meta.sha} (${meta.subject})`);
}

// ── sync-touch ───────────────────────────────────────────────────────────────

function runSyncTouch() {
  const manifestPath = requireArg('manifest', '--manifest');
  const eventId = requireArg('eventId', '--event-id');
  const manifest = loadManifest(manifestPath);
  const arr = manifest.provenance?.touched_by ?? [];
  if (!arr.length) throw new Error('manifest has no touched_by[] entries');
  const last = arr[arr.length - 1];
  last.context_event_ids ??= [];
  if (!last.context_event_ids.includes(eventId)) last.context_event_ids.push(eventId);
  saveManifest(manifestPath, manifest);
  console.log(`linked ${eventId} into last touch_event of ${String(manifest.brick?.id ?? manifest.build?.id)}`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function loadManifest(path: string): Manifest {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`manifest not found: ${abs}`);
  try { return JSON.parse(readFileSync(abs, 'utf8')) as Manifest; }
  catch (e) { throw new Error(`could not parse manifest: ${e instanceof Error ? e.message : String(e)}`); }
}

function saveManifest(path: string, manifest: Manifest): void {
  const abs = resolve(path);
  const tmp = `${abs}.tmp.${String(process.pid)}`;
  writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
  renameSync(tmp, abs);
}

/**
 * @param {{
 * actorKind: string,
 * actorId: string,
 * role: string,
 * intent: string,
 * summary?: string,
 * decisionRationale?: string,
 * rejectedAlternatives?: Array<{alternative: string, reason: string}>,
 * linkedBacklog?: string[],
 * commit?: string,
 * model?: string,
 * sessionId?: string,
 * taskId?: string,
 * leaseId?: string,
 * attestation?: {method: string, reference: string},
 * timestamp?: string
 * }} input
 */
function buildTouchEvent({
  actorKind,
  actorId,
  role,
  intent,
  summary,
  decisionRationale,
  rejectedAlternatives,
  linkedBacklog,
  commit,
  model,
  sessionId,
  taskId,
  leaseId,
  attestation,
  timestamp,
}: TouchInput): TouchEvent {
  const t: TouchEvent = {
    actor_kind: actorKind,
    actor_id: actorId,
    role,
    timestamp: timestamp ?? new Date().toISOString(),
    summary: summary ?? intent,
    intent,
  };
  if (model) t.model = model;
  if (sessionId) t.session_id = sessionId;
  if (taskId) t.task_id = taskId;
  if (commit) t.commit = commit;
  if (decisionRationale) t.decision_rationale = decisionRationale;
  if (rejectedAlternatives?.length) t.rejected_alternatives = rejectedAlternatives;
  if (linkedBacklog?.length) t.linked_backlog = linkedBacklog;
  if (leaseId) t.lease_id = leaseId;
  if (attestation) t.attestation = attestation;
  return t;
}

function appendTouch(manifest: Manifest, touch: TouchEvent): void {
  manifest.provenance = manifest.provenance ?? {};
  if (!manifest.provenance.created_by) {
    manifest.provenance.created_by = touch;
  } else {
    manifest.provenance.touched_by = manifest.provenance.touched_by ?? [];
    manifest.provenance.touched_by.push(touch);
  }
}

function readGitCommit(cwd: string, sha: string): GitCommit {
  // %H sha, %an author name, %ae email, %aI iso8601 date, %s subject, %b body
  const fmt = '%H%n%an%n%ae%n%aI%n%s%n%b';
  let raw;
  try {
    raw = execFileSync('git', ['log', '-1', `--pretty=format:${fmt}`, sha], { cwd, encoding: 'utf8' });
  } catch (e) {
    throw new Error(`git log failed for ${sha}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const lines = raw.split('\n');
  return {
    sha: lines[0],
    author_name: lines[1],
    author_email: lines[2],
    iso_date: lines[3],
    subject: lines[4],
    body: lines.slice(5).join('\n').trim(),
  };
}

function parseRejected(arr: string[] | undefined): RejectedAlternative[] {
  if (!arr?.length) return [];
  return arr.map((r) => {
    const idx = r.indexOf('::');
    if (idx < 0) return { alternative: r, reason: '' };
    return { alternative: r.slice(0, idx).trim(), reason: r.slice(idx + 2).trim() };
  });
}

function requireArg(key: StringArgKey, flag: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`missing ${flag}`);
  }
  return value;
}

function parseArgs(list: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_match: string, c: string) => c.toUpperCase()) as keyof CliArgs;
    const next = list[i + 1];
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) {
      if (camel === 'noContext' || camel === 'intentFromMessage') out[camel] = true;
      continue;
    }
    if (['rejected', 'linkedBacklog'].includes(camel)) {
      const arrayKey = camel as 'rejected' | 'linkedBacklog';
      out[arrayKey] = [...(out[arrayKey] ?? []), next];
    } else {
      const stringKey = camel as StringArgKey;
      out[stringKey] = next;
    }
    i += 1;
  }
  return out;
}
