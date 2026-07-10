import {
  getBrick,
  loadRegistryContext,
  requireString,
  trustFields,
} from "../lib.mjs";

export const name = "brick-get";
export const description = "Get one registry brick by id, name, or path fragment.";
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
    ...brick,
    trust: trustFields(brick, context.state),
  };
}

