const DEFAULT_TIMEOUT_MS = 500;

/** @typedef {{ type?: string, enum?: unknown[], minLength?: number, maxLength?: number, pattern?: string, minimum?: number, maximum?: number }} InputRule */
/** @typedef {{ type?: string, properties?: Record<string, InputRule>, required?: string[], additionalProperties?: boolean }} InputSchema */
/** @typedef {Record<string, unknown>} ToolInput */
/** @typedef {{ code: string, message?: unknown, details?: Record<string, unknown> }} McpErrorLike */

export class McpToolError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown> | undefined} [details]
   * @param {ErrorOptions | undefined} [options]
   */
  constructor(code, message, details = undefined, options = undefined) {
    super(message, options);
    this.name = "McpToolError";
    this.code = code;
    if (details && typeof details === "object") this.details = details;
  }
}

export const readOnlyAuthorization = Object.freeze({
  boundary: "stdio-parent-process",
  effect: "read",
  required_capability: "registry:read",
});

export const releaseInstallAuthorization = Object.freeze({
  boundary: "stdio-parent-process",
  effect: "filesystem-write",
  required_capability: "release:install",
  enforcement: "target-containment",
});

export const readOnlyAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

export const releaseInstallAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
});

/** @param {unknown} value */
function valueType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/**
 * @param {string} tool
 * @param {string} field
 * @param {string} expectation
 */
function validationError(tool, field, expectation) {
  return new McpToolError(
    "MCP_INVALID_INPUT",
    `Invalid input for ${tool}`,
    { field, expectation },
  );
}

/**
 * @param {string} tool
 * @param {InputSchema} schema
 * @param {unknown} input
 * @returns {ToolInput}
 */
export function validateInput(tool, schema, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw validationError(tool, "$", "object");
  }

  const record = /** @type {ToolInput} */ (input);
  const properties = schema.properties || {};
  for (const field of schema?.required || []) {
    if (!Object.hasOwn(record, field)) throw validationError(tool, field, "required");
  }
  if (schema?.additionalProperties === false) {
    const unexpected = Object.keys(record).find((field) => !Object.hasOwn(properties, field));
    if (unexpected) throw validationError(tool, unexpected, "known property");
  }

  for (const [field, value] of Object.entries(record)) {
    const rule = properties[field];
    if (!rule) continue;
    const matchesType = rule.type === "integer"
      ? Number.isInteger(value)
      : valueType(value) === rule.type;
    if (rule.type && !matchesType) {
      throw validationError(tool, field, rule.type);
    }
    if (Array.isArray(rule.enum) && !rule.enum.includes(value)) {
      throw validationError(tool, field, `one of: ${rule.enum.join(", ")}`);
    }
    if (rule.type === "string") {
      if (Number.isInteger(rule.minLength) && typeof rule.minLength === "number" && typeof value === "string" && value.length < rule.minLength) {
        throw validationError(tool, field, `string length >= ${rule.minLength}`);
      }
      if (Number.isInteger(rule.maxLength) && typeof rule.maxLength === "number" && typeof value === "string" && value.length > rule.maxLength) {
        throw validationError(tool, field, `string length <= ${rule.maxLength}`);
      }
      if (rule.pattern && typeof value === "string" && !(new RegExp(rule.pattern)).test(value)) {
        throw validationError(tool, field, `string matching ${rule.pattern}`);
      }
    }
    if (rule.type === "integer") {
      if (!Number.isInteger(value)) throw validationError(tool, field, "integer");
      if (Number.isFinite(rule.minimum) && typeof rule.minimum === "number" && typeof value === "number" && value < rule.minimum) {
        throw validationError(tool, field, `integer >= ${rule.minimum}`);
      }
      if (Number.isFinite(rule.maximum) && typeof rule.maximum === "number" && typeof value === "number" && value > rule.maximum) {
        throw validationError(tool, field, `integer <= ${rule.maximum}`);
      }
    }
  }
  return record;
}

/**
 * @param {unknown} error
 * @returns {McpToolError | McpErrorLike}
 */
export function normalizeError(error) {
  if (error instanceof McpToolError) return error;
  if (error && typeof error === "object" && "code" in error
    && typeof error.code === "string" && error.code.startsWith("MCP_")) {
    return /** @type {McpErrorLike} */ (error);
  }
  return new McpToolError(
    "MCP_INTERNAL_ERROR",
    "The MCP tool could not complete the request",
    undefined,
    { cause: error },
  );
}

/**
 * @param {unknown} value
 * @param {number} [depth]
 * @returns {unknown}
 */
export function boundedDiagnosticValue(value, depth = 0) {
  if (depth >= 6) return "[truncated]";
  if (typeof value === "string") {
    return value.length <= 4096 ? value : `${value.slice(0, 4096)}…`;
  }
  if (Array.isArray(value)) {
    /** @type {unknown[]} */
    const bounded = value.slice(0, 100).map((entry) => boundedDiagnosticValue(entry, depth + 1));
    if (value.length > 100) bounded.push({ truncated_count: value.length - 100 });
    return bounded;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    /** @type {Record<string, unknown>} */
    const bounded = Object.fromEntries(entries
      .slice(0, 100)
      .map(([key, entry]) => [key, boundedDiagnosticValue(entry, depth + 1)]));
    if (entries.length > 100) bounded.truncated_key_count = entries.length - 100;
    return bounded;
  }
  return value;
}

/**
 * @param {string} tool
 * @param {McpToolError | McpErrorLike} error
 * @param {number} durationMs
 */
export function emitFailure(tool, error, durationMs) {
  console.error(JSON.stringify({
    area: `mcp:${tool}`,
    severity: "error",
    event: "tool_failed",
    code: error?.code || "MCP_INTERNAL_ERROR",
    duration_ms: durationMs,
  }));
}

/**
 * @template Result
 * @param {{ name: string, inputSchema: InputSchema, args: unknown, operation: (input: ToolInput) => Promise<Result>, timeoutMs?: number }} options
 * @returns {Promise<Result>}
 */
export async function executeTool({
  name,
  inputSchema,
  args,
  operation,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const started = performance.now();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    const input = validateInput(name, inputSchema, args);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new McpToolError(
        "MCP_TIMEOUT",
        `The ${name} request exceeded its ${timeoutMs}ms budget`,
        { timeout_ms: timeoutMs },
      )), timeoutMs);
    });
    return await Promise.race([operation(input), timeout]);
  } catch (error) {
    const normalized = normalizeError(error);
    emitFailure(name, normalized, Math.round(performance.now() - started));
    throw normalized;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
