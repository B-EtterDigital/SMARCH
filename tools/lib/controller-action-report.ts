/* Snapshot inputs cross a runtime JSON boundary, so defensive guards and existing diagnostic coercion remain required. */
/* Packet builders and renderers are declarative fallback maps; complexity counts nullish fields as control-flow branches. */
/* eslint @typescript-eslint/no-base-to-string: "off", @typescript-eslint/no-unnecessary-condition: "off", complexity: "off" */
/**
 * WHAT: Converts controller snapshots into ranked action, cleanup, and graph-repair reports and Markdown handoffs.
 * WHY: Operators need stable, claimable next actions instead of interpreting raw lease, graph, and dirty-state records.
 * HOW: The controller passes normalized state; builders return packet objects and renderers return text.
 * Generated commands preserve lease fingerprints so stale packets fail safely before another agent claims them.
 * This module only shapes supplied data and does not claim work or write handoff files itself.
 * @example node --input-type=module -e "import * as reports from './tools/lib/controller-action-report.ts'; console.log(Object.keys(reports))"
 */

import { packetLeaseFingerprint } from './packet-freshness.ts';

const DEFAULT_ACTION_LIMIT = 25;
const GRAPH_REPAIR_TIMEOUT_SECONDS = 240;
const DIRTY_GROUP_SAMPLE_LIMIT = 5;
const CLEANUP_PACKETS_BASENAME = 'cleanup-packets.generated';
const GRAPH_PACKETS_BASENAME = 'graph-packets.generated';

type LeaseInput = Parameters<typeof packetLeaseFingerprint>[0];
type LeaseFingerprint = ReturnType<typeof packetLeaseFingerprint>;
interface ParallelClaim {
  group?: string;
  count?: number;
  brick?: string | null;
  command?: string;
  conflict?: string | null;
  sample_paths?: string[];
}
interface ControllerActionItem {
  severity: string;
  kind: string;
  project: string;
  title: string;
  detail?: string;
  command?: string;
  impact_score?: number;
  brick?: string | null;
  dirty_count?: number;
  uncovered_dirty_count?: number;
  top_dirty_group?: string;
  top_dirty_group_count?: number;
  top_dirty_group_sample_paths?: string[];
  parallel_claims?: ParallelClaim[];
  next_commands?: Record<string, string | null | undefined>;
  module_graph_gap_count?: number;
  missing_graph_count?: number;
  missing_target_count?: number;
  repair_kind?: string;
  target_fixes?: unknown[];
}
interface CleanupWaveCommand {
  rank: number;
  project: string;
  group: string;
  count: number;
  parent_dirty_count?: number;
  brick?: string | null;
  command: string;
  inspect?: string | null;
  conflict?: string | null;
  sample_paths?: string[];
  wave_gain_percent?: number | null;
  project_gain_percent?: number | null;
}
interface ParallelWave {
  commands?: CleanupWaveCommand[];
  recommended_agent_count?: number;
  total_candidate_count?: number;
  overflow_count?: number;
  selection_rule?: string;
  total_impact?: number;
  limit?: number;
}
interface ControllerSnapshot {
  generated_at: string;
  leases: LeaseInput;
  projects: { id?: string }[];
  summary: Record<string, unknown> & {
    projects?: number;
    active_leases?: number;
    open_conflicts?: number;
    dirty_unleased_projects?: number;
    active_dirty_scope_projects?: number;
    active_dirty_scope_paths?: number;
    stale_agent_process_projects?: number;
    stale_agent_processes?: number;
    agent_process_scan_error_projects?: number;
    graph_gaps?: number;
    module_graph_gaps?: number;
    controller_actions?: number;
  };
  parallel_wave?: ParallelWave;
  action_items: ControllerActionItem[];
}
type CleanupPacketInput = CleanupWaveCommand & {
  packet_type?: string;
  claim_intent?: string;
};

