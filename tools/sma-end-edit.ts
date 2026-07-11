#!/usr/bin/env node
/* Defensive external-input guards and JavaScript coercion semantics are intentional in this behavior-preserving strict-type pass. */
/* eslint @typescript-eslint/no-unnecessary-boolean-literal-compare: "off", @typescript-eslint/no-unnecessary-condition: "off", @typescript-eslint/no-useless-default-assignment: "off", @typescript-eslint/prefer-nullish-coalescing: "off", @typescript-eslint/array-type: "off", max-lines-per-function: "off", complexity: "off", @typescript-eslint/prefer-optional-chain: "off", @typescript-eslint/no-base-to-string: "off", @typescript-eslint/no-unnecessary-type-conversion: "off", @typescript-eslint/restrict-template-expressions: "off", @typescript-eslint/use-unknown-in-catch-callback-variable: "off" */
/**
 * WHAT: Records an edit outcome, reports its dirty delta, and releases the matching lease.
 * WHY: Work must close with evidence and ownership cleanup rather than an untracked handoff.
 * HOW: Captures verification context, checks cleanup policy, appends an event, and releases ownership.
 * INPUTS: Lease, project, brick, intent, changed files, and optional verification evidence.
 * OUTPUTS: A closeout receipt, cleanup status, portfolio summary, and released lease state.
 * CALLERS: Agents and controllers at the end of a leased edit session.
 * Usage: `node tools/sma-end-edit.ts --help`
 */
