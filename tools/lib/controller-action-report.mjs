/** Action and packet report builders for sma-controller-snapshot.mjs. */

import { packetLeaseFingerprint } from './packet-freshness.mjs';

const DEFAULT_ACTION_LIMIT = 25;
const GRAPH_REPAIR_TIMEOUT_SECONDS = 240;
const DIRTY_GROUP_SAMPLE_LIMIT = 5;
const CLEANUP_PACKETS_BASENAME = 'cleanup-packets.generated';
const GRAPH_PACKETS_BASENAME = 'graph-packets.generated';

export function buildActionReport(snapshot) {
  const bySeverity = {};
  const byKind = {};
  const byProject = {};
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
      full_sweep: `npm run controller:snapshot -- --all --actions-only --dirty-limit 0 --action-limit ${snapshot.action_items.length}`,
      json: 'npm run controller:sweep:json',
      dashboard: 'npm run gen3:dashboard',
      cleanup_packets: `cat handoffs/${CLEANUP_PACKETS_BASENAME}.md`,
      graph_packets: `cat handoffs/${GRAPH_PACKETS_BASENAME}.md`,
    },
  };
}

export function buildCleanupPacketReport(report) {
  const wavePackets = (report.parallel_wave?.commands || []).map((item) => cleanupPacket({
    ...item,
    packet_type: 'dirty-unleased',
  }));
  const activeScopePackets = buildActiveScopeCleanupPackets(report, wavePackets.length);
  const packets = [...wavePackets, ...activeScopePackets];
  for (const packet of packets) {
    packet.lease_fingerprint = report.lease_fingerprints_by_project?.[packet.project] || null;
  }
  const activeScopePaths = activeScopePackets.reduce((sum, item) => sum + Number(item.dirty_path_count || 0), 0);
  const defaultWavePaths = wavePackets.reduce((sum, item) => sum + Number(item.dirty_path_count || 0), 0);
  const topWavePacket = wavePackets[0] || null;
  return {
    schema_version: '1.0.0',
    generated_at: report.generated_at,
    lease_fingerprint: report.lease_fingerprint || null,
    summary: {
      packet_count: packets.length,
      lease_fingerprint_hash: report.lease_fingerprint?.hash || null,
      lease_fingerprint_lease_count: report.lease_fingerprint?.lease_count ?? null,
      dirty_paths_covered: packets.reduce((sum, item) => sum + Number(item.dirty_path_count || 0), 0),
      dirty_unleased_packet_count: wavePackets.length,
      active_scope_packet_count: activeScopePackets.length,
      active_scope_paths_covered: activeScopePaths,
      default_wave_agent_count: Number(report.parallel_wave?.recommended_agent_count ?? wavePackets.length),
      default_wave_dirty_paths: defaultWavePaths,
      default_wave_top_gain_percent: topWavePacket?.wave_gain_percent ?? null,
      default_wave_top_project_gain_percent: topWavePacket?.project_gain_percent ?? null,
      total_candidate_count: Number(report.parallel_wave?.total_candidate_count ?? wavePackets.length) + activeScopePackets.length,
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

function buildActiveScopeCleanupPackets(report, startIndex) {
  const packets = [];
  for (const item of report.action_items || []) {
    if (item.kind !== 'active-dirty-scope') continue;
    const claims = Array.isArray(item.parallel_claims) && item.parallel_claims.length
      ? item.parallel_claims
      : [{
        group: item.top_dirty_group || item.brick || 'active-scope',
        count: Number(item.top_dirty_group_count ?? item.uncovered_dirty_count ?? item.impact_score ?? 0),
        brick: item.brick,
        command: item.command,
        conflict: item.next_commands?.conflict,
        sample_paths: item.top_dirty_group_sample_paths || [],
      }];

    for (const claim of claims) {
      const count = Number(claim.count ?? 0);
      if (!claim.command || count <= 0) continue;
      packets.push(cleanupPacket({
        rank: startIndex + packets.length + 1,
        project: item.project,
        group: claim.group || item.brick || 'active-scope',
        count,
        parent_dirty_count: Number(item.dirty_count ?? item.impact_score ?? 0),
        brick: claim.brick || item.brick || null,
        command: claim.command,
        inspect: item.next_commands?.inspect || null,
        conflict: claim.conflict || item.next_commands?.conflict || null,
        sample_paths: claim.sample_paths || [],
        packet_type: 'active-dirty-scope',
        claim_intent: `claim uncovered active dirty scope ${claim.group || item.brick || 'active-scope'} (${count} path${count === 1 ? '' : 's'})`,
      }));
    }
  }
  return packets;
}

export function buildGraphPacketReport(report) {
  const graphItems = report.action_items.filter((item) => item.kind === 'graph-gap' || item.kind === 'module-graph-gap');
  const packets = graphItems.map((item, index) => graphPacket(item, index + 1));
  for (const packet of packets) {
    packet.lease_fingerprint = report.lease_fingerprints_by_project?.[packet.project] || null;
  }
  return {
    schema_version: '1.0.0',
    generated_at: report.generated_at,
    lease_fingerprint: report.lease_fingerprint || null,
    summary: {
      packet_count: packets.length,
      lease_fingerprint_hash: report.lease_fingerprint?.hash || null,
      lease_fingerprint_lease_count: report.lease_fingerprint?.lease_count ?? null,
      project_graph_gaps: packets.filter((packet) => packet.kind === 'graph-gap').length,
      module_graph_gap_projects: packets.filter((packet) => packet.kind === 'module-graph-gap').length,
      module_graph_gap_count: packets.reduce((sum, packet) => sum + Number(packet.module_graph_gap_count || 0), 0),
      total_impact: packets.reduce((sum, packet) => sum + Number(packet.impact_score || 0), 0),
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

function graphPacket(item, rank) {
  const moduleGapCount = Number(item.module_graph_gap_count ?? item.impact_score ?? 0);
  const brick = graphPacketBrick(item);
  const targetDrift = item.repair_kind === 'target-drift';
  const claimIntent = item.kind === 'module-graph-gap'
    ? targetDrift
      ? `repair module target drift for ${item.project} (${moduleGapCount} stale target${moduleGapCount === 1 ? '' : 's'})`
      : `repair module graph gaps for ${item.project} (${moduleGapCount} gap${moduleGapCount === 1 ? '' : 's'})`
    : `repair project graph gap for ${item.project}`;
  const claimPacketCommand = `npm run graph:claim -- --rank ${rank}`;
  return {
    rank,
    project: item.project,
    kind: item.kind,
    brick,
    title: item.title,
    detail: item.detail || '',
    impact_score: Number(item.impact_score ?? 0),
    module_graph_gap_count: item.kind === 'module-graph-gap' ? moduleGapCount : 0,
    missing_graph_count: Number(item.missing_graph_count ?? 0),
    missing_target_count: Number(item.missing_target_count ?? 0),
    repair_kind: item.repair_kind || (item.kind === 'module-graph-gap' ? 'module-graph' : 'project-graph'),
    target_fixes: Array.isArray(item.target_fixes) ? item.target_fixes : [],
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

function graphPacketBrick(item) {
  return item.kind === 'module-graph-gap' ? 'graphify-modules' : 'graphify-project';
}

function graphPacketVerifyCommand(item) {
  if (item.kind === 'module-graph-gap') {
    return `npm run graphify:check:modules -- --project ${shellArg(item.project)} --strict --summary-json`;
  }
  return `npm run graphify:check -- --project ${shellArg(item.project)} --strict`;
}

function cleanupPacket(item) {
  const claimPacketCommand = `npm run cleanup:claim -- --rank ${item.rank}`;
  const packetType = item.packet_type || 'dirty-unleased';
  return {
    rank: item.rank,
    packet_type: packetType,
    project: item.project,
    group: item.group,
    brick: item.brick,
    dirty_path_count: Number(item.count || 0),
    parent_dirty_count: Number(item.parent_dirty_count || 0),
    wave_gain_percent: item.wave_gain_percent ?? null,
    project_gain_percent: item.project_gain_percent ?? null,
    sample_paths: normalizeSamplePaths(item.sample_paths),
    claim_packet_command: claimPacketCommand,
    claim_command: item.command,
    claim_intent: item.claim_intent || `claim dirty group ${item.group} (${Number(item.count || 0)} path${Number(item.count || 0) === 1 ? '' : 's'})`,
    inspect_command: item.inspect || `npm run controller:snapshot:quiet -- --project ${shellArg(item.project)}`,
    conflict_command: item.conflict || null,
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

export function renderCleanupPacketMarkdown(report) {
  const lines = [
    '# SMA Gen3 Cleanup Packets',
    '',
    `Generated: ${report.generated_at}`,
    '',
    '## Summary',
    '',
    `- Packets: ${report.summary.packet_count}`,
    `- Dirty paths covered: ${report.summary.dirty_paths_covered}`,
    `- Dirty-unleased packets: ${report.summary.dirty_unleased_packet_count ?? report.summary.packet_count}`,
    `- Active-scope packets: ${report.summary.active_scope_packet_count ?? 0}`,
    `- Active-scope paths covered: ${report.summary.active_scope_paths_covered ?? 0}`,
    `- Default wave: ${report.summary.default_wave_agent_count ?? report.summary.dirty_unleased_packet_count ?? report.summary.packet_count} agents, ${report.summary.default_wave_dirty_paths ?? report.summary.dirty_paths_covered} dirty paths`,
    `- Default wave top gain: ${formatNullablePercent(report.summary.default_wave_top_gain_percent)} of wave, ${formatNullablePercent(report.summary.default_wave_top_project_gain_percent)} of project dirty`,
    `- Active lease fingerprint: ${formatLeaseFingerprint(report.lease_fingerprint)}`,
    `- Total candidates: ${report.summary.total_candidate_count}`,
    `- Overflow: ${report.summary.overflow_count}`,
    `- Selection rule: ${report.summary.selection_rule || 'n/a'}`,
    '',
    '## Packets',
    '',
  ];

  if (!report.packets.length) {
    lines.push('- No cleanup packets available.');
  } else {
    for (const packet of report.packets) {
      lines.push(`- [ ] ${packet.rank}. ${packet.project} ${packet.group} (${packet.dirty_path_count} paths, ${packet.packet_type || 'dirty-unleased'})`);
      if (packet.wave_gain_percent !== null && packet.wave_gain_percent !== undefined) {
        const projectGain = packet.project_gain_percent === null || packet.project_gain_percent === undefined
          ? ''
          : `, ${packet.project_gain_percent}% of project dirty`;
        lines.push(`  - gain: ${packet.wave_gain_percent}% of wave${projectGain}`);
      }
      lines.push(`  - claim: \`${packet.claim_packet_command}\``);
      lines.push(`  - fallback claim: \`${packet.claim_command}\``);
      lines.push(`  - inspect: \`${packet.inspect_command}\``);
      if (packet.conflict_command) lines.push(`  - conflict: \`${packet.conflict_command}\``);
      if (packet.sample_paths?.length) lines.push(`  - sample paths: ${packet.sample_paths.map((file) => `\`${file}\``).join(', ')}`);
      lines.push(`  - finish: ${packet.finish_rule}`);
    }
  }

  lines.push('', '## Commands', '');
  for (const [name, command] of Object.entries(report.next_commands)) {
    lines.push(`- ${name}: \`${command}\``);
  }

  return `${lines.join('\n')}\n`;
}

export function renderGraphPacketMarkdown(report) {
  const lines = [
    '# SMA Gen3 Graph Packets',
    '',
    `Generated: ${report.generated_at}`,
    '',
    '## Summary',
    '',
    `- Packets: ${report.summary.packet_count}`,
    `- Project graph gaps: ${report.summary.project_graph_gaps}`,
    `- Module graph gap projects: ${report.summary.module_graph_gap_projects}`,
    `- Module graph gaps: ${report.summary.module_graph_gap_count}`,
    `- Total impact: ${report.summary.total_impact}`,
    `- Active lease fingerprint: ${formatLeaseFingerprint(report.lease_fingerprint)}`,
    `- Repair timeout seconds: ${report.summary.repair_timeout_seconds}`,
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
        ? `${packet.module_graph_gap_count} module gap${packet.module_graph_gap_count === 1 ? '' : 's'}`
        : 'missing project graph';
      lines.push(`- [ ] ${packet.rank}. ${packet.project} ${packet.kind} (${impact})`);
      lines.push(`  - claim: \`${packet.claim_packet_command}\``);
      lines.push(`  - fallback claim: \`${packet.claim_command}\``);
      lines.push(`  - repair: \`${packet.repair_command}\``);
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

export function renderActionReportMarkdown(report) {
  const lines = [
    '# SMA Gen3 Controller Actions',
    '',
    `Generated: ${report.generated_at}`,
    '',
    '## Summary',
    '',
    `- Projects observed: ${report.summary.projects}`,
    `- Active leases: ${report.summary.active_leases}`,
    `- Open conflicts: ${report.summary.open_conflicts}`,
    `- Dirty-unleased projects: ${report.summary.dirty_unleased_projects}`,
    `- Active dirty-scope projects: ${report.summary.active_dirty_scope_projects ?? 0}`,
    `- Active dirty-scope paths: ${report.summary.active_dirty_scope_paths ?? 0}`,
    `- Stale agent process projects: ${report.summary.stale_agent_process_projects ?? 0}`,
    `- Stale agent processes: ${report.summary.stale_agent_processes ?? 0}`,
    `- Agent process scan error projects: ${report.summary.agent_process_scan_error_projects ?? 0}`,
    `- Graph gaps: ${report.summary.graph_gaps}`,
    `- Module graph gaps: ${report.summary.module_graph_gaps ?? 0}`,
    `- Action items: ${report.summary.controller_actions}`,
    `- Active lease fingerprint: ${formatLeaseFingerprint(report.lease_fingerprint)}`,
    `- Parallel cleanup wave: ${report.parallel_wave?.recommended_agent_count ?? 0} agents, ${report.parallel_wave?.total_impact ?? 0} dirty paths covered`,
    '',
    '## Parallel Cleanup Wave',
    '',
  ];

  if (!report.parallel_wave?.commands?.length) {
    lines.push('- No safe dirty-cleanup wave available.');
  } else {
    lines.push(`Recommended agents: ${report.parallel_wave.recommended_agent_count}/${report.parallel_wave.limit}`);
    lines.push(`Covered dirty paths: ${report.parallel_wave.total_impact}`);
    lines.push(`Selection rule: ${report.parallel_wave.selection_rule}`);
    lines.push('');
    for (const item of report.parallel_wave.commands) {
      const projectGain = item.project_gain_percent === null || item.project_gain_percent === undefined
        ? ''
        : `, ${item.project_gain_percent}% of project dirty`;
      lines.push(`- [ ] ${item.rank}. ${item.project} ${item.group} (${item.count}; ${item.wave_gain_percent}% of wave${projectGain}): \`${item.command}\``);
      if (item.inspect) lines.push(`  - inspect: \`${item.inspect}\``);
      if (item.conflict) lines.push(`  - conflict: \`${item.conflict}\``);
    }
  }

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
      if (item.parallel_claims?.length > 1) {
        lines.push('  - parallel_claims:');
        for (const claim of item.parallel_claims) {
          lines.push(`    - ${claim.group} (${claim.count}): \`${claim.command}\``);
        }
      }
    }
  }

  lines.push('', '## Commands', '');
  for (const [name, command] of Object.entries(report.next_commands)) {
    lines.push(`- ${name}: \`${command}\``);
  }
  return `${lines.join('\n')}\n`;
}

function formatLeaseFingerprint(fingerprint) {
  if (!fingerprint?.hash) return 'n/a';
  return `${String(fingerprint.hash).slice(0, 12)} (${fingerprint.lease_count ?? 0} active leases)`;
}

function projectLeaseFingerprints(projects, leases) {
  const out = {};
  for (const project of projects || []) {
    if (!project?.id) continue;
    out[project.id] = packetLeaseFingerprint(leases, { project: project.id });
  }
  return out;
}

function normalizeSamplePaths(paths, limit = DIRTY_GROUP_SAMPLE_LIMIT) {
  const out = [];
  for (const value of Array.isArray(paths) ? paths : []) {
    const file = String(value || '').trim();
    if (!file || out.includes(file)) continue;
    out.push(file);
    if (out.length >= limit) break;
  }
  return out;
}

function formatNullablePercent(value) {
  if (value === null || value === undefined || value === '') return 'n/a';
  return String(value) + '%';
}

function shellArg(value) {
  return "'" + String(value ?? '').replace(/'/g, "'\\''") + "'";
}
