/**
 * WHAT: Runs Codex requests through the shared workforce contract with structured output and caching.
 * WHY: Ranking, enrichment, and wiki commands need one timeout, model, error, and cache policy for model calls.
 * HOW: Callers submit prompts and optional schemas; the module returns success data or a normalized failure object.
 * Batch callers also receive bounded concurrency and per-result callbacks without duplicating process control.
 * Cached results live below the user's cache directory and are keyed by model, prompt, and schema.
 * Command-line terms are defined in docs/GLOSSARY.md.
 * @example node --input-type=module -e "import { internals } from './tools/lib/codex-runner.ts'; console.log(internals.cacheKey('demo-model', 'Reply READY', null))"
 */
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

type JsonValue = { [key: string]: JsonValue } | JsonValue[] | string | number | boolean | null;
type CodexOptions = {
  prompt?: string;
  schema?: JsonValue;
  model?: string;
  timeoutMs?: number;
  noCache?: boolean;
  label?: string;
};
type CodexSuccess = { ok: true; data?: JsonValue; text?: string; fromCache?: boolean; durationMs: number };
type CodexFailure = { ok: false; error: string; stderr?: string; rawText?: string; fromCache?: boolean; durationMs?: number };
type CodexResult = CodexSuccess | CodexFailure;
type DispatchResult = { ok: boolean; output?: unknown; raw?: { stderr?: string; exitCode?: number; error?: string } };
type DispatchFunction = (prompt: string, options: {
  backend: string; model: string; schema?: string; readOnly: boolean; timeoutMs: number;
}) => Promise<DispatchResult>;
type BatchItem = CodexOptions & { id: string; prompt: string };
type BatchWrapped = { id: string; result: CodexResult };

function reportRunnerError(area: string, hint: string, error: unknown): void {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  if (code === 'ENOENT') return;
  console.error(JSON.stringify({
    area,
    severity: 'warning',
    hint,
    error: error instanceof Error ? error.message : String(error),
    ...(code ? { code } : {}),
  }));
}

/**
 * @typedef {object} CodexOptions
 * @property {string} [prompt]
 * @property {unknown} [schema]
 * @property {string} [model]
 * @property {number} [timeoutMs]
 * @property {boolean} [noCache]
 * @property {string} [label]
 */

async function ensureCache(): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

function cacheKey(model: string, prompt: string, schema: JsonValue | null | undefined): string {
  const h = crypto.createHash("sha256");
  h.update(model);
  h.update("\u0000");
  h.update(prompt);
  h.update("\u0000");
  if (schema) h.update(JSON.stringify(schema));
  return h.digest("hex");
}

async function readCache(key: string): Promise<CodexResult | null> {
  try {
    const raw = await fs.readFile(path.join(CACHE_DIR, `${key}.json`), "utf8");
    return JSON.parse(raw) as CodexResult;
  } catch (error) {
    reportRunnerError('codex-runner.cache-read', 'Delete the corrupt cache entry or check cache permissions.', error);
    return null;
  }
}

async function writeCache(key: string, payload: CodexResult): Promise<void> {
  await fs.writeFile(path.join(CACHE_DIR, `${key}.json`), JSON.stringify(payload));
}

async function dispatchCodex({ prompt, schemaPath, model, timeoutMs }: {
  prompt: string; schemaPath: string | null; model: string; timeoutMs: number;
}, dispatchFn: DispatchFunction = dispatch as DispatchFunction): Promise<
  { ok: true; output: unknown; stderr: string; durationMs: number }
  | { ok: false; error: string; stderr: string; durationMs: number }
> {
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
}: CodexOptions = {}): Promise<CodexResult> {
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
    try { await fs.rm(tmp, { recursive: true, force: true }); } catch (error) {
      reportRunnerError('codex-runner.temp-cleanup', 'Remove the temporary schema directory manually.', error);
    }
    return spawned;
  }

  const raw = typeof spawned.output === "string"
    ? spawned.output
    : JSON.stringify(spawned.output ?? "");

  let result: CodexResult;
  if (schema) {
    // Codex sometimes wraps JSON in fenced blocks. Strip them.
    const unfenced = raw
      .replace(/^\s*```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();
    try {
      const data = JSON.parse(unfenced) as JsonValue;
      result = { ok: true, data, durationMs: spawned.durationMs };
    } catch (err: unknown) {
      reportRunnerError('codex-runner.response-parse', 'Inspect the raw Codex response and requested schema.', err);
      result = {
        ok: false,
        error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
        rawText: unfenced.slice(0, 2000),
        durationMs: spawned.durationMs
      };
    }
  } else {
    result = { ok: true, text: raw.trim(), durationMs: spawned.durationMs };
  }

  try { await fs.rm(tmp, { recursive: true, force: true }); } catch (error) {
    reportRunnerError('codex-runner.temp-cleanup', 'Remove the temporary schema directory manually.', error);
  }

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
 * @param {{concurrency?: number, model?: string, timeoutMs?: number, onResult?: ((result: unknown) => void) | null}} [options]
 */
export async function codexBatch(items: BatchItem[], { concurrency = 3, model = DEFAULT_MODEL, timeoutMs = 240000, onResult = null }: {
  concurrency?: number; model?: string; timeoutMs?: number; onResult?: ((result: BatchWrapped) => void) | null;
} = {}): Promise<BatchWrapped[]> {
  const queue = items.slice();
  const results: BatchWrapped[] = [];
  let active = 0;
  let resolveAll: () => void = () => {};
  const done = new Promise<void>((resolveDone) => { resolveAll = resolveDone; });

  const tick = (): void => {
    if (queue.length === 0 && active === 0) {
      resolveAll();
      return;
    }
    while (active < concurrency && queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;
      active += 1;
      codex({
        prompt: item.prompt,
        schema: item.schema || null,
        model: item.model || model,
        timeoutMs: item.timeoutMs || timeoutMs,
        label: item.id
      }).then((result) => {
        const wrapped: BatchWrapped = { id: item.id, result };
        results.push(wrapped);
        if (onResult) {
          try { onResult(wrapped); } catch (error) {
            reportRunnerError('codex-runner.on-result', 'Fix the batch result callback; dispatch completed successfully.', error);
          }
        }
      }).catch((err: unknown) => {
        const wrapped: BatchWrapped = { id: item.id, result: { ok: false, error: err instanceof Error ? err.message : String(err) } };
        results.push(wrapped);
        if (onResult) {
          try { onResult(wrapped); } catch (callbackError) {
            reportRunnerError('codex-runner.on-result', 'Fix the batch result callback; dispatch failure was already recorded.', callbackError);
          }
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
