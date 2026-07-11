#!/usr/bin/env node
/**
 * WHAT: Renders one brick's agent-context events as a chronological work story.
 * WHY: Raw line-delimited logs are difficult to review during handoff and incident analysis.
 * HOW: Reads a project and brick log, filters by time, and formats the selected events.
 * INPUTS: Project and brick identifiers plus optional time, format, and output-path filters.
 * OUTPUTS: A text, Markdown, or structured-data timeline on standard output or in a file.
 * CALLERS: Operators, reviewers, and coordination commands reconstructing prior work.
 * Usage: `node tools/sma-context-replay.ts --project sma --brick w9-explain-d --format text`
 */
/**
 * sma-context-replay.ts — render a brick's full agent-context log as a story.
 *
 * Reads:
 *   <project>/.smarch/agent-context/<brick-id>.ndjson
 *
 * Writes (stdout, optionally --out):
 *   Markdown timeline grouped by session. Each section has the agent, model,
 *   time window, intents, decisions, files touched, verifications, and any
 *   rejected alternatives. Optional --since cuts off old events.
 *
 * Usage:
 *   sma context-replay --project <id> --brick <id> [--since <iso|days>]
 *                      [--out <path>] [--format md|text|json]
 *
 *   --since "2026-04-01"          ISO date cutoff
 *   --since "30d"                 last 30 days
 *
 * The output is meant to be the file a new agent reads to pick up where
 * someone left off — Entire's "preserve why" pitch in concrete form.
 * Lineage: see docs/INFLUENCES.md.
 */

import { argv, exit } from 'node:process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { readContextLog } from './lib/context-log.ts';

interface ReplayArgs { help?: boolean; project?: string; brick?: string; since?: string; out?: string; format?: string }
interface ReplayEvent {
  timestamp: string;
  kind: string;
  intent?: string;
  session_id?: string;
  actor_id?: string;
  actor_kind?: string;
  model?: string;
  decision_rationale?: string;
  rejected_alternatives?: { alternative?: string; reason?: string }[];
  files_touched?: string[];
  verification?: { status?: string; command?: string };
  linked_backlog?: string[];
  commit?: string;
  lease_id?: string;
}
interface ReplaySession {
  label: string; session_id?: string; agent_id?: string; actor_kind?: string; model?: string;
  started_at: string; ended_at: string; events: ReplayEvent[];
}

const args = parseArgs(argv.slice(2));

if (args.help || !args.project || !args.brick) {
  usage();
  exit(args.help ? 0 : 2);
}

try {
  const events = readContextLog(args.project, args.brick).filter(isReplayEvent);
  const cutoff = parseSince(args.since);
  const filtered = cutoff ? events.filter((e) => Date.parse(e.timestamp) >= cutoff) : events;

  const format = args.format ?? 'md';
  let out;
  if (format === 'json') {
    out = JSON.stringify({ project: args.project, brick: args.brick, events: filtered }, null, 2);
  } else {
    out = renderTimeline({ project: args.project, brick: args.brick, events: filtered, format });
  }

  if (args.out) {
    const path = resolve(args.out);
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, out + '\n');
    console.error(`wrote ${path}`);
  } else {
    process.stdout.write(out + '\n');
  }
} catch (err) {
  console.error(`sma-context-replay: ${err instanceof Error ? err.message : String(err)}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-context-replay.ts --project <id> --brick <id> [--since <iso|Nd>]
                         [--out <path>] [--format md|text|json]
`);
}

function renderTimeline({ project, brick, events, format }: { project: string; brick: string; events: ReplayEvent[]; format: string }) {
  const sessions = groupBySession(events);
  const isMd = format !== 'text';
  const lines = renderReplayHeader({ project, brick, events, isMd });
  if (events.length === 0) return lines.join('\n');

  for (const session of sessions) {
    lines.push(...renderSessionHeader(session, isMd));
    for (const event of session.events) lines.push(...renderEvent(event, isMd));
  }
  lines.push(...renderReplaySummary(events, isMd));
  return lines.join('\n');
}

function renderReplayHeader({ project, brick, events, isMd }: { project: string; brick: string; events: ReplayEvent[]; isMd: boolean }) {
  const lines = isMd
    ? [`# Replay — \`${brick}\``, '', `Project: \`${project}\``, `Total events: ${String(events.length)}`]
    : [`Replay — ${brick}`, `Project: ${project}`, `Total events: ${String(events.length)}`, ''];
  if (isMd && events.length > 0) lines.push(`Window: \`${events[0].timestamp}\` → \`${String(events.at(-1)?.timestamp)}\``);
  if (isMd) lines.push('');
  if (events.length === 0) lines.push(isMd ? '_(no events for this brick)_' : '(no events for this brick)');
  return lines;
}

function renderSessionHeader(session: ReplaySession, isMd: boolean) {
  if (!isMd) {
    return [`-- Session ${session.label} --`, `agent: ${String(session.agent_id)} (${session.actor_kind ?? 'unknown'})`,
      ...(session.model ? [`model: ${session.model}`] : []), `window: ${session.started_at} → ${session.ended_at}`,
      `events: ${String(session.events.length)}`, ''];
  }
  return [`## Session — ${session.label}`, '', `- Agent: \`${String(session.agent_id)}\` (${session.actor_kind ?? 'unknown'})`,
    ...(session.model ? [`- Model: \`${session.model}\``] : []), ...(session.session_id ? [`- Session id: \`${session.session_id}\``] : []),
    `- Window: \`${session.started_at}\` → \`${session.ended_at}\``, `- Events: ${String(session.events.length)}`, ''];
}

