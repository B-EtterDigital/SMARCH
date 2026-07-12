import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** @typedef {import("node:child_process").ChildProcessByStdio<null, import("node:stream").Readable, import("node:stream").Readable>} LeaseChildProcess */
/** @typedef {import("node:child_process").SpawnSyncReturns<string>} StringSpawnResult */
/** @typedef {{ lease_id?: string, agent_id?: string }} LeaseRecord */
/** @typedef {{ leases?: LeaseRecord[] }} LeaseRegistry */
/** @typedef {{ event_id?: string, intent?: string }} ContextEvent */
/** @typedef {{ child: LeaseChildProcess, output: () => { stdout: string, stderr: string } }} LeaseHandle */

const LEASE_CLI = path.resolve("tools/sma-lease.ts");
const CONFLICT_CLI = path.resolve("tools/sma-conflict.ts");
const NORMALIZE_CLI = path.resolve("tools/sma-context-normalize.ts");
const CONTEXT_LOG_URL = new URL("../lib/context-log.ts", import.meta.url).href;

/** @param {string} file @param {string[]} args @param {NodeJS.ProcessEnv} [env] @returns {StringSpawnResult} */
function cli(file, args, env = {}) {
  return spawnSync(process.execPath, [file, ...args], {
    encoding: "utf8",
    env: { ...process.env, USER: "fixture-user", ...env },
  });
}

/** @param {StringSpawnResult} result @returns {Record<string, unknown>} */
function jsonResult(result) {
  assert.equal(result.status, 0, result.stderr);
  return /** @type {Record<string, unknown>} */ (JSON.parse(result.stdout));
}

/** @template T @param {() => Promise<T | null | undefined | false>} predicate @param {number} [timeoutMs] @returns {Promise<T>} */
async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

/** @param {string} registry @returns {Promise<LeaseRegistry | null>} */
async function readRegistry(registry) {
  try {
    return /** @type {LeaseRegistry} */ (JSON.parse(await readFile(registry, "utf8")));
  } catch {
    return null;
  }
}