export function buildActionReport(snapshot: ControllerSnapshot) {
  const bySeverity: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  const byProject: Record<string, number> = {};
  for (const item of snapshot.action_items) {
    bySeverity[item.severity] = (bySeverity[item.severity] || 0) + 1;
    byKind[item.kind] = (byKind[item.kind] || 0) + 1;
    byProject[item.project] = (byProject[item.project] || 0) + 1;
  }
  const leaseFingerprint = packetLeaseFingerprint(snapshot.leases);
  const leaseFingerprintsByProject = projectLeaseFingerprints(snapshot.projects, snapshot.leases);
  return {
    schema_version: '1.0.0',
    generated_at: snapshot.generated_at,
    lease_fingerprint: leaseFingerprint,
    lease_fingerprints_by_project: leaseFingerprintsByProject,
    summary: {
      ...snapshot.summary,
      action_limit_default: DEFAULT_ACTION_LIMIT,
      lease_fingerprint_hash: leaseFingerprint.hash,
      lease_fingerprint_lease_count: leaseFingerprint.lease_count,
      by_severity: bySeverity,
      by_kind: byKind,
      by_project: byProject,
    },
    parallel_wave: snapshot.parallel_wave,
    action_items: snapshot.action_items,
    next_commands: {
      sweep: 'npm run controller:sweep',
      full_sweep: `npm run controller:snapshot -- --all --actions-only --dirty-limit 0 --action-limit ${String(snapshot.action_items.length)}`,
      json: 'npm run controller:sweep:json',
      dashboard: 'npm run gen3:dashboard',
      cleanup_packets: `cat handoffs/${CLEANUP_PACKETS_BASENAME}.md`,
      graph_packets: `cat handoffs/${GRAPH_PACKETS_BASENAME}.md`,
    },
  };
}

export function buildCleanupPacketReport(report: ReturnType<typeof buildActionReport>) {
  const wavePackets = (report.parallel_wave?.commands ?? []).map((item) => cleanupPacket({
    ...item,
    packet_type: 'dirty-unleased',
  }));
  const activeScopePackets = buildActiveScopeCleanupPackets(report, wavePackets.length);
  const packets = [...wavePackets, ...activeScopePackets];
  for (const packet of packets) {
    packet.lease_fingerprint = report.lease_fingerprints_by_project[packet.project] || null;
  }
  const activeScopePaths = activeScopePackets.reduce((sum, item) => sum + (item.dirty_path_count || 0), 0);
  const defaultWavePaths = wavePackets.reduce((sum, item) => sum + (item.dirty_path_count || 0), 0);
  const topWavePacket = wavePackets[0] || null;
  return {
    schema_version: '1.0.0',
    generated_at: report.generated_at,
    lease_fingerprint: report.lease_fingerprint || null,
    summary: {
      packet_count: packets.length,
      lease_fingerprint_hash: report.lease_fingerprint.hash || null,
      lease_fingerprint_lease_count: report.lease_fingerprint.lease_count ?? null,
      dirty_paths_covered: packets.reduce((sum, item) => sum + (item.dirty_path_count || 0), 0),
      dirty_unleased_packet_count: wavePackets.length,
      active_scope_packet_count: activeScopePackets.length,
      active_scope_paths_covered: activeScopePaths,
      default_wave_agent_count: (report.parallel_wave?.recommended_agent_count ?? wavePackets.length),
      default_wave_dirty_paths: defaultWavePaths,
      default_wave_top_gain_percent: topWavePacket.wave_gain_percent ?? null,
      default_wave_top_project_gain_percent: topWavePacket.project_gain_percent ?? null,
      total_candidate_count: (report.parallel_wave?.total_candidate_count ?? wavePackets.length) + activeScopePackets.length,
      overflow_count: report.parallel_wave?.overflow_count ?? 0,
      selection_rule: `${report.parallel_wave?.selection_rule ?? 'dirty-unleased packet ranking'}; active-dirty-scope packets appended so uncovered active work is always claimable`,
    },
    packets,
    next_commands: {
      refresh: 'npm run controller:sweep:write',
      controller_sweep: 'npm run controller:sweep',
      cleanup_next: 'npm run cleanup:claim -- --next',
      dashboard: 'npm run gen3:dashboard',
    },
  };
}

