#!/usr/bin/env node

import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { McpToolError, normalizeError } from "./contract.mjs";

/** @typedef {{ required_capability: string, boundary?: string, effect?: string, enforcement?: string }} ToolAuthorization */
/** @typedef {{ readOnlyHint?: boolean, destructiveHint?: boolean, idempotentHint?: boolean, openWorldHint?: boolean }} ToolAnnotations */
/** @typedef {{ name: string, handler: (args?: unknown) => Promise<unknown>, authorization: ToolAuthorization }} InvocableTool */
/** @typedef {InvocableTool & { description: string, inputSchema: unknown, annotations?: ToolAnnotations, timeoutMs?: number }} ToolModule */
/** @typedef {{ grantedCapabilities?: Set<string> | string }} ServerOptions */

const SERVER_NAME = "smarch-registry";
const SERVER_VERSION = "0.1.0";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolsDirectory = path.resolve(__dirname, "tools");
const DEFAULT_CAPABILITIES = Object.freeze(["registry:read"]);

/**
 * @param {unknown} [value]
 * @returns {Set<string>}
 */
export function parseGrantedCapabilities(value = process.env.SMARCH_MCP_CAPABILITIES) {
  if (value === undefined) return new Set(DEFAULT_CAPABILITIES);
  return new Set(String(value)
    .split(/[\s,]+/)
    .map((capability) => capability.trim())
    .filter(Boolean));
}

/**
 * @param {InvocableTool} tool
 * @param {unknown} args
 * @param {Set<string>} grantedCapabilities
 */
export async function invokeTool(tool, args, grantedCapabilities) {
  const requiredCapability = tool?.authorization?.required_capability;
  if (typeof requiredCapability !== "string" || !requiredCapability) {
    throw new McpToolError(
      "MCP_TOOL_INVALID",
      "The MCP tool does not declare a required capability",
      { tool: tool?.name || "unknown" },
    );
  }
  if (!grantedCapabilities.has(requiredCapability)) {
    const error = new McpToolError(
      "MCP_CAPABILITY_REQUIRED",
      "The MCP client has not been granted the capability required by this tool",
      { tool: tool.name, required_capability: requiredCapability },
    );
    console.error(JSON.stringify({
      area: `mcp:${tool.name}`,
      severity: "error",
      event: "tool_denied",
      code: error.code,
      required_capability: requiredCapability,
    }));
    throw error;
  }
  return tool.handler(args);
}

/** @param {unknown} error */
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
    if (error && typeof error === "object" && "code" in error
      && error.code === "ERR_MODULE_NOT_FOUND") throw sdkInstallError(error);
    throw error;
  }
}

/**
 * @param {unknown} value
 * @returns {value is ToolModule}
 */
function isToolModule(value) {
  if (!value || typeof value !== "object") return false;
  const authorization = "authorization" in value ? value.authorization : null;
  return "name" in value && typeof value.name === "string" && Boolean(value.name)
    && "description" in value && typeof value.description === "string" && Boolean(value.description)
    && "inputSchema" in value && Boolean(value.inputSchema)
    && "handler" in value && typeof value.handler === "function"
    && authorization !== null && typeof authorization === "object"
    && "required_capability" in authorization
    && typeof authorization.required_capability === "string";
}

/**
 * @param {string} [directory]
 * @returns {Promise<ToolModule[]>}
 */
export async function loadToolModules(directory = toolsDirectory) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const loadedModules = await Promise.all(entries.map((entry) => (
    import(pathToFileURL(path.resolve(directory, entry.name)).href)
  )));

  const seen = new Set();
  /** @type {ToolModule[]} */
  const modules = [];
  for (const tool of loadedModules) {
    if (!isToolModule(tool)) {
      throw new Error("MCP_TOOL_INVALID: every tool module must export name, description, inputSchema, handler, and authorization.required_capability");
    }
    if (seen.has(tool.name)) throw new Error(`MCP_TOOL_DUPLICATE: ${tool.name}`);
    seen.add(tool.name);
    modules.push(tool);
  }
  return modules;
}

/** @param {unknown} value */
function toolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

/** @param {unknown} error */
function toolError(error) {
  const safe = normalizeError(error);
  const structured = {
    code: safe.code,
    message: safe.message,
    ...(safe.details && typeof safe.details === "object" ? { details: safe.details } : {}),
  };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: structured }) }],
  };
}

/** @param {ServerOptions} [options] */
export async function createServer(options = {}) {
  const {
    Server,
    CallToolRequestSchema,
    ListToolsRequestSchema,
  } = await loadSdk();
  const tools = await loadToolModules();
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const grantedCapabilities = options.grantedCapabilities instanceof Set
    ? options.grantedCapabilities
    : parseGrantedCapabilities(options.grantedCapabilities);
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) return toolError(new McpToolError(
      "MCP_TOOL_NOT_FOUND",
      "No MCP tool matched the request",
    ));
    try {
      return toolResult(await invokeTool(tool, request.params.arguments || {}, grantedCapabilities));
    } catch (error) {
      // Tool handlers emit their own structured, payload-free failure telemetry.
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
