#!/usr/bin/env node

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_BACKEND = "codex";
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 250;

/** @typedef {{ model?: unknown, effort?: unknown, timeoutMs?: number, signal?: AbortSignal, schema?: string, readOnly?: boolean, cwd?: string }} ExecuteOptions */
/** @typedef {Record<string, unknown> & { backend?: unknown, response?: { model?: unknown }, sessionId?: unknown, timedOut?: boolean, model?: unknown, effort?: unknown, error?: unknown, name?: unknown }} WorkforceRaw */
/** @typedef {{ ok?: boolean, output?: unknown, tokensIn?: number, tokensOut?: number, retryable?: boolean, raw?: WorkforceRaw }} WorkforceResult */
/** @typedef {{ ok: boolean, output: unknown, tokensIn: number, tokensOut: number, retryable?: boolean, raw: WorkforceRaw }} NormalizedResult */
/** @typedef {{ execute: (packet: unknown, options: ExecuteOptions) => WorkforceResult | Promise<WorkforceResult> }} Executor */
/** @typedef {string | Executor | Executor["execute"]} BackendSelection */
/** @typedef {string | Function | { execute: Function }} LegacyBackendSelection */

/** @type {Map<string, () => Promise<unknown>>} */
const BACKEND_LOADERS = new Map(/** @type {Array<[string, () => Promise<unknown>]>} */ ([
  ["codex", () => import("./codex.mjs")],
  ["claude", () => import("./claude-cli.mjs")],
  ["claude-cli", () => import("./claude-cli.mjs")],
  ["opencode", () => import("./opencode.mjs")],
]));

/** @param {string} message @param {WorkforceRaw} [raw] @returns {NormalizedResult} */
function failure(message, raw = {}) {
  return {
    ok: false,
    output: "",
    tokensIn: 0,
    tokensOut: 0,
    raw: { error: message, ...raw },
  };
}

/** @param {unknown} result @returns {NormalizedResult} */
function normalize(result) {
  if (!result || typeof result !== "object") {
    return failure("workforce backend returned an invalid result", { result });
  }

  const typed = /** @type {WorkforceResult} */ (result);
  return {
    ok: typed.ok === true,
    output: typed.output ?? "",
    tokensIn: Number.isFinite(typed.tokensIn) ? typed.tokensIn ?? 0 : 0,
    tokensOut: Number.isFinite(typed.tokensOut) ? typed.tokensOut ?? 0 : 0,
    raw: typed.raw ?? /** @type {WorkforceRaw} */ (typed),
  };
}

/** @param {BackendSelection} selection @param {unknown} model @param {NormalizedResult} result @param {number} startedAt */
function recordUsage(selection, model, result, startedAt) {
  if (process.env.SMA_WORKFORCE_NO_USAGE_LOG === "1") return;
  if (typeof selection !== "string") return;
  const file = process.env.SMA_WORKFORCE_USAGE_LOG || join(homedir(), ".smarch", "workforce-usage.jsonl");
  const backend = String(result.raw.backend || selection).toLowerCase();
  const record = {
    schema: "smarch.workforce-usage.v1",
    timestamp: new Date().toISOString(),
    backend,
    model: String(model || result.raw.response?.model || backend),
    tokens_in: Number(result.tokensIn || 0),
    tokens_out: Number(result.tokensOut || 0),
    ok: result.ok === true,
    duration_ms: Date.now() - startedAt,
    session_id: result.raw.sessionId || null,
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // Accounting must not turn a successful executor call into a failed task.
  }
}

/** @param {BackendSelection} selection @returns {Promise<Executor>} */
async function resolveBackend(selection) {
  if (typeof selection === "function") return { execute: selection };
  if (typeof selection === "object" && selection !== null && typeof selection.execute === "function") return selection;

  const name = String(selection || "").trim().toLowerCase();
  const load = BACKEND_LOADERS.get(name);
  if (!load) throw new Error(`unknown workforce backend: ${name || "(empty)"}`);

  const module = await load();
  if (!module || typeof module !== "object" || !("execute" in module) || typeof module.execute !== "function") {
    throw new Error(`workforce backend ${name} does not export execute()`);
  }
  return { execute: /** @type {Executor["execute"]} */ (module.execute) };
}