/** @param {string} registry @param {string[]} args @returns {LeaseHandle} */
function spawnLease(registry, args) {
  const child = spawn(process.execPath, [LEASE_CLI, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SMA_LEASE_REGISTRY_PATH: registry, USER: "fixture-user" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  return { child, output: () => ({ stdout, stderr }) };
}

/** @param {LeaseHandle} handle @param {number} [timeoutMs] */
async function closeResult(handle, timeoutMs = 5000) {
  return await Promise.race([
    new Promise((resolve) => handle.child.once("close", (code, signal) => resolve({ code, signal, ...handle.output() }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`child did not close; ${JSON.stringify(handle.output())}`)), timeoutMs)),
  ]);
}

test("conflict resolve requires an open conflict event id and resolves only that event", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-conflict-id-"));
  const env = { SMA_ROOT: root, SMA_AGENT: "reviewer" };
  try {
    const first = /** @type {ContextEvent} */ (jsonResult(cli(CONFLICT_CLI, ["report", "--project", "sma", "--brick", "coord", "--intent", "first overlap", "--json"], env)).event);
    const second = /** @type {ContextEvent} */ (jsonResult(cli(CONFLICT_CLI, ["report", "--project", "sma", "--brick", "coord", "--intent", "second overlap", "--json"], env)).event);
    assert.equal(typeof first.event_id, "string");
    assert.equal(typeof second.event_id, "string");
    const firstId = /** @type {string} */ (first.event_id);
    const secondId = /** @type {string} */ (second.event_id);

    const missingId = cli(CONFLICT_CLI, ["resolve", "--project", "sma", "--brick", "coord", "--intent", "ambiguous resolution"], env);
    assert.notEqual(missingId.status, 0);
    assert.match(missingId.stderr, /missing --conflict/);

    jsonResult(cli(CONFLICT_CLI, ["resolve", "--project", "sma", "--brick", "coord", "--conflict", secondId, "--intent", "resolve newer overlap", "--json"], env));
    const open = /** @type {ContextEvent[]} */ (jsonResult(cli(CONFLICT_CLI, ["list", "--project", "sma", "--brick", "coord", "--open", "--json"], env)).open);
    assert.deepEqual(open.map((event) => event.event_id), [firstId]);

    const duplicate = cli(CONFLICT_CLI, ["resolve", "--project", "sma", "--brick", "coord", "--conflict", secondId, "--intent", "duplicate resolution"], env);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr, /not an open conflict/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wrapped lease terminates its child when renewal ownership is displaced", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-lease-displaced-"));
  const registry = path.join(root, "leases.json");
  const childScript = "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},50)";
  const handle = spawnLease(registry, [
    "run", "--resource-kind", "brick", "--resource", "guarded", "--agent", "owner",
    "--intent", "guard wrapped mutation", "--ttl", "3", "--renew-every", "0.2",
    "--", process.execPath, "--eval", childScript,
  ]);
  try {
    const original = await waitFor(async () => (await readRegistry(registry))?.leases?.[0]);
    jsonResult(cli(LEASE_CLI, [
      "force-acquire", "--resource-kind", "brick", "--resource", "guarded", "--agent", "controller",
      "--intent", "displace stale owner", "--reason", "defensive review fixture", "--ttl", "30", "--json",
    ], { SMA_LEASE_REGISTRY_PATH: registry }));
    const result = await closeResult(handle, 2500);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /renew failed|ownership lost/);
    const stored = await readRegistry(registry);
    assert.equal(stored?.leases?.some((lease) => lease.lease_id === original.lease_id), false);
    assert.equal(stored?.leases?.some((lease) => lease.agent_id === "controller"), true);
  } finally {
    if (handle.child.exitCode === null) handle.child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("wrapped lease keeps ownership until a signal-delaying child has terminated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-lease-signal-"));
  const registry = path.join(root, "leases.json");
  const ready = path.join(root, "child-ready");
  const childScript = `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),700));setInterval(()=>{},50)`;
  const handle = spawnLease(registry, [
    "run", "--resource-kind", "brick", "--resource", "signal-guarded", "--agent", "owner",
    "--intent", "retain ownership through shutdown", "--ttl", "2", "--renew-every", "0.2",
    "--", process.execPath, "--eval", childScript,
  ]);
  try {
    const original = await waitFor(async () => (await readRegistry(registry))?.leases?.[0]);
    await waitFor(async () => access(ready).then(() => true, () => false));
    handle.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const duringShutdown = await readRegistry(registry);
    assert.equal(duringShutdown?.leases?.some((lease) => lease.lease_id === original.lease_id), true);
    await closeResult(handle, 3000);
    const afterShutdown = await readRegistry(registry);
    assert.equal(afterShutdown?.leases?.some((lease) => lease.lease_id === original.lease_id), false);
  } finally {
    if (handle.child.exitCode === null) handle.child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("context normalization cannot lose an append racing its rewrite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-context-race-"));
  const contextDir = path.join(root, ".smarch", "agent-context");
  const log = path.join(contextDir, "race.ndjson");
  await mkdir(contextDir, { recursive: true });
  const legacy = JSON.stringify({ ts: "2026-01-01T00:00:00Z", brick: "race", status: "pass", proof: ["ok"] });
  await writeFile(log, `${Array.from({ length: 10000 }, () => legacy).join("\n")}\n`);
  const normalizer = spawn(process.execPath, [NORMALIZE_CLI, "--project", "sma", "--brick", "race", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, SMA_ROOT: root, USER: "fixture-user" },
  });
  let normalizeStdout = "";
  let normalizeStderr = "";
  normalizer.stdout.on("data", (chunk) => { normalizeStdout += chunk; });
  normalizer.stderr.on("data", (chunk) => { normalizeStderr += chunk; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const append = spawnSync(process.execPath, [
      "--input-type=module", "--eval",
      `const m=await import(${JSON.stringify(CONTEXT_LOG_URL)});m.appendContextEvent({project:'sma',brick:'race',kind:'note',intent:'append survives normalize',actorId:'writer'});`,
    ], { encoding: "utf8", env: { ...process.env, USER: "fixture-user", SMA_ROOT: root } });
    assert.equal(append.status, 0, append.stderr);
    const normalizeResult = await new Promise((resolve) => normalizer.once("close", (code) => resolve({ code })));
    assert.equal(normalizeResult.code, 0, normalizeStderr || normalizeStdout);
    const records = (await readFile(log, "utf8")).trim().split("\n").map((line) => /** @type {ContextEvent} */ (JSON.parse(line)));
    assert.equal(records.some((event) => event.intent === "append survives normalize"), true);
    assert.equal(records.length, 10001);
  } finally {
    if (normalizer.exitCode === null) normalizer.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
