import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs, usage } from '../lib/parallel-preflight-cli.ts';

test('parallel preflight CLI parser preserves value and boolean flags', () => {
  const args = parseArgs([
    'selftest', '--project', 'sma', '--max-agents', '6', '--launch-plan', '-h', 'ignored',
  ]);
  assert.equal(args.project, 'sma');
  assert.equal(args.maxAgents, '6');
  assert.equal(args.launchPlan, true);
  assert.equal(args.help, true);
});

test('parallel preflight usage describes safe launch controls', () => {
  /** @type {string[]} */
  const writes = [];
  const original = console.log;
  console.log = (value) => writes.push(String(value));
  try {
    usage();
  } finally {
    console.log = original;
  }
  assert.match(writes.join('\n'), /--max-agents 12/);
  assert.match(writes.join('\n'), /--no-auto-refresh/);
  assert.match(writes.join('\n'), /module-dispatch/);
});
