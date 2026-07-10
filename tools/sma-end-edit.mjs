#!/usr/bin/env node
/**
 * sma-end-edit.mjs — bookend for sma-start-edit. Appends an edit_applied (or
 * decision_recorded) event with the actual outcome, then releases the lease.
 *
 * Usage:
 *   sma end-edit --lease <lease_id> --project <id> --brick <id>
 *                --intent "what you ended up doing"
 *                [--decision "..."] [--rejected "alt::reason"]...
 *                [--file <path>]... [--commit <sha>]
 *                [--verify-cmd "..." --verify-status pass|fail|skipped|blocked]
 *                [--kind edit_applied|decision_recorded]  (default: edit_applied)
 *                [--no-release]    (just log; don't release the lease)
 *                [--no-preflight-tldr]
 *                [--json]
 */

import { argv, exit } from 'node:process';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const DIRTY = resolve(TOOLS_DIR, 'sma-dirty-baseline.mjs');
const PARALLEL_PREFLIGHT = resolve(TOOLS_DIR, 'sma-parallel-preflight.mjs');

const rawArgs = argv.slice(2);
const command = rawArgs.find((arg) => !arg.startsWith('--')) || '';
const args = parseArgs(rawArgs);

if (args.selftest || command === 'selftest') {
  runSelftest();
  exit(0);
}

if (args.help || !args.lease || !args.project || !args.brick || !args.intent) {
  usage();
  exit(args.help ? 0 : 2);
}

const kind = args.kind ?? 'edit_applied';

try {
  if (args.requireCleanupOk && args.noDirtyDelta) {
    throw new Error('--require-cleanup-ok cannot be combined with --no-dirty-delta');
  }

  const preflightDirtyDelta = args.requireCleanupOk ? captureDirtyDelta(args.lease) : null;
  const preflightCleanup = preflightDirtyDelta?.ok ? dirtyCleanupStatus(preflightDirtyDelta, { preflight: true }) : null;
  if (args.requireCleanupOk) {
    enforceCleanupOk(preflightDirtyDelta, preflightCleanup);
  }

  const contextArgs = [
    resolve(TOOLS_DIR, 'sma-context.mjs'), 'append',
    '--project', args.project,
    '--brick', args.brick,
    '--kind', kind,
    '--intent', args.intent,
    '--lease', args.lease,
    '--json',
  ];
  if (args.decision) contextArgs.push('--decision', args.decision);
  for (const r of args.rejected ?? []) contextArgs.push('--rejected', r);
  for (const f of args.file ?? []) contextArgs.push('--file', f);
  if (args.commit) contextArgs.push('--commit', args.commit);
  if (args.verifyCmd) contextArgs.push('--verify-cmd', args.verifyCmd);
  if (args.verifyStatus) contextArgs.push('--verify-status', args.verifyStatus);

  const ctxRes = spawnSync('node', contextArgs, { encoding: 'utf8' });
  if (ctxRes.status !== 0) {
    process.stderr.write(ctxRes.stderr ?? '');
    exit(ctxRes.status ?? 1);
  }
  const event = JSON.parse(ctxRes.stdout);

  let released = null;
  if (!args.noRelease) {
    const releaseArgs = [
      resolve(TOOLS_DIR, 'sma-lease.mjs'), 'release',
      '--lease', args.lease,
      '--project', args.project,
      '--brick', args.brick,
      '--auto-context',
      '--json',
    ];
    if (args.decision || args.intent) releaseArgs.push('--reason', args.decision ?? args.intent);
    const relRes = spawnSync('node', releaseArgs, { encoding: 'utf8' });
    if (relRes.status !== 0) {
      process.stderr.write(relRes.stderr ?? '');
      exit(relRes.status ?? 1);
    }
    released = JSON.parse(relRes.stdout);
  }

  const dirtyDelta = args.noDirtyDelta ? null : (preflightDirtyDelta || captureDirtyDelta(args.lease));
  const cleanup = dirtyDelta?.ok ? (preflightCleanup || dirtyCleanupStatus(dirtyDelta)) : null;
  const gen3Tldr = args.noPreflightTldr ? null : captureGen3PreflightTldr();

  if (args.json) {
    console.log(JSON.stringify({ context_event: event, released, dirty_delta: dirtyDelta, cleanup, gen3_tldr: gen3Tldr }, null, 2));
  } else {
    console.log(`[end-edit] logged  ${event.event_id} (${kind})`);
    if (released) console.log(`[end-edit] released ${released.lease_id}`);
    else console.log('[end-edit] lease left held (--no-release)');
    if (dirtyDelta?.ok) {
      console.log(`[end-edit] dirty delta: ${formatDirtyDelta(dirtyDelta)}`);
      printCleanupStatus(cleanup);
    } else if (dirtyDelta?.error) {
      console.log(`[end-edit] dirty delta skipped: ${dirtyDelta.error}`);
    }
    printGen3Tldr(gen3Tldr);
  }
} catch (err) {
  console.error(`sma-end-edit: ${err.message}`);
  exit(1);
}

