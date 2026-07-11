#!/usr/bin/env node
/**
 * WHAT: Exercises source-license detection and declared-versus-observed mismatch policy on temporary fixtures.
 * WHY: A scanner that trusts filenames or declarations could miss restricted headers and permit license laundering.
 * HOW: The test writes synthetic source trees, scans their actual bytes, and asserts matching and mismatching outcomes.
 * Temporary directories are tracked and removed even when an assertion fails.
 * A successful run prints the number of policy groups; failed assertions exit nonzero.
 * License abbreviations are defined in docs/GLOSSARY.md.
 * Usage: node tools/lib/license-evidence-selftest.ts
 */
/**
 * Self-test for license-evidence. Proves the scanner reads the ACTUAL bytes of
 * source files (SPDX tags + license-text signatures) and that the
 * declared-vs-actual laundering check flags a permissive declaration sitting on
 * top of copyleft/absent evidence.
 * Run: node tools/lib/license-evidence-selftest.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanText, scanDirectory, evaluateDeclarationMismatch } from './license-evidence.ts';

let n = 0;
const ok = (name: string, fn: () => void): void => { fn(); n += 1; };

const roots: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `lic-ev-${prefix}-`));
  roots.push(d);
  return d;
}

try {
  ok('scanText: SPDX-License-Identifier tag detected', () => {
    const r = scanText('/*\n * SPDX-License-Identifier: AGPL-3.0\n */\nexport const x = 1;\n');
    assert.deepEqual(r.spdxTags, ['AGPL-3.0']);
    assert.deepEqual(r.textMatches, []);
  });

  ok('scanText: MIT permission text detected via signature', () => {
    const r = scanText('Permission is hereby granted, free of charge, to any person obtaining a copy...');
    assert.ok(r.textMatches.includes('MIT'));
  });

  ok('scanDirectory: SPDX tag in a source file is detected as AGPL-3.0', () => {
    const dir = tmp('spdx');
    writeFileSync(join(dir, 'index.mjs'), '// SPDX-License-Identifier: AGPL-3.0\nexport default 1;\n');
    const ev = scanDirectory(dir);
    assert.ok(ev.detected.includes('AGPL-3.0'));
    assert.ok(ev.byLicense['AGPL-3.0'].includes('index.mjs'));
    assert.equal(ev.fileCount, 1);
  });

  ok('scanDirectory: a file with MIT permission text is detected as MIT', () => {
    const dir = tmp('mit');
    writeFileSync(join(dir, 'notice.txt'), 'Permission is hereby granted, free of charge, to any person...');
    const ev = scanDirectory(dir);
    assert.ok(ev.detected.includes('MIT'));
  });

  ok('scanDirectory: a GPL LICENSE file => primary GPL', () => {
    const dir = tmp('gpl');
    writeFileSync(
      join(dir, 'LICENSE'),
      'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n\nEveryone is permitted to copy...',
    );
    // some ordinary source with no license header
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'app.mjs'), 'export const app = () => 42;\n');
    const ev = scanDirectory(dir);
    assert.equal(ev.hasLicenseFile, true);
    assert.equal(ev.primary, 'GPL-3.0');
    assert.ok(ev.detected.includes('GPL-3.0'));
  });

  ok('scanDirectory: skips node_modules and binaries', () => {
    const dir = tmp('skip');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'dep.mjs'), '// SPDX-License-Identifier: GPL-3.0\n');
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    writeFileSync(join(dir, 'main.mjs'), '// SPDX-License-Identifier: MIT\n');
    const ev = scanDirectory(dir);
    assert.ok(ev.detected.includes('MIT'));
    assert.ok(!ev.detected.includes('GPL-3.0'), 'node_modules must be skipped');
    assert.equal(ev.fileCount, 1);
  });

  ok('mismatch: declared MIT over AGPL evidence => mismatch true (laundering)', () => {
    const r = evaluateDeclarationMismatch('MIT', { detected: ['AGPL-3.0'] });
    assert.equal(r.mismatch, true);
    assert.equal(r.severity, 'high');
  });

  ok('mismatch: declared AGPL over AGPL evidence => mismatch false', () => {
    const r = evaluateDeclarationMismatch('AGPL-3.0', { detected: ['AGPL-3.0'] });
    assert.equal(r.mismatch, false);
    assert.equal(r.severity, 'none');
  });

  ok('mismatch: declared MIT over MIT evidence => mismatch false', () => {
    const r = evaluateDeclarationMismatch('MIT', { detected: ['MIT'] });
    assert.equal(r.mismatch, false);
  });

  ok('mismatch: declared open with NO evidence => flagged (fail toward flagging)', () => {
    const r = evaluateDeclarationMismatch('MIT', { detected: [], hasLicenseFile: false });
    assert.equal(r.mismatch, true);
    assert.equal(r.severity, 'medium');
  });

  ok('mismatch: declared MIT over proprietary evidence => mismatch true (openness escalation)', () => {
    const r = evaluateDeclarationMismatch('MIT', { detected: ['proprietary'] });
    assert.equal(r.mismatch, true);
    assert.equal(r.severity, 'high');
  });

  ok('mismatch: declared proprietary over AGPL evidence => no permissive-direction mismatch', () => {
    const r = evaluateDeclarationMismatch('proprietary', { detected: ['AGPL-3.0'] });
    assert.equal(r.mismatch, false);
  });

  ok('mismatch: accepts a scanDirectory result directly + array shorthand', () => {
    const dir = tmp('e2e');
    writeFileSync(join(dir, 'a.mjs'), '// SPDX-License-Identifier: GPL-3.0\n');
    const ev = scanDirectory(dir);
    assert.equal(evaluateDeclarationMismatch('MIT', ev).mismatch, true);
    assert.equal(evaluateDeclarationMismatch('MIT', ['AGPL-3.0']).mismatch, true);
  });
} finally {
  for (const d of roots) {
    try { rmSync(d, { recursive: true, force: true }); } catch (error) {
      console.error(JSON.stringify({ area: 'license-evidence-selftest.cleanup', severity: 'warning', hint: 'Remove the temporary selftest directory manually.', error: error instanceof Error ? error.message : String(error) }));
    }
  }
}

console.log(`license-evidence selftest: ${n} groups passed`);
