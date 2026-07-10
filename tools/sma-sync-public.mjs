#!/usr/bin/env node
/**
 * SMA private-to-public tree sync.
 *
 * Dry-run is the default. A write is applied only after the transformed
 * staging tree passes tools/sma-leak-gate.mjs.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const TOOL_PATH = fileURLToPath(import.meta.url);
const SMA_ROOT = resolve(dirname(TOOL_PATH), '..');
const LEAK_GATE_PATH = resolve(SMA_ROOT, 'tools/sma-leak-gate.mjs');
const DEFAULT_CONFIG = 'registry/sync-public.config.json';
const GITLEAKS_CONFIG = '.gitleaks.toml';

let args = {};
try {
  args = parseArgs(process.argv.slice(2));
  if (args.selftest) {
    runSelftest();
  } else {
    const result = executeSync(args);
    printResult(result, args.json);
  }
} catch (error) {
  if (error.report && !args.selftest) printResult(error.report, args.json);
  printError(error.code || 'UNEXPECTED_ERROR', error.message);
  process.exit(error.exitCode || 2);
}

function executeSync(options, execution = {}) {
  if (!options.from) throw codedError('ARGUMENT_INVALID', '--from requires a source root');
  if (!options.to) throw codedError('ARGUMENT_INVALID', '--to requires a target root');

  const requestedFromRoot = resolve(options.from);
  const requestedToRoot = resolve(options.to);
  if (!existsSync(requestedFromRoot)) {
    throw codedError('SOURCE_NOT_FOUND', `source root is not a directory: ${requestedFromRoot}`);
  }
  const fromRoot = resolveRealPath(requestedFromRoot);
  const toRoot = resolveRealPath(requestedToRoot);
  if (!lstatSync(fromRoot).isDirectory()) {
    throw codedError('SOURCE_NOT_FOUND', `source root is not a directory: ${requestedFromRoot}`);
  }
  if (containsPath(fromRoot, toRoot) || containsPath(toRoot, fromRoot)) {
    throw codedError('ROOTS_OVERLAP', 'source and target roots must not be ancestors or descendants of each other');
  }

  const configPath = resolve(options.config || join(fromRoot, DEFAULT_CONFIG));
  const config = readConfig(configPath);
  const sourceFiles = collectFiles(fromRoot).filter((file) => isSelected(file, config));
  const targetFiles = existsSync(toRoot) ? collectFiles(toRoot).filter((file) => isSelected(file, config)) : [];
  const tempRoot = mkdtempSync(join(tmpdir(), 'sma-sync-public-'));
  const stageRoot = join(tempRoot, 'stage');
  mkdirSync(stageRoot, { recursive: true });

  try {
    const replacementCounts = config.replacements.map((replacement) => ({ ...replacement, count: 0 }));
    for (const file of sourceFiles) {
      const sourcePath = resolve(fromRoot, file);
      const targetPath = resolve(stageRoot, file);
      mkdirSync(dirname(targetPath), { recursive: true });
      const buffer = readFileSync(sourcePath);
      const text = decodeText(buffer);
      if (text === null) {
        writeFileSync(targetPath, buffer);
        continue;
      }
      let transformed = text;
      for (const replacement of replacementCounts) {
        const count = countOccurrences(transformed, replacement.from);
        if (!count) continue;
        transformed = transformed.split(replacement.from).join(replacement.to);
        replacement.count += count;
      }
      writeFileSync(targetPath, transformed);
    }

    const stageFiles = collectFiles(stageRoot);
    const stageSet = new Set(stageFiles);
    const adds = [];
    const changes = [];
    const removes = targetFiles.filter((file) => !stageSet.has(file)).sort();
    for (const file of stageFiles) {
      const targetPath = resolve(toRoot, file);
      if (!existsSync(targetPath)) {
        adds.push(file);
      } else if (!readFileSync(resolve(stageRoot, file)).equals(readFileSync(targetPath))) {
        changes.push(file);
      }
    }

    const report = {
      status: 'pending-leak-gate',
      mode: options.write ? 'write' : 'dry-run',
      from: fromRoot,
      to: toRoot,
      config: configPath,
      add_count: adds.length,
      change_count: changes.length,
      remove_count: removes.length,
      adds,
      changes,
      removes,
      replacement_counts: replacementCounts,
      leak_gate: null,
      gitleaks: null,
    };

    const leakResult = runLeakGate(stageRoot);
    report.leak_gate = {
      status: leakResult.status === 0 ? 'passed' : 'failed',
      exit: leakResult.status,
      output: leakResult.stdout.trim(),
    };
    const gitleaksResult = runGitleaks(stageRoot, execution);
    report.gitleaks = {
      status: !gitleaksResult.available ? 'unavailable' : gitleaksResult.status === 0 ? 'passed' : 'failed',
      exit: gitleaksResult.status,
      output: gitleaksResult.stdout.trim(),
    };
    if (!gitleaksResult.available) {
      const warning = 'WARN gitleaks binary not found on PATH; --write requires --allow-no-gitleaks';
      (execution.warn || console.warn)(warning);
    }
    if (leakResult.status !== 0 || (gitleaksResult.available && gitleaksResult.status !== 0)) {
      report.status = 'blocked';
      const leakFailed = leakResult.status !== 0;
      const detail = leakFailed
        ? leakResult.stdout.trim() || leakResult.stderr.trim() || 'staging tree failed leak gate'
        : gitleaksResult.stdout.trim() || gitleaksResult.stderr.trim() || 'staging tree failed gitleaks';
      const error = codedError(leakFailed ? 'LEAK_GATE_FAILED' : 'GITLEAKS_FAILED', detail);
      error.exitCode = 1;
      error.report = report;
      throw error;
    }
    if (!gitleaksResult.available && options.write && !options.allowNoGitleaks) {
      report.status = 'blocked';
      const error = codedError('GITLEAKS_REQUIRED', 'gitleaks is required for --write; install it or explicitly pass --allow-no-gitleaks');
      error.exitCode = 1;
      error.report = report;
      throw error;
    }

    if (options.write) applyChanges(stageRoot, toRoot, adds, changes, removes);
    report.status = 'passed';
    if (!execution.silent) return report;
    return report;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function readConfig(filePath) {
  if (!existsSync(filePath)) throw codedError('CONFIG_NOT_FOUND', `sync config not found: ${filePath}`);
  let payload;
  try {
    payload = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw codedError('CONFIG_INVALID', `cannot parse sync config: ${error.message}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw codedError('CONFIG_INVALID', 'sync config must be a JSON object');
  }
  const allowlistGlobs = validateStringArray(payload.allowlist_globs, 'allowlist_globs');
  if (allowlistGlobs.length === 0) throw codedError('CONFIG_INVALID', 'explicit allowlist required');
  const excludeGlobs = validateStringArray(payload.exclude_globs, 'exclude_globs');
  if (!Array.isArray(payload.replacements)) throw codedError('CONFIG_INVALID', 'replacements must be an array');
  const replacements = payload.replacements.map((entry, index) => {
    if (!entry || typeof entry.from !== 'string' || typeof entry.to !== 'string' || !entry.from) {
      throw codedError('CONFIG_INVALID', `replacement ${index + 1} must contain a non-empty from string and a to string`);
    }
    return { from: entry.from, to: entry.to };
  }).sort((left, right) => right.from.length - left.from.length || left.from.localeCompare(right.from));
  return { allowlistGlobs, excludeGlobs, replacements };
}

function validateStringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    throw codedError('CONFIG_INVALID', `${name} must be an array of non-empty strings`);
  }
  return value;
}

function collectFiles(root) {
  const files = [];
  walk(root, '', files);
  return files.sort();
}

function walk(root, relativeDir, files) {
  const absoluteDir = resolve(root, relativeDir);
  let entries;
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch (error) {
    throw codedError('DIRECTORY_READ_FAILED', `${absoluteDir}: ${error.message}`);
  }
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const relativePath = normalizePath(join(relativeDir, entry.name));
    const absolutePath = resolve(root, relativePath);
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) throw codedError('SYMLINK_UNSUPPORTED', `refusing symlink: ${relativePath}`);
    if (stat.isDirectory()) {
      walk(root, relativePath, files);
    } else if (stat.isFile()) {
      files.push(relativePath);
    }
  }
}

function isSelected(file, config) {
  const included = !config.allowlistGlobs.length || config.allowlistGlobs.some((glob) => matchesGlob(file, glob));
  return included && !config.excludeGlobs.some((glob) => matchesGlob(file, glob));
}

function matchesGlob(file, glob) {
  const normalizedGlob = normalizePath(glob);
  let source = '^';
  for (let index = 0; index < normalizedGlob.length; index += 1) {
    const char = normalizedGlob[index];
    if (char === '*' && normalizedGlob[index + 1] === '*') {
      if (normalizedGlob[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`).test(file);
}

function runLeakGate(stageRoot) {
  try {
    execFileSync('git', ['init', '-q'], { cwd: stageRoot, stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('git', ['add', '-f', '--', '.'], { cwd: stageRoot, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    const detail = error.stderr?.toString('utf8').trim() || error.message;
    throw codedError('STAGING_GIT_FAILED', detail);
  }
  return spawnSync(process.execPath, [LEAK_GATE_PATH], { cwd: stageRoot, encoding: 'utf8' });
}

function runGitleaks(stageRoot, execution) {
  const spawn = execution.gitleaksSpawn || spawnSync;
  const result = spawn(
    'gitleaks',
    ['detect', '--source', stageRoot, '--no-git', '--config', GITLEAKS_CONFIG],
    { cwd: SMA_ROOT, encoding: 'utf8' },
  );
  if (result.error?.code === 'ENOENT') {
    return { available: false, status: null, stdout: '', stderr: result.error.message || '' };
  }
  if (result.error) {
    return { available: true, status: result.status ?? 2, stdout: result.stdout || '', stderr: result.stderr || result.error.message || '' };
  }
  return {
    available: true,
    status: result.status ?? 2,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function resolveRealPath(filePath) {
  const absolutePath = resolve(filePath);
  let existingPath = absolutePath;
  const missingSegments = [];
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) break;
    missingSegments.unshift(basename(existingPath));
    existingPath = parent;
  }
  return resolve(realpathSync(existingPath), ...missingSegments);
}

function containsPath(parentPath, childPath) {
  const rel = relative(parentPath, childPath);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function applyChanges(stageRoot, toRoot, adds, changes, removes) {
  mkdirSync(toRoot, { recursive: true });
  for (const file of removes) {
    const targetPath = resolve(toRoot, file);
    if (existsSync(targetPath)) unlinkSync(targetPath);
  }
  for (const file of [...adds, ...changes]) {
    const sourcePath = resolve(stageRoot, file);
    const targetPath = resolve(toRoot, file);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}

function decodeText(buffer) {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

function countOccurrences(text, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`SMA public sync: ${result.status}`);
  console.log(`mode: ${result.mode}`);
  console.log(`files: ${result.add_count} add, ${result.change_count} change, ${result.remove_count} remove`);
  for (const file of result.adds) console.log(`ADD ${file}`);
  for (const file of result.changes) console.log(`CHANGE ${file}`);
  for (const file of result.removes) console.log(`REMOVE ${file}`);
  for (const replacement of result.replacement_counts) {
    console.log(`REPLACE ${replacement.count} ${JSON.stringify(replacement.from)} -> ${JSON.stringify(replacement.to)}`);
  }
  console.log(`leak gate: ${result.leak_gate?.status || 'not-run'}`);
  if (result.leak_gate?.status === 'failed' && result.leak_gate.output) console.log(result.leak_gate.output);
  console.log(`gitleaks: ${result.gitleaks?.status || 'not-run'}`);
  if (result.gitleaks?.status === 'failed' && result.gitleaks.output) console.log(result.gitleaks.output);
}

function runSelftest() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'sma-sync-public-selftest-'));
  const machineLeak = ['/ho', 'me/testuser'].join('');
  try {
    const gitleaksCalls = [];
    const passingGitleaks = mockGitleaks(0, gitleaksCalls);
    const scrubSource = join(fixtureRoot, 'scrub-source');
    const scrubTarget = join(fixtureRoot, 'scrub-target');
    mkdirSync(scrubSource, { recursive: true });
    writeFileSync(join(scrubSource, 'note.txt'), `owner=${machineLeak}\n`);
    const scrubConfig = join(fixtureRoot, 'scrub-config.json');
    writeFileSync(scrubConfig, JSON.stringify({
      allowlist_globs: ['**/*.txt'],
      exclude_globs: [],
      replacements: [{ from: machineLeak, to: '<private-home>' }],
      target_root: '',
    }));
    executeSync({ from: scrubSource, to: scrubTarget, config: scrubConfig, write: true }, passingGitleaks);
    assert(readFileSync(join(scrubTarget, 'note.txt'), 'utf8') === 'owner=<private-home>\n', 'scrub replacement was not applied');
    assert(gitleaksCalls.length === 1, 'gitleaks was not run for the staging tree');
    assertGitleaksInvocation(gitleaksCalls[0]);

    const emptyConfig = join(fixtureRoot, 'empty-config.json');
    writeFileSync(emptyConfig, JSON.stringify({ allowlist_globs: [], exclude_globs: [], replacements: [] }));
    expectErrorCode(() => readConfig(emptyConfig), 'CONFIG_INVALID', 'explicit allowlist required');

    const overlapRoot = join(fixtureRoot, 'overlap-root');
    const overlapChild = join(overlapRoot, 'child');
    mkdirSync(overlapChild, { recursive: true });
    expectErrorCode(
      () => executeSync({ from: overlapRoot, to: overlapChild, config: scrubConfig }, passingGitleaks),
      'ROOTS_OVERLAP',
    );
    expectErrorCode(
      () => executeSync({ from: overlapChild, to: overlapRoot, config: scrubConfig }, passingGitleaks),
      'ROOTS_OVERLAP',
    );
    const overlapAlias = join(fixtureRoot, 'overlap-alias');
    symlinkSync(overlapRoot, overlapAlias, 'dir');
    expectErrorCode(
      () => executeSync({ from: overlapAlias, to: join(overlapRoot, 'alias-child'), config: scrubConfig }, passingGitleaks),
      'ROOTS_OVERLAP',
    );

    const gateSource = join(fixtureRoot, 'gate-source');
    const gateTarget = join(fixtureRoot, 'gate-target');
    mkdirSync(gateSource, { recursive: true });
    mkdirSync(gateTarget, { recursive: true });
    writeFileSync(join(gateTarget, 'sentinel.txt'), 'unchanged\n');
    writeFileSync(join(gateSource, 'leak.txt'), `owner=${machineLeak}\n`);
    const gateConfig = join(fixtureRoot, 'gate-config.json');
    writeFileSync(gateConfig, JSON.stringify({ allowlist_globs: ['**/*.txt'], exclude_globs: [], replacements: [], target_root: '' }));
    let blocked = false;
    try {
      executeSync({ from: gateSource, to: gateTarget, config: gateConfig, write: true }, passingGitleaks);
    } catch (error) {
      blocked = error.code === 'LEAK_GATE_FAILED';
    }
    assert(blocked, 'leak gate did not block write');
    assert(readFileSync(join(gateTarget, 'sentinel.txt'), 'utf8') === 'unchanged\n', 'blocked write changed target');
    assert(!existsSync(join(gateTarget, 'leak.txt')), 'blocked write copied leaking file');

    writeFileSync(join(gateSource, 'leak.txt'), 'owner=public-user\n');
    executeSync({ from: gateSource, to: gateTarget, config: gateConfig, write: true }, passingGitleaks);
    assert(readFileSync(join(gateTarget, 'leak.txt'), 'utf8') === 'owner=public-user\n', 'clean tree did not sync');

    const missingWarnings = [];
    const missingGitleaks = mockMissingGitleaks(missingWarnings);
    const noGitleaksTarget = join(fixtureRoot, 'no-gitleaks-target');
    const dryRun = executeSync({ from: gateSource, to: noGitleaksTarget, config: gateConfig }, missingGitleaks);
    assert(dryRun.gitleaks.status === 'unavailable', 'dry-run did not report unavailable gitleaks');
    assert(missingWarnings.some((warning) => warning.startsWith('WARN ')), 'missing gitleaks did not print WARN');
    expectErrorCode(
      () => executeSync({ from: gateSource, to: noGitleaksTarget, config: gateConfig, write: true }, missingGitleaks),
      'GITLEAKS_REQUIRED',
    );
    assert(!existsSync(noGitleaksTarget), 'write without gitleaks changed the target');
    executeSync(
      { from: gateSource, to: noGitleaksTarget, config: gateConfig, write: true, allowNoGitleaks: true },
      missingGitleaks,
    );
    assert(existsSync(join(noGitleaksTarget, 'leak.txt')), '--allow-no-gitleaks did not permit a clean write');

    const failingGitleaks = mockGitleaks(1, []);
    const gitleaksBlockedTarget = join(fixtureRoot, 'gitleaks-blocked-target');
    let gitleaksError;
    try {
      executeSync({ from: gateSource, to: gitleaksBlockedTarget, config: gateConfig, write: true }, failingGitleaks);
    } catch (error) {
      gitleaksError = error;
    }
    assert(gitleaksError?.code === 'GITLEAKS_FAILED', 'gitleaks finding did not block write');
    assert(gitleaksError.report?.leak_gate?.status === 'passed', 'node leak gate did not run alongside gitleaks');
    assert(!existsSync(gitleaksBlockedTarget), 'failed gitleaks changed the target');
    console.log('SMA public sync selftest: passed');
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function mockGitleaks(status, calls) {
  return {
    silent: true,
    warn() {},
    gitleaksSpawn(command, args, options) {
      calls.push({ command, args, options });
      return { status, stdout: status === 0 ? '' : 'gitleaks finding', stderr: '' };
    },
  };
}

