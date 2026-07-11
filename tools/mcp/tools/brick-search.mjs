import {
  loadRegistryContext,
  normalizeLimit,
  searchBricks,
} from "../lib.mjs";
import {
  boundedDiagnosticValue,
  executeTool,
  readOnlyAnnotations,
  readOnlyAuthorization,
} from "../contract.mjs";

export const name = "brick-search";
export const description = "Search the SMA registry for reusable bricks and return normalized trust fields.";
export const inputSchema = {
  type: "object",
  properties: {
    query: { type: "string", maxLength: 256, description: "Brick id, name, domain, project, or path fragment." },
    project: { type: "string", minLength: 1, maxLength: 256, description: "Optional exact project id filter." },
    kind: { type: "string", minLength: 1, maxLength: 128, description: "Optional exact brick kind filter." },
    status: { type: "string", minLength: 1, maxLength: 128, description: "Optional exact brick status filter." },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  },
  additionalProperties: false,
};
export const annotations = readOnlyAnnotations;
export const authorization = readOnlyAuthorization;
export const timeoutMs = 500;

export function searchRegistryBricks(args, context) {
  const results = searchBricks(context, {
    ...args,
    limit: normalizeLimit(args.limit, 20),
  });
  return boundedDiagnosticValue({
    query: String(args.query || "").trim(),
    count: results.length,
    results,
    registry_generated_at: context.registry?.generated_at || null,
  });
}

export async function handler(args = {}) {
  return executeTool({
    name,
    inputSchema,
    args,
    timeoutMs,
    operation: async (input) => searchRegistryBricks(input, await loadRegistryContext()),
  });
}
