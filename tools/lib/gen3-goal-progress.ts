/**
 * WHAT: Builds and renders long-running goal progress from module plans, context events, and verification evidence.
 * WHY: Operators need durable progress by goal and module instead of mistaking recent activity for completed work.
 * HOW: Dashboard and progress commands pass plans, events, and time bounds; this module returns reports, markup, and styles.
 * Bucketing and module-path matching keep summaries stable across large histories and control-plane work.
 * The bundled self-test validates aggregation and rendering without writing production state.
 * Gen3 terminology is defined in docs/GLOSSARY.md#gen3.
 * @example node --input-type=module -e "import { runGoalProgressSelfTest } from './tools/lib/gen3-goal-progress.ts'; console.log(runGoalProgressSelfTest())"
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { pathPatternCovers } from './module-work-paths.ts';

const DEFAULT_BUCKETS = 50;
const VERIFY_STATUSES = new Set(['pass', 'fail', 'blocked', 'skipped']);
const CONTROL_PLANE_MODULES = [
  { id: 'dashboard', label: 'Dashboard', paths: ['tools/*dashboard*.mjs', 'wiki/*DASHBOARD*'] },
  { id: 'graphify', label: 'Graphify', paths: ['tools/sma-graphify.ts', 'tools/sma-graph-packets.ts', 'graphify-out/**'] },
  { id: 'leases', label: 'Leases + collisions', paths: ['tools/sma-lease.ts', 'tools/sma-start-edit.ts', 'tools/sma-end-edit.ts', 'tools/sma-conflict.ts'] },
  { id: 'modules', label: 'Module waves', paths: ['tools/sma-module-work-packets.ts', 'tools/lib/module-work-*.mjs', 'handoffs/module-waves/**'] },
  { id: 'state', label: 'State + scanner', paths: ['tools/sma-state.ts', 'tools/sma-scan.ts', 'registry/**', 'wiki/SMA_STATE*'] },
  { id: 'quality', label: 'Quality gates', paths: ['tools/sma-*-gate.mjs', 'tools/sma-validate*.mjs', 'tools/sma-source-size-gate.ts'] },
];

type VerificationStatus = 'pass' | 'fail' | 'blocked' | 'skipped';
type EventCategories = { srs: boolean; graph: boolean; collision: boolean; upgrade: boolean; gate: boolean };
type CategoryCounts = { srs: number; graph: number; collision: number; upgrade: number; gate: number };
type ProjectModule = {
  id: string;
  label?: string;
  paths: string[];
  excludePaths?: string[];
  maxParallelAgents?: number;
};
type ProjectInput = { id?: string; project?: string; root?: string; absoluteRoot?: string; project_root?: string };
type NormalizedProject = { id: string; root: string; modules: ProjectModule[] };
type RawContextEvent = {
  project?: string;
  brick_id?: string;
  kind?: string;
  intent?: string;
  decision_rationale?: string;
  timestamp: string;
  session_id?: string;
  files_touched?: string[];
  verification?: { status?: string; command?: string };
};
type GoalEvent = RawContextEvent & {
  project: string;
  brick_id: string;
  kind: string;
  timestamp: string;
  time_ms: number;
  files_touched: string[];
  module: string;
  verification_status: VerificationStatus | null;
  verification_command: string;
  categories: EventCategories;
};
type ModuleRow = {
  project: string;
  id: string;
  label: string;
  family: string;
  primary_path: string;
  path_count: number;
  max_parallel_agents: number;
  event_count: number;
  pass_count: number;
  fail_count: number;
  blocked_count: number;
  completion_count: number;
  file_count: number;
  file_set?: Set<string>;
  srs_signal_count: number;
  graph_signal_count: number;
  collision_signal_count: number;
  upgrade_signal_count: number;
  last_event_at: string | null;
};
type TimelineBucket = {
  bucket_start: string;
  event_count: number;
  pass_count: number;
  fail_count: number;
  blocked_count: number;
  completion_count: number;
  srs_signal_count: number;
  collision_signal_count: number;
  graph_signal_count: number;
};
type ModuleGroup = {
  project: string;
  family: string;
  modules: ModuleRow[];
  event_count: number;
  pass_count: number;
  fail_count: number;
  blocked_count: number;
  completion_count: number;
  srs_signal_count: number;
  graph_signal_count: number;
  collision_signal_count: number;
  file_count: number;
  slot_count: number;
  last_event_at: string | null;
};

export function buildGoalProgressReport({
  projects = [],
  hours = 100,
  now = null,
  maxBuckets = DEFAULT_BUCKETS,
  projectFilter = [],
}: {
  projects?: ProjectInput[];
  hours?: number;
  now?: string | null;
  maxBuckets?: number;
  projectFilter?: string[];
} = {}) {
  const projectList = normalizeProjectList(projects, projectFilter);
  const allEvents = projectList.flatMap((project) => readProjectEvents(project));
  const latestEventAt = latestTimestamp(allEvents);
  const anchorMs = Date.parse(now || latestEventAt || new Date().toISOString());
  const windowHours = clampNumber(hours, 1, 1000, 100);
  const startMs = anchorMs - windowHours * 60 * 60 * 1000;
  const windowEvents = allEvents
    .filter((event) => event.time_ms >= startMs && event.time_ms <= anchorMs)
    .sort((a, b) => a.time_ms - b.time_ms);
  const modules = buildModuleRows(windowEvents, projectList);
  const buckets = buildBuckets(windowEvents, { startMs, anchorMs, maxBuckets });
  const verifications = windowEvents.filter((event) => event.verification_status);
  const failedThenPassed = failedToPassed(verifications);
  const eventKinds: Record<string, number> = countBy(windowEvents, (event) => event.kind || 'unknown');
  const categories = countCategories(windowEvents);
  const projectsTouched = new Set(windowEvents.map((event) => event.project).filter(Boolean));
  const bricksTouched = new Set(windowEvents.map((event) => `${event.project}:${event.brick_id}`).filter(Boolean));
  const sessionsTouched = new Set(windowEvents.map((event) => event.session_id).filter(Boolean));
  const filesTouched = new Set(windowEvents.flatMap((event) => event.files_touched || []));
  const moduleCoverage = modules.filter((module) => module.event_count > 0).length;
  const proofCoverage = percent(
    new Set(verifications.map((event) => `${event.project}:${event.brick_id}`)).size,
    bricksTouched.size,
  );
  const passCount = verifications.filter((event) => event.verification_status === 'pass').length;
  const failCount = verifications.filter((event) => event.verification_status === 'fail').length;
  const blockedCount = verifications.filter((event) => event.verification_status === 'blocked').length;
  const skippedCount = verifications.filter((event) => event.verification_status === 'skipped').length;
  const conflictDetected = number(eventKinds.conflict_detected);
  const conflictResolved = number(eventKinds.conflict_resolved);
  const hardening = hardeningScore({
    proofCoverage,
    passCount,
    failCount,
    blockedCount,
    conflictDetected,
    conflictResolved,
    categories,
    bricks: bricksTouched.size,
  });

  return {
    schema_version: '1.0.0',
    kind: 'sma-gen3-goal-progress',
    window_hours: windowHours,
    window_start: new Date(startMs).toISOString(),
    window_end: new Date(anchorMs).toISOString(),
    anchor_event_at: latestEventAt,
    summary: {
      event_count: windowEvents.length,
      project_count: projectsTouched.size,
      module_count: modules.length,
      module_coverage_percent: percent(moduleCoverage, modules.length),
      brick_count: bricksTouched.size,
      session_count: sessionsTouched.size,
      files_touched_count: filesTouched.size,
      verification_count: verifications.length,
      pass_count: passCount,
      fail_count: failCount,
      blocked_count: blockedCount,
      skipped_count: skippedCount,
      failed_then_passed_count: failedThenPassed.length,
      proof_coverage_percent: proofCoverage,
      hardening_score_percent: hardening.score,
      srs_signal_count: categories.srs,
      graph_signal_count: categories.graph,
      collision_signal_count: categories.collision,
      upgrade_signal_count: categories.upgrade,
      gate_signal_count: categories.gate,
      completion_count: number(eventKinds.edit_applied) + number(eventKinds.proof_recorded),
      conflict_detected_count: conflictDetected,
      conflict_resolved_count: conflictResolved,
      current_agents_supported: 12,
      future_agents_target: 100,
    },
    hardening_components: hardening.components,
    event_kinds: eventKinds,
    categories,
    modules,
    timeline: buckets,
    recent_verifications: verifications.slice(-12).reverse().map(compactVerification),
    failed_then_passed: failedThenPassed.slice(-12).reverse(),
    philosophy: [
      'Proof before claim: every meaningful change leaves a context event and verification status.',
      'Telemetry before silence: SRS and observability signals are tracked as hardening evidence.',
      'Module ownership before parallelism: agents work module-local first, shared hot paths serialize.',
      'Graphs before broad search: module graphs make retrieval fast and reduce accidental overlap.',
      'Release gates before speed: failed gates are visible until they pass or remain explicitly blocked.',
    ],
  };
}

export function renderGoalProgressSection(report: ReturnType<typeof buildGoalProgressReport> | null | undefined): string {
  if (!report) return '';
  const s = report.summary || {};
  const timeline = renderTimelineChart(report.timeline || []);
  const moduleGroups = renderModuleGroups(report.modules || []);
  const verificationRows = (report.recent_verifications || []).map((item) => `
      <tr>
        <td>${esc(item.time)}</td>
        <td>${esc(item.project)}</td>
        <td>${esc(item.module)}</td>
        <td><span class="status ${esc(item.status)}">${esc(item.status)}</span></td>
        <td>${esc(item.command)}</td>
      </tr>`).join('');
  const recoveryRows = (report.failed_then_passed || []).map((item) => `
      <tr>
        <td>${esc(item.project)}</td>
        <td>${esc(item.module)}</td>
        <td>${esc(item.brick_id)}</td>
        <td>${esc(item.command)}</td>
        <td>${esc(item.failed_at)} → ${esc(item.passed_at)}</td>
      </tr>`).join('');
  const hardeningBars = (report.hardening_components || []).map((item) => `
      <div class="gp-hardening-row">
        <span>${esc(item.label)}</span>
        <b>${item.value}%</b>
        <i><em style="width:${clampNumber(item.value, 0, 100, 0)}%"></em></i>
      </div>`).join('');
  const philosophy = (report.philosophy || []).map((item) => `<li>${esc(item)}</li>`).join('');

  return stripTrailingWhitespace(`
  <section class="goal-progress">
    <div class="gp-head">
      <div>
        <h2>100h Goal Progress · SMA Gen3 Hardening Layer</h2>
        <p>Module-first progress over ${s.event_count || 0} context events, anchored at ${esc(report.window_end)}. This is the default long-goal operator layer; rebuild with <code>--no-goal-progress</code> to opt out.</p>
      </div>
      <div class="gp-score">
        <span>Hardening</span>
        <strong>${number(s.hardening_score_percent)}%</strong>
      </div>
    </div>
    <div class="gp-grid">
      ${metricCard('Proof coverage', `${number(s.proof_coverage_percent)}%`, `${s.verification_count || 0} gate/test proofs · ${s.failed_then_passed_count || 0} fail→pass recoveries`)}
      ${metricCard('Module coverage', `${number(s.module_coverage_percent)}%`, `${s.module_count || 0} module buckets · ${s.files_touched_count || 0} touched files`)}
      ${metricCard('SRS/telemetry', number(s.srs_signal_count), 'observability/SRS hardening signals')}
      ${metricCard('Parallel future', `${number(s.current_agents_supported)}→${number(s.future_agents_target)}`, `${number(s.collision_signal_count)} collision-control signals · ${number(s.graph_signal_count)} graph signals`)}
      ${metricCard('Verification', `${number(s.pass_count)}/${number(s.verification_count)}`, `${number(s.fail_count)} fail · ${number(s.blocked_count)} blocked · ${number(s.skipped_count)} skipped`)}
      ${metricCard('Upgrade readiness', number(s.upgrade_signal_count), `${number(s.gate_signal_count)} gate signals · future-safe changes tracked`)}
    </div>
    <div class="gp-panel">
      <h3>Progress Over Time</h3>
      ${timeline}
    </div>
    <div class="gp-columns">
      <div class="gp-panel">
        <h3>Hardening Components</h3>
        ${hardeningBars || '<p class="empty">No hardening data in the selected window.</p>'}
      </div>
      <div class="gp-panel">
        <h3>NASA-Style Discipline</h3>
        <ul class="gp-philosophy">${philosophy}</ul>
      </div>
    </div>
    <div class="gp-panel">
      <h3>Module Progress by Family</h3>
      ${moduleGroups || '<p class="empty">No module activity in this window.</p>'}
    </div>
    <div class="gp-columns">
      <div class="gp-panel">
        <h3>Recent Tests / Gates</h3>
        ${verificationRows ? `<table><thead><tr><th>time</th><th>project</th><th>module</th><th>status</th><th>command</th></tr></thead><tbody>${verificationRows}</tbody></table>` : '<p class="empty">No verification events in this window.</p>'}
      </div>
      <div class="gp-panel">
        <h3>Failed Then Passed</h3>
        ${recoveryRows ? `<table><thead><tr><th>project</th><th>module</th><th>brick</th><th>command</th><th>timeline</th></tr></thead><tbody>${recoveryRows}</tbody></table>` : '<p class="empty">No fail→pass recovery recorded in this window yet.</p>'}
      </div>
    </div>
  </section>`);
}

export function goalProgressDashboardStyles(): string {
  return stripTrailingWhitespace(`
    .goal-progress { border: 1px solid var(--bd); border-radius: 8px; padding: 16px; background: linear-gradient(180deg, rgba(10,119,170,0.08), rgba(0,0,0,0.015)); }
    .gp-head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
    .gp-head p { margin: 4px 0 0; color: var(--mute); font-size: 13px; }
    .gp-score { min-width: 132px; border: 1px solid var(--bd); border-radius: 6px; padding: 10px; text-align: right; background: rgba(255,255,255,0.45); }
    .gp-score span { display: block; color: var(--mute); font-size: 12px; text-transform: uppercase; }
    .gp-score strong { font-size: 32px; }
    .gp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin: 14px 0; }
    .gp-metric { border: 1px solid var(--bd); border-radius: 6px; padding: 12px; background: rgba(255,255,255,0.35); }
    .gp-metric span { display: block; color: var(--mute); font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    .gp-metric strong { display: block; font-size: 24px; margin-top: 4px; }
    .gp-metric small { color: var(--mute); }
    .gp-panel { margin-top: 14px; border: 1px solid var(--bd); border-radius: 6px; padding: 12px; background: rgba(255,255,255,0.28); }
    .gp-panel h3 { margin: 0 0 8px; font-size: 14px; }
    .gp-columns { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
    .gp-chart { width: 100%; height: auto; display: block; }
    .gp-module-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); gap: 12px; }
    .gp-module-group { border: 1px solid var(--bd); border-radius: 7px; padding: 12px; background: rgba(255,255,255,0.26); }
    .gp-module-group-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; margin-bottom: 10px; }
    .gp-module-group-head strong { display: block; font-size: 15px; }
    .gp-module-group-head span { display: block; color: var(--mute); font-size: 12px; }
    .gp-module-group-stats { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
    .gp-pill { border: 1px solid var(--bd); border-radius: 999px; padding: 2px 7px; color: var(--mute); font-size: 11px; background: rgba(255,255,255,0.36); white-space: nowrap; }
    .gp-modules { display: grid; grid-template-columns: 1fr; gap: 8px; }
    .gp-module-group > .line { display: flex; justify-content: space-between; gap: 12px; color: var(--mute); font-size: 12px; margin-top: 8px; }
    .gp-module { border: 1px solid var(--bd); border-radius: 6px; padding: 10px; background: rgba(255,255,255,0.36); }
    .gp-module-top { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
    .gp-module strong { display: block; margin-bottom: 2px; }
    .gp-module .line { display: flex; justify-content: space-between; gap: 12px; color: var(--mute); font-size: 12px; }
    .gp-module .bar { margin-top: 8px; }
    .gp-tag { border-radius: 999px; padding: 1px 6px; font-size: 11px; background: rgba(0,0,0,0.06); color: var(--mute); white-space: nowrap; }
    .gp-tag.verified { color: var(--ok); }
    .gp-tag.attention, .gp-tag.blocked { color: var(--bad); }
    .gp-overflow { margin: 8px 0 0; color: var(--mute); font-size: 12px; }
    .gp-hardening-row { display: grid; grid-template-columns: 1fr 44px; gap: 8px; align-items: center; margin: 8px 0; }
    .gp-hardening-row i { grid-column: 1 / 3; height: 7px; border-radius: 999px; background: rgba(0,0,0,0.08); overflow: hidden; }
    .gp-hardening-row em { display: block; height: 100%; background: var(--hi); }
    .gp-philosophy { margin: 0 0 0 18px; color: var(--mute); font-size: 13px; }
    @media (max-width: 700px) { .gp-head { display: block; } .gp-score { margin-top: 10px; text-align: left; } }
  `);
}

export function runGoalProgressSelfTest(): ReturnType<typeof buildGoalProgressReport> {
  const root = mkdtempSync(resolve(tmpdir(), 'sma-goal-progress-'));
  try {
    mkdirSync(resolve(root, '.smarch/agent-context'), { recursive: true });
    writeFileSync(resolve(root, 'sma.gen3.json'), JSON.stringify({
      modules: [{
        id: 'modlink',
        label: 'MODLINK',
        paths: ['src/renderer/modules/modlink/**'],
        maxParallelAgents: 3,
      }],
      sharedHotPaths: [],
    }, null, 2));
    const lines = [
      event({ project: 'fixture', brick_id: 'modlink-stability', kind: 'verification_run', timestamp: '2026-06-30T00:00:00.000Z', status: 'fail', command: 'pnpm test:modlink', files: ['src/renderer/modules/modlink/Room.tsx'] }),
      event({ project: 'fixture', brick_id: 'modlink-stability', kind: 'verification_run', timestamp: '2026-06-30T01:00:00.000Z', status: 'pass', command: 'pnpm test:modlink', files: ['src/renderer/modules/modlink/Room.tsx'] }),
      event({ project: 'fixture', brick_id: 'modlink-srs', kind: 'edit_applied', timestamp: '2026-06-30T02:00:00.000Z', status: 'pass', command: 'pnpm run srs:audit', files: ['src/renderer/modules/modlink/errors.ts'] }),
    ];
    writeFileSync(resolve(root, '.smarch/agent-context/modlink-stability.ndjson'), `${lines.join('\n')}\n`);
    const report = buildGoalProgressReport({
      projects: [{ id: 'fixture', root }],
      hours: 100,
      now: '2026-06-30T03:00:00.000Z',
    });
    assert(report.summary.failed_then_passed_count === 1, 'expected fail then pass recovery');
    assert(report.modules.some((module) => module.id === 'modlink' && module.event_count === 3), 'expected modlink module grouping');
    assert(report.summary.srs_signal_count >= 1, 'expected SRS hardening signal');
    assert(report.summary.proof_coverage_percent === 100, 'expected proof coverage');
    assert(renderGoalProgressSection(report).includes('gp-module-group'), 'expected grouped module HTML');
    return report;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function normalizeProjectList(projects: ProjectInput[], projectFilter: string[]): NormalizedProject[] {
  const filters = new Set((projectFilter || []).map((id) => String(id).toLowerCase()));
  const seen = new Set();
  const out: NormalizedProject[] = [];
  for (const project of projects || []) {
    const id = String(project?.id || project?.project || '').trim();
    const root = project?.root || project?.absoluteRoot || project?.project_root;
    if (!id || !root || !existsSync(root)) continue;
    if (filters.size && !filters.has(id.toLowerCase())) continue;
    const key = `${id}:${root}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id,
      root,
      modules: readProjectModules(id, root),
    });
  }
  return out;
}

function readProjectModules(projectId: string, root: string): ProjectModule[] {
  const file = resolve(root, 'sma.gen3.json');
  if (!existsSync(file)) {
    return projectId === 'sma'
      ? CONTROL_PLANE_MODULES
      : [];
  }
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as { modules?: ProjectModule[] };
    return (json.modules || []).map((module: ProjectModule) => ({
      id: String(module.id || '').trim(),
      label: module.label || module.id,
      paths: Array.isArray(module.paths) ? module.paths : [],
      excludePaths: Array.isArray(module.excludePaths) ? module.excludePaths : [],
      maxParallelAgents: module.maxParallelAgents,
    })).filter((module) => module.id);
  } catch (error) {
    console.error(JSON.stringify({ area: 'gen3-goal-progress.module-config', severity: 'warning', hint: 'Repair the project Gen3 module configuration.', error: error instanceof Error ? error.message : String(error) }));
    return [];
  }
}

function readProjectEvents(project: NormalizedProject): GoalEvent[] {
  const dir = resolve(project.root, '.smarch/agent-context');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ndjson'));
  const events: GoalEvent[] = [];
  for (const file of files) {
    const brickFromFile = basename(file.name, '.ndjson');
    const raw = safeRead(resolve(dir, file.name));
    for (const line of raw.split('\n')) {
      const text = line.trim();
      if (!text) continue;
      const parsed = safeJson(text);
      if (!parsed || !parsed.timestamp) continue;
      const timeMs = Date.parse(parsed.timestamp);
      if (!Number.isFinite(timeMs)) continue;
      const verificationStatus = parsed.verification?.status;
      const enriched: GoalEvent = {
        ...parsed,
        project: parsed.project || project.id,
        brick_id: parsed.brick_id || brickFromFile,
        kind: parsed.kind || '',
        intent: parsed.intent || '',
        time_ms: timeMs,
        files_touched: Array.isArray(parsed.files_touched) ? parsed.files_touched : [],
        module: '',
        verification_status: verificationStatus && VERIFY_STATUSES.has(verificationStatus)
          ? verificationStatus as VerificationStatus
          : null,
        verification_command: parsed.verification?.command || '',
        categories: { srs: false, graph: false, collision: false, upgrade: false, gate: false },
      };
      enriched.module = inferModule(enriched, project.modules);
      enriched.categories = classifyEvent(enriched);
      events.push(enriched);
    }
  }
  return events;
}

function inferModule(event: Pick<GoalEvent, 'files_touched' | 'brick_id' | 'intent' | 'project'>, modules: ProjectModule[]): string {
  const files = event.files_touched || [];
  for (const module of modules || []) {
    if (files.some((file) => moduleMatchesPath(module, file))) return module.id;
  }
  const text = `${event.brick_id || ''} ${event.intent || ''}`.toLowerCase();
  for (const module of modules || []) {
    if (module.id && text.includes(module.id.toLowerCase())) return module.id;
  }
  const fromPath = files.map(moduleFromPath).find(Boolean);
  if (fromPath) return fromPath;
  return event.project === 'sma' ? 'control-plane' : 'unmapped';
}

function moduleMatchesPath(module: ProjectModule, file: string): boolean {
  const path = String(file || '').replace(/\\/g, '/');
  if (!path) return false;
  if ((module.excludePaths || []).some((pattern) => pathPatternCovers(pattern, path))) return false;
  return (module.paths || []).some((pattern) => pathPatternCovers(pattern, path) || pathPatternCovers(path, pattern));
}

function moduleFromPath(file: string): string | null {
  const parts = String(file || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts[0] === 'src' && parts[1] === 'renderer' && parts[2] === 'modules' && parts[3]) return parts[3];
  if (parts[0] === 'src' && parts[1] === 'renderer' && parts[2] === 'features' && parts[3]) return parts[3];
  if (parts[0] === 'web' && parts[1] === 'src' && parts[2] === 'modules' && parts[3]) return parts[3];
  return null;
}

function buildModuleRows(events: GoalEvent[], projects: NormalizedProject[]): ModuleRow[] {
  const known = new Map<string, ModuleRow>();
  for (const project of projects) {
    for (const module of project.modules || []) {
      known.set(`${project.id}:${module.id}`, {
        project: project.id,
        id: module.id,
        label: module.label || module.id,
        family: moduleFamily(project.id, module),
        primary_path: module.paths?.[0] || '',
        path_count: module.paths?.length || 0,
        max_parallel_agents: number(module.maxParallelAgents),
        event_count: 0,
        pass_count: 0,
        fail_count: 0,
        blocked_count: 0,
        completion_count: 0,
        file_count: 0,
        file_set: new Set(),
        srs_signal_count: 0,
        graph_signal_count: 0,
        collision_signal_count: 0,
        upgrade_signal_count: 0,
        last_event_at: null,
      });
    }
  }
  for (const event of events) {
    const key = `${event.project}:${event.module}`;
    if (!known.has(key)) {
      known.set(key, {
        project: event.project,
        id: event.module,
        label: titleLabel(event.module),
        family: moduleFamily(event.project, {
          id: event.module,
          label: event.module,
          paths: event.files_touched || [],
        }),
        primary_path: (event.files_touched || [])[0] || '',
        path_count: 0,
        max_parallel_agents: 0,
        event_count: 0,
        pass_count: 0,
        fail_count: 0,
        blocked_count: 0,
        completion_count: 0,
        file_count: 0,
        file_set: new Set(),
        srs_signal_count: 0,
        graph_signal_count: 0,
        collision_signal_count: 0,
        upgrade_signal_count: 0,
        last_event_at: null,
      });
    }
    const row = known.get(key);
    if (!row) continue;
    row.event_count += 1;
    if (event.verification_status === 'pass') row.pass_count += 1;
    if (event.verification_status === 'fail') row.fail_count += 1;
    if (event.verification_status === 'blocked') row.blocked_count += 1;
    if (event.kind === 'edit_applied' || event.kind === 'proof_recorded') row.completion_count += 1;
    for (const file of event.files_touched || []) row.file_set?.add(file);
    if (event.categories.srs) row.srs_signal_count += 1;
    if (event.categories.graph) row.graph_signal_count += 1;
    if (event.categories.collision) row.collision_signal_count += 1;
    if (event.categories.upgrade) row.upgrade_signal_count += 1;
    if (!row.last_event_at || event.timestamp > row.last_event_at) row.last_event_at = event.timestamp;
  }
  return [...known.values()]
    .map(finalizeModuleRow)
    .filter((row) => row.event_count > 0 || row.max_parallel_agents > 0)
    .sort((a, b) => b.event_count - a.event_count || a.project.localeCompare(b.project) || a.id.localeCompare(b.id));
}

function buildBuckets(events: GoalEvent[], { startMs, anchorMs, maxBuckets }: { startMs: number; anchorMs: number; maxBuckets: number }): TimelineBucket[] {
  const bucketCount = Math.max(1, Math.min(maxBuckets, Math.ceil((anchorMs - startMs) / (2 * 60 * 60 * 1000)) || 1));
  const bucketMs = Math.max(1, Math.ceil((anchorMs - startMs) / bucketCount));
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    bucket_start: new Date(startMs + index * bucketMs).toISOString(),
    event_count: 0,
    pass_count: 0,
    fail_count: 0,
    blocked_count: 0,
    completion_count: 0,
    srs_signal_count: 0,
    collision_signal_count: 0,
    graph_signal_count: 0,
  }));
  for (const event of events) {
    const index = Math.max(0, Math.min(bucketCount - 1, Math.floor((event.time_ms - startMs) / bucketMs)));
    const bucket = buckets[index];
    if (!bucket) continue;
    bucket.event_count += 1;
    if (event.verification_status === 'pass') bucket.pass_count += 1;
    if (event.verification_status === 'fail') bucket.fail_count += 1;
    if (event.verification_status === 'blocked') bucket.blocked_count += 1;
    if (event.kind === 'edit_applied' || event.kind === 'proof_recorded') bucket.completion_count += 1;
    if (event.categories.srs) bucket.srs_signal_count += 1;
    if (event.categories.collision) bucket.collision_signal_count += 1;
    if (event.categories.graph) bucket.graph_signal_count += 1;
  }
  return buckets;
}

function finalizeModuleRow(row: ModuleRow): ModuleRow {
  row.file_count = row.file_set?.size || 0;
  delete row.file_set;
  return row;
}

function moduleFamily(projectId: string, module: ProjectModule | ModuleRow): string {
  if (projectId === 'sma') return 'control-plane';
  const paths = 'paths' in module && Array.isArray(module.paths)
    ? module.paths
    : 'primary_path' in module && module.primary_path
      ? [module.primary_path]
      : [];
  const pathFamily = paths.map(familyFromPath).find(Boolean);
  if (pathFamily) return pathFamily;
  const id = String(module.id || '').toLowerCase();
  const label = String(module.label || '').toLowerCase();
  const named = [id, label].map(familyFromKnownName).find(Boolean);
  if (named) return named;
  const moduleToken = id.match(/(?:^|[-_.])modules[-_.]([a-z0-9]+)/);
  if (moduleToken?.[1]) return moduleToken[1];
  return id.split(/[-_.:/]+/).find(Boolean) || 'unmapped';
}

function familyFromPath(file: string): string | null {
  const parts = String(file || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const moduleIndex = parts.indexOf('modules');
  if (moduleIndex >= 0 && parts[moduleIndex + 1]) return parts[moduleIndex + 1].toLowerCase();
  const featureIndex = parts.indexOf('features');
  if (featureIndex >= 0 && parts[featureIndex + 1]) return parts[featureIndex + 1].toLowerCase();
  return null;
}

function familyFromKnownName(value: string): string | null {
  const match = String(value || '').match(/\b(modlink|modcap|modchat|moddic|acme-agent|modbro|modcore|modvibe|modflow)\b/i);
  return match ? match[1].toLowerCase() : null;
}

function classifyEvent(event: Pick<GoalEvent, 'kind' | 'intent' | 'decision_rationale' | 'verification_command' | 'files_touched'>): EventCategories {
  const text = [
    event.kind,
    event.intent,
    event.decision_rationale,
    event.verification_command,
    ...(event.files_touched || []),
  ].join(' ');
  return {
    srs: /(^|\W)(srs|observability|telemetry|captureRendererError|breadcrumb)(\W|$)/i.test(text),
    graph: /graphify|module graph|graph-first|graph packet/i.test(text),
    collision: /lease|conflict|dirty|merge|dispatch|claim|shared hot|overlap/i.test(text),
    upgrade: /upgrade|migration|schema|future|compat|release train|version|contract/i.test(text),
    gate: /test|typecheck|check|build|lint|gate|audit|verify|coverage/i.test(text),
  };
}

function countCategories(events: GoalEvent[]): CategoryCounts {
  return events.reduce((acc, event) => {
    for (const key of ['srs', 'graph', 'collision', 'upgrade', 'gate'] as const) {
      if (event.categories[key]) acc[key] += 1;
    }
    return acc;
  }, { srs: 0, graph: 0, collision: 0, upgrade: 0, gate: 0 });
}

function failedToPassed(verifications: GoalEvent[]) {
  const byKey = new Map<string, { fail?: GoalEvent | null }>();
  const recovered: Array<{ project: string; module: string; brick_id: string; command: string; failed_at: string; passed_at: string }> = [];
  for (const event of verifications) {
    const key = `${event.project}:${event.brick_id}:${normalizeCommand(event.verification_command)}`;
    const previous = byKey.get(key) || {};
    if (event.verification_status === 'fail') previous.fail = event;
    if (event.verification_status === 'pass' && previous.fail) {
      recovered.push({
        project: event.project,
        module: event.module,
        brick_id: event.brick_id,
        command: shortCommand(event.verification_command),
        failed_at: previous.fail.timestamp,
        passed_at: event.timestamp,
      });
      previous.fail = null;
    }
    byKey.set(key, previous);
  }
  return recovered;
}

function hardeningScore({ proofCoverage, passCount, failCount, blockedCount, conflictDetected, conflictResolved, categories, bricks }: {
  proofCoverage: number; passCount: number; failCount: number; blockedCount: number;
  conflictDetected: number; conflictResolved: number; categories: CategoryCounts; bricks: number;
}) {
  const passRate = percent(passCount, passCount + failCount + blockedCount);
  const conflictClosure = conflictDetected ? percent(conflictResolved, conflictDetected) : 100;
  const graphDiscipline = percent(Math.min(number(categories.graph), Math.max(1, bricks)), Math.max(1, bricks));
  const srsDiscipline = percent(Math.min(number(categories.srs), Math.max(1, Math.ceil(bricks / 2))), Math.max(1, Math.ceil(bricks / 2)));
  const gateDiscipline = percent(Math.min(number(categories.gate), Math.max(1, bricks)), Math.max(1, bricks));
  const score = Math.round(
    proofCoverage * 0.28
    + passRate * 0.24
    + conflictClosure * 0.18
    + graphDiscipline * 0.12
    + srsDiscipline * 0.10
    + gateDiscipline * 0.08
  );
  return {
    score: clampNumber(score, 0, 100, 0),
    components: [
      { label: 'Proof coverage', value: proofCoverage },
      { label: 'Gate pass rate', value: passRate },
      { label: 'Conflict closure', value: conflictClosure },
      { label: 'Graph discipline', value: graphDiscipline },
      { label: 'SRS telemetry discipline', value: srsDiscipline },
      { label: 'Gate visibility', value: gateDiscipline },
    ],
  };
}

function renderTimelineChart(buckets: TimelineBucket[]): string {
  if (!buckets.length) return '<p class="empty">No timeline buckets available.</p>';
  const width = 920;
  const height = 220;
  const pad = 24;
  const max = Math.max(1, ...buckets.map((bucket) => bucket.event_count));
  const gap = 2;
  const barWidth = Math.max(2, (width - pad * 2) / buckets.length - gap);
  const bars = buckets.map((bucket, index) => {
    const x = pad + index * (barWidth + gap);
    const eventHeight = Math.round(((height - pad * 2) * bucket.event_count) / max);
    const y = height - pad - eventHeight;
    const passHeight = Math.round(((height - pad * 2) * bucket.pass_count) / max);
    const failHeight = Math.round(((height - pad * 2) * bucket.fail_count) / max);
    const doneHeight = Math.round(((height - pad * 2) * bucket.completion_count) / max);
    return `
      <rect x="${x}" y="${y}" width="${barWidth}" height="${eventHeight}" rx="2" fill="rgba(10,119,170,0.22)" />
      <rect x="${x}" y="${height - pad - passHeight}" width="${barWidth}" height="${passHeight}" rx="2" fill="#067647" />
      <rect x="${x}" y="${height - pad - passHeight - failHeight}" width="${barWidth}" height="${failHeight}" rx="2" fill="#b42318" />
      <rect x="${x}" y="${height - pad - passHeight - failHeight - doneHeight}" width="${barWidth}" height="${doneHeight}" rx="2" fill="#0a7" />`;
  }).join('');
  const first = buckets[0]?.bucket_start?.slice(5, 16).replace('T', ' ');
  const last = buckets[buckets.length - 1]?.bucket_start?.slice(5, 16).replace('T', ' ');
  return `
    <svg class="gp-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="SMA Gen3 progress timeline">
      <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="rgba(0,0,0,0.18)" />
      ${bars}
      <text x="${pad}" y="${height - 6}" font-size="11" fill="currentColor">${esc(first)}</text>
      <text x="${width - pad - 70}" y="${height - 6}" font-size="11" fill="currentColor">${esc(last)}</text>
      <text x="${pad}" y="16" font-size="11" fill="currentColor">blue events · green pass · red fail · teal completed</text>
    </svg>`;
}

function renderModuleGroups(modules: ModuleRow[]): string {
  const groups = new Map<string, ModuleGroup>();
  for (const module of modules || []) {
    const family = module.family || moduleFamily(module.project, module);
    const key = `${module.project}:${family}`;
    if (!groups.has(key)) {
      groups.set(key, {
        project: module.project,
        family,
        modules: [],
        event_count: 0,
        pass_count: 0,
        fail_count: 0,
        blocked_count: 0,
        completion_count: 0,
        srs_signal_count: 0,
        graph_signal_count: 0,
        collision_signal_count: 0,
        file_count: 0,
        slot_count: 0,
        last_event_at: null,
      });
    }
    const group = groups.get(key);
    if (!group) continue;
    group.modules.push(module);
    group.event_count += number(module.event_count);
    group.pass_count += number(module.pass_count);
    group.fail_count += number(module.fail_count);
    group.blocked_count += number(module.blocked_count);
    group.completion_count += number(module.completion_count);
    group.srs_signal_count += number(module.srs_signal_count);
    group.graph_signal_count += number(module.graph_signal_count);
    group.collision_signal_count += number(module.collision_signal_count);
    group.file_count += number(module.file_count);
    group.slot_count += number(module.max_parallel_agents);
    if (!group.last_event_at || (module.last_event_at && module.last_event_at > group.last_event_at)) {
      group.last_event_at = module.last_event_at;
    }
  }
  const cards = [...groups.values()]
    .sort((a, b) => b.event_count - a.event_count || b.slot_count - a.slot_count || a.project.localeCompare(b.project) || a.family.localeCompare(b.family))
    .slice(0, 12)
    .map(renderModuleGroup)
    .join('');
  return cards ? `<div class="gp-module-groups">${cards}</div>` : '';
}

function renderModuleGroup(group: ModuleGroup): string {
  const modules = group.modules
    .slice()
    .sort((a, b) => b.event_count - a.event_count || b.max_parallel_agents - a.max_parallel_agents || a.id.localeCompare(b.id));
  const visible = modules.slice(0, 6);
  const hidden = modules.length - visible.length;
  const verified = group.pass_count + group.fail_count + group.blocked_count;
  const groupTitle = group.family === 'control-plane'
    ? 'SMA Control Plane'
    : titleLabel(group.family);
  const moduleCards = visible.map(renderModuleCard).join('');
  const overflow = hidden > 0
    ? `<p class="gp-overflow">+${hidden} lower-activity module${hidden === 1 ? '' : 's'} in this family.</p>`
    : '';
  return `
    <div class="gp-module-group">
      <div class="gp-module-group-head">
        <div>
          <strong>${esc(groupTitle)}</strong>
          <span>${esc(group.project)} · ${group.modules.length} module${group.modules.length === 1 ? '' : 's'} · latest ${esc(shortDate(group.last_event_at))}</span>
        </div>
        <div class="gp-module-group-stats">
          <span class="gp-pill">${group.event_count} events</span>
          <span class="gp-pill">${group.completion_count} done</span>
          <span class="gp-pill">${group.pass_count}/${verified || 0} pass</span>
          <span class="gp-pill">${group.file_count} files</span>
          <span class="gp-pill">${group.slot_count || 'n/a'} slots</span>
        </div>
      </div>
      <div class="gp-modules">${moduleCards}</div>
      <div class="line"><span>SRS ${group.srs_signal_count} · graphs ${group.graph_signal_count} · collisions ${group.collision_signal_count}</span><span>${group.fail_count} fail · ${group.blocked_count} blocked</span></div>
      ${overflow}
    </div>`;
}

function renderModuleCard(module: ModuleRow): string {
  const total = Math.max(1, module.event_count);
  const passWidth = percent(module.pass_count, total);
  const failWidth = percent(module.fail_count, total);
  const status = moduleStatus(module);
  const pathText = module.primary_path
    ? shortText(module.primary_path, 72)
    : `${number(module.path_count)} declared path${number(module.path_count) === 1 ? '' : 's'}`;
  return `
    <div class="gp-module">
      <div class="gp-module-top">
        <strong>${esc(module.label || module.id)}</strong>
        <span class="gp-tag ${esc(status.className)}">${esc(status.label)}</span>
      </div>
      <div class="line"><span>${esc(module.project)} / ${esc(module.id)}</span><span>${module.event_count} events</span></div>
      <div class="line"><span>${module.pass_count} pass · ${module.fail_count} fail · ${module.completion_count} done</span><span>${module.max_parallel_agents ? `${module.max_parallel_agents} slots` : 'inferred'}</span></div>
      <div class="bar"><i style="width:${Math.max(4, passWidth)}%; background:#067647"></i></div>
      <div class="bar"><i style="width:${Math.max(0, failWidth)}%; background:#b42318"></i></div>
      <div class="line"><span>SRS ${module.srs_signal_count} · graphs ${module.graph_signal_count} · collisions ${module.collision_signal_count}</span><span>${esc(shortDate(module.last_event_at))}</span></div>
      <div class="line"><span>${esc(pathText)}</span><span>${module.file_count} files</span></div>
    </div>`;
}

function moduleStatus(module: ModuleRow): { label: string; className: string } {
  if (module.fail_count > 0) return { label: 'needs attention', className: 'attention' };
  if (module.blocked_count > 0) return { label: 'blocked', className: 'blocked' };
  if (module.pass_count > 0) return { label: 'verified', className: 'verified' };
  if (module.event_count > 0) return { label: 'active', className: 'active' };
  return { label: 'ready', className: 'ready' };
}

function metricCard(label: unknown, value: unknown, sub: unknown): string {
  return `<div class="gp-metric"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(sub)}</small></div>`;
}

function compactVerification(event: GoalEvent) {
  return {
    time: event.timestamp,
    project: event.project,
    module: event.module,
    brick_id: event.brick_id,
    status: event.verification_status,
    command: shortCommand(event.verification_command),
  };
}

function event({ project, brick_id, kind, timestamp, status, command, files }: {
  project: string; brick_id: string; kind: string; timestamp: string;
  status: VerificationStatus; command: string; files: string[];
}): string {
  return JSON.stringify({
    schema_version: '1.0.0',
    event_id: `${brick_id}-${kind}-${status}`,
    project,
    brick_id,
    kind,
    intent: `${brick_id} ${kind}`,
    timestamp,
    files_touched: files,
    verification: { status, command },
  });
}

function latestTimestamp(events: GoalEvent[]): string | null {
  let latest: string | null = null;
  for (const event of events) {
    if (!latest || event.timestamp > latest) latest = event.timestamp;
  }
  return latest;
}

function countBy<T>(items: readonly T[], keyFn: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function normalizeCommand(command: unknown): string {
  return String(command || '').replace(/\s+/g, ' ').trim().toLowerCase() || '<no-command>';
}

function shortCommand(command: unknown): string {
  const text = normalizeCommand(command);
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
}

function shortText(value: unknown, max = 96): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text;
}

function shortDate(value: unknown): string {
  return value ? String(value).slice(5, 16).replace('T', ' ') : 'no events';
}

function titleLabel(id: unknown): string {
  const value = String(id || 'unmapped');
  if (/^c0[a-z0-9]+$/i.test(value)) return value.toUpperCase();
  return value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function percent(value: unknown, total: unknown): number {
  const n = number(value);
  const d = number(total);
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

function number(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function safeRead(file: string): string {
  try { return readFileSync(file, 'utf8'); } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
    if (code !== 'ENOENT') console.error(JSON.stringify({ area: 'gen3-goal-progress.read', severity: 'warning', hint: 'Check the progress input file and its permissions.', error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) }));
    return '';
  }
}

function safeJson(text: string): RawContextEvent | null {
  try { return JSON.parse(text) as RawContextEvent; } catch (error) {
    console.error(JSON.stringify({ area: 'gen3-goal-progress.parse-json', severity: 'warning', hint: 'Repair malformed progress JSON.', error: error instanceof Error ? error.message : String(error) }));
    return null;
  }
}

function esc(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stripTrailingWhitespace(text: string): string {
  return String(text || '').replace(/[ \t]+$/gm, '');
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