function buildActiveScopeCleanupPackets(report: ReturnType<typeof buildActionReport>, startIndex: number): ReturnType<typeof cleanupPacket>[] {
  const packets: ReturnType<typeof cleanupPacket>[] = [];
  for (const item of report.action_items || []) {
    if (item.kind !== 'active-dirty-scope') continue;
    const claims = Array.isArray(item.parallel_claims) && item.parallel_claims.length
      ? item.parallel_claims
      : [{
        group: (item.top_dirty_group ?? item.brick) ?? 'active-scope',
        count: (item.top_dirty_group_count ?? item.uncovered_dirty_count ?? item.impact_score ?? 0),
        brick: item.brick,
        command: item.command,
        conflict: item.next_commands?.conflict,
        sample_paths: item.top_dirty_group_sample_paths ?? [],
      }];

    for (const claim of claims) {
      const count = (claim.count ?? 0);
      if (!claim.command || count <= 0) continue;
      packets.push(cleanupPacket({
        rank: startIndex + packets.length + 1,
        project: item.project,
        group: (claim.group ?? item.brick) ?? 'active-scope',
        count,
        parent_dirty_count: (item.dirty_count ?? item.impact_score ?? 0),
        brick: (claim.brick ?? item.brick) ?? null,
        command: claim.command,
        inspect: item.next_commands?.inspect ?? null,
        conflict: (claim.conflict ?? item.next_commands?.conflict) ?? null,
        sample_paths: claim.sample_paths ?? [],
        packet_type: 'active-dirty-scope',
        claim_intent: `claim uncovered active dirty scope ${(claim.group ?? item.brick) ?? 'active-scope'} (${String(count)} path${count === 1 ? '' : 's'})`,
      }));
    }
  }
  return packets;
}

export function buildGraphPacketReport(report: ReturnType<typeof buildActionReport>) {
  const graphItems = report.action_items.filter((item) => item.kind === 'graph-gap' || item.kind === 'module-graph-gap');
  const packets = graphItems.map((item, index) => graphPacket(item, index + 1));
  for (const packet of packets) {
    packet.lease_fingerprint = report.lease_fingerprints_by_project[packet.project] || null;
  }
  return {
    schema_version: '1.0.0',
    generated_at: report.generated_at,
    lease_fingerprint: report.lease_fingerprint || null,
    summary: {
      packet_count: packets.length,
      lease_fingerprint_hash: report.lease_fingerprint.hash || null,
      lease_fingerprint_lease_count: report.lease_fingerprint.lease_count ?? null,
      project_graph_gaps: packets.filter((packet) => packet.kind === 'graph-gap').length,
      module_graph_gap_projects: packets.filter((packet) => packet.kind === 'module-graph-gap').length,
      module_graph_gap_count: packets.reduce((sum, packet) => sum + (packet.module_graph_gap_count || 0), 0),
      total_impact: packets.reduce((sum, packet) => sum + (packet.impact_score || 0), 0),
      repair_timeout_seconds: GRAPH_REPAIR_TIMEOUT_SECONDS,
      selection_rule: 'all controller graph-gap and module-graph-gap action items',
    },
    packets,
    next_commands: {
      refresh: 'npm run controller:sweep:write',
      controller_sweep: 'npm run controller:sweep',
      graph_next: 'npm run graph:claim -- --next',
      dashboard: 'npm run gen3:dashboard',
    },
  };
}

