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
  readOnlyAnnotations,
  readOnlyAuthorization,
} from "../contract.mjs";

export const name = "brick-get";
export const description = "Get one registry brick by id, name, or path fragment.";
export const inputSchema = {
  type: "object",
  properties: {
    brick: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description: "Brick id, name, or path fragment.",
    },
  },
  required: ["brick"],
  additionalProperties: false,
};
export const annotations = readOnlyAnnotations;
export const authorization = readOnlyAuthorization;
export const timeoutMs = 500;

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

export async function handler(args = {}) {
  return executeTool({
    name,
    inputSchema,
    args,
    timeoutMs,
    operation: async (input) => getRegistryBrick(input, await loadRegistryContext()),
  });
}
