#!/usr/bin/env node
import assert from "node:assert/strict";
import { parseJsonEvents } from "./opencode.mjs";

const parsed = parseJsonEvents([
  JSON.stringify({ type: "step_start", sessionID: "ses-test", usage: { input: 11, output: 0 } }),
  JSON.stringify({ type: "text", part: { text: "PONG", usage: { input: 0, output: 3 } } }),
].join("\n"));
assert.equal(parsed.sessionId, "ses-test");
assert.equal(parsed.output, "PONG");
assert.equal(parsed.tokensIn, 11);
assert.equal(parsed.tokensOut, 3);
console.log("workforce opencode selftest: ok");
