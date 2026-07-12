/**
 * WHAT: A bounded poll loop. It cannot become immortal — it always exits when
 *   its watched target dies OR a deadline passes, whichever comes first.
 * WHY: Detached watch-loops (`while true; grep SENTINEL; sleep`) leak for days
 *   when the session that spawned them is suspended: the sentinel never fires,
 *   nothing owns the loop's death. SPL detects that class after the fact; this
 *   prevents it by construction — every monitor has a deadline and a liveness
 *   check, so a dead target reclaims the monitor with it.
 * HOW: runBoundedMonitor polls `onTick` every intervalMs. Each tick it also
 *   checks `isTargetAlive`; a false result ends the loop as `target-gone`, and
 *   exceeding maxMs ends it as `deadline`. onTick may return a truthy sentinel
 *   to end as `sentinel`. There is no code path that loops forever.
 * @example
 *   await runBoundedMonitor({
 *     intervalMs: 1000, maxMs: 30 * 60_000,
 *     isTargetAlive: () => platform.isAlive(childPid, startToken),
 *     onTick: () => existsSync(sentinelPath),
 *   });
 */

type MonitorReason = 'sentinel' | 'target-gone' | 'deadline';

export interface BoundedMonitorOptions {
  /** Poll cadence in milliseconds. */
  intervalMs: number;
  /** Hard deadline in milliseconds; the loop can never run longer than this. */
  maxMs: number;
  /** Called each tick; return truthy to stop with reason `sentinel`. */
  onTick: () => boolean | Promise<boolean>;
  /** Called each tick; a false result stops the loop with reason `target-gone`. Absent = always alive. */
  isTargetAlive?: () => boolean | Promise<boolean>;
  /** Optional sleeper (injectable for tests). Default sleeps real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional monotonic clock in ms (injectable for tests). Default performance.now(). */
  now?: () => number;
}

export interface BoundedMonitorResult { reason: MonitorReason; ticks: number; elapsed_ms: number }

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run a poll loop that is guaranteed to terminate. Never `while (true)`.
 */
export async function runBoundedMonitor(options: BoundedMonitorOptions): Promise<BoundedMonitorResult> {
  const { intervalMs, maxMs, onTick } = options;
  if (!(intervalMs > 0)) throw new Error('spl-monitor: intervalMs must be > 0');
  if (!(maxMs > 0)) throw new Error('spl-monitor: maxMs must be > 0');
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => performance.now());
  const isAlive = options.isTargetAlive ?? ((): boolean => true);

  const started = now();
  let ticks = 0;
  // Bounded by the deadline check below — this loop provably cannot run forever.
  for (;;) {
    ticks += 1;
    if (!(await isAlive())) return { reason: 'target-gone', ticks, elapsed_ms: now() - started };
    if (await onTick()) return { reason: 'sentinel', ticks, elapsed_ms: now() - started };
    const elapsed = now() - started;
    if (elapsed >= maxMs) return { reason: 'deadline', ticks, elapsed_ms: elapsed };
    // elapsed < maxMs here, so the remaining budget is always positive.
    await sleep(Math.min(intervalMs, maxMs - elapsed));
  }
}
