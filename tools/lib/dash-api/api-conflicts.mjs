import fs from "node:fs/promises";
import path from "node:path";
import { DASH_API_MAX_ROWS, DashboardApiError, runReadHandler, validateQuery } from "./core.mjs";

export const CONFLICTS_SCOPE = "dashboard:conflicts:read";
export const CONFLICTS_CONTRACT = Object.freeze({ method: "GET", path: "/api/conflicts", idempotent: true, retry: "safe with exponential backoff after 502/504", timeout_ms: 500, max_rows: DASH_API_MAX_ROWS });

/** @typedef {{ kind?: string, actor_id?: string, decision_rationale?: string, brick_id?: string, event_id?: string, timestamp?: string, project?: string, intent?: string, _source_brick?: string }} ConflictEvent */
/** @typedef {{ limit: number, days: number, status: "all" | "open" | "resolved", project?: string }} ConflictQuery */
/** @typedef {{ event_id: string, timestamp: string, project: string, brick_id: string, agents: string[], intent: string, status: "open" | "resolved" }} Conflict */
/** @typedef {{ root: string, principal: { subject: string, scopes: string[] }, query: URLSearchParams, requestId?: string, telemetry?: (event: Record<string, unknown>) => void, timeoutMs?: number, load?: (input: ConflictQuery) => Promise<unknown> }} ConflictsHandlerOptions */

/** @param {URLSearchParams} query */
export function validateConflictsQuery(query) {
  const validated = validateQuery(query, {
    limit: { type: "integer", min: 1, max: DASH_API_MAX_ROWS, default: 200 },
    days: { type: "integer", min: 1, max: 365, default: 30 },
    status: { type: "enum", values: ["all", "open", "resolved"], default: "all" },
    project: { type: "string", minLength: 1, maxLength: 120, default: undefined }
  });
  const status = validated.status;
  if (typeof validated.limit !== "number" || typeof validated.days !== "number") throw new DashboardApiError("DASH_API_VALIDATION");
  /** @type {"all" | "open" | "resolved"} */
  let typedStatus;
  if (status === "all") typedStatus = "all";
  else if (status === "open") typedStatus = "open";
  else if (status === "resolved") typedStatus = "resolved";
  else throw new DashboardApiError("DASH_API_VALIDATION");
  const project = validated.project;
  if (project !== undefined && typeof project !== "string") throw new DashboardApiError("DASH_API_VALIDATION");
  return { limit: validated.limit, days: validated.days, status: typedStatus, project };
}

/** @param {ConflictEvent} event */
function conflictAgents(event) {
  const values = new Set();
  if (event.actor_id) values.add(String(event.actor_id));
  for (const key of ["blocked_agent", "holder_agent"]) {
    const match = String(event.decision_rationale || "").match(new RegExp(`(?:^|\\|\\s*)${key}=([^|]+)`));
    if (match?.[1]?.trim()) values.add(match[1].trim());
  }
  return [...values];
}

/** @param {string} directory @returns {Promise<ConflictEvent[]>} */
async function readConflictEvents(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw new DashboardApiError("DASH_API_STORAGE", { cause: error });
  }
  const files = entries.filter((/** @type {import("node:fs").Dirent} */ entry) => entry.isFile() && entry.name.endsWith(".ndjson")).sort((/** @type {import("node:fs").Dirent} */ a, /** @type {import("node:fs").Dirent} */ b) => a.name.localeCompare(b.name));
  if (files.length > 500) throw new DashboardApiError("DASH_API_STORAGE");
  /** @type {ConflictEvent[]} */
  const events = [];
  let totalBytes = 0;
  for (const entry of files) {
    const filePath = path.join(directory, entry.name);
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 2 * 1024 * 1024) throw new DashboardApiError("DASH_API_STORAGE");
      totalBytes += stat.size;
      if (totalBytes > 32 * 1024 * 1024) throw new DashboardApiError("DASH_API_STORAGE");
      const content = await fs.readFile(filePath, "utf8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        /** @type {unknown} */
        const parsed = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null || !("kind" in parsed)) continue;
        const event = /** @type {ConflictEvent} */ (parsed);
        if (event.kind === "conflict_detected" || event.kind === "conflict_resolved") events.push({ ...event, _source_brick: entry.name.replace(/\.ndjson$/, "") });
      }
    } catch (error) {
      if (error instanceof DashboardApiError) throw error;
      throw new DashboardApiError("DASH_API_STORAGE", { cause: error });
    }
  }
  return events.sort((left, right) => Date.parse(left.timestamp || "") - Date.parse(right.timestamp || ""));
}

/** @param {string} smaRoot @param {ConflictQuery} input */
export async function loadConflicts(smaRoot, input) {
  const events = await readConflictEvents(path.join(smaRoot, ".smarch", "agent-context"));
  /** @type {Map<string, Conflict[]>} */
  const openByBrick = new Map();
  /** @type {Conflict[]} */
  const conflicts = [];
  for (const event of events) {
    const brick = String(event.brick_id || event._source_brick);
    if (event.kind === "conflict_detected") {
      /** @type {Conflict} */
      const conflict = { event_id: event.event_id || `${brick}-${event.timestamp}`, timestamp: event.timestamp || new Date(0).toISOString(), project: event.project || "sma", brick_id: brick, agents: conflictAgents(event), intent: event.intent || "", status: "open" };
      conflicts.push(conflict);
      const queue = openByBrick.get(brick) || [];
      queue.push(conflict);
      openByBrick.set(brick, queue);
    } else {
      const resolved = (openByBrick.get(brick) || []).shift();
      if (resolved) resolved.status = "resolved";
    }
  }
  const cutoff = Date.now() - input.days * 24 * 60 * 60 * 1_000;
  const matching = conflicts
    .filter((conflict) => Date.parse(conflict.timestamp) >= cutoff)
    .filter((conflict) => input.status === "all" || conflict.status === input.status)
    .filter((conflict) => !input.project || conflict.project === input.project)
    .sort((left, right) => left.status === right.status ? Date.parse(right.timestamp) - Date.parse(left.timestamp) : left.status === "open" ? -1 : 1);
  return { generated_at: new Date().toISOString(), conflicts: matching.slice(0, input.limit), stats: { open: matching.filter((conflict) => conflict.status === "open").length, matching: matching.length, returned: Math.min(matching.length, input.limit), truncated: matching.length > input.limit } };
}

/** @param {ConflictsHandlerOptions} options */
export function handleConflicts(options) {
  return runReadHandler({ ...options, area: "dashboard.api.conflicts", scope: CONFLICTS_SCOPE, validate: validateConflictsQuery, load: options.load ?? ((/** @type {ConflictQuery} */ input) => loadConflicts(options.root, input)) });
}