function captureGen3PreflightTldr() {
  const preflightArgs = buildGen3PreflightArgs(args.project);
  const res = spawnSync('node', preflightArgs, {
    encoding: 'utf8',
    maxBuffer: 12 * 1024 * 1024,
    timeout: 120000,
  });
  if (res.status !== 0) {
    return {
      ok: false,
      error: firstLine(res.stderr) || `exit ${res.status ?? 1}`,
    };
  }
  try {
    const parsed = JSON.parse(res.stdout);
    return {
      ok: true,
      scope_project: parsed.scope?.project || null,
      status: parsed.status || 'unknown',
      readiness_score_percent: Number(parsed.readiness_score_percent || 0),
      active_lane_capacity_percent: Number(parsed.active_lane_capacity_percent ?? parsed.readiness_score_percent ?? 0),
      recommended_agents: Number(parsed.recommended_agents || 0),
      active_recommended_agents: Number(parsed.active_recommended_agents ?? parsed.recommended_agents ?? 0),
      requested_agents: Number(parsed.requested_agents || 0),
      active_lane: parsed.active_lane || '',
      launch_allowed: Boolean(parsed.launch_allowed),
      release_allowed: Boolean(parsed.launch_decision?.release_allowed),
      launch_slots: Number(parsed.big_picture?.current_state?.launch_slots ?? parsed.launch_plan?.length ?? 0),
      tldr: parsed.big_picture?.tldr || '',
      current_slice: parsed.big_picture?.current_slice || '',
      outlook: Array.isArray(parsed.big_picture?.next_slices) ? parsed.big_picture.next_slices.slice(0, 3) : [],
      horizon: Array.isArray(parsed.big_picture?.horizon) ? parsed.big_picture.horizon.slice(0, 3) : [],
      eta: parsed.big_picture?.eta || null,
      primary_next_command: parsed.primary_next_command || '',
      conflicts: parsed.conflict_sla?.open_conflicts ?? null,
      graph_packets: parsed.graph_packets?.packet_count ?? null,
      active_leases: parsed.controller?.active_leases ?? null,
    };
  } catch (err) {
    return {
      ok: false,
      error: `invalid preflight JSON: ${err.message}`,
    };
  }
}

function buildGen3PreflightArgs(project) {
  const preflightArgs = [
    PARALLEL_PREFLIGHT,
    '--json',
    '--no-auto-refresh',
  ];
  if (project && project !== 'sma') {
    preflightArgs.push('--project', project);
  }
  return preflightArgs;
}