/**
 * sma-end-edit.ts — bookend for sma-start-edit. Appends an edit_applied (or
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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const DIRTY = resolve(TOOLS_DIR, 'sma-dirty-baseline.ts');
const PARALLEL_PREFLIGHT = resolve(TOOLS_DIR, 'sma-parallel-preflight.ts');

interface EndEditArgs {
  help?: boolean; selftest?: boolean; lease?: string; project?: string; brick?: string; intent?: string;
  auto?: boolean; kind?: string; requireCleanupOk?: boolean; noDirtyDelta?: boolean; noRelease?: boolean;
  noPreflightTldr?: boolean; json?: boolean; decision?: string; rejected: string[]; file: string[];
  commit?: string; verifyCmd?: string; verifyStatus?: string; historyFile?: string;
}
interface PreflightReport {
  ok?: boolean; error?: string; scope_project?: string | null; status?: string; readiness_score_percent?: number;
  active_lane_capacity_percent?: number; recommended_agents?: number; active_recommended_agents?: number;
  requested_agents?: number; active_lane?: string; launch_allowed?: boolean; release_allowed?: boolean;
  launch_slots?: number; tldr?: string; current_slice?: string; outlook?: unknown[]; horizon?: unknown[];
  eta?: unknown; primary_next_command?: string; conflicts?: unknown; graph_packets?: unknown; active_leases?: unknown;
}
interface DirtyDeltaCounts { new_count?: number; cleared_count?: number; status_changed_count?: number; unchanged_count?: number }
interface DirtyDeltaReport {
  ok: boolean; error?: string; label?: string; baseline_id?: unknown; baseline_created_at?: unknown; baseline?: unknown;
  current?: unknown; delta?: DirtyDeltaCounts; changed_files?: string[];
}
interface CleanupStatus extends DirtyDeltaCounts {
  status: string; requires_cleanup: boolean; preflight: boolean; delta_command: string; guidance: string;
}
interface ParsedPreflight {
  scope?: { project?: string }; status?: string; readiness_score_percent?: number; active_lane_capacity_percent?: number;
  recommended_agents?: number; active_recommended_agents?: number; requested_agents?: number; active_lane?: string;
  launch_allowed?: boolean; launch_decision?: { release_allowed?: boolean }; big_picture?: { current_state?: { launch_slots?: number }; tldr?: string; current_slice?: string; next_slices?: unknown[]; horizon?: unknown[]; eta?: unknown };
  launch_plan?: unknown[]; primary_next_command?: string; conflict_sla?: { open_conflicts?: unknown };
  graph_packets?: { packet_count?: unknown }; controller?: { active_leases?: unknown };
}
interface DirtyBaselinePayload {
  label?: string; baseline_id?: unknown; baseline_created_at?: unknown; baseline?: unknown; current?: unknown;
  delta?: { new?: unknown[]; cleared?: unknown[]; status_changed?: unknown[]; unchanged_count?: number };
}
interface ContextEvent { event_id: string }
interface ReleasedLease { lease_id: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const rawArgs = argv.slice(2);
const command = rawArgs.find((arg) => !arg.startsWith('--')) || '';
const args = parseArgs(rawArgs);

if (args.selftest || command === 'selftest') {
  runSelftest();
  exit(0);
}

if (args.help || !args.lease || !args.project || !args.brick || (!args.intent && !args.auto)) {
  usage();
  exit(args.help ? 0 : 2);
}
const lease = args.lease;
const project = args.project;
const brick = args.brick;

const kind = args.kind ?? 'edit_applied';

try {
  if (args.requireCleanupOk && args.noDirtyDelta) {
    throw new Error('--require-cleanup-ok cannot be combined with --no-dirty-delta');
  }

  const preflightDirtyDelta = (args.requireCleanupOk || args.auto) ? captureDirtyDelta(lease) : null;
  const preflightCleanup = preflightDirtyDelta?.ok ? dirtyCleanupStatus(preflightDirtyDelta, { preflight: true }) : null;
  if (args.requireCleanupOk) {
    enforceCleanupOk(preflightDirtyDelta, preflightCleanup);
  }

  const closingIntent = args.auto
    ? deriveAutoIntent(preflightDirtyDelta, args.intent, args.historyFile)
    : args.intent ?? '';
  const contextArgs = [
    resolve(TOOLS_DIR, 'sma-context.ts'), 'append',
    '--project', project,
    '--brick', brick,
    '--kind', kind,
    '--intent', closingIntent,
    '--lease', lease,
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
  const event = JSON.parse(ctxRes.stdout) as ContextEvent;

  let released: ReleasedLease | null = null;
  if (!args.noRelease) {
    const releaseArgs = [
      resolve(TOOLS_DIR, 'sma-lease.ts'), 'release',
      '--lease', lease,
      '--project', project,
      '--brick', brick,
      '--auto-context',
      '--json',
    ];
    if (args.decision || closingIntent) releaseArgs.push('--reason', args.decision ?? closingIntent);
    const relRes = spawnSync('node', releaseArgs, { encoding: 'utf8' });
    if (relRes.status !== 0) {
      process.stderr.write(relRes.stderr ?? '');
      exit(relRes.status ?? 1);
    }
    released = JSON.parse(relRes.stdout) as ReleasedLease;
  }

  const dirtyDelta = args.noDirtyDelta ? null : (preflightDirtyDelta || captureDirtyDelta(lease));
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
  console.error(`sma-end-edit: ${errorMessage(err)}`);
  exit(1);
}

function captureGen3PreflightTldr(): PreflightReport {
  const preflightArgs = buildGen3PreflightArgs(project);
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
    const parsed = JSON.parse(res.stdout) as ParsedPreflight;
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
      error: `invalid preflight JSON: ${errorMessage(err)}`,
    };
  }
}

function buildGen3PreflightArgs(project: string): string[] {
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

function printGen3Tldr(report: PreflightReport | null): void {
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

function formatReadinessScore(report: PreflightReport): string {
  const launch = Number(report?.active_lane_capacity_percent ?? report?.readiness_score_percent ?? 0);
  const integration = Number(report?.readiness_score_percent ?? 0);
  if (launch !== integration) return `launch ${launch}%, integration ${integration}%`;
  return `${integration}%`;
}

function formatLaunchStatusSuffix(report: PreflightReport): string {
  if (report?.launch_allowed && report?.release_allowed) return ` (${report.active_lane || 'active lane'} ready; release allowed)`;
  if (report?.launch_allowed) return ` (${report.active_lane || 'active lane'} ready; release blocked)`;
  return '';
}

function runSelftest(): void {
  const projectArgs = buildGen3PreflightArgs('acme-desktop');
  assertSelftest(projectArgs.includes('--project'), 'project closeouts should use project-scoped preflight');
  assertSelftest(projectArgs.includes('acme-desktop'), 'project closeouts should pass the project id');
  const smaArgs = buildGen3PreflightArgs('sma');
  assertSelftest(!smaArgs.includes('--project'), 'SMA controller closeouts should keep portfolio-wide preflight');
  assertSelftest(
    formatReadinessScore({ active_lane_capacity_percent: 75, readiness_score_percent: 0 }) === 'launch 75%, integration 0%',
    'readiness formatter should separate launch capacity from integration readiness',
  );
  const auto = deriveAutoIntent({
    ok: true,
    changed_files: ['tools/example.ts', 'docs/EXAMPLE.md'],
  }, '', '');
  assertSelftest(auto.includes('2 files changed'), '--auto should count changed files');
  assertSelftest(auto.includes('tools/example.ts'), '--auto should name changed files');
  const fallback = deriveAutoIntent({ ok: false }, 'fallback intent', '');
  assertSelftest(fallback === 'fallback intent', '--auto should fall back to --intent');
  assertSelftest(
    formatLaunchStatusSuffix({ launch_allowed: true, release_allowed: false, active_lane: 'module-observe' }) === ' (module-observe ready; release blocked)',
    'status suffix should keep release blocked while module launch is allowed',
  );
  console.log('OK sma-end-edit selftest');
}

function assertSelftest(condition: boolean, message: string): void {
  if (!condition) throw new Error(`selftest failed: ${message}`);
}

function formatEta(eta: unknown): string {
  if (typeof eta === 'string') return eta;
  if (!eta || typeof eta !== 'object') return 'n/a';
  return Object.entries(eta)
    .map(([key, value]) => `${key.replace(/_/g, ' ')} ${value}`)
    .join('; ');
}

function captureDirtyDelta(label: string): DirtyDeltaReport {
  const res = spawnSync('node', [
    DIRTY,
    'delta',
    '--project', project,
    '--label', label,
    '--json',
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (res.status !== 0) {
    return { ok: false, error: firstLine(res.stderr) || `exit ${res.status ?? 1}` };
  }
  try {
    const parsed = JSON.parse(res.stdout) as DirtyBaselinePayload;
    const delta = parsed.delta ?? {};
    const changedFiles = [...(delta.new || []), ...(delta.status_changed || [])]
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (!entry || typeof entry !== 'object') return '';
        for (const key of ['path', 'file', 'to']) {
          if (key in entry) {
            const value = entry[key as keyof typeof entry];
            if (typeof value === 'string') return value;
          }
        }
        return '';
      })
      .filter(Boolean);
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
      changed_files: [...new Set(changedFiles)],
    };
  } catch (err) {
    return { ok: false, error: `invalid dirty delta JSON: ${errorMessage(err)}` };
  }
}

function deriveAutoIntent(report: DirtyDeltaReport | null, fallback = '', historyFile = ''): string {
  const files = report?.ok && Array.isArray(report.changed_files) ? report.changed_files : [];
  const gates = readGateHistory(historyFile);
  const parts = [];
  if (files.length) {
    const shown = files.slice(0, 8).join(', ');
    parts.push(`${files.length} file${files.length === 1 ? '' : 's'} changed: ${shown}${files.length > 8 ? ` (+${files.length - 8} more)` : ''}`);
  }
  if (gates.length) parts.push(`gates run: ${gates.join('; ')}`);
  if (parts.length) return parts.join('. ');
  if (fallback) return fallback;
  return 'edit session closed with no dirty-baseline changes detected';
}

function readGateHistory(historyFile: string): string[] {
  if (!historyFile) return [];
  try {
    const text = requireReadFile(historyFile);
    return text.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /(?:npm|pnpm|yarn|node|npx|cargo)\s+(?:run\s+)?(?:check|test|typecheck|gate|selftest|ci|lint)/i.test(line))
      .slice(-8);
  } catch {
    return [];
  }
}

function requireReadFile(file: string): string {
  return readFileSync(resolve(file), 'utf8');
}

function formatDirtyDelta(report: DirtyDeltaReport): string {
  const delta = report.delta ?? {};
  return `${delta.new_count ?? 0} new, ${delta.cleared_count ?? 0} cleared, ${delta.status_changed_count ?? 0} changed, ${delta.unchanged_count ?? 0} unchanged hidden`;
}

function dirtyCleanupStatus(report: DirtyDeltaReport, options: { preflight?: boolean } = {}): CleanupStatus {
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
    delta_command: `npm run dirty:delta -- --project ${shellArg(project)} --label ${shellArg(lease)}`,
    guidance: requiresCleanup
      ? 'commit task-scoped work, delete scratch output, or keep the handoff explicitly classified before final integration'
      : 'no new or status-changed dirty paths since the task baseline',
  };
}

function enforceCleanupOk(dirtyDelta: DirtyDeltaReport | null, cleanup: CleanupStatus | null): void {
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

function printCleanupStatus(cleanup: CleanupStatus | null): void {
  if (!cleanup) return;
  if (cleanup.requires_cleanup) {
    console.log(`[end-edit] cleanup required: ${cleanup.new_count} new, ${cleanup.status_changed_count} changed since start`);
    console.log(`[end-edit] next: ${cleanup.guidance}`);
    console.log(`[end-edit] inspect: ${cleanup.delta_command}`);
    return;
  }
  console.log('[end-edit] cleanup ok: no new or status-changed dirty paths since start');
}

function firstLine(value: unknown): string {
  return String(value || '').split(/\r?\n/).find((line) => line.trim())?.trim() || '';
}

function shellArg(value: unknown): string {
  return `'${String(value ?? '').replace(/'/g, `'\\''`)}'`;
}

function usage(): void {
  console.log(`Usage:
  sma-end-edit.ts --lease <lease_id> --project <id> --brick <id> [--intent "..." | --auto]
                   [--decision "..."] [--rejected "alt::reason"]... [--file <path>]...
                   [--commit <sha>] [--verify-cmd "..." --verify-status <s>]
                   [--kind edit_applied|decision_recorded] [--no-release]
                   [--require-cleanup-ok] [--no-dirty-delta]
                   [--history-file <path>] [--no-preflight-tldr] [--json]

Prints a dirty delta and cleanup ok/required status unless --no-dirty-delta is set.
With --auto, derives the closing summary from that delta and optional shell-history file;
--intent is used only as the fallback when no automatic evidence is available.
Also prints a compact Gen3 big-picture TLDR unless --no-preflight-tldr is set.
With --require-cleanup-ok, exits 4 before logging/releasing when the task delta
still has new or status-changed dirty paths.
`);
}

function parseArgs(list: string[]): EndEditArgs {
  const out: EndEditArgs = { rejected: [], file: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_match: string, character: string) => character.toUpperCase());
    const next = list[i + 1];
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) { (out as unknown as Record<string, unknown>)[camel] = true; continue; }
    if (camel === 'rejected') out.rejected.push(next);
    else if (camel === 'file') out.file.push(next);
    else (out as unknown as Record<string, unknown>)[camel] = next;
    i += 1;
  }
  return out;
}
