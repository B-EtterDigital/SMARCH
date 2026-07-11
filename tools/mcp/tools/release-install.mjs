import { currentRoot, requireString } from "../lib.mjs";
import { installRelease } from "../../sma-store.ts";
import {
  executeTool,
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

export async function handler(args = {}) {
  return executeTool({
    name,
    inputSchema,
    args,
    timeoutMs,
    operation: async (input) => installRelease({
      root: currentRoot(),
      brick: requireString(input.brick, "brick"),
      version: requireString(input.version, "version"),
      target: requireString(input.target, "target"),
      write: input.write === true,
      force: input.force === true,
    }),
  });
}
