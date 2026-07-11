#!/usr/bin/env node
/**
 * WHAT: Acquires an edit lease and records the planned edit in one command.
 * WHY: Separate lease and context commands can leave ownership and intent out of sync.
 * HOW: Validates project, brick, and intent inputs before invoking lease and context tools.
 * OUTPUTS: Prints or returns the lease, context event, conflict details, and dirty baseline.
 * CALLERS: Agents use it before editing and pair it with sma-end-edit.ts afterward.
 * USAGE: `node tools/sma-start-edit.ts --help`
 * Glossary: [SMA](../docs/GLOSSARY.md).
 */

import { argv, exit, env } from 'node:process';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const LEASE = resolve(TOOLS_DIR, 'sma-lease.ts');
const CONFLICT = resolve(TOOLS_DIR, 'sma-conflict.ts');
const DIRTY = resolve(TOOLS_DIR, 'sma-dirty-baseline.ts');

const args = parseArgs(argv.slice(2));

if (args.help || !args.project || !args.brick || !args.intent) {
  usage();
  exit(args.help ? 0 : 2);
}

try {
  const acquireArgs = [
    LEASE, 'acquire',
    '--resource-kind', 'brick',
    '--resource', args.brick,
    '--project', args.project,
    '--brick', args.brick,
    '--intent', args.intent,
    '--ttl', String(args.ttl ?? 1200),
    '--auto-context',
    '--json',
  ];
  if (args.rationale) acquireArgs.push('--rationale', args.rationale);
  if (args.task) acquireArgs.push('--task', args.task);
  if (args.session) acquireArgs.push('--session', args.session);
  if (args.actorKind) acquireArgs.push('--actor-kind', args.actorKind);
  if (args.model) acquireArgs.push('--model', args.model);
  for (const id of args.linkedBacklog ?? []) acquireArgs.push('--linked-backlog', id);

  const res = spawnSync('node', acquireArgs, { encoding: 'utf8' });
  if (res.status !== 0) {
    process.stderr.write(res.stderr ?? '');
    if (res.status === 10) {
      const report = reportConflict();
      if (!report.ok) exit(report.status || 11);
    }
    exit(res.status ?? 1);
  }
  const lease = JSON.parse(res.stdout);

  // The acquire above already auto-stamped a `lease_acquired` event. Now add
  // an `edit_planned` event so the next agent reading the log sees the actual
  // edit intent (not just the lease metadata).
  const contextArgs = [
    resolve(TOOLS_DIR, 'sma-context.ts'), 'append',
    '--project', args.project,
    '--brick', args.brick,
    '--kind', 'edit_planned',
    '--intent', args.intent,
    '--lease', lease.lease_id,
    '--json',
  ];
  if (args.rationale) contextArgs.push('--decision', args.rationale);
  if (args.task) contextArgs.push('--task', args.task);
  if (args.session) contextArgs.push('--session', args.session);
  if (args.actorKind) contextArgs.push('--actor-kind', args.actorKind);
  if (args.model) contextArgs.push('--model', args.model);
  for (const id of args.linkedBacklog ?? []) contextArgs.push('--linked-backlog', id);
  for (const file of args.file ?? []) contextArgs.push('--file', file);

  const ctxRes = spawnSync('node', contextArgs, { encoding: 'utf8' });
  if (ctxRes.status !== 0) {
    process.stderr.write(ctxRes.stderr ?? '');
    console.error('[start-edit] WARN: context append failed; lease is held but log is incomplete');
    exit(ctxRes.status ?? 1);
  }
  const event = JSON.parse(ctxRes.stdout);
  const dirtyBaseline = args.noDirtyBaseline ? null : captureDirtyBaseline(lease.lease_id);

  if (args.json) {
    console.log(JSON.stringify({ lease, context_event: event, dirty_baseline: dirtyBaseline }, null, 2));
  } else {
    console.log(`[start-edit] acquired ${lease.lease_id} (${lease.resource_kind}:${lease.resource_id})`);
    console.log(`[start-edit] expires ${lease.expires_at}`);
    console.log(`[start-edit] logged  ${event.event_id} (edit_planned)`);
    if (dirtyBaseline?.ok) {
      console.log(`[start-edit] dirty baseline ${dirtyBaseline.id}: ${formatDirtyCounts(dirtyBaseline.summary)}`);
    } else if (dirtyBaseline?.error) {
      console.log(`[start-edit] dirty baseline skipped: ${dirtyBaseline.error}`);
    }
    console.log('');
    console.log('When done, finish with:');
    console.log(`  sma end-edit --lease ${lease.lease_id} --project ${args.project} --brick ${args.brick} --intent "<what you ended up doing>"`);
  }
} catch (err) {
  console.error(`sma-start-edit: ${err.message}`);
  exit(1);
}

