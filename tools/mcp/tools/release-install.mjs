import { currentRoot, requireString } from "../lib.mjs";
import { runReleaseInstall } from "../../lib/mcp-release-install-client.mjs";
import {
  executeTool,
  McpToolError,
  releaseInstallAnnotations,
  releaseInstallAuthorization,
} from "../contract.mjs";

export const name = "release-install";
export const description = "Install a versioned SMA release through the import-safe sma-store API.";
export const inputSchema = {
  type: "object",
  properties: {
    brick: { type: "string", minLength: 1, maxLength: 256, description: "Release artifact/brick id." },
    version: { type: "string", minLength: 1, maxLength: 128, description: "Exact release version." },
    target: { type: "string", minLength: 1, maxLength: 4096, description: "Target project directory." },
    write: { type: "boolean", default: false, description: "Apply writes; false performs a dry run." },
    force: { type: "boolean", default: false, description: "Allow an explicitly forced install where supported." },
  },
  required: ["brick", "version", "target"],
  additionalProperties: false,
};
export const annotations = releaseInstallAnnotations;
export const authorization = releaseInstallAuthorization;
export const timeoutMs = 10_000;

/** @param {unknown} payload */
function parseWorkerResult(payload) {
  if (payload && typeof payload === "object" && "ok" in payload && payload.ok === true && "value" in payload) return payload.value;
  const error = /** @type {Record<string, unknown>} */ (
    payload && typeof payload === "object" && "error" in payload
      && payload.error && typeof payload.error === "object" ? payload.error : {}
  );
  throw new McpToolError(
    typeof error.code === "string" ? error.code : "MCP_INTERNAL_ERROR",
    typeof error.message === "string" ? error.message : "The release install worker failed",
    error.details && typeof error.details === "object"
      ? /** @type {Record<string, unknown>} */ (error.details)
      : undefined,
  );
}

/** @param {unknown} [args] */
export async function handler(args = {}) {
  return executeTool({
    name,
    inputSchema,
    args,
    timeoutMs,
    waitForTermination: true,
    operation: async (input, signal) => {
      const root = currentRoot();
      const result = await runReleaseInstall({
        root,
        brick: requireString(input.brick, "brick"),
        version: requireString(input.version, "version"),
        target: requireString(input.target, "target"),
        write: input.write === true,
        force: input.force === true,
      }, signal);
      return parseWorkerResult(result);
    },
  });
}
