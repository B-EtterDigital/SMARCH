import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 600_000;

function packetPrompt(packet) {
  return typeof packet === "string" ? packet : JSON.stringify(packet, null, 2);
}

function runProcess(args, input, { timeoutMs, signal }) {
  return new Promise((resolve) => {
    const child = spawn("claude", args, { env: process.env });
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

/**
 * @param {unknown} packet
 * @param {{ model?: string, timeoutMs?: number, signal?: AbortSignal }} [options]
 */
export async function execute(packet, {
  model,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
} = {}) {
  const args = ["-p", "--output-format", "json"];
  if (model) args.push("--model", String(model));

  const result = await runProcess(args, packetPrompt(packet), { timeoutMs, signal });
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
