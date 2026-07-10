import {
  loadRegistryContext,
  normalizeLimit,
  searchBricks,
} from "../lib.mjs";

export const name = "brick-search";
export const description = "Search the SMA registry for reusable bricks and return normalized trust fields.";
export const inputSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Brick id, name, domain, project, or path fragment." },
    project: { type: "string", description: "Optional exact project id filter." },
    kind: { type: "string", description: "Optional exact brick kind filter." },
    status: { type: "string", description: "Optional exact brick status filter." },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  },
  additionalProperties: false,
};

export async function handler(args = {}) {
  const context = await loadRegistryContext();
  const results = searchBricks(context, {
    ...args,
    limit: normalizeLimit(args.limit, 20),
  });
  return {
    query: String(args.query || "").trim(),
    count: results.length,
    results,
    registry_generated_at: context.registry?.generated_at || null,
  };
}

