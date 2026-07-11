import crypto from "node:crypto";
import fs from "node:fs/promises";

const DASH_API_DEFAULT_TIMEOUT_MS = 500;
export const DASH_API_MAX_ROWS = 500;

const LOOPBACK_READ_SCOPES = Object.freeze([
  "dashboard:leases:read",
  "dashboard:conflicts:read",
  "dashboard:registry:read",
  "dashboard:graph:read",
  "dashboard:events:read"
]);

const ERROR_DEFINITIONS = {
  DASH_API_AUTH_UNAVAILABLE: { status: 503, message: "Dashboard API authentication is not configured" },
  DASH_API_UNAUTHENTICATED: { status: 401, message: "Authentication is required" },
  DASH_API_FORBIDDEN: { status: 403, message: "The authenticated principal is not authorized for this operation" },
  DASH_API_VALIDATION: { status: 400, message: "The request is invalid" },
  DASH_API_NOT_FOUND: { status: 404, message: "Dashboard API route not found" },
  DASH_API_METHOD_NOT_ALLOWED: { status: 405, message: "Method not allowed" },
  DASH_API_TIMEOUT: { status: 504, message: "Dashboard API request timed out" },
  DASH_API_STORAGE: { status: 502, message: "Dashboard data could not be read" },
  DASH_API_INTERNAL: { status: 500, message: "Dashboard API request failed" }
};

/** @typedef {keyof typeof ERROR_DEFINITIONS} DashboardErrorCode */
/** @typedef {{ message?: string, cause?: unknown, status?: number, details?: unknown }} DashboardErrorOptions */
/** @typedef {{ subject: string, token: string, scopes: string[] }} Credential */
/** @typedef {{ authTokens?: Array<string | { subject?: string, token: string, scopes?: string[] }>, authTokensJson?: string, authToken?: string }} AuthOptions */
/** @typedef {{ subject: string, scopes: string[] }} Principal */
/** @typedef {(event: Record<string, unknown>) => void} TelemetrySink */
/** @typedef {{ required?: boolean, default?: unknown, type: "integer", min: number, max: number } | { required?: boolean, default?: unknown, type: "enum", values: string[] } | { required?: boolean, default?: unknown, type: "string", minLength?: number, maxLength: number }} QueryDefinition */

export class DashboardApiError extends Error {
  /**
* @param {string} code
*/
  /** @param {DashboardErrorCode} code @param {DashboardErrorOptions} [options] */
  constructor(code, options = {}) {
    const definition = ERROR_DEFINITIONS[code];
    super(options.message || definition.message, { cause: options.cause });
    this.name = "DashboardApiError";
    this.code = code;
    this.status = options.status || definition.status;
    this.details = options.details;
  }
}

/** @param {unknown} error */
function toDashboardApiError(error) {
  if (error instanceof DashboardApiError) return error;
  return new DashboardApiError("DASH_API_INTERNAL", { cause: error });
}

/** @param {unknown} error @param {string} requestId */
export function errorBody(error, requestId) {
  const typed = toDashboardApiError(error);
  return {
    error: {
      code: typed.code,
      message: typed.message,
      request_id: requestId
    }
  };
}

export function createRequestId() {
  return crypto.randomUUID();
}

/** @param {TelemetrySink | undefined} sink @returns {TelemetrySink} */
export function createTelemetrySink(sink) {
  if (typeof sink === "function") return sink;
  return (event) => console.error(JSON.stringify(event));
}

/** @param {TelemetrySink} sink @param {Record<string, unknown>} event */
export function emitTelemetry(sink, event) {
  try {
    sink({
      timestamp: new Date().toISOString(),
      area: event.area || "dashboard.api",
      severity: event.severity || "info",
      ...event
    });
  } catch (error) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "dashboard_api_telemetry_failure",
      area: "dashboard.api.telemetry",
      severity: "error",
      message: error instanceof Error ? error.message : String(error)
    }));
  }
}

/** @param {unknown} left @param {unknown} right */
function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

/** @param {string} subject @param {unknown} value @returns {Credential | null} */
function normalizeCredential(subject, value) {
  if (typeof value === "string") return { subject, token: value, scopes: ["dashboard:*"] };
  if (!value || typeof value !== "object" || !("token" in value) || typeof value.token !== "string") return null;
  return {
    subject,
    token: value.token,
    scopes: "scopes" in value && Array.isArray(value.scopes) ? value.scopes.map(String) : []
  };
}

/** @param {AuthOptions} [options] @returns {Credential[]} */
export function loadAuthCredentials(options = {}) {
  if (Array.isArray(options.authTokens)) {
    return options.authTokens
      .map((entry, index) => normalizeCredential(String(typeof entry === 'object' && entry.subject ? entry.subject : `token-${index + 1}`), entry))
      .filter((entry) => entry !== null);
  }
  const encoded = options.authTokensJson ?? process.env.SMA_DASHBOARD_AUTH_TOKENS;
  if (encoded) {
    try {
      const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(encoded));
      return Object.entries(parsed).map(([subject, value]) => normalizeCredential(subject, value)).filter((entry) => entry !== null);
    } catch (error) {
      throw new DashboardApiError("DASH_API_AUTH_UNAVAILABLE", { cause: error });
    }
  }
  const legacyToken = options.authToken ?? process.env.SMA_DASHBOARD_AUTH_TOKEN;
  return legacyToken ? [{ subject: "dashboard-operator", token: String(legacyToken), scopes: ["dashboard:*"] }] : [];
}

