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

export async function handler() {
  return {
    name: "smarch-registry",
    description: "Stdio MCP access to the SMARCH registry, trust, doctor, build, and release-install seams.",
    version: "0.1.0",
    transport: { type: "stdio" },
    repository: "https://github.com/B-EtterDigital/SMARCH",
    tools: TOOLS,
  };
}

