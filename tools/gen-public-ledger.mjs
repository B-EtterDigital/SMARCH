#!/usr/bin/env node
// Generate the PUBLIC self-ledger: provenance seals over this repo's own tools,
// verifiable by anyone (including in a browser) from raw.githubusercontent.com.
// Inputs are 100% public: file bytes + git history of this repository.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { computeSeal } from './lib/provenance-seal.mjs';

const FILES = [
  'tools/sma-ci.mjs',
  'tools/sma-scan.mjs',
  'tools/install-agent-skills.mjs',
  'tools/lib/provenance-seal.mjs',
  'tools/lib/license-lattice.mjs',
];
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

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

const bricks = FILES.map((path) => {
  const content_hash = sha256(readFileSync(path));
  const brick_id = 'smarch.tools.' + path.split('/').pop().replace(/\.mjs$/, '');
  const events = gitEvents(path);
  const seal = computeSeal({ brick_id, content_hash, events });
  return { brick_id, path, content_hash, anchor: seal.anchor, head: seal.head, chain_length: seal.chain_length, events };
});

const bundle = {
  schema: 'smarch-public-ledger-v1',
  generated_at: new Date().toISOString(),
  repo: 'B-EtterDigital/SMARCH',
  branch: 'main',
  algo: 'sha256-chain-v2',
  note: 'Self-ledger over the tools of this repository. Verify: hash the raw file, recompute the anchor, fold the events, compare the head. All inputs are public.',
  bricks,
};
writeFileSync('registry/public-ledger.generated.json', JSON.stringify(bundle, null, 1) + '\n');
console.log('public ledger:', bricks.length, 'bricks,', bricks.reduce((a, b) => a + b.chain_length, 0), 'events');
