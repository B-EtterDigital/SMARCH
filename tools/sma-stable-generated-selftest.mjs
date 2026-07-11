#!/usr/bin/env node
/**
 * WHAT: Verifies that stable generated-file helpers ignore timestamp-only changes.
 * WHY: Volatile rewrites create false dirty work and unnecessary controller contention.
 * HOW: Creates temporary registry snapshots and exercises meaningful-change detection.
 * OUTPUTS: Prints one success line or throws when a stability assertion fails.
 * CALLERS: Maintainers run it when changing generated-state normalization.
 * USAGE: `node tools/sma-stable-generated-selftest.mjs`
 * Glossary: [SMA](../docs/GLOSSARY.md).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { normalizeRegistrySnapshot, writeJsonIfMeaningfulChanged } from './lib/stable-generated.mjs';

const dir = mkdtempSync(resolve(tmpdir(), 'sma-stable-generated-'));

try {
  const file = resolve(dir, 'latest.registry.json');
  const first = {
    schema_version: '1.0.0',
    generated_at: '2026-06-30T00:00:00.000Z',
    count: 1,
    bricks: [{ id: 'brick-a' }],
  };
  const timestampOnly = {
    ...first,
    generated_at: '2026-06-30T01:00:00.000Z',
  };
  const meaningful = {
    ...timestampOnly,
    count: 2,
    bricks: [{ id: 'brick-a' }, { id: 'brick-b' }],
  };

  writeFileSync(file, `${JSON.stringify(first, null, 2)}\n`);
  const timestampResult = await writeJsonIfMeaningfulChanged(file, timestampOnly, {
    normalize: normalizeRegistrySnapshot,
  });
  assert(!timestampResult.written, 'timestamp-only registry update should not write');
  assert(readFileSync(file, 'utf8').includes(first.generated_at), 'timestamp-only update should preserve prior file');

  const meaningfulResult = await writeJsonIfMeaningfulChanged(file, meaningful, {
    normalize: normalizeRegistrySnapshot,
  });
  assert(meaningfulResult.written, 'meaningful registry update should write');
  assert(readFileSync(file, 'utf8').includes('"count": 2'), 'meaningful update should update file');

  console.log('sma-stable-generated selftest: ok');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
