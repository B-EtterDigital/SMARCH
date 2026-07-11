#!/usr/bin/env node
/**
 * WHAT: Estimates source-generation tokens for one path or every brick in a project.
 * WHY: Reuse savings and regeneration cost need measured inputs instead of intuition.
 * HOW: Walks supported files and applies either calibrated heuristics or an optional tokenizer.
 * OUTPUTS: Prints a path estimate or writes .smarch/token-counts.generated.json with --write.
 * CALLERS: Reuse receipts, backlog accounting, and stakeholder reports consume the estimates.
 * USAGE: `node tools/sma-token-count.ts --path tools/sma-token-count.ts`
 * Glossary: [SMA](../docs/GLOSSARY.md).
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, relative, extname, join } from 'node:path';
import { argv, exit } from 'node:process';

const args = parseArgs(argv.slice(2));
if (args.help || (!args.root && !args.path)) {
  console.log(`Usage:
  sma-token-count.ts --root <project_root> [--write] [--method=heuristic|tiktoken]
  sma-token-count.ts --path <file_or_dir>  [--method=heuristic|tiktoken]

Options:
  --root <p>      project root; walks packages/* and apps/* for bricks
  --path <p>      single file or directory
  --write         write .smarch/token-counts.generated.json (root mode only)
  --method=...    "heuristic" (default) or "tiktoken"
  --multiplier=N  total cost multiplier (default 3.8 — direct + iteration + design)
  --json          machine-readable output
`);
  exit(args.help ? 0 : 2);
}

const METHOD = args.method ?? 'heuristic';
const MULTIPLIER = Number(args.multiplier ?? 3.8);
const COUNT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.sql', '.md']);
const SKIP_DIR = new Set(['node_modules', '.next', 'dist', 'build', '.git', '.expo', 'ios', 'android', 'coverage']);

interface TokenCountArgs {
  help?: boolean;
  root?: string;
  path?: string;
  write?: boolean;
  json?: boolean;
  method?: string;
  multiplier?: string;
}

interface FileEstimate {
  tokens: number;
  chars: number;
  lines: number;
  method: string;
}

interface PathEstimate {
  files: number;
  chars: number;
  lines: number;
  static_tokens: number;
  direct_generate_tokens: number;
  realistic_regenerate_tokens: number;
  multiplier: number;
  method: string;
  per_file: Array<FileEstimate & { path: string }>;
}

interface BrickEstimate {
  path: string;
  files: number;
  lines: number;
  static_tokens: number;
  direct_generate_tokens: number;
  realistic_regenerate_tokens: number;
}

interface Totals {
  files: number;
  lines: number;
  static_tokens: number;
  realistic_regenerate_tokens: number;
}

const charsPerToken = (file: string): number => {
  const ext = extname(file).toLowerCase();
  if (ext === '.json' || ext === '.md' || ext === '.sql') return 3.5;
  return 3.7; // TypeScript-ish
};

function countTokensInFile(file: string): FileEstimate {
  const buf = readFileSync(file, 'utf8');
  if (METHOD === 'tiktoken') {
    // Optional path; falls back to heuristic if unavailable.
    try {
      const { encoding_for_model } = require('tiktoken');
      const enc = encoding_for_model('gpt-4o');
      const n = enc.encode(buf).length;
      enc.free();
      return { tokens: n, chars: buf.length, lines: buf.split('\n').length, method: 'tiktoken' };
    } catch {
      // fall through
    }
  }
  return {
    tokens: Math.round(buf.length / charsPerToken(file)),
    chars: buf.length,
    lines: buf.split('\n').length,
    method: 'heuristic',
  };
}

function* walk(dir: string): Generator<string, void, unknown> {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.') && ent.name !== '.smarch') continue;
    if (SKIP_DIR.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (ent.isFile() && COUNT_EXT.has(extname(p))) yield p;
  }
}

function findBrickRoots(root: string): Array<{ id: string; path: string }> {
  const out: Array<{ id: string; path: string }> = [];
  for (const subdir of ['packages', 'apps', 'web/src/modules', 'src/renderer/modules', 'apps/web/src/modules']) {
    const base = resolve(root, subdir);
    if (!existsSync(base)) continue;
    for (const ent of readdirSync(base, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const brickDir = join(base, ent.name);
      if (existsSync(join(brickDir, 'module.sweetspot.json'))) {
        out.push({ id: `${subdir}/${ent.name}`.replace(/\//g, '.'), path: brickDir });
      }
    }
  }
  return out;
}

function estimateForPath(p: string): PathEstimate {
  const st = statSync(p);
  const files = st.isFile() ? [p] : [...walk(p)];
  let tokens = 0, chars = 0, lines = 0, fileCount = 0;
  const perFile: Array<FileEstimate & { path: string }> = [];
  for (const f of files) {
    const r = countTokensInFile(f);
    tokens += r.tokens; chars += r.chars; lines += r.lines; fileCount++;
    perFile.push({ path: relative(p, f) || f, ...r });
  }
  return {
    files: fileCount,
    chars,
    lines,
    static_tokens: tokens,
    direct_generate_tokens: tokens,
    realistic_regenerate_tokens: Math.round(tokens * MULTIPLIER),
    multiplier: MULTIPLIER,
    method: METHOD,
    per_file: perFile,
  };
}

function main() {
  if (args.path) {
    const r = estimateForPath(resolve(args.path));
    if (args.json) console.log(JSON.stringify(r, null, 2));
    else printSummary({ '<single>': r });
    return;
  }
  if (!args.root) return;

  const root = resolve(args.root);
  const bricks = findBrickRoots(root);
  if (!bricks.length) {
    console.error(`no bricks found under ${root}/{packages,apps,...}`);
    exit(1);
  }
  const result: {
    schema_version: string;
    generated_at: string;
    project_root: string;
    method: string;
    multiplier: number;
    bricks: Record<string, BrickEstimate>;
    totals: Totals;
  } = {
    schema_version: '1.0.0',
    generated_at: new Date().toISOString(),
    project_root: root,
    method: METHOD,
    multiplier: MULTIPLIER,
    bricks: {},
    totals: { files: 0, lines: 0, static_tokens: 0, realistic_regenerate_tokens: 0 },
  };
  for (const b of bricks) {
    const e = estimateForPath(b.path);
    result.bricks[b.id] = {
      path: relative(root, b.path),
      files: e.files,
      lines: e.lines,
      static_tokens: e.static_tokens,
      direct_generate_tokens: e.direct_generate_tokens,
      realistic_regenerate_tokens: e.realistic_regenerate_tokens,
    };
    result.totals.files += e.files;
    result.totals.lines += e.lines;
    result.totals.static_tokens += e.static_tokens;
    result.totals.realistic_regenerate_tokens += e.realistic_regenerate_tokens;
  }

  if (args.write) {
    const outDir = resolve(root, '.smarch');
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, 'token-counts.generated.json');
    writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`wrote ${outPath}`);
  }
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printSummary(result.bricks, result.totals);
}

function printSummary(bricks: Record<string, BrickEstimate | PathEstimate>, totals: Totals | undefined = undefined): void {
  const rows = Object.entries(bricks).sort((a, b) => b[1].static_tokens - a[1].static_tokens);
  const w = (s: string | number, n: number): string => String(s).padEnd(n);
  console.log(`${w('brick', 50)} ${w('files', 6)} ${w('lines', 8)} ${w('static_tok', 12)} ${w('regen_tok', 12)}`);
  console.log('-'.repeat(94));
  for (const [id, e] of rows) {
    console.log(`${w(id, 50)} ${w(e.files, 6)} ${w(e.lines, 8)} ${w(e.static_tokens, 12)} ${w(e.realistic_regenerate_tokens, 12)}`);
  }
  if (totals) {
    console.log('-'.repeat(94));
    console.log(`${w('TOTAL', 50)} ${w(totals.files, 6)} ${w(totals.lines, 8)} ${w(totals.static_tokens, 12)} ${w(totals.realistic_regenerate_tokens, 12)}`);
  }
}

function parseArgs(argv: string[]): TokenCountArgs {
  const out: TokenCountArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--write') out.write = true;
    else if (a === '--json') out.json = true;
    else if (a.startsWith('--method=')) out.method = a.slice(9);
    else if (a.startsWith('--multiplier=')) out.multiplier = a.slice(13);
    else if (a === '--root') out.root = argv[++i];
    else if (a === '--path') out.path = argv[++i];
  }
  return out;
}

main();
