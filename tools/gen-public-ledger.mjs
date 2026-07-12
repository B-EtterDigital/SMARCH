#!/usr/bin/env node
/**
 * WHAT: Builds or verifies the public provenance ledger for this repository's core tools.
 * WHY: External readers need evidence derived only from public file bytes and history rather than private registry state.
 * HOW: The command hashes selected files, reads their history, computes seals, and writes one generated ledger document.
 * Verification compares a fresh result with the committed ledger; self-test checks the expected public contract.
 * The default mode writes registry/public-ledger.generated.json, while verification modes do not update it.
 * Usage: node tools/gen-public-ledger.mjs --selftest
 */
// Generate the PUBLIC self-ledger: provenance seals over this repo's own tools,
// verifiable by anyone (including in a browser) from raw.githubusercontent.com.
// Inputs are 100% public: file bytes + git history of this repository.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { computeSeal } from './lib/provenance-seal.ts';

const LEDGER_PATH = 'registry/public-ledger.generated.json';
const FILES = [
  'tools/sma-ci.ts',
  'tools/sma-scan.ts',
  'tools/install-agent-skills.ts',
  'tools/lib/provenance-seal.ts',
  'tools/lib/license-lattice.ts',
];
/** @param {import('node:crypto').BinaryLike} buf */
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const args = process.argv.slice(2);
if (args.length > 1 || args.some((arg) => arg !== '--verify' && arg !== '--selftest')) {
  console.error('usage: node tools/gen-public-ledger.mjs [--verify|--selftest]');
  process.exit(2);
}

/** @param {string} path */
function gitEvents(path) {
  const raw = execSync(
    `git log --follow --reverse --format='%H%x1f%aI%x1f%ae%x1f%s' -- "${path}"`,
    { encoding: 'utf8' }
  ).trim();
  if (!raw) return [];
  return raw.split('\n').map((line, i) => {
    const [commit, timestamp, email, summary] = line.split('\x1f');
    return {
      actor_kind: 'human',
      actor_id: email,
      role: i === 0 ? 'architect' : 'implementer',
      timestamp,
      commit,
      summary: (summary || '').trim(),
    };
  });
}

function buildBundle(generatedAt = new Date().toISOString()) {
  const bricks = FILES.map((path) => {
    const content_hash = sha256(readFileSync(path));
    const brick_id = 'smarch.tools.' + (path.split('/').pop() ?? path).replace(/\.mjs$/, '');
    const events = gitEvents(path);
    const seal = computeSeal({ brick_id, content_hash, events });
    return { brick_id, path, content_hash, anchor: seal.anchor, head: seal.head, chain_length: seal.chain_length, events };
  });
  return {
    schema: 'smarch-public-ledger-v1',
    generated_at: generatedAt,
    repo: 'B-EtterDigital/SMARCH',
    branch: 'main',
    algo: 'sha256-chain-v2',
    note: 'Self-ledger over the tools of this repository. Verify: hash the raw file, recompute the anchor, fold the events, compare the head. All inputs are public.',
    bricks,
  };
}

function verifyLedger() {
  if (!existsSync(LEDGER_PATH)) {
    console.error(`public ledger verify: missing ${LEDGER_PATH}; regenerate with node tools/gen-public-ledger.mjs`);
    process.exit(1);
  }
  let current;
  try {
    current = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
  } catch (error) {
    console.error(`public ledger verify: invalid ${LEDGER_PATH}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const mismatch = ledgerMismatch(current);
  if (mismatch) {
    console.error(`public ledger verify: ${mismatch}`);
    process.exit(1);
  }
  printSummary('verified', current.bricks);
}

/** @param {ReturnType<typeof buildBundle>} current */
function ledgerMismatch(current) {
  if (
    typeof current?.generated_at !== 'string'
    || !Number.isFinite(Date.parse(current.generated_at))
    || new Date(current.generated_at).toISOString() !== current.generated_at
  ) {
    return 'generated_at must be an ISO timestamp';
  }
  const expected = buildBundle(current.generated_at);
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    return `stale ${LEDGER_PATH}; regenerate with node tools/gen-public-ledger.mjs`;
  }
  return '';
}

function runSelftest() {
  const current = buildBundle('2026-01-01T00:00:00.000Z');
  if (ledgerMismatch(current)) throw new Error('fresh ledger did not verify');
  const stale = structuredClone(current);
  stale.bricks[0].content_hash = '0'.repeat(64);
  if (!ledgerMismatch(stale).startsWith('stale ')) throw new Error('stale ledger was not rejected');
  const invalidTimestamp = structuredClone(current);
  invalidTimestamp.generated_at = 'not-a-date';
  if (ledgerMismatch(invalidTimestamp) !== 'generated_at must be an ISO timestamp') {
    throw new Error('invalid generated_at was not rejected');
  }
  console.log('public ledger selftest: passed');
}

/** @param {string} action @param {ReturnType<typeof buildBundle>['bricks']} bricks */
function printSummary(action, bricks) {
  console.log(`public ledger ${action}:`, bricks.length, 'bricks,', bricks.reduce((sum, brick) => sum + brick.chain_length, 0), 'events');
}

if (args.includes('--selftest')) {
  runSelftest();
} else if (args.includes('--verify')) {
  verifyLedger();
} else {
  const bundle = buildBundle();
  writeFileSync(LEDGER_PATH, JSON.stringify(bundle, null, 1) + '\n');
  printSummary('generated', bundle.bricks);
}
