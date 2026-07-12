import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const ADOPT = resolve(import.meta.dirname, '../sma-adopt.ts');

/** @param {string} target @param {string[]} [args] */
function adopt(target, args = []) {
  return execFileSync('node', [ADOPT, '--target', target, '--json', ...args], { encoding: 'utf8' });
}

test('adopts an existing project: wrappers, config, and SPL signatures', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'smarch-adopt-'));
  try {
    writeFileSync(resolve(dir, 'package.json'), '{"name":"demo"}\n');
    const result = JSON.parse(adopt(dir));
    assert.equal(result.ok, true);
    for (const f of ['sma', 'spl', 'registry/portfolio.config.json', 'registry/spl-agents.json']) {
      assert.ok(existsSync(resolve(dir, f)), `${f} must be created`);
    }
    // wrappers must be executable
    assert.ok((statSync(resolve(dir, 'sma')).mode & 0o111) !== 0, 'sma wrapper must be executable');
    // the adopted engine must actually run against this project
    const out = execFileSync(resolve(dir, 'spl'), ['doctor'], { encoding: 'utf8' });
    assert.match(out, /pressure:/, 'adopted ./spl doctor must run the real engine');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('never overwrites existing files without --force', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'smarch-adopt-'));
  try {
    writeFileSync(resolve(dir, 'sma'), 'KEEP ME\n');
    const first = JSON.parse(adopt(dir));
    assert.ok(first.skipped.some((/** @type {string} */ p) => p.endsWith('/sma')), 'existing sma must be skipped');
    const forced = JSON.parse(adopt(dir, ['--force']));
    assert.ok(forced.created.some((/** @type {string} */ p) => p.endsWith('/sma')), '--force must overwrite');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