function graphPacket(item: ControllerActionItem, rank: number) {
  const moduleGapCount = (item.module_graph_gap_count ?? item.impact_score ?? 0);
  const brick = graphPacketBrick(item);
  const targetDrift = item.repair_kind === 'target-drift';
  const claimIntent = item.kind === 'module-graph-gap'
    ? targetDrift
      ? `repair module target drift for ${item.project} (${String(moduleGapCount)} stale target${moduleGapCount === 1 ? '' : 's'})`
      : `repair module graph gaps for ${item.project} (${String(moduleGapCount)} gap${moduleGapCount === 1 ? '' : 's'})`
    : `repair project graph gap for ${item.project}`;
  const claimPacketCommand = `npm run graph:claim -- --rank ${String(rank)}`;
  return {
    rank,
    project: item.project,
    kind: item.kind,
    brick,
    title: item.title,
    detail: item.detail ?? '',
    impact_score: (item.impact_score ?? 0),
    module_graph_gap_count: item.kind === 'module-graph-gap' ? moduleGapCount : 0,
    missing_graph_count: (item.missing_graph_count ?? 0),
    missing_target_count: (item.missing_target_count ?? 0),
    repair_kind: item.repair_kind ?? (item.kind === 'module-graph-gap' ? 'module-graph' : 'project-graph'),
    target_fixes: Array.isArray(item.target_fixes) ? item.target_fixes : [],
    lease_fingerprint: null as LeaseFingerprint | null,
    claim_packet_command: claimPacketCommand,
    claim_command: `npm run start:edit -- --project ${shellArg(item.project)} --brick ${shellArg(brick)} --intent ${shellArg(claimIntent)}`,
    claim_intent: claimIntent,
    repair_command: item.command,
    verify_command: graphPacketVerifyCommand(item),
    inspect_command: `npm run controller:snapshot:quiet -- --project ${shellArg(item.project)}`,
    finish_rule: targetDrift
      ? 'After claiming, run repair_command, update only the stale module ownership/source map if you own it, run verify_command, refresh controller:sweep:write, commit only owned map/generated artifacts, then end-edit with --require-cleanup-ok. If the project is dirty outside your claimed map paths, conflict-report or hand off instead of sweeping changes.'
      : 'After claiming, run repair_command, run verify_command, refresh controller:sweep:write, commit only graph/generated artifacts you own, then end-edit with --require-cleanup-ok.',
    agent_prompt: [
      `Claim ${item.project}/${brick} with claim_packet_command, or run npm run graph:claim -- --next to take the first currently unheld graph packet.`,
      targetDrift
        ? 'This packet is target/source-map drift; run repair_command for candidate paths and fix the module map before refreshing graphs.'
        : 'Use the bounded repair_command as written; do not switch to clustered or semantic refresh unless a controller explicitly asks.',
      'Use inspect_command for current graph state without printing unrelated dirty paths.',
      'Do not clean, stash, reset, or restore unrelated work.',
    ].join(' '),
  };
}

function graphPacketBrick(item: ControllerActionItem): string {
  return item.kind === 'module-graph-gap' ? 'graphify-modules' : 'graphify-project';
}

function graphPacketVerifyCommand(item: ControllerActionItem): string {
  if (item.kind === 'module-graph-gap') {
    return `npm run graphify:check:modules -- --project ${shellArg(item.project)} --strict --summary-json`;
  }
  return `npm run graphify:check -- --project ${shellArg(item.project)} --strict`;
}

