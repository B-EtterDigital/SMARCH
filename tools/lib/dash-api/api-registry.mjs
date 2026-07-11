import path from "node:path";
import { DASH_API_MAX_ROWS, readJsonFile, runReadHandler, validateQuery } from "./core.mjs";

const REGISTRY_SCOPE = "dashboard:registry:read";
const REGISTRY_CONTRACT = Object.freeze({ method: "GET", path: "/api/registry", idempotent: true, retry: "safe with exponential backoff after 502/504", timeout_ms: 500, max_rows: DASH_API_MAX_ROWS });

/** @typedef {{ project?: string, status: string, limit: number }} RegistryInput */
/** @typedef {{ id?: unknown, brick_count?: unknown, average_score?: unknown }} RegistryProject */
/** @typedef {{ id?: unknown, project?: unknown, status?: unknown, score?: unknown, health?: { status?: unknown } }} RegistryBrick */
/** @typedef {{ root: string, principal: { subject: string, scopes: string[] }, query: URLSearchParams, requestId?: string, telemetry?: (event: Record<string, unknown>) => void, timeoutMs?: number, load?: (input: RegistryInput) => Promise<unknown> }} RegistryHandlerOptions */

/** @param {unknown} value @returns {number} */
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

/** @param {URLSearchParams} query @returns {RegistryInput} */
export function validateRegistryQuery(query) {
  return /** @type {RegistryInput} */ (validateQuery(query, {
    limit: { type: "integer", min: 1, max: DASH_API_MAX_ROWS, default: DASH_API_MAX_ROWS },
    project: { type: "string", minLength: 1, maxLength: 120, default: undefined },
    status: { type: "enum", values: ["all", "candidate", "verified", "canonical", "deprecated"], default: "all" }
  }));
}

/** @param {string} smaRoot @param {RegistryInput} input */
export async function loadRegistry(smaRoot, input) {
  const source = await readJsonFile(path.join(smaRoot, "registry", "global-modules.generated.json"), { generated_at: new Date(0).toISOString(), projects: [], bricks: [], count: 0 }, { maxBytes: 32 * 1024 * 1024 });
  const projects = /** @type {RegistryProject[]} */ (Array.isArray(source.projects) ? source.projects : []).slice(0, DASH_API_MAX_ROWS).map((project) => ({ id: String(project.id || "unknown"), brick_count: number(project.brick_count), average_score: number(project.average_score) }));
  const allBricks = /** @type {RegistryBrick[]} */ (Array.isArray(source.bricks) ? source.bricks : []).map((brick) => ({ id: String(brick.id || "unknown"), project: String(brick.project || "unknown"), status: String(brick.status || "candidate"), score: number(brick.score), health_status: String(brick.health?.status || "unknown") }));
  const matching = allBricks.filter((brick) => !input.project || brick.project === input.project).filter((brick) => input.status === "all" || brick.status === input.status);
  return { generated_at: source.generated_at || new Date(0).toISOString(), summary: { bricks: allBricks.length || number(source.count), canonical: allBricks.filter((brick) => brick.status === "canonical").length, projects: projects.length, matching: matching.length, returned: Math.min(matching.length, input.limit), truncated: matching.length > input.limit }, projects, bricks: matching.slice(0, input.limit) };
}

/** @param {RegistryHandlerOptions} options */
export function handleRegistry(options) {
  return runReadHandler({ ...options, area: "dashboard.api.registry", scope: REGISTRY_SCOPE, validate: validateRegistryQuery, load: options.load || ((input) => loadRegistry(options.root, input)) });
}
