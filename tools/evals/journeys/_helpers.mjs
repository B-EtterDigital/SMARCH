import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";

export const RUNS = 10;
const OUTPUT_LIMIT = 4_000;

/** @typedef {import("node:child_process").ChildProcessByStdio<null, import("node:stream").Readable, import("node:stream").Readable>} PipedChild */
/** @typedef {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, expectStatus?: number, label?: string }} RunOptions */

/** @param {string[]} argv @param {string} name */
export function parseJourneyArgs(argv, name) {
  let selftest = false;
  for (const arg of argv) {
    if (arg === "--selftest") selftest = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node tools/evals/journeys/${name}.mjs [--selftest]`);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { selftest };
}

/** @param {unknown} value */
function tail(value) {
  const text = String(value || "").trim();
  return text.length <= OUTPUT_LIMIT ? text : text.slice(-OUTPUT_LIMIT);
}

/** @param {string} command @param {string[]} args @param {RunOptions} [options] */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: options.timeoutMs || 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const expected = options.expectStatus ?? 0;
  if (result.error || result.status !== expected) {
    const output = tail([result.stdout, result.stderr].filter(Boolean).join("\n"));
    throw new Error(
      `${options.label || command} exited ${result.status}; expected ${expected}`
      + (result.error ? ` (${result.error.message})` : "")
      + (output ? `\n${output}` : ""),
    );
  }
  return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
}

/** @param {string} script @param {string[]} [args] @param {RunOptions} [options] */
export function runNode(script, args = [], options = {}) {
  return run(process.execPath, [script, ...args], options);
}

/** @template T @param {string} prefix @param {(root: string) => Promise<T>} callback @returns {Promise<T>} */
export async function withTempRoot(prefix, callback) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await callback(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** @param {string} name @param {() => Promise<unknown>} journey @param {number} perRunBudgetMs */
export async function runSelftest(name, journey, perRunBudgetMs) {
  const signatures = [];
  const durations = [];
  const started = performance.now();
  for (let index = 0; index < RUNS; index += 1) {
    const runStarted = performance.now();
    signatures.push(await journey());
    const duration = performance.now() - runStarted;
    durations.push(duration);
    assert.ok(
      duration <= perRunBudgetMs,
      `${name} run ${index + 1} exceeded ${perRunBudgetMs}ms budget (${Math.ceil(duration)}ms)`,
    );
  }
  for (const signature of signatures.slice(1)) assert.deepEqual(signature, signatures[0]);
  const totalMs = Math.ceil(performance.now() - started);
  const maxMs = Math.ceil(Math.max(...durations));
  console.log(`PASS ${name} selftest: ${RUNS}/${RUNS} identical outcomes; max ${maxMs}ms; total ${totalMs}ms`);
}

/** @param {PipedChild} child @param {RegExp} pattern @param {number} [timeoutMs] @returns {Promise<string>} */
export function waitForOutput(child, pattern, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for process signal ${pattern}: ${tail(output)}`));
    }, timeoutMs);
    /** @param {Buffer | string} chunk */
    const onData = (chunk) => {
      output += chunk.toString();
      if (pattern.test(output)) {
        cleanup();
        resolve(output);
      }
    };
    /** @param {number | null} code */
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Process exited ${code} before signal ${pattern}: ${tail(output)}`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });
}

/** @param {string} script @param {string[]} [args] @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options] */
export function spawnNode(script, args = [], options = {}) {
  return spawn(process.execPath, [script, ...args], {
    cwd: options.cwd,
    env: options.env || process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** @param {import("node:child_process").ChildProcess} child @param {number} [timeoutMs] @returns {Promise<number | null>} */
export function waitForExit(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for child exit")), timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

export function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

export { assert, fs, path };
