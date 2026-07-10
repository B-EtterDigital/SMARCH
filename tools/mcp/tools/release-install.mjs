import { readFile } from "node:fs/promises";

import { currentRoot, requireString } from "../lib.mjs";

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

async function loadInstallRelease() {
  const moduleUrl = new URL("../../sma-store.mjs", import.meta.url);
  const source = await readFile(moduleUrl, "utf8");
  if (!/export\s+(?:async\s+)?function\s+installRelease\b/.test(source)) {
    throw new Error("MCP_STORE_API_MISSING: tools/sma-store.mjs must export installRelease(options)");
  }
  const store = await import(moduleUrl.href);
  if (typeof store.installRelease !== "function") {
    throw new Error("MCP_STORE_API_MISSING: tools/sma-store.mjs must export installRelease(options)");
  }
  return store.installRelease;
}

export async function handler(args = {}) {
  const installRelease = await loadInstallRelease();
  return installRelease({
    root: currentRoot(),
    brick: requireString(args.brick, "brick"),
    version: requireString(args.version, "version"),
    target: requireString(args.target, "target"),
    write: args.write === true,
    force: args.force === true,
  });
}

