#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, emitFailure } from "../cli-contract.mjs";
import { loadSdk, loadToolModules, main as serveStdio } from "./server.mjs";

const TOOL_PATH = fileURLToPath(import.meta.url);

/** @typedef {{ check: boolean, json: boolean, quiet: boolean, verbose: boolean, help: boolean }} CliOptions */
/** @typedef {{ loadSdk?: () => Promise<unknown>, loadToolModules?: () => Promise<Array<{ name: string }>>, serve?: () => Promise<void> }} RunDependencies */

export function usage() {
  return `Serve the SMARCH registry over MCP stdio.

Usage:
  sma mcp-serve [--quiet | --verbose]
  sma mcp-serve --check [--json]

Options:
  --check    Validate tool modules and report MCP SDK availability, then exit.
  --json     Emit the --check result as JSON; protocol stdout stays clean.
  --quiet    Suppress human status output.
  --verbose  Emit startup details on stderr.
  -h, --help Show this help.

Examples:
  sma mcp-serve --check --json
  sma mcp-serve --verbose

Exit codes: 0 success; 2 usage; 3 optional SDK missing; 4 invalid tools; 1 runtime failure.
Known limitation: serving uses stdio only; stdout is reserved for MCP JSON-RPC. A check can pass with ready=false when the optional SDK is absent.`;
}

/**
 * @param {string[]} argv
 * @returns {CliOptions}
 */
export function parseArgs(argv) {
  const options = { check: false, json: false, quiet: false, verbose: false, help: false };
  for (const arg of argv) {
    if (arg === "--check") options.check = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new CliError("USAGE_ERROR", `Unknown option: ${arg}`, { exitCode: 2, nextCommand: "Run `sma mcp-serve --help`." });
  }
  if (options.quiet && options.verbose) throw new CliError("USAGE_ERROR", "--quiet and --verbose cannot be combined.", { exitCode: 2, nextCommand: "Choose one output mode and retry." });
  if (options.json && !options.check) throw new CliError("USAGE_ERROR", "--json is available only with --check because stdout carries MCP traffic while serving.", { exitCode: 2, nextCommand: "Run `sma mcp-serve --check --json`." });
  return options;
}

/** @param {unknown} error */
function classify(error) {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("MCP_SDK_MISSING")) return new CliError("MCP_SDK_MISSING", message, { exitCode: 3, nextCommand: "Run `npm install --include=optional`, then retry." });
  if (message.includes("MCP_TOOL_")) return new CliError("MCP_TOOLS_INVALID", message, { exitCode: 4, nextCommand: "Run `node tools/mcp/selftest.mjs` to identify the invalid tool module." });
  return new CliError("MCP_SERVE_FAILED", message, { exitCode: 1, nextCommand: "Run `sma mcp-serve --check --verbose` before retrying the server." });
}

/**
 * @param {string[]} argv
 * @param {RunDependencies} [dependencies]
 */
export async function run(argv, dependencies = {}) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) { process.stdout.write(`${usage()}\n`); return 0; }
    const sdkLoader = dependencies.loadSdk || loadSdk;
    const toolLoader = dependencies.loadToolModules || loadToolModules;
    if (options.check) {
      const tools = await toolLoader();
      let sdkAvailable = true;
      try { await sdkLoader(); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("MCP_SDK_MISSING")) throw error;
        sdkAvailable = false;
      }
      const result = { ok: true, ready: sdkAvailable, transport: "stdio", tool_count: tools.length, sdk_available: sdkAvailable };
      if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
      else if (!options.quiet) process.stdout.write(`mcp-serve check completed: ${tools.length} tools, sdk ${sdkAvailable ? "available" : "missing"}, stdio transport\n`);
      return 0;
    }
    if (options.verbose) process.stderr.write("mcp-serve: starting stdio transport\n");
    await (dependencies.serve || serveStdio)();
    return 0;
  } catch (error) {
    return emitFailure("mcp-serve", classify(error), { mode: options?.check ? "check" : "serve" });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === TOOL_PATH) process.exitCode = await run(process.argv.slice(2));
