#!/usr/bin/env node
/**
 * WHAT: Verifies that the pull-request workflow runs SMARCH's real local gate battery.
 * WHY: A syntax-only workflow can report green while type, secret, journey, and fixture gates are broken.
 * HOW: Reads the checked-in workflow and asserts every required action or command is present.
 * INPUTS: .github/workflows/gates.yml.
 * OUTPUTS: A single passing status line or a failing assertion.
 * CALLERS: Local verification and the gates workflow itself.
 * Usage: `node tools/gates-workflow-selftest.mjs`
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/gates.yml", import.meta.url), "utf8");

/** @type {Array<[RegExp, string]>} */
const required = [
  [/pull_request\s*:/, "pull_request trigger"],
  [/\brun:\s*npm ci\b/, "npm ci (reproducible install from the locked tree)"],
  [/\brun:\s*npm --prefix web ci\b/, "dashboard dependencies (the quality gate lints web/src with types)"],
  [/\brun:\s*npm run gate:quality\b/, "code-quality ratchet"],
  [/\brun:\s*npm run check\b/, "npm run check"],
  [/uses:\s*gitleaks\/gitleaks-action@v2\b/, "gitleaks action"],
  [/\brun:\s*node tools\/sma-leak-gate\.mjs\b/, "repository leak gate"],
  [/\brun:\s*node tools\/evals\/journeys\/index\.mjs\b/, "journeys index"],
  [/\brun:\s*node tools\/evals\/fixture-snapshot\.mjs --check\b/, "fixture snapshot check"],
  [/\brun:\s*node tools\/gen-public-ledger\.mjs\b/, "public ledger generation"],
  [/\brun:\s*node tools\/evals\/stranger-smoke\.mjs\b/, "stranger smoke test"],
];

for (const [pattern, label] of required) {
  assert.match(workflow, pattern, `gates.yml must include ${label}`);
}

console.log(`gates workflow selftest passed (${required.length} assertions)`);
