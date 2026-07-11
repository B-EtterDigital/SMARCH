/**
 * WHAT: Collects active leases, context coverage, and merge proposals into shared Gen3 state summaries.
 * WHY: State, doctor, controller, promotion, and dashboard commands need one interpretation of coordination health.
 * HOW: Callers supply project roots or project lists; readers return normalized project and global summary objects.
 * Expired and volatile regeneration leases are filtered so transient maintenance does not distort readiness.
 * The module only reads registry and per-project coordination files and never rewrites them.
 * Gen3 terminology is defined in docs/GLOSSARY.md#gen3.
 * @example node --input-type=module -e "import { isVolatileSmaRegenLease } from './tools/lib/gen3-state.ts'; console.log(isVolatileSmaRegenLease({ project: 'sma', resource_kind: 'state-regen' }))"
 */
/**
 * gen3-state.ts — collectors for the Gen-3 multi-agent surfaces.
 *
 * Reads:
 *   - registry/active-leases.generated.json  (local runtime cache for active leases)
 *   - <project>/.smarch/agent-context/*.ndjson  (per-brick context coverage)
 *   - <project>/.smarch/merge-proposals/*.json  (open/resolved divergence)
 *
 * Used by sma-state, sma-doctor, sma-ci, and any HTML dashboards. Sync-friendly
 * (no I/O outside readFileSync/readdirSync).
 */

import { SMA_ROOT } from "./sma-paths.ts";
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';


const LEASES_PATH = resolve(SMA_ROOT, 'registry/active-leases.generated.json');
const VOLATILE_SMA_REGEN_KINDS = new Set(['registry-regen', 'state-regen', 'wiki-regen']);

type RawLease = {
  lease_id: string; resource_kind: string; resource_id: string; agent_id: string;
  project?: string | null; acquired_at: string; expires_at: string; intent?: string;
};
type LeaseRegistry = { generated_at?: string; leases?: RawLease[] };
type ContextBrick = {
  brick_id: string; event_count: number; last_event_at: string | null; last_intent: string | null;
  last_kind: string | null; conflict_detected: number; conflict_resolved: number; open_conflicts: number;
};
type ContextCoverage = {
  bricks_with_context: number; total_events: number; last_event_at: string | null;
  conflict_detected: number; conflict_resolved: number; open_conflicts: number; bricks: ContextBrick[];
};
type MergeProposal = {
  proposal_id?: string; brick_id?: string; generated_at?: string; resolved_at: string | null;
  resolution_kind: string | null; recommendation: string | null; chain_count: number;
};

export function isVolatileSmaRegenLease(lease: Partial<RawLease> | null | undefined): boolean {
  return lease?.project === 'sma'
    && typeof lease.resource_kind === 'string'
    && VOLATILE_SMA_REGEN_KINDS.has(lease.resource_kind);
}

/**
 * Read the lease registry and return a summary.
 * Honors expires_at (already-expired leases are excluded by default).
 */
export function readActiveLeases({
  includeExpired = false,
  excludeCurrentWrapperLease = false,
  excludeVolatileSmaRegenLeases = false,
  excludeLeaseIds = [],
}: {
  includeExpired?: boolean; excludeCurrentWrapperLease?: boolean;
  excludeVolatileSmaRegenLeases?: boolean; excludeLeaseIds?: string[];
} = {}) {
  if (!existsSync(LEASES_PATH)) {
    return {
      generated_at: null,
      active_count: 0,
      by_resource_kind: {},
      by_agent: {},
      leases: [],
    };
  }
  let parsed: LeaseRegistry;
  try {
    parsed = JSON.parse(readFileSync(LEASES_PATH, 'utf8')) as LeaseRegistry;
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
    if (code !== 'ENOENT') console.error(JSON.stringify({ area: 'gen3-state.active-leases', severity: 'warning', hint: 'Repair the active lease registry or check its permissions.', error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) }));
    return {
      generated_at: null,
      active_count: 0,
      by_resource_kind: {},
      by_agent: {},
      leases: [],
      _error: 'lease registry is corrupt',
    };
  }
  const now = Date.now();
  const all = Array.isArray(parsed.leases) ? parsed.leases : [];
  const excluded = new Set([
    ...excludeLeaseIds,
    ...(excludeCurrentWrapperLease && process.env.SMA_ACTIVE_LEASE_ID ? [process.env.SMA_ACTIVE_LEASE_ID] : []),
  ].filter(Boolean));
  const active = (includeExpired ? all : all.filter((l) => Date.parse(l.expires_at) > now))
    .filter((l) => !excluded.has(l.lease_id))
    .filter((l) => !excludeVolatileSmaRegenLeases || !isVolatileSmaRegenLease(l));
  return {
    generated_at: parsed.generated_at ?? null,
    active_count: active.length,
    by_resource_kind: bucket(active, 'resource_kind'),
    by_agent: bucket(active, 'agent_id'),
    leases: active.map((l) => ({
      lease_id: l.lease_id,
      resource_kind: l.resource_kind,
      resource_id: l.resource_id,
      agent_id: l.agent_id,
      project: l.project ?? null,
      acquired_at: l.acquired_at,
      expires_at: l.expires_at,
      ttl_remaining_seconds: Math.max(0, Math.floor((Date.parse(l.expires_at) - now) / 1000)),
      intent: l.intent,
    })),
  };
}