function renderEvent(event: ReplayEvent, isMd: boolean) {
  const lines = [selectFormat(isMd, `**${event.timestamp}** · \`${event.kind}\` — ${String(event.intent)}`, `${event.timestamp}  [${event.kind}]  ${String(event.intent)}`)];
  if (event.decision_rationale) lines.push(selectFormat(isMd, `  - decision: ${event.decision_rationale}`, `  decision: ${event.decision_rationale}`));
  for (const rejected of event.rejected_alternatives ?? []) {
    lines.push(selectFormat(isMd, `  - rejected: \`${String(rejected.alternative)}\` — ${String(rejected.reason)}`, `  rejected: ${String(rejected.alternative)} :: ${String(rejected.reason)}`));
  }
  if (event.files_touched?.length) {
    const files = event.files_touched.slice(0, 6).join(', ');
    const more = event.files_touched.length > 6 ? ` (+${String(event.files_touched.length - 6)} more)` : '';
    lines.push(selectFormat(isMd, `  - files: ${files}${more}`, `  files: ${files}${more}`));
  }
  if (event.verification?.status) lines.push(selectFormat(isMd, `  - verification: \`${event.verification.command ?? '(no cmd)'}\` → ${event.verification.status}`, `  verify: ${event.verification.command ?? '(no cmd)'} → ${event.verification.status}`));
  if (event.linked_backlog?.length) lines.push(selectFormat(isMd, `  - backlog: ${event.linked_backlog.map((item) => `\`${item}\``).join(', ')}`, `  backlog: ${event.linked_backlog.join(', ')}`));
  if (event.commit) lines.push(selectFormat(isMd, `  - commit: \`${event.commit}\``, `  commit: ${event.commit}`));
  if (event.lease_id) lines.push(selectFormat(isMd, `  - lease: \`${event.lease_id}\``, `  lease: ${event.lease_id}`));
  lines.push('');
  return lines;
}

function selectFormat(isMarkdown: boolean, markdown: string, text: string) {
  return isMarkdown ? markdown : text;
}

function renderReplaySummary(events: ReplayEvent[], isMd: boolean) {
  const intentCount = uniq(events.map((event) => event.intent).filter(Boolean)).length;
  const decisionCount = uniq(events.map((event) => event.decision_rationale).filter(Boolean)).length;
  const backlog = uniq(events.flatMap((event) => event.linked_backlog ?? []));
  const lines = isMd ? ['## Summary', '', `- Distinct intents: ${String(intentCount)}`, `- Distinct decisions: ${String(decisionCount)}`]
    : ['Summary', `distinct intents: ${String(intentCount)}`, `distinct decisions: ${String(decisionCount)}`];
  if (backlog.length > 0) lines.push(isMd ? `- Linked backlog: ${backlog.map((item) => `\`${item}\``).join(', ')}` : `linked backlog: ${backlog.join(', ')}`);
  return lines;
}

function groupBySession(events: ReplayEvent[]) {
  const buckets = new Map<string, ReplayEvent[]>();
  for (const e of events) {
    const key = e.session_id ?? `agent:${e.actor_id ?? 'unknown'}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(e);
    else buckets.set(key, [e]);
  }
  const sessions: {
    label: string;
    session_id?: string;
    agent_id?: string;
    actor_kind?: string;
    model?: string;
    started_at: string;
    ended_at: string;
    events: ReplayEvent[];
  }[] = [];
  for (const [key, evs] of buckets) {
    evs.sort((a: { timestamp: string; }, b: { timestamp: string; }) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const head = evs[0];
    sessions.push({
      label: key,
      session_id: head.session_id,
      agent_id: head.actor_id,
      actor_kind: head.actor_kind,
      model: head.model,
      started_at: head.timestamp,
      ended_at: evs[evs.length - 1].timestamp,
      events: evs,
    });
  }
  sessions.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  return sessions;
}

function parseSince(raw: string | undefined) {
  if (!raw) return null;
  // Number of days form: "30d", "365d"
  const dm = /^(\d+)d$/.exec(raw);
  if (dm) return Date.now() - Number(dm[1]) * 24 * 60 * 60 * 1000;
  const t = Date.parse(raw);
  if (!Number.isNaN(t)) return t;
  throw new Error(`could not parse --since: ${raw}`);
}

function uniq<T>(arr: Iterable<T> | null | undefined) {
  return [...new Set(arr)];
}

function parseArgs(list: string[]): ReplayArgs {
  const out: ReplayArgs = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_match: string, character: string) => character.toUpperCase());
    const next = list.at(i + 1);
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) {
      if (camel === 'help') out.help = true;
      continue;
    }
    if (camel === 'project' || camel === 'brick' || camel === 'since' || camel === 'out' || camel === 'format') out[camel] = next;
    i += 1;
  }
  return out;
}

function isReplayEvent(value: Record<string, unknown>): value is Record<string, unknown> & ReplayEvent {
  return typeof value.timestamp === 'string' && typeof value.kind === 'string';
}
