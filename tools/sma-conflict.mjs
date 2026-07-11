#!/usr/bin/env node
/**
 * WHAT: Reports, resolves, summarizes, and audits multi-agent collisions as append-only context events.
 * WHY: Overlapping leases and dirty paths must become visible coordination state rather than silent races or overwritten work.
 * HOW: Reads lease and [agent-context](../docs/GLOSSARY.md#agent-context) logs, appends conflict events, and serves agents plus controller gates.
 * Usage: `node tools/sma-conflict.mjs summary --project sma --limit 5`
 */
/**
 * sma-conflict.mjs — mandatory collision reports for SMA Gen3 agents.
 *
 * Conflict reports are normal agent-context events. They are append-only,
 * project-local, and cheap to write while many agents are active.
 */

import { SMA_ROOT } from "./lib/sma-paths.ts";
import { argv, exit, env } from 'node:process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  appendContextEvent,
  readContextLog,
  logPath,
  listBricksWithContext,
} from './lib/context-log.ts';
import { discoverPortfolioProjects } from './lib/portfolio-projects.ts';


const LEASES_PATH = resolve(SMA_ROOT, 'registry/active-leases.generated.json');

const cmd = argv[2];
const args = parseArgs(argv.slice(3));

try {
  await main();
} catch (err) {
  console.error(`sma-conflict: ${err.message}`);
  exit(1);
}