function cleanupPacket(item: CleanupPacketInput) {
  const claimPacketCommand = `npm run cleanup:claim -- --rank ${String(item.rank)}`;
  const packetType = item.packet_type ?? 'dirty-unleased';
  return {
    rank: item.rank,
    packet_type: packetType,
    project: item.project,
    group: item.group,
    brick: item.brick,
    dirty_path_count: (item.count || 0),
    parent_dirty_count: (item.parent_dirty_count ?? 0),
    wave_gain_percent: item.wave_gain_percent ?? null,
    project_gain_percent: item.project_gain_percent ?? null,
    sample_paths: normalizeSamplePaths(item.sample_paths),
    lease_fingerprint: null as LeaseFingerprint | null,
    claim_packet_command: claimPacketCommand,
    claim_command: item.command,
    claim_intent: item.claim_intent ?? `claim dirty group ${item.group} (${(String(item.count || 0))} path${(item.count || 0) === 1 ? '' : 's'})`,
    inspect_command: item.inspect ?? `npm run controller:snapshot:quiet -- --project ${shellArg(item.project)}`,
    conflict_command: item.conflict ?? null,
    finish_rule: packetType === 'active-dirty-scope'
      ? 'After claiming, explain or clean only this uncovered active-scope group, run relevant project gates, refresh controller:sweep:write, then end-edit with --require-cleanup-ok.'
      : 'After claiming, clean or commit only this group, run relevant project gates, then end-edit with --require-cleanup-ok.',
    agent_prompt: [
      `Claim ${item.project}/${item.group} with claim_packet_command, or run npm run cleanup:claim -- --next to take the first currently unheld packet.`,
      'Do not print the full dirty tree.',
      'Use inspect_command only when exact paths are needed.',
      'Do not clean, stash, reset, or restore unrelated work.',
      packetType === 'active-dirty-scope'
        ? 'This packet covers uncovered dirty work while another lease is active; claim it, split it, or report a conflict before integration.'
        : 'If the group overlaps active work, run conflict_command and back off.',
    ].join(' '),
  };
}

export function renderCleanupPacketMarkdown(report: ReturnType<typeof buildCleanupPacketReport>): string {
  const lines: string[] = [
    '# SMA Gen3 Cleanup Packets',
    '',
    `Generated: ${report.generated_at}`,
    '',
    '## Summary',
    '',
    `- Packets: ${String(report.summary.packet_count)}`,
    `- Dirty paths covered: ${String(report.summary.dirty_paths_covered)}`,
    `- Dirty-unleased packets: ${String(report.summary.dirty_unleased_packet_count ?? report.summary.packet_count)}`,
    `- Active-scope packets: ${String(report.summary.active_scope_packet_count ?? 0)}`,
    `- Active-scope paths covered: ${String(report.summary.active_scope_paths_covered ?? 0)}`,
    `- Default wave: ${String(report.summary.default_wave_agent_count ?? report.summary.dirty_unleased_packet_count ?? report.summary.packet_count)} agents, ${String(report.summary.default_wave_dirty_paths ?? report.summary.dirty_paths_covered)} dirty paths`,
    `- Default wave top gain: ${formatNullablePercent(report.summary.default_wave_top_gain_percent)} of wave, ${formatNullablePercent(report.summary.default_wave_top_project_gain_percent)} of project dirty`,
    `- Active lease fingerprint: ${formatLeaseFingerprint(report.lease_fingerprint)}`,
    `- Total candidates: ${String(report.summary.total_candidate_count)}`,
    `- Overflow: ${String(report.summary.overflow_count)}`,
    `- Selection rule: ${report.summary.selection_rule || 'n/a'}`,
    '',
    '## Packets',
    '',
  ];

  if (!report.packets.length) {
    lines.push('- No cleanup packets available.');
  } else {
    for (const packet of report.packets) {
      lines.push(`- [ ] ${String(packet.rank)}. ${packet.project} ${packet.group} (${String(packet.dirty_path_count)} paths, ${packet.packet_type || 'dirty-unleased'})`);
      if (packet.wave_gain_percent !== null && packet.wave_gain_percent !== undefined) {
        const projectGain = packet.project_gain_percent === null || packet.project_gain_percent === undefined
          ? ''
          : `, ${String(packet.project_gain_percent)}% of project dirty`;
        lines.push(`  - gain: ${String(packet.wave_gain_percent)}% of wave${projectGain}`);
      }
      lines.push(`  - claim: \`${packet.claim_packet_command}\``);
      lines.push(`  - fallback claim: \`${packet.claim_command}\``);
      lines.push(`  - inspect: \`${packet.inspect_command}\``);
      if (packet.conflict_command) lines.push(`  - conflict: \`${packet.conflict_command}\``);
      if (packet.sample_paths.length) lines.push(`  - sample paths: ${packet.sample_paths.map((file) => `\`${file}\``).join(', ')}`);
      lines.push(`  - finish: ${packet.finish_rule}`);
    }
  }

  lines.push('', '## Commands', '');
  for (const [name, command] of Object.entries(report.next_commands)) {
    lines.push(`- ${name}: \`${command}\``);
  }

  return `${lines.join('\n')}\n`;
}