function printGen3Tldr(report) {
  if (!report) return;
  if (!report.ok) {
    console.log(`[end-edit] Gen3 big picture unavailable: ${report.error}`);
    return;
  }
  console.log(`[end-edit] Gen3 big picture: ${report.tldr || 'no TLDR available'}`);
  if (report.scope_project) console.log(`[end-edit] Gen3 scope: project ${report.scope_project}`);
  console.log(`[end-edit] Gen3 readiness: ${formatReadinessScore(report)} ${report.status}${formatLaunchStatusSuffix(report)}; ${report.active_recommended_agents}/${report.requested_agents} active-lane agents; cleanup ${report.recommended_agents}/${report.requested_agents}; ${report.launch_slots} launch slots; conflicts ${report.conflicts ?? 'n/a'}; graphs ${report.graph_packets ?? 'n/a'}; leases ${report.active_leases ?? 'n/a'}`);
  if (report.current_slice) console.log(`[end-edit] Gen3 current slice: ${report.current_slice}`);
  for (const [index, item] of (report.outlook || []).entries()) {
    console.log(`[end-edit] Gen3 outlook ${index + 1}: ${item}`);
  }
  if (report.horizon?.length) console.log(`[end-edit] Gen3 horizon: ${report.horizon.join(' | ')}`);
  if (report.eta) console.log(`[end-edit] Gen3 eta: ${formatEta(report.eta)}`);
  if (report.primary_next_command) console.log(`[end-edit] Gen3 next: ${report.primary_next_command}`);
}

function formatReadinessScore(report) {
  const launch = Number(report?.active_lane_capacity_percent ?? report?.readiness_score_percent ?? 0);
  const integration = Number(report?.readiness_score_percent ?? 0);
  if (launch !== integration) return `launch ${launch}%, integration ${integration}%`;
  return `${integration}%`;
}

function formatLaunchStatusSuffix(report) {
  if (report?.launch_allowed && report?.release_allowed) return ` (${report.active_lane || 'active lane'} ready; release allowed)`;
  if (report?.launch_allowed) return ` (${report.active_lane || 'active lane'} ready; release blocked)`;
  return '';
}

function runSelftest() {
  const projectArgs = buildGen3PreflightArgs('acme-desktop');
  assertSelftest(projectArgs.includes('--project'), 'project closeouts should use project-scoped preflight');
  assertSelftest(projectArgs.includes('acme-desktop'), 'project closeouts should pass the project id');
  const smaArgs = buildGen3PreflightArgs('sma');
  assertSelftest(!smaArgs.includes('--project'), 'SMA controller closeouts should keep portfolio-wide preflight');
  assertSelftest(
    formatReadinessScore({ active_lane_capacity_percent: 75, readiness_score_percent: 0 }) === 'launch 75%, integration 0%',
    'readiness formatter should separate launch capacity from integration readiness',
  );
  assertSelftest(
    formatLaunchStatusSuffix({ launch_allowed: true, release_allowed: false, active_lane: 'module-observe' }) === ' (module-observe ready; release blocked)',
    'status suffix should keep release blocked while module launch is allowed',
  );
  console.log('OK sma-end-edit selftest');
}

function assertSelftest(condition, message) {
  if (!condition) throw new Error(`selftest failed: ${message}`);
}

function formatEta(eta) {
  if (typeof eta === 'string') return eta;
  if (!eta || typeof eta !== 'object') return 'n/a';
  return Object.entries(eta)
    .map(([key, value]) => `${key.replace(/_/g, ' ')} ${value}`)
    .join('; ');
}

