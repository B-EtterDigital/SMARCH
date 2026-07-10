#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_EFFORT = "xhigh";
const DEFAULT_TIMEOUT_MS = 600_000;

function packetPrompt(packet) {
  return typeof packet === "string" ? packet : JSON.stringify(packet, null, 2);
}

/**
 * @param {{ model?: string, effort?: string, schema?: string, readOnly?: boolean }} [options]
 */
export function buildArgs({
  model = DEFAULT_MODEL,
  effort = DEFAULT_EFFORT,
  schema,
  readOnly = false,
} = {}) {
  const args = [
    "exec",
    "-m", String(model),
    "-c", `model_reasoning_effort=${effort}`,
  ];
  if (readOnly) args.push("-s", "read-only");
  else args.push("--yolo");
  if (schema) args.push("--output-schema", String(schema));
  args.push("--json", "-");
  return args;
}

function runProcess(command, args, input, { timeoutMs, signal }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => {
      timedOut = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ code: null, stdout, stderr, error, timedOut }));
    child.on("close", (code, closeSignal) => finish({ code, stdout, stderr, closeSignal, timedOut }));
    child.stdin.end(input);
  });
}

function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }

  let output = "";
  let tokensIn = 0;
  let tokensOut = 0;
  for (const event of events) {
    const usage = event.usage || event.turn?.usage || event.item?.usage;
    if (usage) {
      tokensIn = usage.input_tokens ?? usage.inputTokens ?? tokensIn;
      tokensOut = usage.output_tokens ?? usage.outputTokens ?? tokensOut;
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      output = event.item.text ?? event.item.content ?? output;
    } else if (event.type === "agent_message") {
      output = event.text ?? event.message ?? output;
    }
  }
  return { events, output: typeof output === "string" ? output.trim() : output, tokensIn, tokensOut };
}

export function isAvailable() {
  const probe = spawnSync("codex", ["--version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

/**
 * @param {unknown} packet
 * @param {{ model?: string, effort?: string, schema?: string, readOnly?: boolean, timeoutMs?: number, signal?: AbortSignal }} [options]
 */
export async function execute(packet, {
  model = DEFAULT_MODEL,
  effort = DEFAULT_EFFORT,
  schema,
  readOnly = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
} = {}) {
  if (schema && typeof schema !== "string") {
    return {
      ok: false,
      output: "",
      tokensIn: 0,
      tokensOut: 0,
      retryable: false,
      raw: { backend: "codex", error: "schema must be a filesystem path" },
    };
  }

  const args = buildArgs({ model, effort, schema, readOnly });
  const result = await runProcess("codex", args, packetPrompt(packet), { timeoutMs, signal });
  const parsed = parseEvents(result.stdout);
  const ok = result.code === 0 && !result.timedOut;
  return {
    ok,
    output: parsed.output,
    tokensIn: parsed.tokensIn,
    tokensOut: parsed.tokensOut,
    retryable: result.error?.code !== "ENOENT",
    raw: {
      backend: "codex",
      command: "codex",
      args,
      exitCode: result.code,
      signal: result.closeSignal,
      timedOut: result.timedOut,
      error: result.error?.message,
      stderr: result.stderr,
      events: parsed.events,
    },
  };
}

async function selftest() {
  assert.deepEqual(buildArgs({ model: "writer-model", effort: "high" }), [
    "exec", "-m", "writer-model", "-c", "model_reasoning_effort=high", "--yolo", "--json", "-",
  ]);
  assert.deepEqual(buildArgs({
    model: "review-model",
    effort: "xhigh",
    readOnly: true,
    schema: "/tmp/workforce-schema.json",
  }), [
    "exec", "-m", "review-model", "-c", "model_reasoning_effort=xhigh",
    "-s", "read-only", "--output-schema", "/tmp/workforce-schema.json", "--json", "-",
  ]);

  if (!isAvailable()) {
    console.log("workforce codex selftest: skip live smoke (argument contract ok; codex CLI absent)");
    return;
  }
  const result = await execute("Reply with OK and nothing else.", {
    readOnly: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  if (!result.ok) throw new Error(result.raw.error || result.raw.stderr || `codex exit ${result.raw.exitCode}`);
  if (String(result.output).trim() !== "OK") throw new Error(`expected OK, received ${JSON.stringify(result.output)}`);
  console.log("workforce codex selftest: ok (live one-word smoke)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--selftest")) {
  selftest().catch((error) => {
    console.error(`workforce codex selftest: ${error.message}`);
    process.exitCode = 1;
  });
}
