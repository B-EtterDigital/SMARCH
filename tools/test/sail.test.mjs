import test from 'node:test';
import assert from 'node:assert/strict';
import { clampCap, planAcquire, pruneRegistry } from '../lib/sail-registry.ts';

/** @returns {import('../lib/sail-registry.ts').SailRegistryData} */
function emptyRegistry() {
  return { version: 1, instances: [], queue: [], events: [] };
}

/** @param {Partial<import('../lib/sail-registry.ts').SailInstance>} overrides @returns {import('../lib/sail-registry.ts').SailInstance} */
function instanceFixture(overrides = {}) {
  return {
    instance_id: 'sail-inst-fixture', project: 'demo', pid: 4242, start_token: 'tok', port: 40000,
    cdp: 'http://127.0.0.1:40000', fingerprint: 'fp-AAA', state: 'IDLE', dirty: false, generation: 1,
    leases_served: 1, pool_lease_id: 'lease-pool', hud_pid: null, hud: { phase: 'idle', note: null },
    launched_by: 'agent-A', launched_at: new Date().toISOString(), last_activity: new Date().toISOString(),
    checkout: null,
    ...overrides,
  };
}

/** @param {Partial<import('../lib/sail-registry.ts').SailAcquireRequest>} overrides @returns {import('../lib/sail-registry.ts').SailAcquireRequest} */
function requestFixture(overrides = {}) {
  return { project: 'demo', agent: 'agent-B', intent: 'test', fingerprint: 'fp-AAA', fresh: false, cap: 2, ticketId: null, waiting: false, ...overrides };
}

const alwaysAlivePlatform = /** @type {import('../lib/spl-platform/contract.ts').SplPlatform} */ ({
  startToken: () => 'tok',
  sessionId: () => 1,
  isAlive: () => true,
  terminate: async () => ({ outcome: 'terminated' }),
  budgetSnapshot: () => ({ cores: 8, load: 0, mem_available_gb: 16, swap_used_pct: 0, pressure: 'ok', recommended_agents: 4 }),
});

test('planAcquire reuses only a clean matching-fingerprint idle instance', () => {
  const data = emptyRegistry();
  data.instances.push(instanceFixture());
  const reuse = planAcquire(data, requestFixture(), 60);
  assert.equal(reuse.kind, 'reuse');

  data.instances[0].dirty = true;
  const dirtyPlan = planAcquire(data, requestFixture({ cap: 1 }), 60);
  assert.equal(dirtyPlan.kind, 'recycle');

  data.instances[0].dirty = false;
  data.instances[0].fingerprint = 'fp-STALE';
  const stalePlan = planAcquire(data, requestFixture({ cap: 1 }), 60);
  assert.equal(stalePlan.kind, 'recycle');
});

test('planAcquire launches below cap and queues at cap with strict FIFO (no barging)', () => {
  const data = emptyRegistry();
  data.instances.push(instanceFixture({ instance_id: 'inst-1', state: 'LEASED' }));
  assert.equal(planAcquire(data, requestFixture(), 60).kind, 'launch');

  data.instances.push(instanceFixture({ instance_id: 'inst-2', state: 'LEASED' }));
  const queued = planAcquire(data, requestFixture(), 60);
  assert.equal(queued.kind, 'queue');
  assert.equal(data.queue.length, 1);

  // A released idle instance appears, but a newcomer must still queue behind the ticket.
  data.instances[0].state = 'IDLE';
  const newcomer = planAcquire(data, requestFixture({ agent: 'barger' }), 60);
  assert.equal(newcomer.kind, 'queue');
  assert.equal(data.queue.length, 2);
  assert.equal(data.queue[0].agent, 'agent-B');

  // The head ticket holder takes the instance; the barger stays queued.
  const headTicket = data.queue[0].ticket_id;
  const served = planAcquire(data, requestFixture({ ticketId: headTicket, waiting: true }), 60);
  assert.equal(served.kind, 'reuse');
});

test('pruneRegistry marks an instance dirty when its checkout lease is no longer live', () => {
  const data = emptyRegistry();
  data.instances.push(instanceFixture({
    state: 'LEASED',
    checkout: { lease_id: 'lease-gone', agent: 'agent-A', intent: 'test', acquired_at: new Date().toISOString(), ttl_s: 60, generation: 1 },
  }));
  const result = pruneRegistry(data, alwaysAlivePlatform, new Set(['some-other-lease']));
  assert.equal(result.expiredCheckouts.length, 1);
  assert.equal(data.instances[0].state, 'IDLE');
  assert.equal(data.instances[0].dirty, true);
  assert.equal(data.instances[0].checkout, null);
});

test('pruneRegistry drops instances whose process identity died and expired tickets', () => {
  const deadPlatform = /** @type {import('../lib/spl-platform/contract.ts').SplPlatform} */ ({ ...alwaysAlivePlatform, isAlive: () => false });
  const data = emptyRegistry();
  data.instances.push(instanceFixture());
  data.queue.push({ ticket_id: 't1', project: 'demo', agent: 'a', intent: 'i', fingerprint: 'fp', enqueued_at: new Date().toISOString(), expires_at: new Date(Date.now() - 1000).toISOString() });
  const result = pruneRegistry(data, deadPlatform, new Set());
  assert.equal(result.removedDead.length, 1);
  assert.equal(data.instances.length, 0);
  assert.equal(data.queue.length, 0);
});

test('clampCap honors the declared cap, the 1..4 bound, the machine budget, and the opt-out', () => {
  assert.equal(clampCap({ cwd: '.', argv: [], cap: 3 }, 4), 3);
  assert.equal(clampCap({ cwd: '.', argv: [], cap: 9 }, 8), 4);
  assert.equal(clampCap({ cwd: '.', argv: [], cap: 3 }, 1), 1);
  assert.equal(clampCap({ cwd: '.', argv: [], cap: 3, budget_clamp: false }, 1), 3);
});
