/**
 * gen3-state.mjs — collectors for the Gen-3 multi-agent surfaces.
 *
 * Reads:
 *   - registry/active-leases.generated.json  (local runtime cache for active leases)
 *   - <project>/.smarch/agent-context/*.ndjson  (per-brick context coverage)
 *   - <project>/.smarch/merge-proposals/*.json  (open/resolved divergence)
 *
 * Used by sma-state, sma-doctor, sma-ci, and any HTML dashboards. Sync-friendly
 * (no I/O outside readFileSync/readdirSync).
 */

import { SMA_ROOT } from "./sma-paths.mjs";
import {
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';


const LEASES_PATH = resolve(SMA_ROOT, 'registry/active-leases.generated.json');
const VOLATILE_SMA_REGEN_KINDS = new Set(['registry-regen', 'state-regen', 'wiki-regen']);

export function isVolatileSmaRegenLease(lease) {
  return lease?.project === 'sma' && VOLATILE_SMA_REGEN_KINDS.has(lease.resource_kind);
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
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(LEASES_PATH, 'utf8'));
  } catch {
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
export function readProjectContextCoverage(projectRoot) {
  const dir = resolve(projectRoot, '.smarch/agent-context');
  if (!existsSync(dir)) {
    return {
      bricks_with_context: 0,
      total_events: 0,
      last_event_at: null,
      bricks: [],
    };
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.ndjson'));
  let totalEvents = 0;
  let lastEventAt = null;
  let totalConflictDetected = 0;
  let totalConflictResolved = 0;
  let totalOpenConflicts = 0;
  const bricks = [];
  for (const f of files) {
    const path = resolve(dir, f);
    let raw;
    try { raw = readFileSync(path, 'utf8'); } catch { continue; }
    const lines = raw.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    let brickLastTs = null;
    let lastIntent = null;
    let lastKind = null;
    let conflictDetected = 0;
    let conflictResolved = 0;
    let openConflicts = 0;
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
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
      } catch { /* ignore malformed line */ }
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
export function readProjectMergeProposals(projectRoot) {
  const dir = resolve(projectRoot, '.smarch/merge-proposals');
  if (!existsSync(dir)) {
    return { open_count: 0, resolved_count: 0, proposals: [] };
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const proposals = [];
  for (const f of files) {
    try {
      const p = JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
      proposals.push({
        proposal_id: p.proposal_id,
        brick_id: p.brick_id,
        generated_at: p.generated_at,
        resolved_at: p.resolved_at ?? null,
        resolution_kind: p.resolution_kind ?? null,
        recommendation: p.recommendation?.preferred_chain ?? null,
        chain_count: Array.isArray(p.chains) ? p.chains.length : 0,
      });
    } catch { /* skip malformed */ }
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
export function collectGlobalGen3({ projects = [] } = {}) {
  const leases = readActiveLeases({
    excludeCurrentWrapperLease: true,
    excludeVolatileSmaRegenLeases: true,
  });
  const byProject = {};
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
export function collectProjectGen3({ projectId, projectRoot }) {
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

function bucket(arr, key) {
  return arr.reduce((m, e) => ((m[e[key]] = (m[e[key]] ?? 0) + 1), m), {});
}
