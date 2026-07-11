import { spawn } from "node:child_process";

/**
 * Run a workforce CLI with consistent abort, timeout, and stream capture semantics.
 * @param {string} command
 * @param {string[]} args
 * @param {string | undefined} input
 * @param {{ timeoutMs: number, signal?: AbortSignal, cwd?: string }} options
 */
export function runWorkforceProcess(command, args, input, { timeoutMs, signal, cwd }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env: process.env, cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    /**
     * @param {{ code: number | null, stdout: string, stderr: string, error?: Error, closeSignal?: NodeJS.Signals | null, timedOut: boolean }} result
     */
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
    if (input !== undefined) child.stdin.end(input);
  });
}
