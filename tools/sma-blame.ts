#!/usr/bin/env node
/**
 * WHAT: Prints intent-aware blame for a tracked file.
 * WHY: Maintainers need the actor, rationale, and proof behind a line range, not only a commit author.
 * HOW: Delegates Git/context/evidence correlation to intent-blame.ts and renders a stable table or JSON.
 * Usage: `node tools/sma-blame.ts --intent tools/sma-lease.ts`
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { argv, cwd, exit } from 'node:process';
import { buildIntentBlame, renderIntentBlame } from './lib/intent-blame.ts';

interface CliArgs {
  file: string;
  repo: string;
  lines?: string;
  intent: boolean;
  json: boolean;
  selftest: boolean;
  help: boolean;
}

try {
  const args = parseArgs(argv.slice(2));
  if (args.help) {
    usage();
  } else if (args.selftest) {
    runSelftest();
  } else {
    runBlame(args);
  }
} catch (error) {
  console.error(`sma-blame: ${error instanceof Error ? error.message : String(error)}`);
  exit(1);
}

function runBlame(args: CliArgs): void {
  if (!args.intent) throw new Error('missing --intent; byte-only blame remains available through git blame');
  if (!args.file) throw new Error('missing file');
  const result = buildIntentBlame({ repoRoot: args.repo, file: args.file, lines: args.lines });
  console.log(args.json ? JSON.stringify(result, null, 2) : renderIntentBlame(result));
}

function parseArgs(values: string[]): CliArgs {
  const result: CliArgs = {
    file: '',
    repo: cwd(),
    intent: false,
    json: false,
    selftest: false,
    help: false,
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? '';
    if (value === '--intent') result.intent = true;
    else if (value === '--json') result.json = true;
    else if (value === '--selftest') result.selftest = true;
    else if (value === '--help' || value === '-h') result.help = true;
    else if (value === '--repo') result.repo = nextValue(values, ++index, '--repo');
    else if (value === '--lines') result.lines = nextValue(values, ++index, '--lines');
    else if (value.startsWith('-')) throw new Error(`unknown option: ${value}`);
    else if (!result.file) result.file = value;
    else throw new Error(`unexpected argument: ${value}`);
  }
  return result;
}

function nextValue(values: string[], index: number, flag: string): string {
  const value = values[index];
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
  return value;
}

function usage(): void {
  console.log(`Usage:
  sma blame --intent <file> [--lines START:END] [--json]
  node tools/sma-blame.ts --intent <file> [--repo <root>] [--lines START:END] [--json]
  node tools/sma-blame.ts --selftest

The umbrella "sma blame" route is intentionally wired by the orchestrator.
This scoped lane owns only the standalone TypeScript CLI and library.`);
}

function runSelftest(): void {
  const root = mkdtempSync(resolve(tmpdir(), 'sma-intent-blame-'));
  try {
    initializeFixture(root);
    const result = buildIntentBlame({ repoRoot: root, file: 'src/demo.ts' });
    const contextual = result.ranges.find((range) => range.start_line <= 1 && range.end_line >= 1);
    const uncontextual = result.ranges.find((range) => range.start_line <= 3 && range.end_line >= 3);
    assert(result.historical_paths.includes('src/demo.mjs'), 'rename lineage was not discovered');
    assert(contextual?.actor === 'agent-fixture', 'context actor was not joined');
    assert(contextual.intent.includes('preserve stable greeting'), 'intent was not joined');
    assert(contextual.intent.includes('rationale:'), 'decision rationale was not joined');
    assert(contextual.evidence.some((item) => item.command === 'node --check src/demo.mjs' && item.exit_code === 0), 'embedded verification was not joined');
    assert(contextual.evidence.some((item) => item.command === 'npm test' && item.exit_code === 0), 'evidence journal was not joined');
    assert(uncontextual?.actor === 'pre-Gen3 history', 'missing context was not labeled honestly');
    assert(renderIntentBlame(result).includes('LINE-RANGE'), 'table header is missing');
    assert(JSON.stringify(result).includes('"ranges"'), 'JSON result is not stable');
    console.log('sma-blame selftest: ok');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function initializeFixture(root: string): void {
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'intent-blame@example.test']);
  git(root, ['config', 'user.name', 'Intent Blame Fixture']);
  mkdirSync(resolve(root, 'src'), { recursive: true });
  writeFileSync(resolve(root, 'src/demo.mjs'), 'export const hello = "hello";\nexport const stable = true;\nexport const mode = "old";\n');
  git(root, ['add', 'src/demo.mjs']);
  git(root, ['commit', '-qm', 'initial demo']);
  const sourceCommit = git(root, ['rev-parse', 'HEAD']).trim();
  const timestamp = git(root, ['show', '-s', '--format=%aI', sourceCommit]).trim();
  writeFixtureContext(root, sourceCommit, timestamp);
  git(root, ['add', '.smarch']);
  git(root, ['commit', '-qm', 'record Gen3 intent and evidence']);
  git(root, ['mv', 'src/demo.mjs', 'src/demo.ts']);
  git(root, ['commit', '-qm', 'rename demo to TypeScript']);
  writeFileSync(resolve(root, 'src/demo.ts'), 'export const hello = "hello";\nexport const stable = true;\nexport const mode = "new";\n');
  git(root, ['add', 'src/demo.ts']);
  git(root, ['commit', '-qm', 'change mode without Gen3 context']);
}

function writeFixtureContext(root: string, commit: string, timestamp: string): void {
  mkdirSync(resolve(root, '.smarch/agent-context'), { recursive: true });
  mkdirSync(resolve(root, '.smarch/evidence'), { recursive: true });
  const context = {
    schema_version: '1.0.0', event_id: 'ctx-fixture', brick_id: 'demo', project: 'fixture',
    actor_kind: 'agent', actor_id: 'agent-fixture', kind: 'edit_applied',
    intent: 'preserve stable greeting', decision_rationale: 'keep the public contract unchanged',
    files_touched: ['src/demo.mjs'], commit, timestamp,
    verification: { command: 'node --check src/demo.mjs', status: 'pass' },
  };
  const evidence = { file: 'src/demo.mjs', command: 'npm test', exit: 0, commit, timestamp };
  writeFileSync(resolve(root, '.smarch/agent-context/demo.ndjson'), `${JSON.stringify(context)}\n`);
  writeFileSync(resolve(root, '.smarch/evidence/journal.jsonl'), `${JSON.stringify(evidence)}\n`);
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`selftest: ${message}`);
}
