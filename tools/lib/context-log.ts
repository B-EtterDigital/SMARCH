/* Context-log diagnostics intentionally retain JavaScript's existing coercion for opaque event values. */
/* Event normalization is a flat defensive boundary checklist; complexity counts each independent fallback and guard. */
/* eslint @typescript-eslint/no-base-to-string: "off", complexity: "off" */
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
 * Normal event writes are append-only. The legacy normalizer uses the shared
 * per-log lock plus generation-checked atomic replacement.
 */

import {
  readFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { env } from 'node:process';
import { PROJECT_PATH_OVERRIDES, resolveProjectRoot } from './project-paths.ts';

export { PROJECT_PATH_OVERRIDES };

export { PROJECTS_ROOT,   } from './sma-paths.ts';
import { PROJECTS_ROOT, SMA_ROOT } from './sma-paths.ts';
const SCHEMA_VERSION = '1.0.0';
const CONTEXT_LOCK_WAIT_MS = 5000;
const CONTEXT_LOCK_STALE_MS = 30000;

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

interface ContextEventInput {
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
  rejectedAlternatives?: (string | { alternative?: string; reason?: string })[] | null;
  linkedBacklog?: string[] | null;
  filesTouched?: string[] | null;
  commit?: string | null;
  verification?: { status?: string; [key: string]: unknown } | null;
  lockHeld?: boolean;
}

type ContextEvent = Record<string, unknown>;
export const VERIFY_STATUSES = new Set(['pass', 'fail', 'skipped', 'blocked']);

function validateContextEventInput(input: Pick<ContextEventInput, 'project' | 'brick' | 'kind' | 'intent' | 'actorKind' | 'verification'>): void {
  if (!input.project) throw new Error('appendContextEvent: missing project');
  if (!input.brick) throw new Error('appendContextEvent: missing brick');
  if (!input.kind) throw new Error('appendContextEvent: missing kind');
  if (!input.intent || input.intent.length < 4) throw new Error('appendContextEvent: intent must be at least 4 chars');
  if (!KINDS.has(input.kind)) throw new Error(`bad kind: ${input.kind}`);
  if (!ACTOR_KINDS.has(input.actorKind ?? 'agent')) throw new Error(`bad actorKind: ${String(input.actorKind)}`);
  if (input.verification?.status && !VERIFY_STATUSES.has(input.verification.status)) {
    throw new Error(`bad verification.status: ${input.verification.status}`);
  }
}

function normalizedAlternatives(values: ContextEventInput['rejectedAlternatives']): { alternative: string; reason: string }[] {
  return (values ?? []).map((value) => {
    if (typeof value !== 'string') return { alternative: value.alternative ?? '', reason: value.reason ?? '' };
    const separator = value.indexOf('::');
    return separator < 0
      ? { alternative: value, reason: '' }
      : { alternative: value.slice(0, separator).trim(), reason: value.slice(separator + 2).trim() };
  });
}

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
  const key = projectId.toLowerCase();
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
  const safe = brickId.replace(/[^a-z0-9._-]/gi, '_');
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
      const parsed: unknown = JSON.parse(t);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('context event must be a JSON object');
      }
      out.push(parsed as ContextEvent);
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
  lockHeld = false,
}: ContextEventInput): ContextEvent {
  validateContextEventInput({ project, brick, kind, intent, actorKind, verification });

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
    intent: intent,
    timestamp: nowIso(),
  };
  if (model) event.model = model;
  if (resolvedSessionId) event.session_id = resolvedSessionId;
  if (taskId) event.task_id = taskId;
  if (leaseId) event.lease_id = leaseId;
  if (decisionRationale) event.decision_rationale = decisionRationale;
  if (Array.isArray(rejectedAlternatives) && rejectedAlternatives.length) {
    event.rejected_alternatives = normalizedAlternatives(rejectedAlternatives);
  }
  if (Array.isArray(linkedBacklog) && linkedBacklog.length) event.linked_backlog = linkedBacklog;
  if (Array.isArray(filesTouched) && filesTouched.length) event.files_touched = filesTouched;
  if (commit) event.commit = commit;
  if (verification?.status) event.verification = verification;

  const path = logPath(project, brick);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const append = (): void => { appendFileSync(path, JSON.stringify(event) + '\n'); };
  if (lockHeld) append();
  else withContextLogLock(path, append);
  return event;
}

export function withContextLogLock<T>(path: string, fn: () => T): T {
  const lockPath = `${path}.lock`;
  const ownerPath = resolve(lockPath, 'owner.json');
  const token = `${String(process.pid)}-${String(Date.now())}-${randomBytes(8).toString('hex')}`;
  const startedAt = Date.now();
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  for (;;) {
    try {
      mkdirSync(lockPath);
      try { writeFileSync(ownerPath, JSON.stringify({ token, pid: process.pid }) + '\n'); }
      catch (error) { rmSync(lockPath, { recursive: true, force: true }); throw error; }
      break;
    } catch (error) {
      if (fsErrorCode(error) !== 'EEXIST') throw error;
      if (recoverStaleContextLock(lockPath)) continue;
      if (Date.now() - startedAt >= CONTEXT_LOCK_WAIT_MS) throw new Error(`timed out waiting for context log lock ${lockPath}`);
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    try {
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8')) as { token?: string };
      if (owner.token === token) rmSync(lockPath, { recursive: true, force: true });
    } catch (error) {
      if (fsErrorCode(error) !== 'ENOENT') throw error;
    }
  }
}

export function replaceContextLogIfUnchanged(path: string, expectedSource: string, contents: string): void {
  if (readFileSync(path, 'utf8') !== expectedSource) throw new Error(`context log changed during normalization: ${path}`);
  const temporary = `${path}.tmp.${String(process.pid)}.${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(temporary, contents, 'utf8');
    if (readFileSync(path, 'utf8') !== expectedSource) throw new Error(`context log changed during normalization: ${path}`);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function recoverStaleContextLock(lockPath: string): boolean {
  let ageMs: number;
  try { ageMs = Date.now() - statSync(lockPath).mtimeMs; } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return true;
    throw error;
  }
  if (ageMs <= CONTEXT_LOCK_STALE_MS) return false;
  let pid = 0;
  try { pid = (JSON.parse(readFileSync(resolve(lockPath, 'owner.json'), 'utf8')) as { pid?: number }).pid ?? 0; } catch { /* malformed stale owner */ }
  if (pid > 0) {
    try { process.kill(pid, 0); return false; } catch (error) { if (fsErrorCode(error) === 'EPERM') return false; }
  }
  const stalePath = `${lockPath}.stale.${String(process.pid)}.${randomBytes(4).toString('hex')}`;
  try { renameSync(lockPath, stalePath); } catch (error) {
    if (fsErrorCode(error) === 'ENOENT') return true;
    return false;
  }
  rmSync(stalePath, { recursive: true, force: true });
  return true;
}

function fsErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function newEventId(): string {
  return `ctx-${String(Date.now())}-${randomBytes(4).toString('hex')}`;
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