function reportConflict() {
  const conflictArgs = [
    CONFLICT, 'report',
    '--project', args.project,
    '--brick', args.brick,
    '--resource-kind', 'brick',
    '--resource', args.brick,
    '--intent', args.intent,
    '--resolution-plan', 'back off, inspect the holder intent, and retry after release or explicit handoff',
  ];
  if (args.session) conflictArgs.push('--session', args.session);
  if (args.task) conflictArgs.push('--task', args.task);
  if (args.actorKind) conflictArgs.push('--actor-kind', args.actorKind);
  if (args.model) conflictArgs.push('--model', args.model);
  for (const file of args.file ?? []) conflictArgs.push('--file', file);
  const conflict = spawnSync('node', conflictArgs, { encoding: 'utf8' });
  if (conflict.status !== 0) {
    process.stderr.write(conflict.stderr ?? '');
    console.error('[start-edit] ERROR: conflict report failed; lease collision was not logged');
    console.error(`[start-edit] manual report command: node ${CONFLICT} report --project ${args.project} --brick ${args.brick} --resource-kind brick --resource ${args.brick} --intent ${shellArg(args.intent)} --resolution-plan ${shellArg('back off, inspect the holder intent, and retry after release or explicit handoff')}`);
    return { ok: false, status: conflict.status ?? 11 };
  }
  process.stderr.write(conflict.stdout ?? '');
  return { ok: true };
}

function captureDirtyBaseline(label) {
  const res = spawnSync('node', [
    DIRTY,
    'save',
    '--project', args.project,
    '--label', label,
    '--json',
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  if (res.status !== 0) {
    return { ok: false, error: firstLine(res.stderr) || `exit ${res.status ?? 1}` };
  }
  try {
    const parsed = JSON.parse(res.stdout);
    return {
      ok: true,
      id: parsed.baseline?.id ?? null,
      label: parsed.baseline?.label ?? label,
      created_at: parsed.baseline?.created_at ?? null,
      summary: parsed.baseline?.summary ?? null,
    };
  } catch (err) {
    return { ok: false, error: `invalid dirty baseline JSON: ${err.message}` };
  }
}

function formatDirtyCounts(summary) {
  if (!summary) return 'unknown dirty state';
  return `${summary.dirty_count ?? 0} dirty (${summary.modified_count ?? 0} modified, ${summary.untracked_count ?? 0} untracked)`;
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/).find((line) => line.trim())?.trim() || '';
}

function shellArg(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function usage() {
  console.log(`Usage:
  sma-start-edit.ts --project <id> --brick <id> --intent "..." [--ttl 1200]
                     [--rationale "..."] [--task <id>] [--session <id>]
                     [--actor-kind <kind>] [--model <name>]
                     [--linked-backlog <id>]... [--file <path>]...
                     [--no-dirty-baseline] [--json]

Acquires a lease + appends an edit_planned context event in one shot.
Pair with sma end-edit to release + record edit_applied/decision.
`);
}

function parseArgs(list) {
  const out: Record<string, any> = { linkedBacklog: [], file: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = list[i + 1];
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) { out[camel] = true; continue; }
    if (camel === 'linkedBacklog') out.linkedBacklog.push(next);
    else if (camel === 'file') out.file.push(next);
    else out[camel] = next;
    i += 1;
  }
  return out;
}