function mockMissingGitleaks(warnings) {
  return {
    silent: true,
    warn(message) { warnings.push(message); },
    gitleaksSpawn() {
      /** @type {NodeJS.ErrnoException} */
      const error = new Error('spawn gitleaks ENOENT');
      error.code = 'ENOENT';
      return { status: null, stdout: '', stderr: '', error };
    },
  };
}

function assertGitleaksInvocation(call) {
  assert(call.command === 'gitleaks', 'staging verification did not spawn gitleaks');
  assert(call.args[0] === 'detect', 'gitleaks detect subcommand missing');
  assert(call.args[1] === '--source' && isAbsolute(call.args[2]), 'gitleaks staging --source missing');
  assert(call.args.slice(3).join(' ') === '--no-git --config .gitleaks.toml', 'gitleaks safety arguments differ');
  assert(call.options.cwd === SMA_ROOT, 'gitleaks config was not resolved from the SMA root');
}

function expectErrorCode(action, code, messageIncludes = '') {
  let error;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  assert(error?.code === code, `expected ${code}, received ${error?.code || 'no error'}`);
  if (messageIncludes) assert(error.message.includes(messageIncludes), `missing error text: ${messageIncludes}`);
}

function assert(condition, message) {
  if (!condition) throw codedError('SELFTEST_FAILED', message);
}

function printError(code, message) {
  console.error(JSON.stringify({ tool: 'sma-sync-public', code, message }));
}

function codedError(code, message) {
  const error = /** @type {Error & {code?: string, exitCode?: number, report?: any}} */ (new Error(message));
  error.code = code;
  return error;
}

function normalizePath(value) {
  const normalized = value.split(sep).join('/').replace(/^\.\//, '');
  return isAbsolute(value) ? normalized.replace(/^\/+/, '') : normalized;
}

function parseArgs(list) {
  const out = {};
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];
    if (arg === '--allow-no-gitleaks') {
      out.allowNoGitleaks = true;
      continue;
    }
    if (arg === '--write' || arg === '--json' || arg === '--selftest') {
      out[arg.slice(2)] = true;
      continue;
    }
    if (arg === '--from' || arg === '--to' || arg === '--config') {
      const next = list[index + 1];
      if (!next || next.startsWith('--')) throw codedError('ARGUMENT_INVALID', `${arg} requires a path`);
      out[arg.slice(2)] = next;
      index += 1;
      continue;
    }
    throw codedError('ARGUMENT_INVALID', `unknown argument: ${arg}`);
  }
  return out;
}
