/**
 * WHAT: Builds and writes the small first-read packet for each module-work assignment.
 * WHY: An assigned agent should not need a full dispatch or dashboard just to begin safely.
 * HOW: Converts a dispatch manifest and assignment into structured data plus rendered Markdown files.
 * INPUTS: A dispatch manifest, its assignments, and the repository root used for relative paths.
 * OUTPUTS: Packet descriptors, packet payloads, and paired structured-data and Markdown files.
 * CALLERS: The module-work dispatch command uses these helpers while persisting a wave.
 * @example node --input-type=module -e "import { agentPacketDescriptor } from './tools/lib/module-work-agent-packets.ts'; console.log(agentPacketDescriptor({ dispatchBase: '/tmp/demo', slot: { agent_slot: 1, module_id: 'reg' }, smaRoot: '/tmp' }));"
 */
/** Low-token per-slot packets for Gen3 module dispatch assignments. */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderAgentPacketMarkdown } from './module-work-renderers.ts';

type AgentPacketDescriptor = { json_path: string; markdown_path: string; first_read: true };
type ModuleAssignment = {
  project: string; task: string; agent_slot: number; module_id: string; slot: number;
  partition_id?: string | null; partition_label?: string | null; brick: string;
  graph_query_command?: string; claim_command?: string; paths?: string[]; exclude_paths?: string[];
  shared_hot_paths?: string[]; iteration_gates?: string[]; required_gates?: string[];
  prompt?: string; agent_packet?: Partial<AgentPacketDescriptor>;
};
type ModuleManifest = {
  created_at: string; dispatch_id: string; assignments?: ModuleAssignment[];
  gains?: Record<string, number | undefined>;
  controller_commands?: Record<string, string | undefined>;
  dispatch_paths?: { json_path?: string; markdown_path?: string };
};

export function agentPacketDescriptor({ dispatchBase, slot, smaRoot }: { dispatchBase: string; slot: Pick<ModuleAssignment, 'agent_slot' | 'module_id'>; smaRoot: string }): AgentPacketDescriptor {
  const slotLabel = String(positiveInt(slot.agent_slot, 1)).padStart(2, '0');
  const moduleLabel = safeId(slot.module_id || 'module').toLowerCase();
  const base = resolve(`${dispatchBase}.agent-packets`, `${slotLabel}-${moduleLabel}`);
  return {
    json_path: relativeToRoot(base, smaRoot, '.json'),
    markdown_path: relativeToRoot(base, smaRoot, '.md'),
    first_read: true,
  };
}

export function writeAgentPackets(manifest: ModuleManifest, { smaRoot }: { smaRoot: string }): void {
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

export function agentPacketPayload(manifest: ModuleManifest, assignment: ModuleAssignment) {
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
      graph_query: assignment.graph_query_command || '',
      claim: assignment.claim_command || '',
      observe: manifest.controller_commands?.observe || '',
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

function relativeToRoot(base: string, root: string, extension: string): string {
  const filePath = `${base}${extension}`;
  return filePath.startsWith(`${root}/`) ? filePath.slice(root.length + 1) : filePath;
}

function safeId(value: unknown): string {
  return String(value || 'module').replace(/[^a-z0-9._-]/gi, '-').replace(/-+/g, '-');
}

function positiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