/** @param {LegacyBackendSelection} selection @returns {BackendSelection} */
function normalizeBackendSelection(selection) {
  if (typeof selection === "string") return selection;
  if (typeof selection === "function") {
    return { execute: (packet, options) => selection(packet, options) };
  }
  return { execute: (packet, options) => selection.execute(packet, options) };
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {Executor} executor @param {unknown} packet @param {ExecuteOptions} options @param {number} timeoutMs @returns {Promise<WorkforceResult>} */
async function runAttempt(executor, packet, options, timeoutMs) {
  const controller = new AbortController();
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({
        ok: false,
        output: "",
        tokensIn: 0,
        tokensOut: 0,
        retryable: true,
        raw: { error: `workforce dispatch timed out after ${timeoutMs}ms`, timedOut: true },
      });
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve(executor.execute(packet, { ...options, timeoutMs, signal: controller.signal })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dispatch a packet through a pluggable workforce backend.
 *
 * Backend selection precedence is the explicit option, then
 * SMA_WORKFORCE_BACKEND, then Codex. A backend may also be an in-process
 * object exposing execute(packet, options), which keeps contract tests local.
 *
 * @param {unknown} packet
 * @param {{ backend?: LegacyBackendSelection, model?: string, effort?: string, schema?: string, readOnly?: boolean, timeoutMs?: number, cwd?: string }} [options]
 */
export async function dispatch(packet, {
  backend,
  model = process.env.SMA_WORKFORCE_MODEL,
  effort = process.env.SMA_WORKFORCE_EFFORT,
  schema,
  readOnly = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cwd,
} = {}) {
  if (packet === undefined || packet === null) {
    return failure("workforce packet is required");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return failure("timeoutMs must be a positive number");
  }

  const selection = normalizeBackendSelection(backend ?? process.env.SMA_WORKFORCE_BACKEND ?? DEFAULT_BACKEND);
  let executor;
  try {
    executor = await resolveBackend(selection);
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error), { backend: String(selection) });
  }

  const startedAt = Date.now();
  /** @type {WorkforceResult | undefined} */
  let lastResult;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) {
      return failure(`workforce dispatch timed out after ${timeoutMs}ms`, {
        backend: String(selection),
        attempts: attempt - 1,
        timedOut: true,
      });
    }

    try {
      lastResult = await runAttempt(executor, packet, {
        model,
        effort,
        schema,
        readOnly: Boolean(readOnly),
        cwd,
      }, remainingMs);
    } catch (error) {
      lastResult = {
        ok: false,
        retryable: true,
        raw: { error: error instanceof Error ? error.message : String(error), name: error instanceof Error ? error.name : "Error" },
      };
    }

    if (lastResult?.ok === true || lastResult?.retryable === false || attempt === MAX_ATTEMPTS) {
      const normalized = normalize(lastResult);
      recordUsage(selection, model, normalized, startedAt);
      return normalized;
    }

    const delayMs = Math.min(BACKOFF_MS * (2 ** (attempt - 1)), timeoutMs - (Date.now() - startedAt));
    if (delayMs > 0) await sleep(delayMs);
  }

  return normalize(lastResult);
}

async function selftest() {
  const packet = { task: "echo", payload: ["workforce", 1] };
  let attempts = 0;
  const stub = {
    /** @param {unknown} received @param {ExecuteOptions} options @returns {Promise<WorkforceResult>} */
    async execute(received, options) {
      attempts += 1;
      if (attempts < 2) return { ok: false, retryable: true, raw: { error: "retry me" } };
      return {
        ok: true,
        output: received,
        tokensIn: 7,
        tokensOut: 3,
        raw: { backend: "stub", model: options.model, effort: options.effort },
      };
    },
  };

  const result = await dispatch(packet, {
    backend: stub,
    model: "stub-model",
    effort: "stub-effort",
    timeoutMs: 5_000,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.output, packet);
  assert.equal(result.tokensIn, 7);
  assert.equal(result.tokensOut, 3);
  assert.equal(result.raw.model, "stub-model");
  assert.equal(result.raw.effort, "stub-effort");
  assert.equal(attempts, 2);

  const timedOut = await dispatch("slow", {
    backend: { execute: () => new Promise(() => {}) },
    timeoutMs: 10,
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.raw.timedOut, true);
  console.log("workforce contract selftest: ok (stub round-trip + retry + timeout)");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--selftest")) {
    selftest().catch((error) => {
      console.error(`workforce contract selftest: ${error.message}`);
      process.exitCode = 1;
    });
  }
}
