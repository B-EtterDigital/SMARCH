import { spawn, spawnSync } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 600_000;

function packetPrompt(packet) {
  return typeof packet === "string" ? packet : JSON.stringify(packet, null, 2);
}

export function isAvailable(command = process.env.SMA_OPENCODE_BIN || "opencode") {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

export function parseJsonEvents(stdout) {
  const events = String(stdout || "").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const text = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let sessionId = null;
  for (const event of events) {
    sessionId ||= event.sessionID || event.session_id || event.session?.id || null;
    const part = event.part || event.message || event;
    const candidate = part.text || part.content || event.text;
    if (typeof candidate === "string" && candidate.trim()) text.push(candidate.trim());
    const usage = event.usage || part.usage || event.tokens || part.tokens || {};
    tokensIn += Number(usage.input_tokens ?? usage.input ?? usage.prompt ?? 0) || 0;
    tokensOut += Number(usage.output_tokens ?? usage.output ?? usage.completion ?? 0) || 0;
  }
  return { events, output: text.at(-1) || "", tokensIn, tokensOut, sessionId };
}

function runProcess(command, args, { timeoutMs, signal, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: process.env, cwd });
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
    const abort = () => { timedOut = true; child.kill("SIGKILL"); };
    const timer = setTimeout(abort, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ code: null, stdout, stderr, error, timedOut }));
    child.on("close", (code, closeSignal) => finish({ code, stdout, stderr, closeSignal, timedOut }));
  });
}

/**
 * @param {unknown} packet
 * @param {{ model?: string, effort?: string, readOnly?: boolean, timeoutMs?: number, signal?: AbortSignal, cwd?: string, command?: string }} [options]
 */
export async function execute(packet, {
  model,
  effort,
  readOnly = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  cwd = process.cwd(),
  command = process.env.SMA_OPENCODE_BIN || "opencode",
} = {}) {
  const args = ["run", "--format", "json", "--dir", cwd];
  if (model) args.push("--model", String(model));
  if (effort) args.push("--variant", String(effort));
  if (!readOnly) args.push("--dangerously-skip-permissions");
  args.push(packetPrompt(packet));
  const result = await runProcess(command, args, { timeoutMs, signal, cwd });
  const parsed = parseJsonEvents(result.stdout);
  return {
    ok: result.code === 0 && !result.timedOut,
    output: parsed.output || result.stdout.trim(),
    tokensIn: parsed.tokensIn,
    tokensOut: parsed.tokensOut,
    retryable: result.error?.code !== "ENOENT",
    raw: {
      backend: "opencode",
      command,
      args,
      exitCode: result.code,
      signal: result.closeSignal,
      timedOut: result.timedOut,
      error: result.error?.message,
      stderr: result.stderr,
      sessionId: parsed.sessionId,
      events: parsed.events,
    },
  };
}
