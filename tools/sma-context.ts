#!/usr/bin/env node
/**
 * WHAT: Appends and reads the per-brick [agent-context](../docs/GLOSSARY.md#agent-context) event stream.
 * WHY: Git records file changes but not the intent, decisions, rejected options, verification, and handoff needed by the next agent.
 * HOW: Accepts project and brick subcommands, reads or appends line-oriented events, and is called by edit, conflict, and audit workflows.
 * Usage: `node tools/sma-context.ts list-bricks --project sma`
 */
/**
 * sma-context.ts — append-only agent-context log per brick.
 *
 * Path:    <project>/.smarch/agent-context/<brick-id>.ndjson
 * Schema:  schemas/agent-context-event.schema.json
 *
 * Why this exists:
 *   git records what changed. SMARCH already records who, with what model, in what
 *   role, via touch_event. What was missing is a durable, append-only stream of
 *   *intent* and *decision* per brick, decoupled from manifest rewrites. This is
 *   the file the next agent reads when they pick up a brick mid-flight.
 *
 * Subcommands:
 *   append      --project <id> --brick <id> --kind <kind> --intent "..."
 *               [--actor-kind <kind>] [--actor <id>] [--model <name>]
 *               [--session <id>] [--task <id>] [--lease <lease_id>]
 *               [--decision "..."] [--rejected "alt::reason"]...
 *               [--linked-backlog <id>]... [--file <path>]... [--commit <sha>]
 *               [--verify-cmd "..." --verify-status pass|fail|skipped|blocked]
 *
 *   tail        --project <id> --brick <id> [-n <count>] [--json]
 *
 *   summarize   --project <id> --brick <id> [--json]
 *
 *   link-backlog --project <id> --brick <id> --backlog <id> --intent "..."
 *
 *   list-bricks  --project <id>
 */

import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import {
  appendContextEvent,
  readContextLog,
  logPath,
  projectRoot,
  KINDS,
  ACTOR_KINDS,
  VERIFY_STATUSES,
  listBricksWithContext,
} from './lib/context-log.ts';

type ContextArgs = {
  actor: string; actorKind: string; backlog: string; brick: string; commit: string;
  decision: string; intent: string; kind: string; lease: string; model: string; n: string;
  project: string; session: string; task: string; verifyCmd: string; verifyStatus: string;
  file?: string[]; linkedBacklog?: string[]; rejected?: string[]; json: boolean;
};
type ContextScalarKey = Exclude<keyof ContextArgs, 'file' | 'linkedBacklog' | 'rejected' | 'json'>;
const CONTEXT_SCALAR_KEYS: readonly ContextScalarKey[] = ['actor', 'actorKind', 'backlog', 'brick', 'commit', 'decision', 'intent', 'kind', 'lease', 'model', 'n', 'project', 'session', 'task', 'verifyCmd', 'verifyStatus'];

const cmd = argv[2];
const args = parseArgs(argv.slice(3));

try {
  switch (cmd) {
    case 'append':
      runAppend();
      break;
    case 'tail':
      runTail();
      break;
    case 'summarize':
      runSummarize();
      break;
    case 'link-backlog':
      runLinkBacklog();
      break;
    case 'list-bricks':
      runListBricks();
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
  console.error(`sma-context: ${err instanceof Error ? err.message : String(err)}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-context.ts append      --project <id> --brick <id> --kind <kind> --intent "..."
                              [--actor-kind <kind>] [--actor <id>] [--model <name>]
                              [--session <id>] [--task <id>] [--lease <lease_id>]
                              [--decision "..."] [--rejected "alt::reason"]...
                              [--linked-backlog <id>]... [--file <path>]... [--commit <sha>]
                              [--verify-cmd "..." --verify-status <status>]
  sma-context.ts tail        --project <id> --brick <id> [-n <count>] [--json]
  sma-context.ts summarize   --project <id> --brick <id> [--json]
  sma-context.ts link-backlog --project <id> --brick <id> --backlog <id> --intent "..."
  sma-context.ts list-bricks  --project <id>

Kinds:    ${[...KINDS].join(', ')}
Actor:    ${[...ACTOR_KINDS].join(', ')}
Verify:   ${[...VERIFY_STATUSES].join(', ')}
`);
}

function runAppend() {
  requireArg('project', '--project');
  requireArg('brick', '--brick');
  requireArg('kind', '--kind');
  requireArg('intent', '--intent');

  const verification = (args.verifyCmd || args.verifyStatus)
    ? { command: args.verifyCmd ?? '', status: args.verifyStatus }
    : undefined;

  const event = appendContextEvent({
    project: args.project,
    brick: args.brick,
    kind: args.kind,
    intent: args.intent,
    actorKind: args.actorKind ?? 'agent',
    actorId: args.actor,
    model: args.model,
    sessionId: args.session,
    taskId: args.task,
    leaseId: args.lease,
    decisionRationale: args.decision,
    rejectedAlternatives: args.rejected,
    linkedBacklog: args.linkedBacklog,
    filesTouched: args.file,
    commit: args.commit,
    verification,
  });

  if (args.json) console.log(JSON.stringify(event, null, 2));
  else console.log(`appended ${event.event_id} (${event.kind}) → ${logPath(args.project, args.brick)}`);
}

function runTail() {
  requireArg('project', '--project');
  requireArg('brick', '--brick');
  const n = Number(args.n ?? 20);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`bad -n: ${args.n}`);
  const events = readContextLog(args.project, args.brick);
  const tail = events.slice(-n);
  if (args.json) {
    console.log(JSON.stringify(tail, null, 2));
    return;
  }
  if (!tail.length) {
    console.log(`(no events for ${args.brick} in ${args.project})`);
    return;
  }
  for (const e of tail) {
    console.log(`${e.timestamp}  ${pad(e.kind, 22)}  ${pad(e.actor_id, 24)}  ${e.intent}`);
    if (e.decision_rationale) console.log(`                                                    ↳ ${e.decision_rationale}`);
  }
}

