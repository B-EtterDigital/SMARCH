#!/usr/bin/env node
/**
 * WHAT: Verifies that every known source-export command still calls the central export guard.
 * WHY: A new exporter or refactor could silently reopen the path that releases closed source without policy checks.
 * HOW: The test reads each registered exporter, checks its import and call sites, then checks the guard's safe default.
 * It consumes repository source text and prints the number of protected export paths.
 * Add every new command that copies, emits, releases, or publishes source to this coverage list.
 * Usage: node tools/lib/export-coverage-selftest.ts
 */
/**
 * Export-coverage selftest — the forcing function for the choke-point.
 *
 * Enforcement is only as good as its coverage: a NEW export tool, or a refactor
 * that drops a guard call, silently reopens the "release closed source" hole.
 * This test fails if any known export/emit tool stops importing the export
 * guard or stops calling it. When you add a new export path, add it here.
 * Run: node tools/lib/export-coverage-selftest.ts
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Every tool that can copy/emit/release/publish a brick's source or manifest
// MUST route through the export guard.
const GUARDED_EXPORTERS: string[] = [
  'tools/sma-clone.mjs',
  'tools/sma-release.mjs',
  'tools/sma-publish.mjs',
  'tools/sma-store-remote.mjs',
];

let n: number = 0;
for (const rel of GUARDED_EXPORTERS) {
  const path = resolve(SMA_ROOT, rel);
  assert.ok(existsSync(path), `export tool missing: ${rel}`);
  const src = readFileSync(path, 'utf8');
  assert.ok(/export-guard\.mjs/.test(src), `${rel} does not import the export guard`);
  assert.ok(/assertExportAllowed|evaluateExport/.test(src), `${rel} imports the guard but never calls it`);
  n += 1;
}

// The guard itself must fail safe (unknown brick => closed) — guard against a
// regression that makes unresolved bricks default to open.
const guardSrc = readFileSync(resolve(SMA_ROOT, 'tools/lib/export-guard.mjs'), 'utf8');
assert.ok(/openness:\s*'closed'/.test(guardSrc), 'export guard must fail-safe unresolved bricks to closed');

console.log(`export-coverage selftest: ${n} export tools guarded + fail-safe verified`);
