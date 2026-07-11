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

/** @type {Map<string, () => Promise<{ execute: Function }>>} */
const BACKEND_LOADERS = new Map([
  ["codex", /** @returns {Promise<{ execute: Function }>} */ () => import("./codex.mjs")],
  ["claude", /** @returns {Promise<{ execute: Function }>} */ () => import("./claude-cli.mjs")],
  ["claude-cli", /** @returns {Promise<{ execute: Function }>} */ () => import("./claude-cli.mjs")],
  ["opencode", /** @returns {Promise<{ execute: Function }>} */ () => import("./opencode.mjs")],
]);

function failure(message, raw = {}) {
  return {
    ok: false,
    output: "",
    tokensIn: 0,
    tokensOut: 0,
    raw: { error: message, ...raw },
  };
}

function normalize(result) {
  if (!result || typeof result !== "object") {
    return failure("workforce backend returned an invalid result", { result });
  }

  return {
    ok: result.ok === true,
    output: result.output ?? "",
    tokensIn: Number.isFinite(result.tokensIn) ? result.tokensIn : 0,
    tokensOut: Number.isFinite(result.tokensOut) ? result.tokensOut : 0,
    raw: result.raw ?? result,
  };
}

function recordUsage(selection, model, result, startedAt) {
  if (process.env.SMA_WORKFORCE_NO_USAGE_LOG === "1") return;
  if (typeof selection !== "string") return;
  const file = process.env.SMA_WORKFORCE_USAGE_LOG || join(homedir(), ".smarch", "workforce-usage.jsonl");
  const backend = String(result?.raw?.backend || selection).toLowerCase();
  const record = {
    schema: "smarch.workforce-usage.v1",
    timestamp: new Date().toISOString(),
    backend,
    model: String(model || result?.raw?.response?.model || backend),
    tokens_in: Number(result?.tokensIn || 0),
    tokens_out: Number(result?.tokensOut || 0),
    ok: result?.ok === true,
    duration_ms: Date.now() - startedAt,
    session_id: result?.raw?.sessionId || null,
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch {
    // Accounting must not turn a successful executor call into a failed task.
  }
}

async function resolveBackend(selection) {
  if (typeof selection === "function") return { execute: selection };
  if (selection && typeof selection.execute === "function") return selection;

  const name = String(selection || "").trim().toLowerCase();
  const load = BACKEND_LOADERS.get(name);
  if (!load) throw new Error(`unknown workforce backend: ${name || "(empty)"}`);

  const module = await load();
  if (typeof module.execute !== "function") {
    throw new Error(`workforce backend ${name} does not export execute()`);
  }
  return module;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAttempt(executor, packet, options, timeoutMs) {
  const controller = new AbortController();
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
 * @param {{ backend?: string | Function | { execute: Function }, model?: string, effort?: string, schema?: string, readOnly?: boolean, timeoutMs?: number, cwd?: string }} [options]
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

  const selection = backend ?? process.env.SMA_WORKFORCE_BACKEND ?? DEFAULT_BACKEND;
  let executor;
  try {
    executor = await resolveBackend(selection);
  } catch (error) {
    return failure(error.message, { backend: String(selection) });
  }

  const startedAt = Date.now();
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
        raw: { error: error.message, name: error.name },
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