function captureDirtyDelta(label) {
  const res = spawnSync('node', [
    DIRTY,
    'delta',
    '--project', args.project,
    '--label', label,
    '--json',
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (res.status !== 0) {
    return { ok: false, error: firstLine(res.stderr) || `exit ${res.status ?? 1}` };
  }
  try {
    const parsed = JSON.parse(res.stdout);
    const delta = parsed.delta ?? {};
    return {
      ok: true,
      label: parsed.label ?? label,
      baseline_id: parsed.baseline_id ?? null,
      baseline_created_at: parsed.baseline_created_at ?? null,
      baseline: parsed.baseline ?? null,
      current: parsed.current ?? null,
      delta: {
        new_count: Array.isArray(delta.new) ? delta.new.length : 0,
        cleared_count: Array.isArray(delta.cleared) ? delta.cleared.length : 0,
        status_changed_count: Array.isArray(delta.status_changed) ? delta.status_changed.length : 0,
        unchanged_count: Number(delta.unchanged_count ?? 0),
      },
    };
  } catch (err) {
    return { ok: false, error: `invalid dirty delta JSON: ${err.message}` };
  }
}

function formatDirtyDelta(report) {
  const delta = report.delta ?? {};
  return `${delta.new_count ?? 0} new, ${delta.cleared_count ?? 0} cleared, ${delta.status_changed_count ?? 0} changed, ${delta.unchanged_count ?? 0} unchanged hidden`;
}

function dirtyCleanupStatus(report, options = {}) {
  const delta = report.delta ?? {};
  const newCount = Number(delta.new_count ?? 0);
  const changedCount = Number(delta.status_changed_count ?? 0);
  const requiresCleanup = newCount + changedCount > 0;
  return {
    status: requiresCleanup ? 'cleanup_required' : 'cleanup_ok',
    requires_cleanup: requiresCleanup,
    new_count: newCount,
    status_changed_count: changedCount,
    cleared_count: Number(delta.cleared_count ?? 0),
    unchanged_count: Number(delta.unchanged_count ?? 0),
    preflight: Boolean(options.preflight),
    delta_command: `npm run dirty:delta -- --project ${shellArg(args.project)} --label ${shellArg(args.lease)}`,
    guidance: requiresCleanup
      ? 'commit task-scoped work, delete scratch output, or keep the handoff explicitly classified before final integration'
      : 'no new or status-changed dirty paths since the task baseline',
  };
}

function enforceCleanupOk(dirtyDelta, cleanup) {
  if (!dirtyDelta?.ok) {
    const error = dirtyDelta?.error || 'dirty delta unavailable';
    if (args.json) {
      console.log(JSON.stringify({
        ok: false,
        status: 'cleanup_check_failed',
        error,
        released: false,
      }, null, 2));
    } else {
      console.error(`[end-edit] cleanup check failed: ${error}`);
      console.error('[end-edit] lease left held; rerun without --require-cleanup-ok only for an explicit handoff.');
    }
    exit(4);
  }
  if (!cleanup?.requires_cleanup) return;
  if (args.json) {
    console.log(JSON.stringify({
      ok: false,
      status: cleanup.status,
      released: false,
      dirty_delta: dirtyDelta,
      cleanup,
    }, null, 2));
  } else {
    console.error(`[end-edit] cleanup required: ${cleanup.new_count} new, ${cleanup.status_changed_count} changed since start`);
    console.error(`[end-edit] next: ${cleanup.guidance}`);
    console.error(`[end-edit] inspect: ${cleanup.delta_command}`);
    console.error('[end-edit] lease left held; clean or commit the task delta before releasing.');
  }
  exit(4);
}

function printCleanupStatus(cleanup) {
  if (!cleanup) return;
  if (cleanup.requires_cleanup) {
    console.log(`[end-edit] cleanup required: ${cleanup.new_count} new, ${cleanup.status_changed_count} changed since start`);
    console.log(`[end-edit] next: ${cleanup.guidance}`);
    console.log(`[end-edit] inspect: ${cleanup.delta_command}`);
    return;
  }
  console.log('[end-edit] cleanup ok: no new or status-changed dirty paths since start');
}

function firstLine(value) {
  return String(value || '').split(/\r?\n/).find((line) => line.trim())?.trim() || '';
}

function shellArg(value) {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function usage() {
  console.log(`Usage:
  sma-end-edit.mjs --lease <lease_id> --project <id> --brick <id> --intent "..."
                   [--decision "..."] [--rejected "alt::reason"]... [--file <path>]...
                   [--commit <sha>] [--verify-cmd "..." --verify-status <s>]
                   [--kind edit_applied|decision_recorded] [--no-release]
                   [--require-cleanup-ok] [--no-dirty-delta]
                   [--no-preflight-tldr] [--json]

Prints a dirty delta and cleanup ok/required status unless --no-dirty-delta is set.
Also prints a compact Gen3 big-picture TLDR unless --no-preflight-tldr is set.
With --require-cleanup-ok, exits 4 before logging/releasing when the task delta
still has new or status-changed dirty paths.
`);
}

function parseArgs(list) {
  const out = { rejected: [], file: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = list[i + 1];
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) { out[camel] = true; continue; }
    if (camel === 'rejected') out.rejected.push(next);
    else if (camel === 'file') out.file.push(next);
    else out[camel] = next;
    i += 1;
  }
  return out;
}
