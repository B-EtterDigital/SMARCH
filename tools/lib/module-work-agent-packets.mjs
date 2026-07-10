/** Low-token per-slot packets for Gen3 module dispatch assignments. */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderAgentPacketMarkdown } from './module-work-renderers.mjs';

export function agentPacketDescriptor({ dispatchBase, slot, smaRoot }) {
  const slotLabel = String(positiveInt(slot.agent_slot, 1)).padStart(2, '0');
  const moduleLabel = safeId(slot.module_id || 'module').toLowerCase();
  const base = resolve(`${dispatchBase}.agent-packets`, `${slotLabel}-${moduleLabel}`);
  return {
    json_path: relativeToRoot(base, smaRoot, '.json'),
    markdown_path: relativeToRoot(base, smaRoot, '.md'),
    first_read: true,
  };
}

export function writeAgentPackets(manifest, { smaRoot }) {
  for (const assignment of manifest.assignments || []) {
    if (!assignment.agent_packet?.json_path || !assignment.agent_packet?.markdown_path) continue;
    const jsonPath = resolve(smaRoot, assignment.agent_packet.json_path);
    const markdownPath = resolve(smaRoot, assignment.agent_packet.markdown_path);
    const packet = agentPacketPayload(manifest, assignment);
    mkdirSync(dirname(jsonPath), { recursive: true });
    writeFileSync(jsonPath, `${JSON.stringify(packet, null, 2)}\n`);
    writeFileSync(markdownPath, renderAgentPacketMarkdown(packet));
  }
}

export function agentPacketPayload(manifest, assignment) {
  return {
    schema_version: '1.0.0',
    kind: 'sma-gen3-module-agent-packet',
    created_at: manifest.created_at,
    dispatch_id: manifest.dispatch_id,
    project: assignment.project,
    task: assignment.task,
    agent_slot: assignment.agent_slot,
    module_id: assignment.module_id,
    slot: assignment.slot,
    partition_id: assignment.partition_id || null,
    partition_label: assignment.partition_label || null,
    brick: assignment.brick,
    first_read: true,
    gains: {
      graph_first_token_reduction_percent_estimate: number(manifest.gains?.module_graph_first_token_reduction_percent_estimate),
      dirty_status_token_reduction_percent_estimate: number(manifest.gains?.dirty_status_token_reduction_percent_estimate),
      collision_reduction_percent_estimate: number(manifest.gains?.collision_reduction_percent_estimate),
    },
    commands: {
      graph_query: assignment.graph_query_command,
      claim: assignment.claim_command,
      observe: manifest.controller_commands?.observe,
      observe_write: manifest.controller_commands?.observe_write,
      conflict_summary: manifest.controller_commands?.conflict_summary,
    },
    scope: {
      paths: assignment.paths || [],
      exclude_paths: assignment.exclude_paths || [],
      shared_hot_paths: assignment.shared_hot_paths || [],
    },
    gates: {
      iteration: assignment.iteration_gates || [],
      required: assignment.required_gates || [],
    },
    links: {
      dispatch_json: manifest.dispatch_paths?.json_path || null,
      dispatch_markdown: manifest.dispatch_paths?.markdown_path || null,
      agent_packet_json: assignment.agent_packet?.json_path || null,
      agent_packet_markdown: assignment.agent_packet?.markdown_path || null,
    },
    rules: [
      'Read this packet before the full dispatch, dashboard, or state file.',
      'Run the module graph query before broad file reads.',
      'Stay inside the listed module or partition paths.',
      'Conflict-report before touching shared hot paths, another module, or uncertain overlap.',
      'Finish with end-edit, dirty cleanup, listed gates, and concise proof.',
    ],
    prompt: assignment.prompt,
  };
}

function relativeToRoot(base, root, extension) {
  const filePath = `${base}${extension}`;
  return filePath.startsWith(`${root}/`) ? filePath.slice(root.length + 1) : filePath;
}

function safeId(value) {
  return String(value || 'module').replace(/[^a-z0-9._-]/gi, '-').replace(/-+/g, '-');
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