/**
 * Per-project context coverage. Reads .smarch/agent-context/*.ndjson and counts
 * events. Cheap; we only count lines, not parse every event for the summary.
 */
export function readProjectContextCoverage(projectRoot: string): ContextCoverage {
  const dir = resolve(projectRoot, '.smarch/agent-context');
  if (!existsSync(dir)) {
    return {
      bricks_with_context: 0,
      total_events: 0,
      last_event_at: null,
      conflict_detected: 0,
      conflict_resolved: 0,
      open_conflicts: 0,
      bricks: [],
    };
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.ndjson'));
  let totalEvents = 0;
  let lastEventAt: string | null = null;
  let totalConflictDetected = 0;
  let totalConflictResolved = 0;
  let totalOpenConflicts = 0;
  const bricks: ContextBrick[] = [];
  for (const f of files) {
    const path = resolve(dir, f);
    let raw;
    try { raw = readFileSync(path, 'utf8'); } catch (error) {
      console.error(JSON.stringify({ area: 'gen3-state.context-read', severity: 'warning', hint: 'Check the context log file and its permissions.', error: error instanceof Error ? error.message : String(error) }));
      continue;
    }
    const lines = raw.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    let brickLastTs: string | null = null;
    let lastIntent: string | null = null;
    let lastKind: string | null = null;
    let conflictDetected = 0;
    let conflictResolved = 0;
    let openConflicts = 0;
    for (const line of lines) {
      try {
        const evt = JSON.parse(line) as { timestamp?: string; intent?: string; kind?: string };
        const ts = evt.timestamp ?? null;
        if (ts && (!brickLastTs || ts > brickLastTs)) {
          brickLastTs = ts;
          lastIntent = evt.intent ?? null;
          lastKind = evt.kind ?? null;
        }
        if (evt.kind === 'conflict_detected') {
          conflictDetected += 1;
          openConflicts += 1;
        } else if (evt.kind === 'conflict_resolved') {
          conflictResolved += 1;
          if (openConflicts > 0) openConflicts -= 1;
        }
      } catch (error) {
        console.error(JSON.stringify({ area: 'gen3-state.context-parse', severity: 'warning', hint: 'Repair the malformed context NDJSON line.', error: error instanceof Error ? error.message : String(error) }));
      }
    }
    totalEvents += lines.length;
    totalConflictDetected += conflictDetected;
    totalConflictResolved += conflictResolved;
    totalOpenConflicts += openConflicts;
    if (brickLastTs && (!lastEventAt || brickLastTs > lastEventAt)) lastEventAt = brickLastTs;
    bricks.push({
      brick_id: f.replace(/\.ndjson$/, ''),
      event_count: lines.length,
      last_event_at: brickLastTs,
      last_intent: lastIntent,
      last_kind: lastKind,
      conflict_detected: conflictDetected,
      conflict_resolved: conflictResolved,
      open_conflicts: openConflicts,
    });
  }
  bricks.sort((a, b) => (b.last_event_at ?? '').localeCompare(a.last_event_at ?? ''));
  return {
    bricks_with_context: bricks.length,
    total_events: totalEvents,
    last_event_at: lastEventAt,
    conflict_detected: totalConflictDetected,
    conflict_resolved: totalConflictResolved,
    open_conflicts: totalOpenConflicts,
    bricks,
  };
}

/**
 * Per-project merge proposals — open vs resolved.
 */
export function readProjectMergeProposals(projectRoot: string): { open_count: number; resolved_count: number; proposals: MergeProposal[] } {
  const dir = resolve(projectRoot, '.smarch/merge-proposals');
  if (!existsSync(dir)) {
    return { open_count: 0, resolved_count: 0, proposals: [] };
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const proposals: MergeProposal[] = [];
  for (const f of files) {
    try {
      const p = JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as {
        proposal_id?: string; brick_id?: string; generated_at?: string; resolved_at?: string;
        resolution_kind?: string; recommendation?: { preferred_chain?: string }; chains?: unknown[];
      };
      proposals.push({
        proposal_id: p.proposal_id,
        brick_id: p.brick_id,
        generated_at: p.generated_at,
        resolved_at: p.resolved_at ?? null,
        resolution_kind: p.resolution_kind ?? null,
        recommendation: p.recommendation?.preferred_chain ?? null,
        chain_count: Array.isArray(p.chains) ? p.chains.length : 0,
      });
    } catch (error) {
      console.error(JSON.stringify({ area: 'gen3-state.proposal-parse', severity: 'warning', hint: 'Repair or regenerate the malformed merge proposal.', error: error instanceof Error ? error.message : String(error) }));
    }
  }
  proposals.sort((a, b) => (b.generated_at ?? '').localeCompare(a.generated_at ?? ''));
  return {
    open_count: proposals.filter((p) => !p.resolved_at).length,
    resolved_count: proposals.filter((p) => p.resolved_at).length,
    proposals,
  };
}

/**
 * Build the global gen3 block to embed in the state snapshot.
 * `projects` is an array of `{ id, absoluteRoot }`.
 */
export function collectGlobalGen3({ projects = [] }: { projects?: Array<{ id: string; absoluteRoot: string }> } = {}) {
  const leases = readActiveLeases({
    excludeCurrentWrapperLease: true,
    excludeVolatileSmaRegenLeases: true,
  });
  const byProject: Record<string, {
    bricks_with_context: number; total_context_events: number; last_event_at: string | null;
    conflict_detected: number; conflict_resolved: number; open_conflicts: number;
    open_merge_proposals: number; resolved_merge_proposals: number;
  }> = {};
  let totalBricksWithContext = 0;
  let totalContextEvents = 0;
  let totalOpenProposals = 0;
  let totalResolvedProposals = 0;
  let totalConflictDetected = 0;
  let totalConflictResolved = 0;
  let totalOpenConflicts = 0;
  for (const proj of projects) {
    if (!proj || !proj.absoluteRoot) continue;
    const ctx = readProjectContextCoverage(proj.absoluteRoot);
    const mp = readProjectMergeProposals(proj.absoluteRoot);
    if (!ctx.bricks_with_context && !mp.open_count && !mp.resolved_count) continue;
    byProject[proj.id] = {
      bricks_with_context: ctx.bricks_with_context,
      total_context_events: ctx.total_events,
      last_event_at: ctx.last_event_at,
      conflict_detected: ctx.conflict_detected,
      conflict_resolved: ctx.conflict_resolved,
      open_conflicts: ctx.open_conflicts,
      open_merge_proposals: mp.open_count,
      resolved_merge_proposals: mp.resolved_count,
    };
    totalBricksWithContext += ctx.bricks_with_context;
    totalContextEvents += ctx.total_events;
    totalOpenProposals += mp.open_count;
    totalResolvedProposals += mp.resolved_count;
    totalConflictDetected += ctx.conflict_detected;
    totalConflictResolved += ctx.conflict_resolved;
    totalOpenConflicts += ctx.open_conflicts;
  }
  return {
    leases: {
      active_count: leases.active_count,
      by_resource_kind: leases.by_resource_kind,
      by_agent: leases.by_agent,
      sample: leases.leases.slice(0, 10).map((lease) => ({
        lease_id: lease.lease_id,
        resource_kind: lease.resource_kind,
        resource_id: lease.resource_id,
        agent_id: lease.agent_id,
        project: lease.project,
        acquired_at: lease.acquired_at,
        intent: lease.intent,
      })),
    },
    context_coverage: {
      projects_with_logs: Object.keys(byProject).length,
      total_bricks_with_context: totalBricksWithContext,
      total_context_events: totalContextEvents,
      by_project: byProject,
    },
    conflicts: {
      detected_count: totalConflictDetected,
      resolved_count: totalConflictResolved,
      open_count: totalOpenConflicts,
    },
    merge_proposals: {
      open_count: totalOpenProposals,
      resolved_count: totalResolvedProposals,
    },
  };
}

/**
 * Build the per-project gen3 block (used by sma-doctor --project).
 */
export function collectProjectGen3({ projectId, projectRoot }: { projectId: string; projectRoot: string }) {
  const leases = readActiveLeases({ excludeCurrentWrapperLease: true });
  const projectLeases = leases.leases.filter(
    (l) => l.project === projectId || (l.resource_kind === 'brick' && /* heuristic */ false),
  );
  const ctx = readProjectContextCoverage(projectRoot);
  const mp = readProjectMergeProposals(projectRoot);
  return {
    project: projectId,
    leases: {
      active_count: projectLeases.length,
      leases: projectLeases,
    },
    context_coverage: ctx,
    merge_proposals: mp,
  };
}

function bucket<T extends Record<string, unknown>>(arr: readonly T[], key: keyof T): Record<string, number> {
  return arr.reduce<Record<string, number>>((counts, entry) => {
    const value = String(entry[key] ?? 'unknown');
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}
