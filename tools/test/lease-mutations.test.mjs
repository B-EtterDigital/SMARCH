import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const LEASE_CLI = path.resolve("tools/sma-lease.ts");

/** @param {string} registry @param {string[]} args @param {NodeJS.ProcessEnv} [env] */
function leaseCommand(registry, args, env = {}) {
  return spawnSync(process.execPath, [LEASE_CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, SMA_LEASE_REGISTRY_PATH: registry, USER: "fixture-user", ...env },
  });
}

/** @param {import("node:child_process").SpawnSyncReturns<string>} result @returns {any} */
function jsonResult(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("lease renew extends ownership and release rejects the wrong actor", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-lease-renew-"));
  const registry = path.join(root, "leases.json");
  try {
    const acquired = jsonResult(leaseCommand(registry, ["acquire", "--resource-kind", "brick", "--resource", "trust", "--agent", "owner", "--intent", "test renew", "--ttl", "30", "--json"]));
    const renewed = jsonResult(leaseCommand(registry, ["renew", "--lease", acquired.lease_id, "--ttl", "120", "--json"]));
    assert.equal(renewed.renewals, 1);
    assert.ok(Date.parse(renewed.expires_at) > Date.parse(acquired.expires_at));
    assert.ok(renewed.renewed_at);

    const wrongOwner = leaseCommand(registry, ["release", "--lease", acquired.lease_id, "--agent", "intruder"]);
    assert.equal(wrongOwner.status, 13);
    assert.match(wrongOwner.stderr, /lease owner mismatch/);
    const released = jsonResult(leaseCommand(registry, ["release", "--lease", acquired.lease_id, "--agent", "owner", "--json"]));
    assert.equal(released.lease_id, acquired.lease_id);
    assert.deepEqual(jsonResult(leaseCommand(registry, ["list", "--json"])), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("force-acquire records the displaced lease and its human reason", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-lease-force-"));
  const registry = path.join(root, "leases.json");
  try {
    const original = jsonResult(leaseCommand(registry, ["acquire", "--resource-kind", "brick", "--resource", "shared", "--agent", "first", "--intent", "original work", "--json"]));
    const conflict = leaseCommand(registry, ["acquire", "--resource-kind", "brick", "--resource", "shared", "--agent", "second", "--intent", "overlap", "--json"]);
    assert.equal(conflict.status, 10);
    assert.match(conflict.stderr, /resource is leased/);

    const forced = jsonResult(leaseCommand(registry, ["force-acquire", "--resource-kind", "brick", "--resource", "shared", "--agent", "controller", "--intent", "recover ownership", "--reason", "stale handoff approved", "--json"]));
    assert.equal(forced.force_acquired_from, original.lease_id);
    assert.equal(forced.force_acquired_reason, "stale handoff approved");
    const rows = jsonResult(leaseCommand(registry, ["list", "--include-expired", "--json"]));
    assert.deepEqual(rows.map((/** @type {{lease_id: string}} */ entry) => entry.lease_id), [forced.lease_id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expire removes only elapsed leases and renew refuses an elapsed lease", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-lease-expire-"));
  const registry = path.join(root, "leases.json");
  try {
    const expired = {
      lease_id: "lease-expired", resource_kind: "brick", resource_id: "old", agent_id: "owner",
      acquired_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-01T00:00:01Z", renewals: 0, intent: "expired",
    };
    const active = { ...expired, lease_id: "lease-active", resource_id: "live", expires_at: new Date(Date.now() + 600_000).toISOString() };
    await writeFile(registry, JSON.stringify({ schema_version: "1.0.0", generated_at: "2026-01-01T00:00:00Z", leases: [expired, active] }));
    const renew = leaseCommand(registry, ["renew", "--lease", expired.lease_id, "--ttl", "60", "--json"]);
    assert.equal(renew.status, 12);
    assert.match(renew.stderr, /not found \(or already expired\)/);
    const expiredResult = leaseCommand(registry, ["expire"]);
    assert.equal(expiredResult.status, 0, expiredResult.stderr);
    assert.match(expiredResult.stdout, /removed 1 lease\(s\)/);
    const rows = jsonResult(leaseCommand(registry, ["list", "--include-expired", "--json"]));
    assert.deepEqual(rows.map((/** @type {{lease_id: string}} */ entry) => entry.lease_id), [active.lease_id]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dead stale registry lock is recovered before mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-lease-stale-lock-"));
  const registry = path.join(root, "leases.json");
  const lock = `${registry}.lock`;
  try {
    await mkdir(lock, { recursive: true });
    await writeFile(path.join(lock, "owner.json"), JSON.stringify({ token: "dead", pid: 999_999_999, acquired_at: "2020-01-01T00:00:00Z" }));
    const old = new Date(Date.now() - 120_000);
    await utimes(lock, old, old);
    const acquired = jsonResult(leaseCommand(registry, ["acquire", "--resource-kind", "other", "--resource", "recovered", "--agent", "owner", "--intent", "recover stale lock", "--json"], { SMA_LEASE_LOCK_STALE_MS: "10" }));
    assert.equal(acquired.resource_id, "recovered");
    const stored = JSON.parse(await readFile(registry, "utf8"));
    assert.equal(stored.leases[0].lease_id, acquired.lease_id);
    await assert.rejects(readFile(path.join(lock, "owner.json")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