async function main() {
  switch (cmd) {
    case 'report':
      runReport();
      break;
    case 'list':
      runList();
      break;
    case 'check':
      runCheck();
      break;
    case 'summary':
      await runSummary();
      break;
    case 'resolve':
      runResolve();
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
}

function usage() {
  console.log(`Usage:
  sma-conflict.mjs report  --project <id> --brick <id> --intent "..."
                           [--resource-kind <kind>] [--resource <id>]
                           [--holder-lease <lease_id>] [--holder-agent <id>]
                           [--blocked-agent <id>] [--resolution-plan "..."]
                           [--file <path>]... [--session <id>] [--task <id>]
                           [--model <name>] [--json]

  sma-conflict.mjs list    --project <id> [--brick <id>] [--open] [--json]

  sma-conflict.mjs check   --project <id> [--brick <id>] [--strict] [--json]

  sma-conflict.mjs summary [--project <id>|--all] [--json] [--limit 20]
                           [--warn-minutes 15] [--critical-minutes 60]

  sma-conflict.mjs resolve --project <id> --brick <id> --intent "..."
                           [--decision "..."] [--file <path>]... [--json]

Conflict reports are appended as agent-context events. Use this whenever an
agent hits a held lease, overlaps another agent's dirty path, or has to back off
from a shared hot path.
`);
}

function runReport() {
  requireArg('project', '--project');
  requireArg('brick', '--brick');
  requireArg('intent', '--intent');

  const holder = findHolder();
  const holderLease = args.holderLease || holder?.lease_id;
  const holderAgent = args.holderAgent || holder?.agent_id;
  const resourceKind = args.resourceKind || holder?.resource_kind || 'brick';
  const resource = args.resource || holder?.resource_id || args.brick;
  const blockedAgent = args.blockedAgent || env.SMA_AGENT || env.USER || 'unknown';

  const decision = [
    `blocked_agent=${blockedAgent}`,
    `resource=${resourceKind}:${resource}`,
    holderLease ? `holder_lease=${holderLease}` : null,
    holderAgent ? `holder_agent=${holderAgent}` : null,
    holder?.expires_at ? `holder_expires=${holder.expires_at}` : null,
    holder?.intent ? `holder_intent=${holder.intent}` : null,
    args.resolutionPlan ? `resolution_plan=${args.resolutionPlan}` : null,
  ].filter(Boolean).join(' | ');

  const event = appendContextEvent({
    project: args.project,
    brick: args.brick,
    kind: 'conflict_detected',
    intent: args.intent,
    actorKind: args.actorKind || 'agent',
    actorId: blockedAgent,
    model: args.model,
    sessionId: args.session,
    taskId: args.task,
    leaseId: holderLease,
    decisionRationale: decision,
    filesTouched: args.file,
  });

  if (args.json) {
    console.log(JSON.stringify({ event, holder: holder || null }, null, 2));
    return;
  }
  console.log(`[conflict] logged ${event.event_id} for ${args.project}/${args.brick}`);
  if (holderLease || holderAgent) {
    console.log(`[conflict] held by ${holderAgent || 'unknown'} ${holderLease ? `(${holderLease})` : ''}`);
  }
  console.log(`[conflict] log ${logPath(args.project, args.brick)}`);
}

function runResolve() {
  requireArg('project', '--project');
  requireArg('brick', '--brick');
  requireArg('intent', '--intent');
  const event = appendContextEvent({
    project: args.project,
    brick: args.brick,
    kind: 'conflict_resolved',
    intent: args.intent,
    actorKind: args.actorKind || 'agent',
    actorId: args.actor || env.SMA_AGENT || env.USER || 'unknown',
    model: args.model,
    sessionId: args.session,
    taskId: args.task,
    decisionRationale: args.decision,
    filesTouched: args.file,
  });

  if (args.json) console.log(JSON.stringify(event, null, 2));
  else console.log(`[conflict] resolved ${event.event_id} for ${args.project}/${args.brick}`);
}

function runList() {
  requireArg('project', '--project');
  const rows = collectConflictRows(args.project, args.brick);
  const open = collectOpenConflicts(args.project, args.brick);
  const visible = args.open ? open : rows;
  if (args.json) {
    console.log(JSON.stringify({ events: visible, open }, null, 2));
    return;
  }
  if (!visible.length) {
    console.log(args.open ? '(no open conflicts)' : '(no conflict events)');
    return;
  }
  for (const event of visible) {
    console.log(`${event.timestamp} ${event.kind} ${event.project}/${event.brick_id} ${event.actor_id}: ${event.intent}`);
    if (event.decision_rationale) console.log(`  ${event.decision_rationale}`);
  }
}

function runCheck() {
  requireArg('project', '--project');
  const open = collectOpenConflicts(args.project, args.brick);
  const result = {
    project: args.project,
    brick: args.brick || null,
    open_conflicts: open.length,
    status: open.length ? 'blocked' : 'clear',
    conflicts: open,
  };
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`project:        ${args.project}`);
    if (args.brick) console.log(`brick:          ${args.brick}`);
    console.log(`open conflicts: ${open.length}`);
    console.log(`status:         ${result.status}`);
    for (const event of open) {
      console.log(`  · ${event.brick_id} ${event.timestamp} ${event.actor_id}: ${event.intent}`);
      if (event.decision_rationale) console.log(`    ${event.decision_rationale}`);
    }
  }
  if (open.length && args.strict) exit(3);
}