export function renderGraphPacketMarkdown(report: ReturnType<typeof buildGraphPacketReport>): string {
  const lines: string[] = [
    '# SMA Gen3 Graph Packets',
    '',
    `Generated: ${report.generated_at}`,
    '',
    '## Summary',
    '',
    `- Packets: ${String(report.summary.packet_count)}`,
    `- Project graph gaps: ${String(report.summary.project_graph_gaps)}`,
    `- Module graph gap projects: ${String(report.summary.module_graph_gap_projects)}`,
    `- Module graph gaps: ${String(report.summary.module_graph_gap_count)}`,
    `- Total impact: ${String(report.summary.total_impact)}`,
    `- Active lease fingerprint: ${formatLeaseFingerprint(report.lease_fingerprint)}`,
    `- Repair timeout seconds: ${String(report.summary.repair_timeout_seconds)}`,
    `- Selection rule: ${report.summary.selection_rule || 'n/a'}`,
    '',
    '## Packets',
    '',
  ];

  if (!report.packets.length) {
    lines.push('- No graph packets available.');
  } else {
    for (const packet of report.packets) {
      const impact = packet.kind === 'module-graph-gap'
        ? `${String(packet.module_graph_gap_count)} module gap${packet.module_graph_gap_count === 1 ? '' : 's'}`
        : 'missing project graph';
      lines.push(`- [ ] ${String(packet.rank)}. ${packet.project} ${packet.kind} (${impact})`);
      lines.push(`  - claim: \`${packet.claim_packet_command}\``);
      lines.push(`  - fallback claim: \`${packet.claim_command}\``);
      lines.push(`  - repair: \`${String(packet.repair_command)}\``);
      lines.push(`  - verify: \`${packet.verify_command}\``);
      lines.push(`  - inspect: \`${packet.inspect_command}\``);
      lines.push(`  - finish: ${packet.finish_rule}`);
    }
  }

  lines.push('', '## Commands', '');
  for (const [name, command] of Object.entries(report.next_commands)) {
    lines.push(`- ${name}: \`${command}\``);
  }

  return `${lines.join('\n')}\n`;
}

type ActionReport = ReturnType<typeof buildActionReport>;

function actionReportSummaryLines(report: ActionReport): string[] {
  return [
    '# SMA Gen3 Controller Actions',
    '',
    `Generated: ${report.generated_at}`,
    '',
    '## Summary',
    '',
    `- Projects observed: ${String(report.summary.projects)}`,
    `- Active leases: ${String(report.summary.active_leases)}`,
    `- Open conflicts: ${String(report.summary.open_conflicts)}`,
    `- Dirty-unleased projects: ${String(report.summary.dirty_unleased_projects)}`,
    `- Active dirty-scope projects: ${String(report.summary.active_dirty_scope_projects ?? 0)}`,
    `- Active dirty-scope paths: ${String(report.summary.active_dirty_scope_paths ?? 0)}`,
    `- Stale agent process projects: ${String(report.summary.stale_agent_process_projects ?? 0)}`,
    `- Stale agent processes: ${String(report.summary.stale_agent_processes ?? 0)}`,
    `- Agent process scan error projects: ${String(report.summary.agent_process_scan_error_projects ?? 0)}`,
    `- Graph gaps: ${String(report.summary.graph_gaps)}`,
    `- Module graph gaps: ${String(report.summary.module_graph_gaps ?? 0)}`,
    `- Action items: ${String(report.summary.controller_actions)}`,
    `- Active lease fingerprint: ${formatLeaseFingerprint(report.lease_fingerprint)}`,
    `- Parallel cleanup wave: ${String(report.parallel_wave?.recommended_agent_count ?? 0)} agents, ${String(report.parallel_wave?.total_impact ?? 0)} dirty paths covered`,
    '',
    '## Parallel Cleanup Wave',
    '',
  ];
}

