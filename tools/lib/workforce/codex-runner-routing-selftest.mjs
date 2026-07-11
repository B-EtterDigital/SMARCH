#!/usr/bin/env node

import assert from "node:assert/strict";
import { internals } from "../codex-runner.mjs";

async function selftest() {
  assert.equal(
    typeof internals.dispatchCodex,
    "function",
    "codex-runner must expose its workforce dispatch seam",
  );

  let received;
  const result = await internals.dispatchCodex({
    prompt: "Reply with PONG.",
    schemaPath: "/tmp/sma-codex-schema.json",
    model: "policy-model",
    timeoutMs: 12_345,
  }, async (packet, options) => {
    received = { packet, options };
    return {
      ok: true,
      output: '{"reply":"PONG"}',
      tokensIn: 4,
      tokensOut: 2,
      raw: { backend: "codex", stderr: "" },
    };
  });

  assert.deepEqual(received, {
    packet: "Reply with PONG.",
    options: {
      backend: "codex",
      model: "policy-model",
      schema: "/tmp/sma-codex-schema.json",
      readOnly: true,
      timeoutMs: 12_345,
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.output, '{"reply":"PONG"}');
  assert.equal(result.stderr, "");
  assert.equal(Number.isFinite(result.durationMs), true);
  console.log("codex runner workforce routing selftest: ok");
}

selftest().catch((error) => {
  console.error(`codex runner workforce routing selftest: ${error.message}`);
  process.exitCode = 1;
});
