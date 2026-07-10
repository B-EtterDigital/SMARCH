#!/usr/bin/env node
/**
 * SMA private-data leak gate.
 *
 * Scans tracked text files with the patterns in registry/leak-patterns.json.
 * Reviewed exceptions may be supplied as an array of { path, pattern } pairs,
 * or as { "exceptions": [...] }.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SMA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PATTERNS_PATH = resolve(SMA_ROOT, 'registry/leak-patterns.json');
const PATTERNS_REPO_PATH = 'registry/leak-patterns.json';
const root = resolve(process.cwd());

try {
  const args = parseArgs(process.argv.slice(2));
  const patterns = readPatterns(PATTERNS_PATH);
  const exceptions = args.allow ? readExceptions(resolve(args.allow)) : [];
  const files = trackedFiles(root);
  const patternRegistryPath = pathWithin(root, PATTERNS_PATH);
  const allowPath = args.allow ? pathWithin(root, resolve(args.allow)) : null;
  const hits = [];
  let textFileCount = 0;
  let allowedCount = 0;

  for (const file of files) {
    if (file === patternRegistryPath || file === PATTERNS_REPO_PATH || file === allowPath) continue;
    const absolutePath = resolve(root, file);
    if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) continue;
    const text = readTextFile(absolutePath);
    if (text === null) continue;
    textFileCount += 1;
    const lines = text.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      const lowered = line.toLowerCase();
      for (const entry of patterns) {
        if (!lowered.includes(entry.normalized)) continue;
        if (isSafePlaceholder(line, entry.pattern)) continue;
        const hit = {
          path: file,
          line: lineIndex + 1,
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

  const result = {
    status: hits.length ? 'failed' : 'passed',
    root,
    tracked_file_count: files.length,
    tracked_text_file_count: textFileCount,
    hit_count: hits.length,
    allowed_count: allowedCount,
    hits,
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printResult(result);
  }

  if (hits.length) process.exit(1);
} catch (error) {
  printError(error.code || 'UNEXPECTED_ERROR', error.message);
  process.exit(2);
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

function isSafePlaceholder(line, pattern) {
  const lowered = line.toLowerCase();
  if (pattern.startsWith('/') && lowered.includes(pattern.toLowerCase())) {
    return line.includes('[redacted]') || line.includes(`${pattern}...`);
  }
  if (!pattern.startsWith('@')) return false;
  const publicMailLink = line.match(/\[([^\]]+@[^\]]+)\]\(mailto:([^\)]+)\)/i);
  return Boolean(
    publicMailLink
      && publicMailLink[1].toLowerCase() === publicMailLink[2].toLowerCase()
      && publicMailLink[1].toLowerCase().includes(pattern.toLowerCase()),
  );
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
