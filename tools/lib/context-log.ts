/**
 * WHAT: Reads and appends per-brick agent context events in the repository's newline-delimited log format.
 * WHY: Leases, edits, verification, and handoffs need durable attribution that survives individual agent sessions.
 * HOW: Coordination tools pass project, brick, actor, session, and event facts; helpers validate and append one record.
 * Readers receive parsed events or discover which bricks already have context without rewriting prior history.
 * Logs live below each project's .smarch/agent-context directory and follow the declared event schema.
 * Format and command terms are defined in docs/GLOSSARY.md.
 * @example node --input-type=module -e "import { logPath } from './tools/lib/context-log.ts'; console.log(logPath('sma', 'demo-brick'))"
 */
/**
 * context-log.ts — shared helpers for the per-brick agent-context NDJSON log.
 *
 * Used by tools/sma-context.ts (CLI) and tools/sma-lease.ts (auto-stamping).
 * Schema: schemas/agent-context-event.schema.json.
 *
 * Path: <project_root>/.smarch/agent-context/<safe-brick-id>.ndjson
 *
 * Append-only. We never rewrite the file. Cheap, durable, diff-friendly.
 */

import {
  readFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { env } from 'node:process';
import { PROJECT_PATH_OVERRIDES, resolveProjectRoot } from './project-paths.ts';

export { PROJECT_PATH_OVERRIDES };

export { PROJECTS_ROOT,   } from './sma-paths.ts';
import { PROJECTS_ROOT, DEV_ROOT, SMA_ROOT } from './sma-paths.ts';
const SCHEMA_VERSION = '1.0.0';

// Project ids that intentionally live outside PROJECTS_ROOT. The SMA control
// plane governs other projects, but it must still be able to log its own
// Gen3 leases, conflicts, and edit context.
export const PROJECT_ABSOLUTE_OVERRIDES: Record<string, string> = {
  sma: SMA_ROOT,
  'dev-sma': SMA_ROOT,
  'sweetspot-modular-architecture': SMA_ROOT,
};

export const KINDS = new Set([
  'lease_acquired',
  'lease_renewed',
  'lease_released',
  'lease_expired',
  'lease_force_acquired',
  'edit_planned',
  'edit_applied',
  'decision_recorded',
  'alternative_rejected',
  'verification_run',
  'proof_recorded',
  'promotion_attempted',
  'promotion_blocked',
  'release_cut',
  'merge_proposed',
  'merge_resolved',
  'conflict_detected',
  'conflict_resolved',
  'note',
]);

export const ACTOR_KINDS = new Set(['human', 'ai_model', 'agent', 'automation', 'tool']);

type ContextEventInput = {
  project: string;
  brick: string;
  kind: string;
  intent: string;
  actorKind?: string;
  actorId?: string | null;
  model?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  leaseId?: string | null;
  decisionRationale?: string | null;
  rejectedAlternatives?: Array<string | { alternative?: string; reason?: string }> | null;
  linkedBacklog?: string[] | null;
  filesTouched?: string[] | null;
  commit?: string | null;
  verification?: { status?: string; [key: string]: unknown } | null;
};

type ContextEvent = Record<string, unknown>;
export const VERIFY_STATUSES = new Set(['pass', 'fail', 'skipped', 'blocked']);

/**
 * @typedef {object} ContextEventInput
 * @property {string} project
 * @property {string} brick
 * @property {string} kind
 * @property {string} intent
 * @property {string} [actorKind]
 * @property {string} [actorId]
 * @property {string} [model]
 * @property {string} [sessionId]
 * @property {string} [taskId]
 * @property {string} [leaseId]
 * @property {string} [decisionRationale]
 * @property {Array<string | {alternative?: string, reason?: string}>} [rejectedAlternatives]
 * @property {unknown[]} [linkedBacklog]
 * @property {string[]} [filesTouched]
 * @property {string} [commit]
 * @property {{status?: string, [key: string]: unknown}} [verification]
 */

const SESSION_ENV_KEYS = [
  'SMA_SESSION',
  'SMA_SESSION_ID',
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'WARP_TERMINAL_SESSION_UUID',
  'XDG_SESSION_ID',
];

export function projectRoot(projectId: string): string {
  if (!projectId) throw new Error('projectRoot: missing project id');
  const key = String(projectId).toLowerCase();
  const absolute = PROJECT_ABSOLUTE_OVERRIDES[key];
  if (absolute && existsSync(absolute)) return absolute;

  const resolved = resolveProjectRoot(projectId);
  if (resolved) return resolved;
  // Last resort: substring match (kept for backward compat with prior calls)
  for (const ent of readdirSync(PROJECTS_ROOT)) {
    if (ent.toLowerCase().includes(projectId.toLowerCase())) {
      return resolve(PROJECTS_ROOT, ent);
    }
  }
  throw new Error(`project not found: ${projectId}`);
}

export function logPath(projectId: string, brickId: string): string {
  if (!brickId) throw new Error('logPath: missing brick id');
  const safe = String(brickId).replace(/[^a-z0-9._-]/gi, '_');
  return resolve(projectRoot(projectId), '.smarch/agent-context', `${safe}.ndjson`);
}

export function readContextLog(projectId: string, brickId: string): ContextEvent[] {
  const path = logPath(projectId, brickId);
  if (!existsSync(path)) return [];
  const out: ContextEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch (error) {
      console.error(JSON.stringify({ area: 'context-log.parse-line', severity: 'warning', hint: 'Repair the malformed NDJSON context line.', error: error instanceof Error ? error.message : String(error) }));
      out.push({ _malformed: true, _raw: t });
    }
  }
  return out;
}

