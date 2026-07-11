import { currentRoot, requireString } from "../lib.mjs";
import { installRelease } from "../../sma-store.ts";

export const name = "release-install";
export const description = "Install a versioned SMA release through the import-safe sma-store API.";
export const inputSchema = {
  type: "object",
  properties: {
    brick: { type: "string", description: "Release artifact/brick id." },
    version: { type: "string", description: "Exact release version." },
    target: { type: "string", description: "Target project directory." },
    write: { type: "boolean", default: false, description: "Apply writes; false performs a dry run." },
    force: { type: "boolean", default: false, description: "Allow an explicitly forced install where supported." },
  },
  required: ["brick", "version", "target"],
  additionalProperties: false,
};

export async function handler(args = {}) {
  return installRelease({
    root: currentRoot(),
    brick: requireString(args.brick, "brick"),
    version: requireString(args.version, "version"),
    target: requireString(args.target, "target"),
    write: args.write === true,
    force: args.force === true,
  });
}
