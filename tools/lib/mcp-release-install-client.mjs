import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { killProcessTree } from "./abortable-process.mjs";

const worker = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mcp-release-install-worker.mjs");
let nextId = 0;
/** @typedef {{ resolve: (value: unknown) => void, reject: (reason?: unknown) => void, signal: AbortSignal, abort: () => void }} PendingRequest */
/** @typedef {{ child: import("node:child_process").ChildProcessWithoutNullStreams, workerPath: string, buffer: string, pending: Map<number, PendingRequest>, stderr: string, error?: unknown }} WorkerState */
/** @type {WorkerState | undefined} */
let active;

/** @param {string} workerPath */
function startWorker(workerPath) {
  const child = spawn(process.execPath, [workerPath], {
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  /** @type {WorkerState} */
  const state = { child, workerPath, buffer: "", pending: new Map(), stderr: "" };
  active = state;
  child.stdout.on("data", (chunk) => {
    state.buffer += chunk.toString("utf8");
    let newline;
    while ((newline = state.buffer.indexOf("\n")) >= 0) {
      const line = state.buffer.slice(0, newline);
      state.buffer = state.buffer.slice(newline + 1);
      const response = /** @type {{ id: number }} */ (JSON.parse(line));
      const request = state.pending.get(response.id);
      if (!request) continue;
      state.pending.delete(response.id);
      request.signal.removeEventListener("abort", request.abort);
      request.resolve(response);
    }
  });
  child.stderr.on("data", (chunk) => { state.stderr += chunk.toString("utf8"); });
  child.once("error", (error) => { state.error = error; });
  child.once("close", (code) => {
    if (active === state) active = undefined;
    for (const request of state.pending.values()) {
      request.signal.removeEventListener("abort", request.abort);
      request.reject(request.signal.aborted
        ? request.signal.reason
        : state.error || new Error(`release install worker exited with status ${String(code)}${state.stderr.trim() ? `: ${state.stderr.trim()}` : ""}`));
    }
    state.pending.clear();
  });
  return state;
}

/** @param {Record<string, unknown>} options @param {AbortSignal} signal @param {string} [workerPath] */
export function runReleaseInstall(options, signal, workerPath = worker) {
  signal.throwIfAborted();
  const state = active && active.child.exitCode === null && active.workerPath === workerPath
    ? active
    : startWorker(workerPath);
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const abort = () => {
      try { killProcessTree(state.child); } catch (error) { state.error = error; }
    };
    state.pending.set(id, { resolve, reject, signal, abort });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else state.child.stdin.write(`${JSON.stringify({ id, options })}\n`);
  });
}