/** @param {{ authorization?: string } | undefined} headers @param {Credential[]} credentials @returns {Principal} */
export function authenticateRequest(headers, credentials) {
  if (!Array.isArray(credentials) || credentials.length === 0) {
    throw new DashboardApiError("DASH_API_AUTH_UNAVAILABLE");
  }
  const authorization = String(headers?.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) throw new DashboardApiError("DASH_API_UNAUTHENTICATED");
  const credential = credentials.find((candidate) => constantTimeEqual(candidate.token, match[1]));
  if (!credential) throw new DashboardApiError("DASH_API_UNAUTHENTICATED");
  return { subject: credential.subject, scopes: [...credential.scopes] };
}

/** @param {{ authorization?: string } | undefined} headers @param {Credential[]} credentials @param {{ loopback?: boolean }} [options] @returns {Principal} */
export function authenticateReadRequest(headers, credentials, options = {}) {
  if (options.loopback === true) {
    return { subject: "loopback-readonly", scopes: [...LOOPBACK_READ_SCOPES] };
  }
  return authenticateRequest(headers, credentials);
}

/** @param {Principal | null | undefined} principal @param {string} requiredScope */
export function authorizePrincipal(principal, requiredScope) {
  if (!principal || typeof principal.subject !== "string" || !Array.isArray(principal.scopes)) {
    throw new DashboardApiError("DASH_API_UNAUTHENTICATED");
  }
  const allowed = principal.scopes.some((/** @type {string} */ scope) => scope === requiredScope || scope === "dashboard:*" || (scope.endsWith(":*") && requiredScope.startsWith(scope.slice(0, -1))));
  if (!allowed) throw new DashboardApiError("DASH_API_FORBIDDEN");
}

/**
* @param {Record<string, unknown>} query
*/
/** @param {URLSearchParams} query @param {Record<string, QueryDefinition>} [schema] @returns {Record<string, unknown>} */
export function validateQuery(query, schema = {}) {
  if (!(query instanceof URLSearchParams)) throw new DashboardApiError("DASH_API_VALIDATION");
  const allowed = new Set(Object.keys(schema));
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const key of new Set(query.keys())) {
    if (!allowed.has(key) || query.getAll(key).length !== 1) throw new DashboardApiError("DASH_API_VALIDATION");
  }
  for (const [key, definition] of Object.entries(schema)) {
    const raw = query.get(key);
    if (raw === null) {
      if (definition.required) throw new DashboardApiError("DASH_API_VALIDATION");
      result[key] = definition.default;
      continue;
    }
    if (definition.type === "integer") {
      if (!/^-?\d+$/.test(raw)) throw new DashboardApiError("DASH_API_VALIDATION");
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < definition.min || value > definition.max) throw new DashboardApiError("DASH_API_VALIDATION");
      result[key] = value;
    } else if (definition.type === "enum") {
      if (!definition.values.includes(raw)) throw new DashboardApiError("DASH_API_VALIDATION");
      result[key] = raw;
    } else if (definition.type === "string") {
      if (raw.length < (definition.minLength || 0) || raw.length > definition.maxLength) throw new DashboardApiError("DASH_API_VALIDATION");
      result[key] = raw;
    } else {
      throw new DashboardApiError("DASH_API_INTERNAL");
    }
  }
  return result;
}

/** @template T @param {string} filePath @param {T} fallback @param {{ maxBytes?: number }} [options] @returns {Promise<T>} */
export async function readJsonFile(filePath, fallback, options = {}) {
  const maxBytes = options.maxBytes || 16 * 1024 * 1024;
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > maxBytes) throw new DashboardApiError("DASH_API_STORAGE");
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === "ENOENT" && fallback !== undefined) return fallback;
    if (error instanceof DashboardApiError) throw error;
    throw new DashboardApiError("DASH_API_STORAGE", { cause: error });
  }
}

/**
 * @template T
 * @param {(() => T | PromiseLike<T>) | null | undefined} operation
 * @param {number | undefined} timeoutMs
 * @returns {Promise<T>}
*/
export async function withTimeout(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DashboardApiError("DASH_API_TIMEOUT")), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @template Input, Output
 * @param {{ requestId?: string, telemetry?: TelemetrySink, area: string, principal: Principal, scope: string, query: URLSearchParams, validate: (query: URLSearchParams) => Input, load: (input: Input) => Promise<Output> | Output, timeoutMs?: number }} options
 * @returns {Promise<{ requestId: string, data: Output }>}
 */
export async function runReadHandler(options) {
  const requestId = options.requestId || createRequestId();
  const telemetry = createTelemetrySink(options.telemetry);
  const startedAt = performance.now();
  emitTelemetry(telemetry, { event: "dashboard_api_request_started", area: options.area, severity: "info", request_id: requestId });
  try {
    authorizePrincipal(options.principal, options.scope);
    emitTelemetry(telemetry, { event: "dashboard_api_authorized", area: options.area, severity: "info", request_id: requestId, subject: options.principal.subject, scope: options.scope });
    const input = options.validate(options.query);
    const data = await withTimeout(() => options.load(input), options.timeoutMs || DASH_API_DEFAULT_TIMEOUT_MS);
    emitTelemetry(telemetry, { event: "dashboard_api_request_succeeded", area: options.area, severity: "info", request_id: requestId, duration_ms: Math.round((performance.now() - startedAt) * 100) / 100 });
    return { requestId, data };
  } catch (error) {
    const typed = error instanceof DashboardApiError ? error : new DashboardApiError("DASH_API_STORAGE", { cause: error });
    emitTelemetry(telemetry, { event: "dashboard_api_request_failed", area: options.area, severity: "error", request_id: requestId, code: typed.code, duration_ms: Math.round((performance.now() - startedAt) * 100) / 100 });
    throw typed;
  }
}