async function runSummary() {
  const projects = await summaryProjects();
  const warnMinutes = numberArg(args.warnMinutes, 15);
  const criticalMinutes = numberArg(args.criticalMinutes, 60);
  const limit = numberArg(args.limit, 20);
  const now = Date.now();
  const skippedProjects = [];
  const openRows = [];
  for (const project of projects) {
    try {
      openRows.push(...collectOpenConflictsForSummary(project));
    } catch (err) {
      skippedProjects.push({ project: project.id, error: err.message });
    }
  }
  const conflicts = openRows
    .map((event) => decorateConflict(event, { now, warnMinutes, criticalMinutes }))
    .sort((left, right) => right.age_minutes - left.age_minutes
      || left.project.localeCompare(right.project)
      || left.brick_id.localeCompare(right.brick_id));
  const visible = conflicts.slice(0, limit);
  const summary = {
    schema_version: '1.0.0',
    generated_at: new Date(now).toISOString(),
    projects_scanned: projects.length,
    projects_skipped: skippedProjects.length,
    warn_minutes: warnMinutes,
    critical_minutes: criticalMinutes,
    open_conflicts: conflicts.length,
    warning_conflicts: conflicts.filter((event) => event.sla_status === 'warning').length,
    critical_conflicts: conflicts.filter((event) => event.sla_status === 'critical').length,
    oldest_age_minutes: conflicts[0]?.age_minutes ?? 0,
    oldest_age_bucket: conflicts[0]?.age_bucket ?? 'none',
    status: conflictSlaStatus(conflicts),
    hidden_conflicts: Math.max(0, conflicts.length - visible.length),
  };
  const result = {
    summary,
    conflicts: visible,
    skipped_projects: skippedProjects,
    next_commands: {
      all: 'npm run conflict:summary',
      json: 'npm run conflict:summary -- --json',
      strict_gate: 'npm run ci:gen3',
    },
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log('SMA Gen3 Conflict SLA');
  console.log(`projects scanned: ${summary.projects_scanned}`);
  if (summary.projects_skipped) console.log(`projects skipped: ${summary.projects_skipped}`);
  console.log(`open conflicts:   ${summary.open_conflicts}`);
  console.log(`status:           ${summary.status}`);
  console.log(`warning/critical: ${summary.warning_conflicts}/${summary.critical_conflicts}`);
  console.log(`oldest:           ${summary.oldest_age_bucket}`);
  if (!visible.length) {
    console.log('Conflicts: none');
    return;
  }
  for (const event of visible) {
    console.log(`- ${event.sla_status.toUpperCase()} ${event.project}/${event.brick_id} ${event.age_label}: ${event.intent}`);
    console.log(`  actor: ${event.actor_id || 'unknown'}  detected: ${event.timestamp}`);
    if (event.decision_rationale) console.log(`  ${event.decision_rationale}`);
    console.log(`  resolve: ${event.resolve_command}`);
  }
  if (summary.hidden_conflicts) {
    console.log(`... ${summary.hidden_conflicts} more hidden; rerun with --limit ${conflicts.length}`);
  }
}

function collectConflictRows(project, brick = null) {
  return targetBricks(project, brick).flatMap((brickId) => readContextLog(project, brickId)
    .filter((event) => event.kind === 'conflict_detected' || event.kind === 'conflict_resolved')
    .map((event) => ({ ...event, project: event.project || project, brick_id: event.brick_id || brickId })));
}

function collectOpenConflicts(project, brick = null) {
  return targetBricks(project, brick).flatMap((brickId) => openConflicts(readContextLog(project, brickId)
    .filter((event) => event.kind === 'conflict_detected' || event.kind === 'conflict_resolved'))
    .map((event) => ({ ...event, project: event.project || project, brick_id: event.brick_id || brickId })));
}

function targetBricks(project, brick = null) {
  if (brick) return [brick];
  return listBricksWithContext(project);
}

function openConflicts(events) {
  let openCount = 0;
  const out = [];
  for (const event of events) {
    if (event.kind === 'conflict_detected') {
      openCount += 1;
      out.push(event);
    } else if (event.kind === 'conflict_resolved' && openCount > 0) {
      openCount -= 1;
    }
  }
  if (openCount <= 0) return [];
  return out.slice(-openCount);
}

async function summaryProjects() {
  if (args.project && !args.all) return [{ id: String(args.project), root: null }];
  if (!args.all && !args.project) return [{ id: 'sma', root: SMA_ROOT }];
  const discovered = await discoverPortfolioProjects();
  const byId = new Map([['sma', { id: 'sma', root: SMA_ROOT }]]);
  for (const project of discovered) {
    if (!project?.id) continue;
    byId.set(project.id, { id: project.id, root: project.absolute_root || null });
  }
  return [...byId.values()];
}

function collectOpenConflictsForSummary(project) {
  if (project.root) return collectOpenConflictsFromRoot(project.id, project.root);
  return collectOpenConflicts(project.id);
}

function collectOpenConflictsFromRoot(projectId, root) {
  const dir = resolve(root, '.smarch/agent-context');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith('.ndjson'))
    .flatMap((file) => {
      const brickId = file.replace(/\.ndjson$/, '');
      return openConflicts(readContextLogFromPath(resolve(dir, file))
        .filter((event) => event.kind === 'conflict_detected' || event.kind === 'conflict_resolved'))
        .map((event) => ({ ...event, project: event.project || projectId, brick_id: event.brick_id || brickId }));
    });
}

