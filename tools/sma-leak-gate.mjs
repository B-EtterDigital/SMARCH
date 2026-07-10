#!/usr/bin/env node
/**
 * SMA private-data leak gate.
 *
 * Scans tracked text files with the patterns in registry/leak-patterns.json.
 * Reviewed exceptions may be supplied as an array of { path, pattern } pairs,
 * or as { "exceptions": [...] }.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_PATH = fileURLToPath(import.meta.url);
const SMA_ROOT = resolve(dirname(TOOL_PATH), '..');
const PATTERNS_PATH = resolve(SMA_ROOT, 'registry/leak-patterns.json');
const PATTERNS_REPO_PATH = 'registry/leak-patterns.json';

// The gate and its pattern file necessarily contain pattern-shaped text
// (selftest fixtures, the patterns themselves) — scanning them is always a
// false positive. Everything else stays in scope.
const SELF_EXCLUDE = new Set(['tools/sma-leak-gate.mjs', PATTERNS_REPO_PATH]);
const root = resolve(process.cwd());

let args = {};
try {
  args = parseArgs(process.argv.slice(2));
  if (args.selftest) {
    runSelftest();
  } else {
    const result = scanLeaks(args, root);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printResult(result);
    }
    if (result.hit_count > 0) process.exitCode = 1;
  }
} catch (error) {
  printError(error.code || 'UNEXPECTED_ERROR', error.message);
  process.exitCode = 2;
}

function scanLeaks(options, repoRoot) {
  const patterns = readPatterns(PATTERNS_PATH);
  const exceptions = options.allow ? readExceptions(resolve(options.allow)) : [];
  const files = trackedFiles(repoRoot);
  const patternRegistryPath = pathWithin(repoRoot, PATTERNS_PATH);
  const allowPath = options.allow ? pathWithin(repoRoot, resolve(options.allow)) : null;
  const hits = [];
  let textFileCount = 0;
  let allowedCount = 0;

  for (const file of files) {
    if (file === patternRegistryPath || file === allowPath || SELF_EXCLUDE.has(file)) continue;
    const absolutePath = resolve(repoRoot, file);
    if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) continue;
    const text = readTextFile(absolutePath);
    if (text === null) continue;
    textFileCount += 1;
    const lines = text.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      for (const entry of patterns) {
        for (const matchIndex of findMatchIndexes(line.toLowerCase(), entry.normalized)) {
          if (isSafePlaceholder(line, matchIndex, entry.pattern)) continue;
          const hit = {
            path: file,
            line: lineIndex + 1,
            column: matchIndex + 1,
            pattern: entry.pattern,
            category: entry.category,
          };
          if (isAllowed(hit, exceptions)) {
            allowedCount += 1;
          } else {
            hits.push(hit);
          }
        }
      }
    }
  }

  const result = {
    status: hits.length ? 'failed' : 'passed',
    root: repoRoot,
    tracked_file_count: files.length,
    tracked_text_file_count: textFileCount,
    hit_count: hits.length,
    allowed_count: allowedCount,
    hits,
  };
  return result;
}

function readPatterns(filePath) {
  if (!existsSync(filePath)) throw codedError('PATTERNS_NOT_FOUND', `pattern registry not found: ${filePath}`);
  let payload;
  try {
    payload = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw codedError('PATTERNS_INVALID', `cannot parse pattern registry: ${error.message}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw codedError('PATTERNS_INVALID', 'pattern registry must be a JSON object');
  }

  const entries = [];
  for (const [category, values] of Object.entries(payload)) {
    if (category.startsWith('$')) continue;
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value)) {
      throw codedError('PATTERNS_INVALID', `${category} must be an array of non-empty strings`);
    }
    for (const pattern of values) entries.push({ category, pattern, normalized: pattern.toLowerCase() });
  }
  return entries;
}

function readExceptions(filePath) {
  if (!existsSync(filePath)) throw codedError('ALLOW_NOT_FOUND', `allow file not found: ${filePath}`);
  let payload;
  try {
    payload = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw codedError('ALLOW_INVALID', `cannot parse allow file: ${error.message}`);
  }
  const entries = Array.isArray(payload) ? payload : payload?.exceptions;
  if (!Array.isArray(entries)) {
    throw codedError('ALLOW_INVALID', 'allow file must be an array or an object with an exceptions array');
  }
  return entries.map((entry, index) => {
    if (!entry || typeof entry.path !== 'string' || typeof entry.pattern !== 'string' || !entry.path || !entry.pattern) {
      throw codedError('ALLOW_INVALID', `exception ${index + 1} must contain non-empty path and pattern strings`);
    }
    return { path: normalizePath(entry.path), pattern: entry.pattern.toLowerCase() };
  });
}

function trackedFiles(repoRoot) {
  let output;
  try {
    output = execFileSync('git', ['-C', repoRoot, 'ls-files', '-z'], { encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const detail = error.stderr?.toString('utf8').trim() || error.message;
    throw codedError('GIT_LS_FILES_FAILED', detail);
  }
  return output.toString('utf8').split('\0').filter(Boolean).map(normalizePath).sort();
}

function readTextFile(filePath) {
  let buffer;
  try {
    buffer = readFileSync(filePath);
  } catch (error) {
    throw codedError('FILE_READ_FAILED', `${filePath}: ${error.message}`);
  }
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function isAllowed(hit, exceptions) {
  const pattern = hit.pattern.toLowerCase();
  return exceptions.some((entry) => entry.path === hit.path && entry.pattern === pattern);
}

function findMatchIndexes(text, pattern) {
  const indexes = [];
  let offset = 0;
  while ((offset = text.indexOf(pattern, offset)) !== -1) {
    indexes.push(offset);
    offset += pattern.length;
  }
  return indexes;
}

function isSafePlaceholder(line, matchIndex, pattern) {
  if (pattern.startsWith('/')) {
    const suffix = line.slice(matchIndex + pattern.length);
    return suffix.startsWith('[redacted]') || suffix.startsWith('...');
  }
  if (!pattern.startsWith('@')) return false;
  const mailLinkPattern = /\[([^\]]+@[^\]]+)\]\(mailto:([^\)]+)\)/ig;
  for (const publicMailLink of line.matchAll(mailLinkPattern)) {
    const start = publicMailLink.index;
    const end = start + publicMailLink[0].length;
    if (
      matchIndex >= start
      && matchIndex < end
      && publicMailLink[1].toLowerCase() === publicMailLink[2].toLowerCase()
      && publicMailLink[1].toLowerCase().includes(pattern.toLowerCase())
    ) return true;
  }
  return false;
}

function runSelftest() {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'sma-leak-gate-selftest-'));
  try {
    mkdirSync(fixtureRoot, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: fixtureRoot, stdio: 'ignore' });
    const fixturePath = resolve(fixtureRoot, 'mixed.txt');
    writeFileSync(
      fixturePath,
      'placeholder=/home/[redacted] real=/home/private\n'
      + 'public=[team@gmail.com](mailto:team@gmail.com) private=owner@gmail.com\n',
    );
    execFileSync('git', ['add', '--', 'mixed.txt'], { cwd: fixtureRoot, stdio: 'ignore' });

    const failed = spawnTool(fixtureRoot);
    assert(failed.status === 1, `leak hits must exit 1, received ${failed.status}`);
    const failedResult = JSON.parse(failed.stdout);
    assert(failedResult.hit_count === 2, `expected two real per-match hits, received ${failedResult.hit_count}`);
    assert(failedResult.hits.every((hit) => hit.column > 1), 'per-match hits must include their columns');

    writeFileSync(
      fixturePath,
      'placeholder=/home/[redacted]\npublic=[team@gmail.com](mailto:team@gmail.com)\n',
    );
    execFileSync('git', ['add', '--', 'mixed.txt'], { cwd: fixtureRoot, stdio: 'ignore' });
    const passed = spawnTool(fixtureRoot);
    assert(passed.status === 0, `placeholder-only fixture must exit 0, received ${passed.status}`);
    assert(JSON.parse(passed.stdout).hit_count === 0, 'placeholder-only fixture produced a hit');
    console.log('SMA leak gate selftest: passed');
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function spawnTool(cwd) {
  const result = spawnSync(process.execPath, [TOOL_PATH, '--json'], { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  return result;
}

function assert(condition, message) {
  if (!condition) throw codedError('SELFTEST_FAILED', message);
}

function printResult(result) {
  console.log(`SMA leak gate: ${result.status}`);
  console.log(`tracked text files: ${result.tracked_text_file_count} | hits: ${result.hit_count} | allowed: ${result.allowed_count}`);
  for (const hit of result.hits) console.log(`${hit.path}:${hit.line}:${hit.pattern}`);
}

function printError(code, message) {
  console.error(JSON.stringify({ tool: 'sma-leak-gate', code, message }));
}

function codedError(code, message) {
  const error = /** @type {Error & {code?: string}} */ (new Error(message));
  error.code = code;
  return error;
}

function pathWithin(rootPath, filePath) {
  const rel = relative(rootPath, filePath);
  if (rel.startsWith('..') || resolve(rootPath, rel) !== resolve(filePath)) return null;
  return normalizePath(rel);
}

function normalizePath(value) {
  return value.split(sep).join('/').replace(/^\.\//, '');
}

function parseArgs(list) {
  const out = {};
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];
    if (arg === '--json') {
      out.json = true;
      continue;
    }
    if (arg === '--selftest') {
      out.selftest = true;
      continue;
    }
    if (arg === '--allow') {
      const next = list[index + 1];
      if (!next || next.startsWith('--')) throw codedError('ARGUMENT_INVALID', '--allow requires a file path');
      out.allow = next;
      index += 1;
      continue;
    }
    throw codedError('ARGUMENT_INVALID', `unknown argument: ${arg}`);
  }
  return out;
}
