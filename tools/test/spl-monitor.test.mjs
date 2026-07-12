import assert from 'node:assert/strict';
import test from 'node:test';
import { runBoundedMonitor } from '../lib/spl-monitor.ts';

// A deterministic fake clock + sleeper so tests never wait real time.
function fakeTime() {
  let t = 0;
  return { now: () => t, sleep: (/** @type {number} */ ms) => { t += ms; return Promise.resolve(); } };
}

test('exits at the deadline when the sentinel never fires (the overnight-orphan case)', async () => {
  const { now, sleep } = fakeTime();
  const result = await runBoundedMonitor({
    intervalMs: 1000, maxMs: 5000,
    onTick: () => false,          // sentinel never arrives
    now, sleep,
  });
  assert.equal(result.reason, 'deadline');
  assert.ok(result.elapsed_ms >= 5000, 'must not exceed nor undershoot the deadline');
  assert.ok(result.ticks <= 6, 'bounded number of ticks');
});

test('exits immediately when the watched target is already gone', async () => {
  const { now, sleep } = fakeTime();
  const result = await runBoundedMonitor({
    intervalMs: 1000, maxMs: 60_000,
    isTargetAlive: () => false,   // lane/pid already dead
    onTick: () => false,
    now, sleep,
  });
  assert.equal(result.reason, 'target-gone');
  assert.equal(result.ticks, 1);
});

test('stops when the sentinel fires', async () => {
  const { now, sleep } = fakeTime();
  let calls = 0;
  const result = await runBoundedMonitor({
    intervalMs: 1000, maxMs: 60_000,
    onTick: () => { calls += 1; return calls >= 3; },
    now, sleep,
  });
  assert.equal(result.reason, 'sentinel');
  assert.equal(result.ticks, 3);
});

test('target death is checked before the sentinel each tick', async () => {
  const { now, sleep } = fakeTime();
  let alive = 2;
  const result = await runBoundedMonitor({
    intervalMs: 1000, maxMs: 60_000,
    isTargetAlive: () => { alive -= 1; return alive > 0; },
    onTick: () => true,           // sentinel would fire, but target dies first on tick 2
    now, sleep,
  });
  assert.equal(result.reason, 'sentinel'); // tick 1: alive(1>0) true, sentinel true -> stops tick 1
  assert.equal(result.ticks, 1);
});

test('rejects an unbounded configuration (no immortal loops)', async () => {
  await assert.rejects(runBoundedMonitor({ intervalMs: 0, maxMs: 1000, onTick: () => false }));
  await assert.rejects(runBoundedMonitor({ intervalMs: 100, maxMs: 0, onTick: () => false }));
});

test('real timers: exits by the deadline without injected fakes', async () => {
  const started = performance.now();
  const result = await runBoundedMonitor({
    intervalMs: 2, maxMs: 12,   // real setTimeout + performance.now paths
    onTick: () => false,
  });
  assert.equal(result.reason, 'deadline');
  assert.ok(performance.now() - started >= 10, 'ran at least until the deadline in real time');
  assert.ok(result.ticks >= 2 && result.ticks <= 20, 'a small, bounded number of real ticks');
});
