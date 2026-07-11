#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER_NAME = "smarch-registry";
const SERVER_VERSION = "0.1.0";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolsDirectory = path.resolve(__dirname, "tools");

function sdkInstallError(error) {
  const wrapped = new Error(
    "MCP_SDK_MISSING: install optional MCP support with `npm install --include=optional` "
    + "after @modelcontextprotocol/sdk is declared as an optionalDependency",
  );
  wrapped.cause = error;
  return wrapped;
}

export async function loadSdk() {
  try {
    const [serverModule, stdioModule, typesModule] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/index.js"),
      import("@modelcontextprotocol/sdk/server/stdio.js"),
      import("@modelcontextprotocol/sdk/types.js"),
    ]);
    return {
      Server: serverModule.Server,
      StdioServerTransport: stdioModule.StdioServerTransport,
      CallToolRequestSchema: typesModule.CallToolRequestSchema,
      ListToolsRequestSchema: typesModule.ListToolsRequestSchema,
    };
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") throw sdkInstallError(error);
    throw error;
  }
}

export async function loadToolModules(directory = toolsDirectory) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const modules = await Promise.all(entries.map((entry) => (
    import(pathToFileURL(path.resolve(directory, entry.name)).href)
  )));

  const seen = new Set();
  for (const tool of modules) {
    if (!tool.name || !tool.description || !tool.inputSchema || typeof tool.handler !== "function") {
      throw new Error("MCP_TOOL_INVALID: every tool module must export name, description, inputSchema, and handler");
    }
    if (seen.has(tool.name)) throw new Error(`MCP_TOOL_DUPLICATE: ${tool.name}`);
    seen.add(tool.name);
  }
  return modules;
}

function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function toolError(error) {
  const message = error instanceof Error ? error.message : String(error);
  const structured = error && typeof error === "object" && typeof error.code === "string"
    ? {
      code: error.code,
      message,
      ...(error.details && typeof error.details === "object" ? { details: error.details } : {}),
    }
    : message;
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: structured }) }],
  };
}

export async function createServer() {
  const {
    Server,
    CallToolRequestSchema,
    ListToolsRequestSchema,
  } = await loadSdk();
  const tools = await loadToolModules();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) return toolError(new Error(`MCP_TOOL_NOT_FOUND: ${request.params.name}`));
    try {
      return toolResult(await tool.handler(request.params.arguments || {}));
    } catch (error) {
      console.error(JSON.stringify({
        area: "mcp-server",
        severity: "error",
        tool: tool.name,
        message: error instanceof Error ? error.message : String(error),
      }));
      return toolError(error);
    }
  });

  return server;
}

export async function main() {
  const { StdioServerTransport } = await loadSdk();
  const server = await createServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(JSON.stringify({
      area: "mcp-server",
      severity: "fatal",
      message: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  });
}
