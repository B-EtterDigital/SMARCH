import {
  getBrick,
  loadRegistryContext,
  requireString,
  trustFields,
} from "../lib.mjs";

export const name = "brick-trust";
export const description = "Explain the current registry trust posture for one brick.";
export const inputSchema = {
  type: "object",
  properties: {
    brick: { type: "string", description: "Brick id, name, or path fragment." },
  },
  required: ["brick"],
  additionalProperties: false,
};

export async function handler(args = {}) {
  const brickQuery = requireString(args.brick, "brick");
  const context = await loadRegistryContext();
  const brick = getBrick(context, brickQuery);
  if (!brick) throw new Error(`MCP_BRICK_NOT_FOUND: no brick matched ${brickQuery}`);
  return {
    brick: brick.id,
    name: brick.name,
    project: brick.project,
    trust: trustFields(brick, context.state),
    health: brick.health || null,
    verification: brick.verification || [],
    clone_readiness: brick.clone_readiness || null,
    data_classes: brick.data_classes || [],
  };
}

