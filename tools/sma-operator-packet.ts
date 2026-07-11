#!/usr/bin/env node
/**
 * What: Builds a compact operator packet from current coordination evidence.
 * Why: Operators need a trustworthy overview without rereading large generated dashboards.
 * How: Reads preflight and goal-progress reports, then writes structured and Markdown handoffs.
 * Callers: Humans and agents use the packet as the first status and planning artifact.
 * Example: `node tools/sma-operator-packet.ts --help`
 */
/**
 * sma-operator-packet.ts - compact Gen3 executive/operator cache.
 *
 * This is the low-token front door for humans and agents. It distills the
 * controller preflight and 100h hardening telemetry into one reusable packet
 * so agents do not re-read the full dashboard/state/wiki surfaces.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';
import { writeJsonIfMeaningfulChanged, writeTextIfChanged } from './lib/stable-generated.ts';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = resolve(SMA_ROOT, 'handoffs/operator-packet.generated.json');
const args = parseArgs(argv.slice(2));

try {
  if (args.help || args.h) {
    usage();
    exit(0);
  }
  if (args.selftest) {
    runSelfTest();
    exit(0);
  }
  await run();
} catch (err) {
  console.error(`sma-operator-packet: ${err.message}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-operator-packet.ts [--project <id>] [--out <path>] [--json] [--no-write]
  sma-operator-packet.ts --selftest

Writes a compact JSON + Markdown operator packet under handoffs/ by default.
Use it as the first reusable context artifact before reading full dashboards.
`);
}

async function run() {
  const project = args.project ? String(args.project) : null;
  const outPath = args.out ? resolve(args.out) : defaultOut(project);
  const mdPath = outPath.replace(/\.json$/i, '.md');
  const preflight = runJsonTool('preflight', [
    'tools/sma-parallel-preflight.ts',
    '--json',
    '--no-auto-refresh',
    ...(project ? ['--project', project] : []),
  ]);
  const goal = runJsonTool('goal-progress', [
    'tools/sma-goal-progress.ts',
    '--json',
    ...(project ? ['--project', project] : []),
  ]);
  const packet = buildOperatorPacket({ project, preflight, goal });

  if (args.json) console.log(JSON.stringify(packet, null, 2));
  if (!args.noWrite) {
    const jsonWrite = await writeJsonIfMeaningfulChanged(outPath, packet, {
      normalize: normalizeOperatorPacket,
    });
    const markdownWrite = writeTextIfChanged(mdPath, renderMarkdown(packet));
    console.log(`${jsonWrite.written ? 'wrote' : 'unchanged'} ${outPath}`);
    console.log(`${markdownWrite.written ? 'wrote' : 'unchanged'} ${mdPath}`);
  }
}

export function buildOperatorPacket({ project = null, preflight, goal }) {
  const g = goal?.summary || {};
  const p = preflight || {};
  const topModules = aggregateModuleFamilies(goal?.modules || []);
  const hasModuleGains = Boolean(p.module_work?.available);

  return {
    schema_version: '1.0.0',
    kind: 'sma-gen3-operator-packet',
    generated_at: new Date().toISOString(),
    scope: project ? { project } : { portfolio: true },
    executive_summary: {
      tldr: p.big_picture?.tldr || 'No preflight TLDR available.',
      current_slice: p.big_picture?.current_slice || '',
      status: p.status || 'unknown',
      active_lane: p.active_lane || 'unknown',
      launch_allowed: Boolean(p.launch_allowed),
      launch_capacity_percent: number(p.active_lane_capacity_percent),
      integration_readiness_percent: number(p.integration_readiness_score_percent ?? p.readiness_score_percent),
      recommended_agents: number(p.active_recommended_agents ?? p.recommended_agents),
      requested_agents: number(p.requested_agents),
      next_command: p.primary_next_command || '',
    },
    why_switch: [
      'Module graphs replace broad repo reads as the default context path.',
      'Leases and conflict receipts make collisions explicit instead of invisible.',
      'Operator packets make the current truth reusable by every agent and human.',
      'SRS/proof telemetry turns user reports into maintainable hardening evidence.',
      'Local-first runners and caches keep cost optional while preserving a paid acceleration path.',
    ],
    architecture_primitives: [
      'sma.gen3.json owns modules, shared hot paths, gates, and cost policy.',
      'Graphify module graphs are mandatory daily work surfaces.',
      'start:edit/end:edit create scoped leases, dirty baselines, and proof receipts.',
      'parallel:preflight and operator:packet are the low-token control-plane APIs.',
      'dashboards are presentation; packets are the reusable decision cache.',
    ],
    proof_metrics: {
      hardening_score_percent: number(g.hardening_score_percent),
      proof_coverage_percent: number(g.proof_coverage_percent),
      verification_pass: number(g.pass_count),
      verification_total: number(g.verification_count),
      failed_then_passed: number(g.failed_then_passed_count),
      srs_signals: number(g.srs_signal_count),
      graph_signals: number(g.graph_signal_count),
      collision_signals: number(g.collision_signal_count),
      conflict_detected: number(g.conflict_detected_count),
      conflict_resolved: number(g.conflict_resolved_count),
      current_agents_supported: number(g.current_agents_supported),
      future_agents_target: number(g.future_agents_target),
    },
    controller_metrics: {
      active_leases: number(p.controller?.active_leases),
      open_conflicts: number(p.conflict_sla?.open_conflicts),
      graph_packets: number(p.graph_packets?.packet_count),
      project_graph_gaps: number(p.graph_packets?.project_graph_gaps),
      module_graph_gaps: number(p.graph_packets?.module_graph_gap_count),
      dirty_projects: number(p.controller?.dirty_projects),
      dirty_unleased_projects: number(p.controller?.dirty_unleased_projects),
      cleanup_claimable_paths: number(p.gains?.claimable_dirty_paths),
      cleanup_targeted_paths: number(p.gains?.targeted_dirty_paths),
    },
    gains: {
      controller_roundtrip_reduction_percent: number(p.gains?.coordination_roundtrip_reduction_percent_estimate),
      dirty_status_token_reduction_percent: number(p.gains?.dirty_status_token_reduction_percent_estimate),
      manual_wave_sizing_reduction_percent: number(p.gains?.manual_wave_sizing_reduction_percent_estimate),
      graph_first_token_reduction_percent: hasModuleGains ? number(p.module_work?.gains?.module_graph_first_token_reduction_percent_estimate) : null,
      collision_reduction_percent: hasModuleGains ? number(p.module_work?.gains?.collision_reduction_percent_estimate) : null,
      selected_wave_top_gain_percent: number(p.gains?.selected_wave_top_gain_percent),
      selected_project_top_gain_percent: number(p.gains?.selected_project_top_gain_percent),
    },
    top_module_families: topModules,
    next_slices: p.big_picture?.next_slices || [],
    horizon: p.big_picture?.horizon || [],
    agent_start_sequence: [
      'Read handoffs/operator-packet.generated.md first.',
      'Run npm run gen3:status -- --no-auto-refresh only when the packet is stale or a live decision is needed.',
      'Use module Graphify before broad file reads.',
      'Claim with start:edit/module:claim/cleanup:claim before touching files.',
      'Close with end:edit plus gates, then refresh operator:packet if portfolio truth changed.',
    ],
    links: {
      global_dashboard: 'wiki/GEN3_DASHBOARD.generated.html',
      project_dashboard: 'wiki/projects/acme-desktop/GEN3_DASHBOARD.generated.html',
      cleanup_packets: 'handoffs/cleanup-packets.generated.md',
      graph_packets: 'handoffs/graph-packets.generated.md',
    },
  };
}

export function renderMarkdown(packet) {
  const e = packet.executive_summary || {};
  const proof = packet.proof_metrics || {};
  const gains = packet.gains || {};
  const controller = packet.controller_metrics || {};
  const modules = (packet.top_module_families || [])
    .slice(0, 8)
    .map((module) => `| ${escMd(module.project)} | ${escMd(module.family)} | ${module.events} | ${module.pass}/${module.pass + module.fail + module.blocked} | ${module.files} | ${module.srs} | ${module.graphs} | ${module.collisions} |`)
    .join('\n');
  return `${[
    '# SMA Gen3 Operator Packet',
    '',
    '## Executive Read',
    `- TLDR: ${e.tldr}`,
    `- Current slice: ${stripLabel(e.current_slice, 'Current slice') || 'n/a'}`,
    `- Status: ${e.status}; lane ${e.active_lane}; ${e.recommended_agents}/${e.requested_agents} agents; launch ${e.launch_capacity_percent}%; integration ${e.integration_readiness_percent}%`,
    `- Next command: \`${e.next_command || 'n/a'}\``,
    '',
    '## Why Teams Switch',
    ...(packet.why_switch || []).map((item) => `- ${item}`),
    '',
    '## Architecture Primitives',
    ...(packet.architecture_primitives || []).map((item) => `- ${item}`),
    '',
    '## Proof Metrics',
    `- Hardening: ${proof.hardening_score_percent}%`,
    `- Proof coverage: ${proof.proof_coverage_percent}%; verification ${proof.verification_pass}/${proof.verification_total}; fail-to-pass ${proof.failed_then_passed}`,
    `- SRS ${proof.srs_signals}; graph ${proof.graph_signals}; collision-control ${proof.collision_signals}`,
    `- Conflicts ${proof.conflict_detected}/${proof.conflict_resolved}; agent target ${proof.current_agents_supported}->${proof.future_agents_target}`,
    '',
    '## Controller Metrics',
    `- Active leases ${controller.active_leases}; open conflicts ${controller.open_conflicts}; graph packets ${controller.graph_packets}; module graph gaps ${controller.module_graph_gaps}`,
    `- Dirty projects ${controller.dirty_projects}; dirty-unleased ${controller.dirty_unleased_projects}; cleanup paths ${controller.cleanup_claimable_paths}/${controller.cleanup_targeted_paths}`,
    '',
    '## Gains',
    `- Controller round trips: ${gains.controller_roundtrip_reduction_percent}% fewer`,
    `- Dirty status tokens: ${gains.dirty_status_token_reduction_percent}% fewer`,
    `- Manual wave sizing: ${gains.manual_wave_sizing_reduction_percent}% less`,
    `- Graph-first module context: ${formatMaybePercent(gains.graph_first_token_reduction_percent, ' fewer tokens')}`,
    `- Collision reduction estimate: ${formatMaybePercent(gains.collision_reduction_percent)}`,
    `- Top wave/project gain: ${gains.selected_wave_top_gain_percent}% / ${gains.selected_project_top_gain_percent}%`,
    '',
    '## Top Module Families',
    '| Project | Family | Events | Verifications | Files | SRS | Graph | Collision |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    modules || '| n/a | n/a | 0 | 0/0 | 0 | 0 | 0 | 0 |',
    '',
    '## Agent Start Sequence',
    ...(packet.agent_start_sequence || []).map((item, index) => `${index + 1}. ${item}`),
    '',
    '## Horizon',
    ...(packet.horizon || []).map((item) => `- ${item}`),
  ].join('\n')}\n`;
}

function runJsonTool(label, commandArgs) {
  const raw = execFileSync(process.execPath, commandArgs, {
    cwd: SMA_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: numberArg(args.timeoutMs, 180000),
    maxBuffer: 96 * 1024 * 1024,
  });
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} returned invalid JSON: ${err.message}`);
  }
}

function aggregateModuleFamilies(modules) {
  const groups = new Map();
  for (const module of modules || []) {
    const family = module.family || module.id || 'unmapped';
    const key = `${module.project || 'unknown'}:${family}`;
    const current = groups.get(key) || {
      project: module.project || 'unknown',
      family,
      events: 0,
      pass: 0,
      fail: 0,
      blocked: 0,
      files: 0,
      srs: 0,
      graphs: 0,
      collisions: 0,
    };
    current.events += number(module.event_count);
    current.pass += number(module.pass_count);
    current.fail += number(module.fail_count);
    current.blocked += number(module.blocked_count);
    current.files += number(module.file_count);
    current.srs += number(module.srs_signal_count);
    current.graphs += number(module.graph_signal_count);
    current.collisions += number(module.collision_signal_count);
    groups.set(key, current);
  }
  return [...groups.values()]
    .sort((left, right) => right.events - left.events || left.project.localeCompare(right.project) || left.family.localeCompare(right.family))
    .slice(0, 10);
}

function defaultOut(project) {
  if (!project) return DEFAULT_OUT;
  return resolve(SMA_ROOT, 'handoffs', `operator-packet.${safeSegment(project)}.generated.json`);
}

function normalizeOperatorPacket(packet) {
  const clone = JSON.parse(JSON.stringify(packet));
  clone.generated_at = '<generated_at>';
  return clone;
}

function runSelfTest() {
  const packet = buildOperatorPacket({
    project: 'demo',
    preflight: {
      status: 'ready',
      readiness_score_percent: 95,
      integration_readiness_score_percent: 90,
      active_lane_capacity_percent: 100,
      requested_agents: 12,
      active_recommended_agents: 12,
      active_lane: 'module',
      launch_allowed: true,
      primary_next_command: 'npm run module:dispatch -- --project demo',
      big_picture: { tldr: 'Ready', current_slice: 'Dispatch modules', next_slices: ['Observe'], horizon: ['Scale'] },
      gains: {
        coordination_roundtrip_reduction_percent_estimate: 75,
        dirty_status_token_reduction_percent_estimate: 90,
        manual_wave_sizing_reduction_percent_estimate: 100,
        selected_wave_top_gain_percent: 25,
        selected_project_top_gain_percent: 50,
      },
      controller: { active_leases: 0, dirty_projects: 0, dirty_unleased_projects: 0 },
      conflict_sla: { open_conflicts: 0 },
      graph_packets: { packet_count: 0, project_graph_gaps: 0, module_graph_gap_count: 0 },
      module_work: { gains: { module_graph_first_token_reduction_percent_estimate: 80, collision_reduction_percent_estimate: 60 } },
    },
    goal: {
      summary: {
        hardening_score_percent: 88,
        proof_coverage_percent: 70,
        pass_count: 7,
        verification_count: 8,
        srs_signal_count: 3,
        graph_signal_count: 4,
        collision_signal_count: 5,
        current_agents_supported: 12,
        future_agents_target: 100,
      },
      modules: [{ project: 'demo', id: 'modlink', family: 'modlink', event_count: 5, pass_count: 2, file_count: 3 }],
    },
  });
  const markdown = renderMarkdown(packet);
  assert(packet.executive_summary.recommended_agents === 12, 'expected recommended agents');
  assert(packet.proof_metrics.future_agents_target === 100, 'expected future target');
  assert(markdown.includes('Why Teams Switch'), 'expected executive switch story');
  console.log('sma-operator-packet selftest: ok');
}

function parseArgs(list): Record<string, any> {
  const out: Record<string, any> = {};
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = list[index + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    index += 1;
  }
  return out;
}

function safeSegment(value) {
  return String(value || 'project').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberArg(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function escMd(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatMaybePercent(value, suffix = '') {
  return value === null || value === undefined ? 'n/a' : `${value}%${suffix || ''}`;
}

function stripLabel(value, label) {
  const text = String(value || '').trim();
  const prefix = `${label}:`;
  return text.toLowerCase().startsWith(prefix.toLowerCase()) ? text.slice(prefix.length).trim() : text;
}

function assert(condition, message) {
  if (!condition) throw new Error(`selftest failed: ${message}`);
}
