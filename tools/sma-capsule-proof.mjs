#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sma-capsule-proof-'));
const capsule = path.join(temp, 'proof-capsule');

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 10 * 60_000, env: { ...process.env, CI: '1', NO_COLOR: '1' } });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

try {
  run(process.execPath, [path.join(root, 'tools/sma-brick-new.mjs'), '--id', 'proof.capsule', '--directory', capsule, '--json']);
  run('npm', ['run', 'gate:all']);
  const fixture = run(process.execPath, [path.join(root, 'tools/sma-brick-run.mjs'), '--strict-sandbox', capsule, '--json']);
  const parsed = JSON.parse(fixture);
  if (parsed.ok === false || parsed.status === 'failed') throw new Error('generated capsule fixture reported failure');
  console.log(JSON.stringify({ ok: true, capsule_created_without_edits: true, gates: 'passing', fixture: 'passing' }));
} catch (error) {
  console.error(`capsule proof failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
