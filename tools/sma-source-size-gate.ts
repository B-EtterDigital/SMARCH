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

interface SourceSizeArgs extends Record<string, string | string[] | boolean | undefined> {
  root?: string;
  maxLines?: string;
  baseline?: string | false;
  sourceRoot?: string[];
  updateBaseline?: boolean;
  json?: boolean;
  gate?: boolean;
}

interface SourceSizeViolation {
  path: string;
  lines: number;
}

interface BaselineViolation extends SourceSizeViolation {
  reason?: string;
}

interface SourceSizeBaseline {
  files: BaselineViolation[];
}

interface LegacyViolation extends SourceSizeViolation {
  baseline_lines: number;
  reason: string;
}

interface GrownViolation extends SourceSizeViolation {
  baseline_lines: number;
}

interface FixedViolation {
  path: string;
  baseline_lines: number;
}

interface SourceSizeResult {
  status: 'failed' | 'passed';
  threshold: number;
  violation_count: number;
  new_violation_count: number;
  grown_baseline_count: number;
  legacy_violation_count: number;
  fixed_baseline_count: number;
  new_violations: SourceSizeViolation[];
  grown_baseline: GrownViolation[];
  legacy_violations: LegacyViolation[];
  fixed_baseline: FixedViolation[];
}

const args = parseArgs(process.argv.slice(2));
const root = resolve(args.root ?? SMA_ROOT);
const maxLines = positiveInt(args.maxLines, 1900);
const threshold = maxLines;
const baselinePath = args.baseline === false
  ? null
  : resolve(root, typeof args.baseline === 'string' ? args.baseline : DEFAULT_BASELINE);
const sourceRoots = (args.sourceRoot ?? DEFAULT_SOURCE_ROOTS).map((item: string) => resolve(root, item));

try {
  const files = collectSourceFiles(sourceRoots);
  const violations = files
    .map((file) => ({ path: relative(root, file).replaceAll(sep, '/'), lines: countLines(file) }))
    .filter((item) => item.lines >= threshold)
    .sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));
  const baseline = baselinePath && existsSync(baselinePath) ? readBaseline(baselinePath) : { files: [] };
  const result = buildResult({ violations, baseline, threshold });

  if (args.updateBaseline) {
    writeBaseline(baselinePath ?? DEFAULT_BASELINE, violations, threshold);
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result);
  }

  if (args.gate && result.status === 'failed') process.exit(4);
} catch (err: unknown) {
  console.error(`sma-source-size-gate: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

function collectSourceFiles(roots: string[]): string[] {
  const files: string[] = [];
  for (const start of roots) {
    if (!existsSync(start)) continue;
    walk(start, files);
  }
  return files;
}

function walk(dir: string, files: string[]): void {
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

function buildResult({ violations, baseline, threshold }: { violations: SourceSizeViolation[]; baseline: SourceSizeBaseline; threshold: number }): SourceSizeResult {
  const baselineMap = new Map<string, BaselineViolation>(baseline.files.map((item: BaselineViolation) => [item.path, item]));
  const newViolations: SourceSizeViolation[] = [];
  const grownBaseline: GrownViolation[] = [];
  const legacyViolations: LegacyViolation[] = [];

  for (const item of violations) {
    const known = baselineMap.get(item.path);
    if (!known) {
      newViolations.push(item);
      continue;
    }
    if (item.lines > known.lines) {
      grownBaseline.push({ ...item, baseline_lines: known.lines });
      continue;
    }
    legacyViolations.push({ ...item, baseline_lines: known.lines, reason: known.reason ?? 'legacy oversized source' });
  }

  const missingBaseline = baseline.files
    .filter((item: BaselineViolation) => !violations.some((violation: SourceSizeViolation) => violation.path === item.path))
    .map((item: BaselineViolation) => ({ path: item.path, baseline_lines: item.lines }));

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

function printResult(result: SourceSizeResult): void {
  console.log(`SMA source-size gate: ${result.status}`);
  console.log(`threshold: >=${String(result.threshold)} lines`);
  console.log(`violations: ${String(result.violation_count)} (${String(result.new_violation_count)} new, ${String(result.grown_baseline_count)} grown baseline, ${String(result.legacy_violation_count)} legacy)`);
  for (const item of result.new_violations) console.log(`NEW ${String(item.lines)} ${item.path}`);
  for (const item of result.grown_baseline) console.log(`GROWN ${String(item.lines)}/${String(item.baseline_lines)} ${item.path}`);
  for (const item of result.legacy_violations) console.log(`LEGACY ${String(item.lines)}/${String(item.baseline_lines)} ${item.path} - ${item.reason}`);
  for (const item of result.fixed_baseline) console.log(`FIXED ${item.path} (was ${String(item.baseline_lines)})`);
}

function readBaseline(filePath: string): SourceSizeBaseline {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as SourceSizeBaseline;
  } catch {
    return { files: [] };
  }
}

function writeBaseline(filePath: string, violations: SourceSizeViolation[], threshold: number): void {
  const payload = {
    schema_version: '1.0.0',
    threshold,
    updated_at: new Date().toISOString(),
    files: violations.map((item: SourceSizeViolation) => ({
      path: item.path,
      lines: item.lines,
      reason: 'legacy oversized source; split below the SMA source-size cap',
    })),
  };
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function isGeneratedSource(name: string): boolean {
  return name.includes('.generated.') || name.includes('.min.');
}

function extension(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index) : '';
}

function countLines(filePath: string): number {
  const text = readFileSync(filePath, 'utf8');
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  return text.endsWith('\n') || text.endsWith('\r\n') ? lines.length - 1 : lines.length;
}

function positiveInt(value: string | undefined, fallback: number): number {
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
function parseArgs(list: string[]): SourceSizeArgs {
  const out: SourceSizeArgs = {};
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];
    if (!arg.startsWith('--')) continue;
    if (arg === '--no-baseline') {
      out.baseline = false;
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_match: string, character: string) => character.toUpperCase());
    const next = list.at(index + 1);
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    if (key === 'sourceRoot') {
      out.sourceRoot = [...(out.sourceRoot ?? []), next];
    } else {
      out[key] = next;
    }
    index += 1;
  }
  return out;
}
