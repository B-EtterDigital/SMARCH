import { spawnSync } from "node:child_process";
import { runWorkforceProcess } from "./process-runner.mjs";

const DEFAULT_TIMEOUT_MS = 600_000;

/** @typedef {{ code: number | null, stdout: string, stderr: string, error?: NodeJS.ErrnoException, closeSignal?: NodeJS.Signals | null, timedOut: boolean }} ProcessResult */

/** @param {unknown} packet @returns {string} */
function packetPrompt(packet) {
  return typeof packet === "string" ? packet : JSON.stringify(packet, null, 2);
}

export function isAvailable(command = process.env.SMA_OPENCODE_BIN || "opencode") {
  const probe = spawnSync(command, ["--version"], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

/** @param {unknown} stdout */
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
  const result = await runWorkforceProcess(command, args, undefined, { timeoutMs, signal, cwd });
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
