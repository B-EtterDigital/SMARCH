/**
 * Reusable Codex CLI runner with structured-output + disk cache.
 *
 * Public API:
 *   await codex({ prompt, schema, model, timeoutMs, noCache, label })
 *     - prompt   : string passed via stdin to `codex exec`
 *     - schema   : optional JSON Schema (object). When set, codex returns
 *                  structured JSON conforming to it.
 *     - model    : default "gpt-5.4"
 *     - timeoutMs: per-call timeout (default 240000)
 *     - noCache  : skip disk cache (default false)
 *     - label    : tag for logs (default "codex")
 *   returns:
 *     { ok: true,  data, fromCache, durationMs }   when schema is set
 *     { ok: true,  text, fromCache, durationMs }   when no schema
 *     { ok: false, error, stderr, durationMs }     on failure
 *
 * Cache lives at ~/.cache/sma-codex/<sha256>.json and is keyed by
 * (model + prompt + schema). Hits are free.
 *
 * Execution is delegated to the shared workforce contract with the Codex
 * backend in read-only mode so model, effort, timeout, and backend policy stay
 * centralized.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { dispatch } from "./workforce/contract.mjs";

const DEFAULT_MODEL = "gpt-5.4";
const CACHE_DIR = path.join(os.homedir(), ".cache", "sma-codex");

/**
 * @typedef {object} CodexOptions
 * @property {string} [prompt]
 * @property {any} [schema]
 * @property {string} [model]
 * @property {number} [timeoutMs]
 * @property {boolean} [noCache]
 * @property {string} [label]
 */

async function ensureCache() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

function cacheKey(model, prompt, schema) {
  const h = crypto.createHash("sha256");
  h.update(model);
  h.update("\u0000");
  h.update(prompt);
  h.update("\u0000");
  if (schema) h.update(JSON.stringify(schema));
  return h.digest("hex");
}

async function readCache(key) {
  try {
    const raw = await fs.readFile(path.join(CACHE_DIR, `${key}.json`), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeCache(key, payload) {
  await fs.writeFile(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(payload));
}

async function dispatchCodex({ prompt, schemaPath, model, timeoutMs }, dispatchFn = dispatch) {
  const started = Date.now();
  const result = await dispatchFn(prompt, {
    backend: "codex",
    model,
    schema: schemaPath || undefined,
    readOnly: true,
    timeoutMs,
  });
  const durationMs = Date.now() - started;
  const stderr = result.raw?.stderr || "";
  if (!result.ok) {
    const exitCode = result.raw?.exitCode;
    const error = result.raw?.error
      || (Number.isInteger(exitCode) ? `codex exit ${exitCode}` : "workforce codex dispatch failed");
    return { ok: false, error, stderr, durationMs };
  }
  return { ok: true, output: result.output, stderr, durationMs };
}

/** @param {CodexOptions} [options] */
export async function codex({
  prompt,
  schema = null,
  model = DEFAULT_MODEL,
  timeoutMs = 240000,
  noCache = false,
  label = "codex"
} = {}) {
  if (!prompt || typeof prompt !== "string") {
    return { ok: false, error: "prompt is required" };
  }

  await ensureCache();
  const key = cacheKey(model, prompt, schema);

  if (!noCache) {
    const cached = await readCache(key);
    if (cached) {
      return { ...cached, fromCache: true };
    }
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sma-codex-"));
  let schemaPath = null;
  if (schema) {
    schemaPath = path.join(tmp, "schema.json");
    await fs.writeFile(schemaPath, JSON.stringify(schema));
  }

  const spawned = await dispatchCodex({
    prompt,
    schemaPath,
    model,
    timeoutMs,
  });

  if (!spawned.ok) {
    try { await fs.rm(tmp, { recursive: true, force: true }); } catch {}
    return spawned;
  }

  const raw = typeof spawned.output === "string"
    ? spawned.output
    : JSON.stringify(spawned.output ?? "");

  let result;
  if (schema) {
    // Codex sometimes wraps JSON in fenced blocks. Strip them.
    const unfenced = raw
      .replace(/^\s*```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    try {
      const data = JSON.parse(unfenced);
      result = { ok: true, data, durationMs: spawned.durationMs };
    } catch (err) {
      result = {
        ok: false,
        error: `JSON parse failed: ${err.message}`,
        rawText: unfenced.slice(0, 2000),
        durationMs: spawned.durationMs
      };
    }
  } else {
    result = { ok: true, text: raw.trim(), durationMs: spawned.durationMs };
  }

  try { await fs.rm(tmp, { recursive: true, force: true }); } catch {}

  if (result.ok) {
    await writeCache(key, result);
  }

  return { ...result, fromCache: false };
}

/**
 * Run many codex calls with bounded concurrency. Items is an array of
 * { id, prompt, schema, ...overrides } — yields { id, result } as each completes.
 */
/**
 * @param {Array<CodexOptions & {id: string}>} items
 * @param {{concurrency?: number, model?: string, timeoutMs?: number, onResult?: ((result: any) => void) | null}} [options]
 */
export async function codexBatch(items, { concurrency = 3, model = DEFAULT_MODEL, timeoutMs = 240000, onResult = null } = {}) {
  const queue = items.slice();
  const results = [];
  let active = 0;
  let resolveAll;
  const done = new Promise((r) => { resolveAll = r; });

  const tick = () => {
    if (queue.length === 0 && active === 0) {
      resolveAll();
      return;
    }
    while (active < concurrency && queue.length > 0) {
      const item = queue.shift();
      active += 1;
      codex({
        prompt: item.prompt,
        schema: item.schema || null,
        model: item.model || model,
        timeoutMs: item.timeoutMs || timeoutMs,
        label: item.id
      }).then((result) => {
        const wrapped = { id: item.id, result };
        results.push(wrapped);
        if (onResult) {
          try { onResult(wrapped); } catch {}
        }
      }).catch((err) => {
        const wrapped = { id: item.id, result: { ok: false, error: err?.message || String(err) } };
        results.push(wrapped);
        if (onResult) {
          try { onResult(wrapped); } catch {}
        }
      }).finally(() => {
        active -= 1;
        tick();
      });
    }
  };

  tick();
  await done;
  return results;
}

export const internals = { CACHE_DIR, cacheKey, dispatchCodex };
