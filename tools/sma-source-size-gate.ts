#!/usr/bin/env node
/**
 * WHAT: Reports source files that meet or exceed the configured line cap.
 * WHY: Oversized files become unsafe bottlenecks for parallel maintenance.
 * HOW: Walks selected source roots and compares violations with an optional baseline.
 * OUTPUTS: Prints text or structured findings and fails gate mode on new or grown violations.
 * CALLERS: The source:size:gate script and release checks enforce the ratchet.
 * USAGE: `node tools/sma-source-size-gate.ts --root . --gate --json`
 * Glossary: [SMA](../docs/GLOSSARY.md).
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASELINE = resolve(SMA_ROOT, 'tools/source-size-baseline.json');
const SOURCE_EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html']);
const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.venv',
  'build',
  'coverage',
  'dist',
  'graphify-out',
  'handoffs',
  'node_modules',
  'registry',
  'scans',
  'security',
]);
const DEFAULT_SOURCE_ROOTS = ['tools'];

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root || SMA_ROOT);
const maxLines = positiveInt(args.maxLines, 1900);
const threshold = maxLines;
const baselinePath = args.baseline === false
  ? null
  : resolve(root, typeof args.baseline === 'string' ? args.baseline : DEFAULT_BASELINE);
const sourceRoots = (args.sourceRoot || DEFAULT_SOURCE_ROOTS).map((item) => resolve(root, item));

try {
  const files = collectSourceFiles(sourceRoots);
  const violations = files
    .map((file) => ({ path: relative(root, file).replaceAll(sep, '/'), lines: countLines(file) }))
    .filter((item) => item.lines >= threshold)
    .sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));
  const baseline = baselinePath && existsSync(baselinePath) ? readBaseline(baselinePath) : { files: [] };
  const result = buildResult({ violations, baseline, threshold });

  if (args.updateBaseline) {
    writeBaseline(baselinePath || DEFAULT_BASELINE, violations, threshold);
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result);
  }

  if (args.gate && result.status === 'failed') process.exit(4);
} catch (err) {
  console.error(`sma-source-size-gate: ${err.message}`);
  process.exit(1);
}

function collectSourceFiles(roots: string[]): string[] {
  const files = [];
  for (const start of roots) {
    if (!existsSync(start)) continue;
    walk(start, files);
  }
  return files;
}

function walk(dir: string, files: string[]) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.well-known') continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      // Fixture trees are test data, not source: planted violations there must
      // not trip the repo's own gate (they exist for scanners to find).
      if (entry.name === 'fixtures' && dir.includes('evals')) continue;
      walk(resolve(dir, entry.name), files);
      continue;
    }
    if (!SOURCE_EXTENSIONS.has(extension(entry.name))) continue;
    if (isGeneratedSource(entry.name)) continue;
    files.push(resolve(dir, entry.name));
  }
}

function buildResult({ violations, baseline, threshold }: Record<string, any>) {
  const baselineMap = new Map<string, any>((baseline.files || []).map((item) => [item.path, item]));
  const newViolations = [];
  const grownBaseline = [];
  const legacyViolations = [];

  for (const item of violations) {
    const known = baselineMap.get(item.path);
    if (!known) {
      newViolations.push(item);
      continue;
    }
    if (item.lines > Number(known.lines || 0)) {
      grownBaseline.push({ ...item, baseline_lines: Number(known.lines || 0) });
      continue;
    }
    legacyViolations.push({ ...item, baseline_lines: Number(known.lines || 0), reason: known.reason || 'legacy oversized source' });
  }

  const missingBaseline = (baseline.files || [])
    .filter((item) => !violations.some((violation) => violation.path === item.path))
    .map((item) => ({ path: item.path, baseline_lines: Number(item.lines || 0) }));

  return {
    status: newViolations.length || grownBaseline.length ? 'failed' : 'passed',
    threshold,
    violation_count: violations.length,
    new_violation_count: newViolations.length,
    grown_baseline_count: grownBaseline.length,
    legacy_violation_count: legacyViolations.length,
    fixed_baseline_count: missingBaseline.length,
    new_violations: newViolations,
    grown_baseline: grownBaseline,
    legacy_violations: legacyViolations,
    fixed_baseline: missingBaseline,
  };
}

function printResult(result) {
  console.log(`SMA source-size gate: ${result.status}`);
  console.log(`threshold: >=${result.threshold} lines`);
  console.log(`violations: ${result.violation_count} (${result.new_violation_count} new, ${result.grown_baseline_count} grown baseline, ${result.legacy_violation_count} legacy)`);
  for (const item of result.new_violations) console.log(`NEW ${item.lines} ${item.path}`);
  for (const item of result.grown_baseline) console.log(`GROWN ${item.lines}/${item.baseline_lines} ${item.path}`);
  for (const item of result.legacy_violations) console.log(`LEGACY ${item.lines}/${item.baseline_lines} ${item.path} - ${item.reason}`);
  for (const item of result.fixed_baseline) console.log(`FIXED ${item.path} (was ${item.baseline_lines})`);
}

function readBaseline(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return { files: [] };
  }
}

function writeBaseline(filePath, violations, threshold) {
  const payload = {
    schema_version: '1.0.0',
    threshold,
    updated_at: new Date().toISOString(),
    files: violations.map((item) => ({
      path: item.path,
      lines: item.lines,
      reason: 'legacy oversized source; split below the SMA source-size cap',
    })),
  };
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function isGeneratedSource(name) {
  return /\.generated\./.test(name) || /\.min\./.test(name);
}

function extension(name) {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index) : '';
}

function countLines(filePath) {
  const text = readFileSync(filePath, 'utf8');
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  return text.endsWith('\n') || text.endsWith('\r\n') ? lines.length - 1 : lines.length;
}

function positiveInt(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * @returns {{
 * root?: string,
 * maxLines?: string | boolean,
 * baseline?: string | false,
 * sourceRoot?: string[],
 * updateBaseline?: boolean,
 * json?: boolean,
 * gate?: boolean
 * }}
 */
function parseArgs(list: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (key === 'noBaseline') {
      out.baseline = false;
      continue;
    }
    const next = list[index + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    if (key === 'sourceRoot') {
      out.sourceRoot = [...(out.sourceRoot || []), next];
    } else {
      out[key] = next;
    }
    index += 1;
  }
  return out;
}
