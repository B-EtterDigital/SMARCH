#!/usr/bin/env node
/**
 * sma-context-replay.mjs — render a brick's full agent-context log as a story.
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
import { readContextLog } from './lib/context-log.mjs';

const args = parseArgs(argv.slice(2));

if (args.help || !args.project || !args.brick) {
  usage();
  exit(args.help ? 0 : 2);
}

try {
  const events = readContextLog(args.project, args.brick);
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
  console.error(`sma-context-replay: ${err.message}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-context-replay.mjs --project <id> --brick <id> [--since <iso|Nd>]
                         [--out <path>] [--format md|text|json]
`);
}

function renderTimeline({ project, brick, events, format }) {
  const sessions = groupBySession(events);
  const isMd = format !== 'text';
  const lines = [];

  if (isMd) {
    lines.push(`# Replay — \`${brick}\``);
    lines.push('');
    lines.push(`Project: \`${project}\``);
    lines.push(`Total events: ${events.length}`);
    if (events.length) {
      const first = events[0]?.timestamp;
      const last = events[events.length - 1]?.timestamp;
      lines.push(`Window: \`${first}\` → \`${last}\``);
    }
    lines.push('');
    if (!events.length) {
      lines.push('_(no events for this brick)_');
      return lines.join('\n');
    }
  } else {
    lines.push(`Replay — ${brick}`);
    lines.push(`Project: ${project}`);
    lines.push(`Total events: ${events.length}`);
    lines.push('');
    if (!events.length) {
      lines.push('(no events for this brick)');
      return lines.join('\n');
    }
  }

  for (const session of sessions) {
    if (isMd) {
      lines.push(`## Session — ${session.label}`);
      lines.push('');
      lines.push(`- Agent: \`${session.agent_id}\` (${session.actor_kind ?? 'unknown'})`);
      if (session.model) lines.push(`- Model: \`${session.model}\``);
      if (session.session_id) lines.push(`- Session id: \`${session.session_id}\``);
      lines.push(`- Window: \`${session.started_at}\` → \`${session.ended_at}\``);
      lines.push(`- Events: ${session.events.length}`);
      lines.push('');
    } else {
      lines.push(`-- Session ${session.label} --`);
      lines.push(`agent: ${session.agent_id} (${session.actor_kind ?? 'unknown'})`);
      if (session.model) lines.push(`model: ${session.model}`);
      lines.push(`window: ${session.started_at} → ${session.ended_at}`);
      lines.push(`events: ${session.events.length}`);
      lines.push('');
    }

    for (const e of session.events) {
      const head = isMd
        ? `**${e.timestamp}** · \`${e.kind}\` — ${e.intent}`
        : `${e.timestamp}  [${e.kind}]  ${e.intent}`;
      lines.push(head);
      if (e.decision_rationale) {
        lines.push(isMd ? `  - decision: ${e.decision_rationale}` : `  decision: ${e.decision_rationale}`);
      }
      if (e.rejected_alternatives?.length) {
        for (const r of e.rejected_alternatives) {
          lines.push(isMd
            ? `  - rejected: \`${r.alternative}\` — ${r.reason}`
            : `  rejected: ${r.alternative} :: ${r.reason}`);
        }
      }
      if (e.files_touched?.length) {
        const files = e.files_touched.slice(0, 6).join(', ');
        const more = e.files_touched.length > 6 ? ` (+${e.files_touched.length - 6} more)` : '';
        lines.push(isMd ? `  - files: ${files}${more}` : `  files: ${files}${more}`);
      }
      if (e.verification?.status) {
        lines.push(isMd
          ? `  - verification: \`${e.verification.command || '(no cmd)'}\` → ${e.verification.status}`
          : `  verify: ${e.verification.command || '(no cmd)'} → ${e.verification.status}`);
      }
      if (e.linked_backlog?.length) {
        lines.push(isMd
          ? `  - backlog: ${e.linked_backlog.map((b) => `\`${b}\``).join(', ')}`
          : `  backlog: ${e.linked_backlog.join(', ')}`);
      }
      if (e.commit) {
        lines.push(isMd ? `  - commit: \`${e.commit}\`` : `  commit: ${e.commit}`);
      }
      if (e.lease_id) {
        lines.push(isMd ? `  - lease: \`${e.lease_id}\`` : `  lease: ${e.lease_id}`);
      }
      lines.push('');
    }
  }

  // Summary footer
  const allIntents = uniq(events.map((e) => e.intent).filter(Boolean));
  const allDecisions = uniq(events.map((e) => e.decision_rationale).filter(Boolean));
  const allBacklog = uniq(events.flatMap((e) => e.linked_backlog ?? []));
  if (isMd) {
    lines.push(`## Summary`);
    lines.push('');
    lines.push(`- Distinct intents: ${allIntents.length}`);
    lines.push(`- Distinct decisions: ${allDecisions.length}`);
    if (allBacklog.length) lines.push(`- Linked backlog: ${allBacklog.map((b) => `\`${b}\``).join(', ')}`);
  } else {
    lines.push(`Summary`);
    lines.push(`distinct intents: ${allIntents.length}`);
    lines.push(`distinct decisions: ${allDecisions.length}`);
    if (allBacklog.length) lines.push(`linked backlog: ${allBacklog.join(', ')}`);
  }

  return lines.join('\n');
}

function groupBySession(events) {
  const buckets = new Map();
  for (const e of events) {
    const key = e.session_id || `agent:${e.actor_id || 'unknown'}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  }
  const sessions = [];
  for (const [key, evs] of buckets) {
    evs.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
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

function parseSince(raw) {
  if (!raw) return null;
  // Number of days form: "30d", "365d"
  const dm = String(raw).match(/^(\d+)d$/);
  if (dm) return Date.now() - Number(dm[1]) * 24 * 60 * 60 * 1000;
  const t = Date.parse(raw);
  if (!Number.isNaN(t)) return t;
  throw new Error(`could not parse --since: ${raw}`);
}

function uniq(arr) {
  return [...new Set(arr)];
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
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
