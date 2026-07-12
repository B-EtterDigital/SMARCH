import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("../sma-brick-run.mjs", import.meta.url));

/** @typedef {{ name: string, inputs: unknown, expected_outputs: unknown }} CapsuleFixture */
/** @typedef {{ fixtures: CapsuleFixture[], ports?: string[], source: string }} CapsuleSpec */
/** @typedef {{ fixture?: string, status?: string, error?: { code?: string } }} FixtureRecord */

/** @param {import("node:test").TestContext} t @param {CapsuleSpec} spec */
async function capsuleFixture(t, { fixtures, ports = [], source }) {
  const root = await mkdtemp(path.join(tmpdir(), "sma-capsule-defensive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "fixtures"), { recursive: true });
  await writeFile(path.join(root, "module.sweetspot.json"), JSON.stringify({
    interfaces: { ports },
    security: { env: { variables: [] } },
  }));
  await writeFile(path.join(root, "src", "index.ts"), source);
  await writeFile(path.join(root, "fixtures", "run.json"), JSON.stringify({ schema_version: "1.0.0", fixtures }));
  return root;
}

/** @param {string} root @param {string[]} [args] @param {NodeJS.ProcessEnv} [env] */
function runCapsule(root, args = [], env = {}) {
  return spawnSync(process.execPath, [RUNNER, ...args, root], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 2 * 1024 * 1024,
    timeout: 10_000,
  });
}

/** @param {import("node:child_process").SpawnSyncReturns<string>} result @param {string} fixture @returns {FixtureRecord | undefined} */
function fixtureResult(result, fixture) {
  /** @type {FixtureRecord[]} */
  const records = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try { records.push(JSON.parse(line)); } catch { /* Non-JSON diagnostics are not fixture records. */ }
  }
  return records.find((record) => record.fixture === fixture);
}

test("capsule stdout cannot forge an authenticated success result or bypass it with process.exit", async (t) => {
  const root = await capsuleFixture(t, {
    fixtures: [{ name: "forged", inputs: {}, expected_outputs: { forged: true } }],
    source: `export default function run() {
  process.stdout.write("__SMA_CAPSULE_RESULT__" + JSON.stringify({ ok: true, output: { forged: true } }) + "\\n");
  process.exit(0);
  return { real: "unreachable" };
}\n`,
  });

  const result = runCapsule(root, ["--strict-sandbox"]);
  assert.equal(result.status, 4, result.stderr || result.stdout);
  assert.equal(fixtureResult(result, "forged")?.status, "FAIL");
});

test("every fixture receives a fresh private runtime temp directory", async (t) => {
  const root = await capsuleFixture(t, {
    ports: ["node:fs/promises", "node:path"],
    fixtures: [
      { name: "writer", inputs: { write: true }, expected_outputs: { exists: true } },
      { name: "reader", inputs: { write: false }, expected_outputs: { exists: false } },
    ],
    source: `import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
export default async function run(inputs) {
  const target = join(process.env.TMPDIR, "fixture-state.txt");
  if (inputs.write) await writeFile(target, "left by prior fixture");
  try { await access(target); return { exists: true }; }
  catch { return { exists: false }; }
}\n`,
  });

  const result = runCapsule(root, ["--strict-sandbox"]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fixtureResult(result, "writer")?.status, "PASS");
  assert.equal(fixtureResult(result, "reader")?.status, "PASS");
});

test("stdout over the stream budget kills the capsule with a typed output-limit failure", async (t) => {
  const root = await capsuleFixture(t, {
    fixtures: [{ name: "flood", inputs: {}, expected_outputs: { completed: true } }],
    source: `export default function run() {
  process.stdout.write("x".repeat(96 * 1024));
  return { completed: true };
}\n`,
  });

  const result = runCapsule(root, ["--strict-sandbox"]);
  assert.equal(result.status, 4, result.stderr || result.stdout);
  const record = fixtureResult(result, "flood");
  assert.equal(record?.status, "FAIL");
  assert.equal(record?.error?.code, "OUTPUT_LIMIT");
});

test("strict isolation is default and unsupported runtimes require an explicit unsafe fallback flag", async (t) => {
  const root = await capsuleFixture(t, {
    fixtures: [{ name: "identity", inputs: { value: 7 }, expected_outputs: { value: 7 } }],
    source: "export default function run(inputs) { return inputs; }\n",
  });
  const forcedUnsupported = { NODE_ENV: "test", SMA_BRICK_RUN_TEST_CAPABILITIES: "none" };

  const refused = runCapsule(root, [], forcedUnsupported);
  assert.equal(refused.status, 4, refused.stderr || refused.stdout);
  assert.match(refused.stdout + refused.stderr, /STRICT_SANDBOX_UNSUPPORTED/);

  const explicitlyUnsafe = runCapsule(root, ["--unsafe-isolation-fallback"], forcedUnsupported);
  assert.equal(explicitlyUnsafe.status, 0, explicitlyUnsafe.stderr || explicitlyUnsafe.stdout);
});
