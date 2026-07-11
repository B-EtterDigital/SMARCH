#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sma-promote-capsule-'));
try {
  const manifestPath = path.join(dir, 'module.sweetspot.json');
  const candidatePath = path.join(dir, 'candidates.json');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'fixtures'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/index.ts'), 'export default function run(input) { return input; }\n');
  const base = {
    brick: { id: 'fixture.capsule', kind: 'capsule' },
    semantics: { purpose: 'fixture', tags: ['capsule'], public_api: ['run'], clone_steps: ['copy'] },
    interfaces: { ports: [] },
    security: { env: { variables: [] } },
    sweetspot: { verification: [{ command: 'node tools/sma-brick-run.mjs fixture', status: 'passing' }] },
  };
  fs.writeFileSync(manifestPath, JSON.stringify(base));
  fs.writeFileSync(candidatePath, JSON.stringify({ bricks: [{ id: 'fixture.capsule', kind: 'capsule', score: 100, manifest_path: manifestPath }] }));
  fs.writeFileSync(path.join(dir, 'fixtures/run.json'), JSON.stringify({
    fixtures: [{ name: 'stale claim', inputs: { value: 1 }, expected_outputs: { value: 2 } }],
  }));
  const stale = spawnSync(process.execPath, [path.join(root, 'tools/sma-promote.ts'), '--candidates', candidatePath, '--dry-run'], { cwd: root, encoding: 'utf8' });
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(JSON.parse(stale.stdout).results.candidate, 1, 'stale manifest text must not promote a failing fixture');

  fs.writeFileSync(path.join(dir, 'fixtures/run.json'), JSON.stringify({
    fixtures: [{ name: 'fresh pass', inputs: { value: 1 }, expected_outputs: { value: 1 } }],
  }));
  const pass = spawnSync(process.execPath, [path.join(root, 'tools/sma-promote.ts'), '--candidates', candidatePath, '--dry-run'], { cwd: root, encoding: 'utf8' });
  assert.equal(pass.status, 0, pass.stderr);
  const report = JSON.parse(pass.stdout);
  assert.equal(report.results.canonical, 1);
  assert.ok(Object.keys(report.reasons).some((reason) => reason.includes('skipped sibling-test and RLS checks')));
  fs.rmSync(path.join(dir, 'fixtures/run.json'));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...base, sweetspot: { verification: [] } }));
  const missing = spawnSync(process.execPath, [path.join(root, 'tools/sma-promote.ts'), '--candidates', candidatePath, '--dry-run'], { cwd: root, encoding: 'utf8' });
  assert.equal(JSON.parse(missing.stdout).results.candidate, 1);
  console.log('sma-promote capsule selftest: ok');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
