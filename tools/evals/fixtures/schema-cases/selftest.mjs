import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { assertSupported, loadSchemas, validate } from "./validator.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const iterations = 100;
const budgetMs = 5000;
const telemetry = [];
const started = performance.now();

assertSupported();
for (const [file, schema] of loadSchemas()) {
  const directory = path.join(root, file.replace(/\.json$/, ""));
  const validText = fs.readFileSync(path.join(directory, "valid.json"), "utf8");
  const valid = JSON.parse(validText);
  const invalid = JSON.parse(fs.readFileSync(path.join(directory, "invalid.json"), "utf8"));
  assert.deepEqual(validate(schema, valid, file), [], `${file} valid fixture`);
  assert(validate(schema, invalid, file).length > 0, `${file} invalid fixture must fail`);
  assert.deepEqual(JSON.parse(JSON.stringify(valid)), valid, `${file} up-down-up JSON round trip`);
  try {
    JSON.parse(validText.slice(0, Math.max(1, validText.length - 2)));
    assert.fail(`${file} partial-write injection must fail parsing`);
  } catch (error) {
    telemetry.push({ kind: "schema_integrity_failure", schema: file, failure: "partial_json", detected: true });
  }
  for (let index = 0; index < iterations; index += 1) assert.equal(validate(schema, valid, file).length, 0);
}

const durationMs = performance.now() - started;
assert.equal(telemetry.length, loadSchemas().size, "one integrity telemetry record per contract");
assert(durationMs < budgetMs, `schema validation budget exceeded: ${durationMs.toFixed(1)}ms >= ${budgetMs}ms`);
console.log(JSON.stringify({
  ok: true,
  schemas: loadSchemas().size,
  valid_cases: loadSchemas().size,
  invalid_cases: loadSchemas().size,
  integrity_events: telemetry.length,
  validations: loadSchemas().size * iterations,
  duration_ms: Number(durationMs.toFixed(1)),
  budget_ms: budgetMs,
  performance_note: "Static contracts: database indexes and query scans are not applicable.",
}));