function appendParallelCleanupWave(lines: string[], report: ActionReport): void {
  if (!report.parallel_wave?.commands?.length) {
    lines.push('- No safe dirty-cleanup wave available.');
  } else {
    lines.push(`Recommended agents: ${String(report.parallel_wave.recommended_agent_count)}/${String(report.parallel_wave.limit)}`);
    lines.push(`Covered dirty paths: ${String(report.parallel_wave.total_impact)}`);
    lines.push(`Selection rule: ${String(report.parallel_wave.selection_rule)}`);
    lines.push('');
    for (const item of report.parallel_wave.commands) {
      const projectGain = item.project_gain_percent === null || item.project_gain_percent === undefined
        ? ''
        : `, ${String(item.project_gain_percent)}% of project dirty`;
      lines.push(`- [ ] ${String(item.rank)}. ${item.project} ${item.group} (${String(item.count)}; ${String(item.wave_gain_percent)}% of wave${projectGain}): \`${item.command}\``);
      if (item.inspect) lines.push(`  - inspect: \`${item.inspect}\``);
      if (item.conflict) lines.push(`  - conflict: \`${item.conflict}\``);
    }
  }
}

function appendControllerActionQueue(lines: string[], report: ActionReport): void {
  lines.push(
    '',
    '## Queue',
    '',
  );

  if (!report.action_items.length) {
    lines.push('- No controller actions.');
  } else {
    for (const item of report.action_items) {
      lines.push(`- [ ] ${item.severity.toUpperCase()} ${item.project} ${item.kind}: ${item.title}`);
      if (item.detail) lines.push(`  - Detail: ${item.detail}`);
      if (item.command) lines.push(`  - Command: \`${item.command}\``);
      if (item.next_commands) {
        for (const [name, command] of Object.entries(item.next_commands)) {
          if (command && command !== item.command) lines.push(`  - ${name}: \`${command}\``);
        }
      }
      const parallelClaims = item.parallel_claims;
      if (parallelClaims && parallelClaims.length > 1) {
        lines.push('  - parallel_claims:');
        for (const claim of parallelClaims) {
          lines.push(`    - ${String(claim.group)} (${String(claim.count)}): \`${String(claim.command)}\``);
        }
      }
    }
  }
}

export function renderActionReportMarkdown(report: ActionReport): string {
  const lines = actionReportSummaryLines(report);
  appendParallelCleanupWave(lines, report);
  appendControllerActionQueue(lines, report);

  lines.push('', '## Commands', '');
  for (const [name, command] of Object.entries(report.next_commands)) {
    lines.push(`- ${name}: \`${command}\``);
  }
  return `${lines.join('\n')}\n`;
}

function formatLeaseFingerprint(fingerprint: LeaseFingerprint | null | undefined): string {
  if (!fingerprint?.hash) return 'n/a';
  return `${fingerprint.hash.slice(0, 12)} (${String(fingerprint.lease_count ?? 0)} active leases)`;
}

function projectLeaseFingerprints(projects: { id?: string }[], leases: LeaseInput): Record<string, LeaseFingerprint> {
  const out: Record<string, LeaseFingerprint> = {};
  for (const project of projects || []) {
    if (!project.id) continue;
    out[project.id] = packetLeaseFingerprint(leases, { project: project.id });
  }
  return out;
}

function normalizeSamplePaths(paths: readonly unknown[] | null | undefined, limit = DIRTY_GROUP_SAMPLE_LIMIT): string[] {
  const out: string[] = [];
  for (const value of Array.isArray(paths) ? paths : []) {
    const file = String(value ?? '').trim();
    if (!file || out.includes(file)) continue;
    out.push(file);
    if (out.length >= limit) break;
  }
  return out;
}

function formatNullablePercent(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'n/a';
  return String(value) + '%';
}

function shellArg(value: unknown): string {
  return "'" + String(value ?? '').replace(/'/g, "'\\''") + "'";
}
