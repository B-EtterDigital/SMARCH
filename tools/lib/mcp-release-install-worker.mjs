import { installRelease } from "../sma-store.ts";
import { createInterface } from "node:readline";

/** @param {unknown} error */
function errorPayload(error) {
  return {
    code: error && typeof error === "object" && "code" in error ? error.code : "MCP_INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "The release install worker failed",
    ...(error && typeof error === "object" && "details" in error ? { details: error.details } : {}),
  };
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
/** @type {ReturnType<typeof setTimeout> | undefined} */
let idleTimer;

function armIdleExit() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => process.exit(0), 2_000);
  idleTimer.unref();
}

for await (const line of input) {
  clearTimeout(idleTimer);
  let response;
  try {
    const request = JSON.parse(line);
    response = { id: request.id, ok: true, value: installRelease(request.options) };
  } catch (error) {
    let id = null;
    try { id = JSON.parse(line).id; } catch { /* malformed input */ }
    response = { id, ok: false, error: errorPayload(error) };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
  armIdleExit();
}
