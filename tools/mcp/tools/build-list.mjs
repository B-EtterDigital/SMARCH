import { loadRegistryContext, normalizeLimit } from "../lib.mjs";
import {
  boundedDiagnosticValue,
  executeTool,
  readOnlyAnnotations,
  readOnlyAuthorization,
} from "../contract.mjs";

export const name = "build-list";
export const description = "List curated builds from the build index or generated state snapshot.";
export const inputSchema = {
  type: "object",
  properties: {
    project: { type: "string", minLength: 1, maxLength: 256, description: "Optional exact source project filter." },
    limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
  },
  additionalProperties: false,
};
export const annotations = readOnlyAnnotations;
export const authorization = readOnlyAuthorization;
export const timeoutMs = 500;

export function listRegistryBuilds(args, context) {
  const project = String(args.project || "").trim();
  const limit = normalizeLimit(args.limit, 20);
  const builds = context.buildIndex?.builds || context.state?.build_plane?.curated_builds || [];
  const results = builds
    .filter((build) => !project || String(build?.project || build?.source_project) === project)
    .sort((left, right) => (
      Number(right?.readiness_score || 0) - Number(left?.readiness_score || 0)
      || String(left?.build_id || left?.artifact_id || "").localeCompare(String(right?.build_id || right?.artifact_id || ""))
    ))
    .slice(0, limit);
  return boundedDiagnosticValue({ count: results.length, results });
}

export async function handler(args = {}) {
  return executeTool({
    name,
    inputSchema,
    args,
    timeoutMs,
    operation: async (input) => listRegistryBuilds(input, await loadRegistryContext()),
  });
}
