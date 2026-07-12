#!/usr/bin/env node
/**
 * WHAT: Exercises license classification, restrictive combination, and composition-policy decisions.
 * WHY: A ranking or default regression could make a build appear more open or visible than its components permit.
 * HOW: The test supplies permissive, reciprocal, proprietary, private, and unknown component combinations.
 * It asserts both allowed declarations and the violations produced for attempted escalation.
 * A successful run prints the number of test groups; failed assertions exit nonzero.
 * License abbreviations are defined in docs/GLOSSARY.md.
 * Usage: node tools/lib/license-lattice-selftest.ts
 */
/**
 * Self-test for the license lattice. Asserts the monotonic rule holds:
 * a composed build can never be more open/visible than its bricks permit.
 * Run: node tools/lib/license-lattice-selftest.ts
 */
import assert from 'node:assert/strict';
import {
  classifyLicense, meetOpenness, meetVisibility, checkComposition, combineLicenses,
} from './license-lattice.ts';

let n = 0;
const ok = (name: string, fn: () => void): void => { fn(); n += 1; };

ok('classify: permissive/copyleft/proprietary/unknown', () => {
  assert.equal(classifyLicense('MIT').openness, 'open');
  assert.equal(classifyLicense('MIT').class, 'permissive');
  assert.equal(classifyLicense('AGPL-3.0').class, 'network-copyleft');
  assert.equal(classifyLicense('GPL-3.0').copyleft, 2);
  assert.equal(classifyLicense('proprietary').openness, 'closed');
  assert.equal(classifyLicense(null).openness, 'closed'); // fail-safe
  assert.equal(classifyLicense('some-weird-thing').openness, 'closed'); // fail-safe
  assert.equal(classifyLicense('BUSL-1.1').openness, 'source-available');
});

ok('meet is the most restrictive', () => {
  assert.equal(meetOpenness(['open', 'closed', 'open']), 'closed');
  assert.equal(meetOpenness(['open', 'source-available']), 'source-available');
  assert.equal(meetOpenness(['open', 'open']), 'open');
  assert.equal(meetVisibility(['public', 'internal', 'private']), 'private');
  assert.equal(meetVisibility(['public', 'community']), 'community');
});

ok('BLOCK: public build derived from a closed brick', () => {
  const res = checkComposition(
    { visibility: 'public', license: 'MIT', publishable: true, has_attribution: true },
    [
      { brick_id: 'a', spdx: 'MIT', openness: 'open', visibility: 'public' },
      { brick_id: 'b', spdx: 'proprietary', openness: 'closed', visibility: 'private' },
    ],
  );
  assert.equal(res.ok, false);
  const codes = res.violations.map((v) => v.code);
  assert.ok(codes.includes('VISIBILITY_ESCALATION'));
  assert.ok(codes.includes('OPENNESS_ESCALATION'));
  assert.ok(codes.includes('CLOSED_SOURCE_PUBLISH'));
  assert.equal(res.effective.openness, 'closed');
  assert.equal(res.effective.visibility, 'private');
});

ok('PASS: internal build from all-open bricks', () => {
  const res = checkComposition(
    { visibility: 'internal', license: 'MIT', publishable: false, has_attribution: true },
    [
      { brick_id: 'a', spdx: 'MIT', openness: 'open', visibility: 'internal' },
      { brick_id: 'b', spdx: 'Apache-2.0', openness: 'open', visibility: 'community' },
    ],
  );
  assert.equal(res.ok, true, JSON.stringify(res.violations));
});

ok('BLOCK: copyleft not honored by a proprietary declaration', () => {
  const res = checkComposition(
    { visibility: 'internal', license: 'proprietary', publishable: false },
    [{ brick_id: 'g', spdx: 'GPL-3.0', openness: 'open', visibility: 'internal' }],
  );
  const codes = res.violations.map((v) => v.code);
  assert.ok(codes.includes('COPYLEFT_UNDECLARED'));
  assert.equal(res.ok, false);
});

ok('CONFLICT: GPL combined with proprietary', () => {
  const c = combineLicenses([
    { brick_id: 'g', spdx: 'GPL-3.0' },
    { brick_id: 'p', spdx: 'proprietary' },
  ]);
  assert.ok(c.conflicts.some((x) => x.code === 'COPYLEFT_PROPRIETARY_CONFLICT'));
});

ok('PASS: closed build kept private is fine', () => {
  const res = checkComposition(
    { visibility: 'private', license: 'proprietary', publishable: false },
    [{ brick_id: 'x', spdx: 'proprietary', openness: 'closed', visibility: 'private' }],
  );
  assert.equal(res.ok, true, JSON.stringify(res.violations));
});

ok('BLOCK: open canonical composition needs waiver for commercial brick', () => {
  const res = checkComposition(
    { visibility: 'private', license: 'MIT', license_tier: 'open', publishable: false },
    [{ brick_id: 'paid.adapter', spdx: 'MIT', openness: 'open', visibility: 'private', license_tier: 'commercial', commercial_terms: 'https://example.test/terms' }],
  );
  assert.equal(res.ok, false);
  assert.ok(res.violations.some((v) => v.code === 'COMMERCIAL_TIER_WAIVER_REQUIRED'));
});

ok('PASS: explicit commercial waiver allows tier mixing', () => {
  const res = checkComposition(
    { visibility: 'private', license: 'MIT', license_tier: 'open', commercial_waiver: { approved_by: 'curator', reason: 'licensed dependency' }, publishable: false },
    [{ brick_id: 'paid.adapter', spdx: 'MIT', openness: 'open', visibility: 'private', license_tier: 'commercial', commercial_terms: 'https://example.test/terms' }],
  );
  assert.equal(res.ok, true, JSON.stringify(res.violations));
  assert.equal(res.effective.license_tier, 'commercial');
});

ok('BLOCK: commercial brick requires terms URI', () => {
  const res = checkComposition(
    { visibility: 'private', license: 'MIT', license_tier: 'commercial', publishable: false },
    [{ brick_id: 'paid.adapter', spdx: 'MIT', openness: 'open', visibility: 'private', license_tier: 'commercial' }],
  );
  assert.ok(res.violations.some((v) => v.code === 'COMMERCIAL_TERMS_MISSING'));
});

console.log(`license-lattice selftest: ${String(n)} groups passed`);
