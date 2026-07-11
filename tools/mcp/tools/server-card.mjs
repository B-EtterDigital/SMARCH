import {
  executeTool,
  readOnlyAnnotations,
  readOnlyAuthorization,
} from "../contract.mjs";

const TOOLS = [
  "brick-search",
  "brick-get",
  "brick-trust",
  "registry-doctor",
  "registry-why-blocked",
  "release-install",
  "build-list",
  "server-card",
];

export const name = "server-card";
export const description = "Return discovery metadata for the SMARCH registry MCP server.";
export const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
export const annotations = readOnlyAnnotations;
export const authorization = readOnlyAuthorization;
export const timeoutMs = 500;

export function getServerCard() {
  return {
    name: "smarch-registry",
    description: "Stdio MCP access to the SMARCH registry, trust, doctor, build, and release-install seams.",
    version: "0.1.0",
    transport: { type: "stdio" },
    repository: "https://github.com/B-EtterDigital/SMARCH",
    tools: TOOLS,
    authorization: {
      boundary: "stdio-parent-process",
      read_capability: "registry:read",
      write_capability: "release:install",
    },
  };
}

export async function handler(args = {}) {
  return executeTool({
    name,
    inputSchema,
    args,
    timeoutMs,
    operation: async () => getServerCard(),
  });
}
