#!/usr/bin/env node
/**
 * WHAT: Adds structured edit rationale to a brick manifest's touch history.
 * WHY: Thin commit metadata cannot explain intent, rejected alternatives, or backlog links.
 * HOW: Reads explicit inputs, a commit, or an existing context event and updates the manifest.
 * OUTPUTS: Writes aligned manifest touch data and, unless disabled, an agent-context event.
 * CALLERS: Maintainers use it to backfill provenance after manual or coordinated changes.
 * USAGE: `node tools/sma-touch-backfill.mjs --help`
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
import { appendContextEvent } from './lib/context-log.mjs';

const ROLES = new Set(['architect', 'implementer', 'reviewer', 'security', 'tester', 'refactor', 'release', 'scanner']);
const ACTOR_KINDS = new Set(['human', 'ai_model', 'agent', 'automation', 'tool']);

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
  console.error(`sma-touch-backfill: ${err.message}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-touch-backfill.mjs add        --manifest <path> --intent "..." --role <role>
                                     --actor-kind <kind> [--actor <id>] [--summary "..."]
                                     [--decision "..."] [--rejected "alt::reason"]...
                                     [--linked-backlog <id>]... [--commit <sha>]
                                     [--model <name>] [--session <id>] [--task <id>]
                                     [--lease <lease_id>] [--project <id>] [--no-context]

  sma-touch-backfill.mjs from-git   --manifest <path> --commit <sha> [--role implementer]
                                     [--intent-from-message] [--linked-backlog <id>]...
                                     [--project <id>] [--no-context]

  sma-touch-backfill.mjs sync-touch --manifest <path> --event-id <ctx-id>

Roles:       ${[...ROLES].join(', ')}
Actor kinds: ${[...ACTOR_KINDS].join(', ')}
`);
}

// ── add ──────────────────────────────────────────────────────────────────────

function runAdd() {
  requireArg('manifest', '--manifest');
  requireArg('intent', '--intent');
  requireArg('role', '--role');
  requireArg('actorKind', '--actor-kind');
  if (!ROLES.has(args.role)) throw new Error(`bad --role: ${args.role}`);
  if (!ACTOR_KINDS.has(args.actorKind)) throw new Error(`bad --actor-kind: ${args.actorKind}`);

  const manifest = loadManifest(args.manifest);
  const brickId = manifest?.brick?.id ?? manifest?.build?.id;
  if (!brickId) throw new Error('manifest has no brick.id or build.id');

  const touch = buildTouchEvent({
    actorKind: args.actorKind,
    actorId: args.actor ?? process.env.SMA_AGENT ?? process.env.USER ?? 'unknown',
    role: args.role,
    intent: args.intent,
    summary: args.summary ?? args.intent,
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
        intent: args.intent,
        actorKind: args.actorKind,
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
      touch.context_event_ids = [ctx.event_id];
    } catch (e) {
      console.error(`warn: could not append context event: ${e.message}`);
    }
  }

  appendTouch(manifest, touch);
  saveManifest(args.manifest, manifest);
  console.log(`added touch_event to ${brickId} (role=${args.role}, intent=${args.intent.slice(0, 40)}...)`);
}

// ── from-git ─────────────────────────────────────────────────────────────────

function runFromGit() {
  requireArg('manifest', '--manifest');
  requireArg('commit', '--commit');
  const role = args.role ?? 'implementer';
  if (!ROLES.has(role)) throw new Error(`bad --role: ${role}`);

  const manifest = loadManifest(args.manifest);
  const brickId = manifest?.brick?.id ?? manifest?.build?.id;
  if (!brickId) throw new Error('manifest has no brick.id or build.id');

  const cwd = dirname(args.manifest);
  const meta = readGitCommit(cwd, args.commit);

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
      touch.context_event_ids = [ctx.event_id];
    } catch (e) {
      console.error(`warn: could not append context event: ${e.message}`);
    }
  }

  appendTouch(manifest, touch);
  saveManifest(args.manifest, manifest);
  console.log(`added touch_event to ${brickId} from commit ${meta.sha} (${meta.subject})`);
}

// ── sync-touch ───────────────────────────────────────────────────────────────

function runSyncTouch() {
  requireArg('manifest', '--manifest');
  requireArg('eventId', '--event-id');
  const manifest = loadManifest(args.manifest);
  const arr = manifest?.provenance?.touched_by ?? [];
  if (!arr.length) throw new Error('manifest has no touched_by[] entries');
  const last = arr[arr.length - 1];
  if (!last.context_event_ids) last.context_event_ids = [];
  if (!last.context_event_ids.includes(args.eventId)) last.context_event_ids.push(args.eventId);
  saveManifest(args.manifest, manifest);
  console.log(`linked ${args.eventId} into last touch_event of ${manifest?.brick?.id ?? manifest?.build?.id}`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function loadManifest(path) {
  const abs = resolve(path);
  if (!existsSync(abs)) throw new Error(`manifest not found: ${abs}`);
  try { return JSON.parse(readFileSync(abs, 'utf8')); }
  catch (e) { throw new Error(`could not parse manifest: ${e.message}`); }
}

function saveManifest(path, manifest) {
  const abs = resolve(path);
  const tmp = abs + '.tmp.' + process.pid;
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
 * linkedBacklog?: any[],
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
}) {
  const t = {
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
  if (rejectedAlternatives && rejectedAlternatives.length) t.rejected_alternatives = rejectedAlternatives;
  if (linkedBacklog && linkedBacklog.length) t.linked_backlog = linkedBacklog;
  if (leaseId) t.lease_id = leaseId;
  if (attestation) t.attestation = attestation;
  return t;
}

function appendTouch(manifest, touch) {
  manifest.provenance = manifest.provenance ?? {};
  if (!manifest.provenance.created_by) {
    manifest.provenance.created_by = touch;
  } else {
    manifest.provenance.touched_by = manifest.provenance.touched_by ?? [];
    manifest.provenance.touched_by.push(touch);
  }
}

function readGitCommit(cwd, sha) {
  // %H sha, %an author name, %ae email, %aI iso8601 date, %s subject, %b body
  const fmt = '%H%n%an%n%ae%n%aI%n%s%n%b';
  let raw;
  try {
    raw = execFileSync('git', ['log', '-1', `--pretty=format:${fmt}`, sha], { cwd, encoding: 'utf8' });
  } catch (e) {
    throw new Error(`git log failed for ${sha}: ${e.message}`);
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

function parseRejected(arr) {
  if (!Array.isArray(arr) || !arr.length) return [];
  return arr.map((r) => {
    const idx = r.indexOf('::');
    if (idx < 0) return { alternative: r, reason: '' };
    return { alternative: r.slice(0, idx).trim(), reason: r.slice(idx + 2).trim() };
  });
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
    if (isBool) {
      out[camel] = true;
      continue;
    }
    if (['rejected', 'linkedBacklog'].includes(camel)) {
      out[camel] = out[camel] ? [...out[camel], next] : [next];
    } else {
      out[camel] = next;
    }
    i += 1;
  }
  return out;
}
