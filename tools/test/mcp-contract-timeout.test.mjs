import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { runReleaseInstall } from "../lib/mcp-release-install-client.mjs";
import { executeTool } from "../mcp/contract.mjs";

const emptySchema = { type: "object", properties: {}, additionalProperties: false };

test("executeTool aborts cooperative asynchronous work before reporting MCP_TIMEOUT", async () => {
  let completed = false;
  let aborted = false;

  await assert.rejects(executeTool({
    name: "async-timeout-fixture",
    inputSchema: emptySchema,
    args: {},
    timeoutMs: 10,
    operation: async (_input, signal) => new Promise((resolve, reject) => {
      const completion = setTimeout(() => {
        completed = true;
        resolve("late-success");
      }, 100);
      signal.addEventListener("abort", () => {
        aborted = true;
        clearTimeout(completion);
        reject(signal.reason);
      }, { once: true });
    }),
  }), { code: "MCP_TIMEOUT" });

  await delay(120);
  assert.equal(aborted, true);
  assert.equal(completed, false, "timed-out work must not complete in the background");
});

test("executeTool never returns success for synchronous work that exceeds its deadline", async () => {
  await assert.rejects(executeTool({
    name: "sync-timeout-fixture",
    inputSchema: emptySchema,
    args: {},
    timeoutMs: 10,
    operation: async () => {
      const deadline = performance.now() + 150;
      while (performance.now() < deadline) {
        // Deliberately block to reproduce the defensive-review finding.
      }
      return "late-success";
    },
  }), { code: "MCP_TIMEOUT" });
});

test("blocking store/clone work is killed and reaped before MCP_TIMEOUT returns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-mcp-blocking-worker-"));
  const worker = path.join(root, "worker.mjs");
  await writeFile(worker, `
import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  JSON.parse(line);
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {}
}
`);
  try {
    const started = performance.now();
    await assert.rejects(executeTool({
      name: "blocking-subprocess-fixture",
      inputSchema: emptySchema,
      args: {},
      timeoutMs: 25,
      waitForTermination: true,
      operation: async (_input, signal) => runReleaseInstall({}, signal, worker),
    }), { code: "MCP_TIMEOUT" });
    assert.ok(performance.now() - started < 750, "timeout must wait for termination, not for blocking work");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