/**
 * Append an event. Returns the event written (with auto-filled fields).
 * Throws on validation problems. Never rewrites or mutates an existing line.
 * @param {ContextEventInput} input
 */
export function appendContextEvent({
  project,
  brick,
  kind,
  intent,
  actorKind = 'agent',
  actorId,
  model,
  sessionId,
  taskId,
  leaseId,
  decisionRationale,
  rejectedAlternatives,
  linkedBacklog,
  filesTouched,
  commit,
  verification,
}: ContextEventInput): ContextEvent {
  if (!project) throw new Error('appendContextEvent: missing project');
  if (!brick) throw new Error('appendContextEvent: missing brick');
  if (!kind) throw new Error('appendContextEvent: missing kind');
  if (!intent || String(intent).length < 4) throw new Error('appendContextEvent: intent must be at least 4 chars');
  if (!KINDS.has(kind)) throw new Error(`bad kind: ${kind}`);
  if (!ACTOR_KINDS.has(actorKind)) throw new Error(`bad actorKind: ${actorKind}`);
  if (verification?.status && !VERIFY_STATUSES.has(verification.status)) {
    throw new Error(`bad verification.status: ${verification.status}`);
  }

  const resolvedSessionId = resolveSessionId(sessionId);
  const resolvedActorId = resolveActorId(actorId, resolvedSessionId);

  const event: ContextEvent = {
    schema_version: SCHEMA_VERSION,
    event_id: newEventId(),
    brick_id: brick,
    project,
    actor_kind: actorKind,
    actor_id: resolvedActorId,
    kind,
    intent: String(intent),
    timestamp: nowIso(),
  };
  if (model) event.model = model;
  if (resolvedSessionId) event.session_id = resolvedSessionId;
  if (taskId) event.task_id = taskId;
  if (leaseId) event.lease_id = leaseId;
  if (decisionRationale) event.decision_rationale = decisionRationale;
  if (Array.isArray(rejectedAlternatives) && rejectedAlternatives.length) {
    event.rejected_alternatives = rejectedAlternatives.map((r) => {
      if (typeof r === 'string') {
        const idx = r.indexOf('::');
        if (idx < 0) return { alternative: r, reason: '' };
        return { alternative: r.slice(0, idx).trim(), reason: r.slice(idx + 2).trim() };
      }
      return { alternative: r.alternative ?? '', reason: r.reason ?? '' };
    });
  }
  if (Array.isArray(linkedBacklog) && linkedBacklog.length) event.linked_backlog = linkedBacklog;
  if (Array.isArray(filesTouched) && filesTouched.length) event.files_touched = filesTouched;
  if (commit) event.commit = commit;
  if (verification?.status) event.verification = verification;

  const path = logPath(project, brick);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + '\n');
  return event;
}

function newEventId(): string {
  return `ctx-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

export function resolveSessionId(explicit?: unknown): string | null {
  const direct = cleanIdentity(explicit);
  if (direct) return direct;
  for (const key of SESSION_ENV_KEYS) {
    const value = cleanIdentity(env[key]);
    if (value) return normalizeSessionValue(key, value);
  }
  const focusSession = cleanIdentity(env.WARP_FOCUS_URL)?.match(/\/session\/([^/?#]+)/)?.[1];
  return focusSession ? `warp-${focusSession}` : null;
}

export function resolveActorId(explicit?: unknown, sessionId: string | null = resolveSessionId()): string {
  const direct = cleanIdentity(explicit);
  if (direct) return direct;
  const configured = cleanIdentity(env.SMA_AGENT ?? env.CODEX_AGENT_ID ?? env.CLAUDE_AGENT_ID);
  if (configured) return configured;
  const user = cleanIdentity(env.USER) ?? 'unknown';
  const suffix = shortIdentity(sessionId);
  return suffix ? `${user}@${suffix}` : user;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function listBricksWithContext(projectId: string): string[] {
  const dir = resolve(projectRoot(projectId), '.smarch/agent-context');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ndjson'))
    .map((f) => f.replace(/\.ndjson$/, ''));
}

function normalizeSessionValue(key: string, value: string): string {
  if (key === 'WARP_TERMINAL_SESSION_UUID') return `warp-${value}`;
  if (key === 'XDG_SESSION_ID') return `xdg-${value}`;
  return value;
}

function shortIdentity(value: unknown): string {
  const text = cleanIdentity(value);
  if (!text) return '';
  const shortened = text.includes('-') ? text.split('-')[0] : text;
  return shortened.slice(0, 12);
}

function cleanIdentity(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text ? text : null;
}
