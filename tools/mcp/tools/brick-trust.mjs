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

export const name = "brick-trust";
export const description = "Explain the current registry trust posture for one brick.";
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

export function explainBrickTrust(args, context) {
  const brickQuery = requireString(args.brick, "brick");
  const brick = getBrick(context, brickQuery);
  if (!brick) throw new McpToolError(
    "MCP_BRICK_NOT_FOUND",
    "No registry brick matched the request",
  );
  return boundedDiagnosticValue({
    brick: brick.id,
    name: brick.name,
    project: brick.project,
    trust: trustFields(brick, context.state),
    health: brick.health || null,
    verification: brick.verification || [],
    clone_readiness: brick.clone_readiness || null,
    data_classes: brick.data_classes || [],
  });
}

export async function handler(args = {}) {
  return executeTool({
    name,
    inputSchema,
    args,
    timeoutMs,
    operation: async (input) => explainBrickTrust(input, await loadRegistryContext()),
  });
}