function runSummarize() {
  requireArg('project', '--project');
  requireArg('brick', '--brick');
  const events = readContextLog(args.project, args.brick);
  const intents = uniq(events.map((e) => e.intent).filter(Boolean));
  const decisions = uniq(events.map((e) => e.decision_rationale).filter(Boolean));
  const rejected = events
    .flatMap((e) => Array.isArray(e.rejected_alternatives) ? e.rejected_alternatives : [])
    .filter((value): value is { alternative: string; reason: string } =>
      typeof value === 'object' && value !== null && 'alternative' in value && typeof value.alternative === 'string' && 'reason' in value && typeof value.reason === 'string')
    .map((alternative) => `${alternative.alternative} :: ${alternative.reason}`);
  const backlog = uniq(events.flatMap((e) => e.linked_backlog ?? []));
  const summary = {
    project: args.project,
    brick: args.brick,
    total_events: events.length,
    distinct_intents: intents,
    distinct_decisions: decisions,
    rejected_alternatives: rejected,
    linked_backlog: backlog,
    last_5: events.slice(-5),
  };
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`brick:  ${args.brick}`);
  console.log(`events: ${events.length}`);
  console.log(`intents (${intents.length}):`);
  for (const i of intents) console.log(`  · ${i}`);
  if (decisions.length) {
    console.log(`decisions (${decisions.length}):`);
    for (const d of decisions) console.log(`  · ${d}`);
  }
  if (rejected.length) {
    console.log(`rejected alternatives:`);
    for (const r of rejected) console.log(`  · ${r}`);
  }
  if (backlog.length) {
    console.log(`linked backlog: ${backlog.join(', ')}`);
  }
}

function runLinkBacklog() {
  requireArg('project', '--project');
  requireArg('brick', '--brick');
  requireArg('backlog', '--backlog');
  requireArg('intent', '--intent');
  args.kind = 'note';
  args.linkedBacklog = [args.backlog];
  runAppend();
}

function runListBricks() {
  requireArg('project', '--project');
  const bricks = listBricksWithContext(args.project);
  if (!bricks.length) {
    console.log('(no agent-context logs in this project)');
    return;
  }
  for (const id of bricks) {
    const path = logPath(args.project, id);
    const lines = readFileSync(path, 'utf8').split('\n').filter((l: string) => l.trim()).length;
    const sz = statSync(path).size;
    console.log(`${pad(id, 70)}  ${pad(String(lines), 6)} events  ${sz} bytes`);
  }
}

function uniq(arr: Iterable<unknown>|null|undefined) {
  return [...new Set(arr)];
}

function requireArg(key: ContextScalarKey, flag: string) {
  if (args[key] === undefined || args[key] === null || args[key] === '') {
    throw new Error(`missing ${flag}`);
  }
}

function pad(s: unknown, n: number) {
  return String(s ?? '').slice(0, n).padEnd(n);
}

function isContextScalarKey(value: string): value is ContextScalarKey {
  return (CONTEXT_SCALAR_KEYS as readonly string[]).includes(value);
}

function parseArgs(list: string[]): ContextArgs {
  const out: ContextArgs = {
    actor: '', actorKind: 'agent', backlog: '', brick: '', commit: '', decision: '', intent: '', kind: '',
    lease: '', model: '', n: '20', project: '', session: '', task: '', verifyCmd: '', verifyStatus: '', json: false,
  };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '-n') {
      out.n = list[i + 1];
      i += 1;
      continue;
    }
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_match: string, c: string) => c.toUpperCase());
    const next = list[i + 1];
    const isBool = next === undefined || (next.startsWith('--') && next !== '--');
    if (isBool) {
      if (camel === 'json') out.json = true;
      continue;
    }
    if (camel === 'rejected' || camel === 'linkedBacklog' || camel === 'file') {
      out[camel] = [...(out[camel] ?? []), next];
    } else if (isContextScalarKey(camel)) {
      out[camel] = next;
    }
    i += 1;
  }
  return out;
}
