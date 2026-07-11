import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runWorkforceProcess } from "./process-runner.mjs";

const DEFAULT_TIMEOUT_MS = 600_000;

/** @param {unknown} packet */
function packetPrompt(packet) {
  return typeof packet === "string" ? packet : JSON.stringify(packet, null, 2);
}

/** @param {string} schema */
function schemaJson(schema) {
  if (typeof schema !== "string" || !schema.trim()) throw new Error("schema must be a JSON string or filesystem path");
  const source = schema.trim().startsWith("{") ? schema : readFileSync(schema, "utf8");
  return JSON.stringify(JSON.parse(source));
}

/**
 * @param {{ model?: string, effort?: string, schema?: string, readOnly?: boolean }} [options]
 */
export function buildClaudeArgs({ model, effort, schema, readOnly = false } = {}) {
  const args = ["-p", "--output-format", "json"];
  if (model) args.push("--model", String(model));
  if (effort) args.push("--effort", String(effort));
  if (schema) args.push("--json-schema", schemaJson(schema));
  if (readOnly) args.push("--permission-mode", "plan");
  return args;
}

/**
 * @param {unknown} packet
 * @param {{ model?: string, effort?: string, schema?: string, readOnly?: boolean, timeoutMs?: number, signal?: AbortSignal, cwd?: string }} [options]
 */
export async function execute(packet, {
  model,
  effort,
  schema,
  readOnly = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  cwd,
} = {}) {
  let args;
  try {
    args = buildClaudeArgs({ model, effort, schema, readOnly });
  } catch (error) {
    return {
      ok: false,
      output: "",
      tokensIn: 0,
      tokensOut: 0,
      retryable: false,
      raw: { backend: "claude-cli", error: error instanceof Error ? error.message : String(error) },
    };
  }

  const result = await runWorkforceProcess("claude", args, packetPrompt(packet), { timeoutMs, signal, cwd });
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch {}
  const usage = parsed?.usage || {};
  const ok = result.code === 0 && !result.timedOut && parsed !== undefined;
  return {
    ok,
    output: parsed?.result ?? parsed?.output ?? parsed ?? result.stdout.trim(),
    tokensIn: usage.input_tokens ?? usage.inputTokens ?? 0,
    tokensOut: usage.output_tokens ?? usage.outputTokens ?? 0,
    retryable: result.error?.code !== "ENOENT",
    raw: {
      backend: "claude-cli",
      command: "claude",
      args,
      exitCode: result.code,
      signal: result.closeSignal,
      timedOut: result.timedOut,
      error: result.error?.message,
      stderr: result.stderr,
      response: parsed,
    },
  };
}

function selftest() {
  const args = buildClaudeArgs({
    model: "sonnet",
    effort: "xhigh",
    schema: JSON.stringify({ type: "object" }),
    readOnly: true,
  });
  assert.deepEqual(args, [
    "-p", "--output-format", "json",
    "--model", "sonnet",
    "--effort", "xhigh",
    "--json-schema", '{"type":"object"}',
    "--permission-mode", "plan",
  ]);
  console.log("claude-cli workforce selftest: ok (full dispatch contract)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--selftest")) {
  selftest();
}