function readContextLogFromPath(path) {
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      out.push({ _malformed: true, _raw: t });
    }
  }
  return out;
}

function decorateConflict(event, { now, warnMinutes, criticalMinutes }) {
  const timestampMs = Date.parse(event.timestamp || '');
  const ageMinutes = Number.isFinite(timestampMs)
    ? Math.max(0, Math.floor((now - timestampMs) / 60000))
    : 0;
  return {
    project: event.project,
    brick_id: event.brick_id,
    event_id: event.event_id,
    timestamp: event.timestamp,
    age_minutes: ageMinutes,
    age_bucket: ageBucket(ageMinutes, warnMinutes, criticalMinutes),
    age_label: ageLabel(ageMinutes),
    sla_status: conflictSlaStatusForAge(ageMinutes, warnMinutes, criticalMinutes),
    actor_id: event.actor_id || null,
    session_id: event.session_id || null,
    task_id: event.task_id || null,
    lease_id: event.lease_id || null,
    intent: event.intent || '',
    decision_rationale: event.decision_rationale || '',
    files_touched: event.files_touched || [],
    resolve_command: `npm run conflict -- resolve --project ${shellArg(event.project)} --brick ${shellArg(event.brick_id)} --intent ${shellArg('resolved documented collision')} --decision ${shellArg('controller resolved, split, or reassigned the overlap')}`,
    check_command: `npm run conflict:check -- --project ${shellArg(event.project)} --brick ${shellArg(event.brick_id)} --strict`,
  };
}

function conflictSlaStatus(conflicts) {
  if (!conflicts.length) return 'clear';
  if (conflicts.some((event) => event.sla_status === 'critical')) return 'critical';
  if (conflicts.some((event) => event.sla_status === 'warning')) return 'warning';
  return 'open';
}

function conflictSlaStatusForAge(ageMinutes, warnMinutes, criticalMinutes) {
  if (ageMinutes >= criticalMinutes) return 'critical';
  if (ageMinutes >= warnMinutes) return 'warning';
  return 'open';
}

function ageBucket(ageMinutes, warnMinutes, criticalMinutes) {
  if (ageMinutes >= criticalMinutes) return `${criticalMinutes}m+`;
  if (ageMinutes >= warnMinutes) return `${warnMinutes}-${criticalMinutes - 1}m`;
  return `<${warnMinutes}m`;
}

function ageLabel(ageMinutes) {
  if (ageMinutes < 60) return `${ageMinutes}m`;
  const hours = Math.floor(ageMinutes / 60);
  const minutes = ageMinutes % 60;
  return minutes ? `${hours}h${minutes}m` : `${hours}h`;
}

function numberArg(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function shellArg(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function findHolder() {
  const resourceKind = args.resourceKind || 'brick';
  const resource = args.resource || args.brick;
  if (!resource || !existsSync(LEASES_PATH)) return null;
  let registry;
  try {
    registry = JSON.parse(readFileSync(LEASES_PATH, 'utf8'));
  } catch {
    return null;
  }
  const now = Date.now();
  return (registry.leases || []).find((lease) => (
    lease.resource_kind === resourceKind
    && lease.resource_id === resource
    && Date.parse(lease.expires_at) > now
  )) || null;
}

function requireArg(key, flag) {
  if (args[key] === undefined || args[key] === null || args[key] === '') {
    throw new Error(`missing ${flag}`);
  }
}

function parseArgs(list) {
  const out = { file: [] };
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = list[i + 1];
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) {
      out[key] = true;
      continue;
    }
    if (key === 'file') out.file.push(next);
    else out[key] = next;
    i += 1;
  }
  return out;
}
