#!/usr/bin/env node
/**
 * WHAT: Exercises the central export policy against open, internal, closed, and unknown bricks.
 * WHY: A permissive default or visibility regression could publish restricted source through an automated path.
 * HOW: The test builds an in-memory license index and asserts allowed, blocked, and authorized outcomes.
 * Audit writes are disabled before the guard loads, so the test never changes the real export audit log.
 * A successful run prints the number of policy groups; failed assertions exit nonzero.
 * Usage: node tools/lib/export-guard-selftest.ts
 */
/**
 * Self-test for the export choke-point. Proves closed/private source cannot be
 * exported to a wider audience without an explicit acknowledgment, and that an
 * unresolved brick fails safe (treated as closed).
 * Run: node tools/lib/export-guard-selftest.ts
 */
import assert from 'node:assert/strict';
process.env.SMA_EXPORT_AUDIT_DISABLE = '1'; // do not append test runs to the real audit log
import { buildLicenseIndex } from './ledger-resolve.ts';
import { evaluateExport, assertExportAllowed, ExportBlockedError } from './export-guard.ts';

const index = buildLicenseIndex([
  { brick_id: 'open-1', project: 'p', spdx: 'MIT', openness: 'open', visibility: 'community' },
  { brick_id: 'internal-1', project: 'p', spdx: 'MIT', openness: 'open', visibility: 'internal' },
  { brick_id: 'closed-1', project: 'p', spdx: null, openness: 'closed', visibility: 'private' },
]);

let n = 0;
const ok = (name: string, fn: () => void): void => { fn(); n += 1; };

ok('closed brick blocked to community', () => {
  const r = evaluateExport({ brickIds: ['closed-1'], project: 'p', targetVisibility: 'community', index });
  assert.equal(r.ok, false);
  const codes = r.violations.map((v) => v.code);
  assert.ok(codes.includes('CLOSED_SOURCE_EXPORT'));
  assert.ok(codes.includes('VISIBILITY_ESCALATION'));
});

ok('unknown brick fails safe (treated closed)', () => {
  const r = evaluateExport({ brickIds: ['does-not-exist'], project: 'p', targetVisibility: 'community', index });
  assert.equal(r.ok, false);
  assert.equal(r.meet_openness, 'closed');
  assert.equal(r.components[0].resolved, false);
});

ok('internal brick blocked to community (visibility escalation)', () => {
  const r = evaluateExport({ brickIds: ['internal-1'], project: 'p', targetVisibility: 'community', index });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.code === 'VISIBILITY_ESCALATION'));
});

ok('community-visible open brick allowed to community', () => {
  const r = evaluateExport({ brickIds: ['open-1'], project: 'p', targetVisibility: 'community', index });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

ok('closed brick allowed to private (internal use)', () => {
  const r = evaluateExport({ brickIds: ['closed-1'], project: 'p', targetVisibility: 'private', index });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
});

ok('assertExportAllowed throws on closed→community, passes with allowClosed', () => {
  assert.throws(
    () => assertExportAllowed({ operation: 'test', brickIds: ['closed-1'], project: 'p', targetVisibility: 'community', index }),
    ExportBlockedError,
  );
  // explicit acknowledgment lets an authorized operator through
  const r = assertExportAllowed({ operation: 'test', brickIds: ['closed-1'], project: 'p', targetVisibility: 'community', allowClosed: true, index });
  assert.equal(r.meet_openness, 'closed');
});

console.log(`export-guard selftest: ${String(n)} groups passed`);
