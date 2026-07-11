import {
  getBrick,
  loadRegistryContext,
  requireString,
  trustFields,
} from "../lib.mjs";
import {
  boundedDiagnosticValue,
  executeTool,
  McpToolError,
} from "../contract.mjs";
import {
  brickReadAnnotations,
  brickReadAuthorization,
  brickReadInputSchema,
  brickReadTimeoutMs,
} from "../brick-read-contract.mjs";

/** @typedef {Awaited<ReturnType<typeof loadRegistryContext>>} RegistryContext */
/** @typedef {Record<string, unknown>} ToolInput */

export const name = "brick-get";
export const description = "Get one registry brick by id, name, or path fragment.";
export const inputSchema = brickReadInputSchema;
export const annotations = brickReadAnnotations;
export const authorization = brickReadAuthorization;
export const timeoutMs = brickReadTimeoutMs;

/**
 * @param {ToolInput} args
 * @param {RegistryContext} context
 */
export function getRegistryBrick(args, context) {
  const brickQuery = requireString(args.brick, "brick");
  const brick = getBrick(context, brickQuery);
  if (!brick) throw new McpToolError(
    "MCP_BRICK_NOT_FOUND",
    "No registry brick matched the request",
  );
  return boundedDiagnosticValue({
    ...brick,
    trust: trustFields(brick, context.state),
  });
}

/** @param {unknown} [args] */
export async function handler(args = {}) {
  return executeTool({
    name,
    inputSchema,
    args,
    timeoutMs,
    operation: async (input) => getRegistryBrick(input, await loadRegistryContext()),
  });
}
