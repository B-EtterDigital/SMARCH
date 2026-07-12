import {
  getBrick,
  getBuild,
  getProject,
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

/** @typedef {Awaited<ReturnType<typeof loadRegistryContext>>} RegistryContext */
/** @typedef {NonNullable<ReturnType<typeof getBrick>>} Brick */
/** @typedef {NonNullable<ReturnType<typeof getBuild>>} Build */
/** @typedef {Record<string, unknown>} ToolInput */

export const name = "registry-why-blocked";
export const description = "Explain recorded readiness blockers for a brick, build, or project.";
export const inputSchema = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: 256, description: "Brick, build, or project identifier." },
    type: { type: "string", enum: ["auto", "brick", "build", "project"], default: "auto" },
  },
  required: ["query"],
  additionalProperties: false,
};
export const annotations = readOnlyAnnotations;
export const authorization = readOnlyAuthorization;
export const timeoutMs = 500;

/** @param {Brick} brick */
function brickBlockers(brick) {
  const reasons = [];
  if (brick?.health?.status && brick.health.status !== "ok") reasons.push("health_not_ok");
  if (Number(brick?.health?.error_count || 0) > 0) reasons.push("validation_errors");
  if (typeof brick?.clone_readiness === "string"
    && ["blocked", "manual_review"].includes(brick.clone_readiness)) reasons.push("clone_not_ready");
  if (brick?.env_contract?.required && brick.env_contract.status !== "complete") reasons.push("env_contract_incomplete");
  if (brick?.rls_contract?.required && brick.rls_contract.status !== "complete") reasons.push("rls_contract_incomplete");
  return [...new Set(reasons)];
}

/** @param {Build} build */
function buildBlockers(build) {
  const explicit = [
    ...(build?.top_blockers || []),
    ...(build?.verification_top_blockers || []),
    ...(build?.promotion_blockers || []),
  ].map((entry) => typeof entry === "string" ? entry : entry?.code).filter(Boolean);
  if (build?.installable === false) explicit.push("not_installable");
  if (build?.verified_ready === false) explicit.push("not_verified_ready");
  if (build?.publish_ready === false) explicit.push("not_publish_ready");
  return [...new Set(explicit)];
}

/**
 * @param {ToolInput} args
 * @param {RegistryContext} context
 */
export async function explainWhyBlocked(args, context) {
  const query = requireString(args.query, "query");
  const requestedType = args.type || "auto";

  const brick = requestedType === "auto" || requestedType === "brick" ? getBrick(context, query) : null;
  if (brick) {
    const reasons = brickBlockers(brick);
    return {
      target_type: "brick",
      matched: brick.id,
      blocked: reasons.length > 0,
      ready: reasons.length === 0,
      reasons,
      trust: trustFields(brick, context.state),
      details: {
        health: brick.health || null,
        clone_readiness: brick.clone_readiness || null,
        env_contract: brick.env_contract || null,
        rls_contract: brick.rls_contract || null,
      },
    };
  }

  const build = requestedType === "auto" || requestedType === "build" ? getBuild(context, query) : null;
  if (build) {
    const reasons = buildBlockers(build);
    return {
      target_type: "build",
      matched: build.build_id || build.artifact_id || build.name,
      blocked: reasons.length > 0,
      ready: reasons.length === 0 && build.installable !== false,
      reasons,
      details: boundedDiagnosticValue(build),
    };
  }

  const project = requestedType === "auto" || requestedType === "project" ? getProject(context, query) : null;
  if (project) {
    const actions = project?.top_actions || project?.quality_queue || [];
    return {
      target_type: "project",
      matched: project.project,
      blocked: actions.length > 0,
      ready: actions.length === 0,
      reasons: actions.map((action) => action.code || action.reason || action.name).filter(Boolean),
      details: boundedDiagnosticValue(project),
    };
  }

  throw new McpToolError(
    "MCP_TARGET_NOT_FOUND",
    "No registry target matched the request",
    { target_type: requestedType },
  );
}

/** @param {unknown} [args] */
export async function handler(args = {}) {
  return executeTool({
    name,
    inputSchema,
    args,
    timeoutMs,
    operation: async (input, signal) => explainWhyBlocked(input, await loadRegistryContext(signal)),
  });
}
