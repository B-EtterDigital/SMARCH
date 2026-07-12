#!/usr/bin/env node
/**
 * WHAT: Prepares and optionally applies a filtered private-to-public tree sync.
 * WHY: Public mirrors must exclude private files and secrets before any target changes.
 * HOW: Reads source, target, and sync configuration, transforms a staging tree, then runs leak gates.
 * OUTPUTS: Prints a dry-run report by default and applies the staged tree only with --write.
 * CALLERS: Release operators use it to maintain the public repository safely.
 * USAGE: `node tools/sma-sync-public.mjs --selftest`
 * Glossary: [SMA](../docs/GLOSSARY.md).
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const TOOL_PATH = fileURLToPath(import.meta.url);
const SMA_ROOT = resolve(dirname(TOOL_PATH), '..');
const LEAK_GATE_PATH = resolve(SMA_ROOT, 'tools/sma-leak-gate.mjs');
const DEFAULT_CONFIG = 'registry/sync-public.config.json';
const DEFAULT_PRIVATE_OVERLAY = 'registry/private-overlay.json';
const GITLEAKS_CONFIG = '.gitleaks.toml';
const APPLY_JOURNAL_VERSION = 1;

/** @typedef {{from?: string, to?: string, config?: string, write?: boolean, allowNoGitleaks?: boolean, json?: boolean, quiet?: boolean, verbose?: boolean, selftest?: boolean, help?: boolean}} CliArgs */
/** @typedef {{from: string, to: string}} Replacement */
/** @typedef {Replacement & {count: number}} ReplacementCount */
/** @typedef {{allowlistGlobs: string[], excludeGlobs: string[], replacements: Replacement[]}} SyncConfig */
/** @typedef {{path: string, privateGlobs: string[], privatePatterns: string[]}} PrivateOverlay */
/** @typedef {{status: string, exit: number | null, output: string}} GateReport */
/** @typedef {{status: string, mode: string, from: string, to: string, config: string, add_count: number, change_count: number, remove_count: number, adds: string[], changes: string[], removes: string[], replacement_counts: ReplacementCount[], leak_gate: GateReport | null, gitleaks: GateReport | null}} SyncReport */
/** @typedef {{status: number | null, stdout: string, stderr: string, error?: NodeJS.ErrnoException}} SpawnResult */
/** @typedef {{gitleaksSpawn?: (command: string, args: string[], options: {cwd: string, encoding: string}) => SpawnResult, warn?: (message: string) => void, silent?: boolean, crashAfterSwaps?: number}} Execution */
/** @typedef {Error & {code?: string, exitCode?: number, report?: SyncReport}} CodedError */
/** @typedef {{name: string, had_original: boolean, staged: boolean, state: string}} ApplyEntry */
/** @typedef {{version: number, state: string, target_root: string, target_root_existed: boolean, transaction_root: string, entries: ApplyEntry[]}} ApplyJournal */
/** @typedef {{command: string, args: string[], options: {cwd: string, encoding: string}}} GitleaksCall */

/** @type {CliArgs} */
let args = {};
try {
  args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
  } else if (args.selftest) {
    runSelftest();
  } else {
    const result = executeSync(args);
    printResult(result, args.json, args.quiet);
    if (args.verbose) console.error(`sma-sync-public: checked ${result.add_count + result.change_count + result.remove_count} changes`);
  }
} catch (error) {
  const failure = /** @type {CodedError} */ (error);
  if (failure.report && !args.selftest) printResult(failure.report, args.json, args.quiet);
  else if (args.json) console.log(JSON.stringify({ status: 'failed', error: { code: failure.code || 'UNEXPECTED_ERROR', message: failure.message } }));
  printError(failure.code || 'UNEXPECTED_ERROR', failure.message, failure);
  process.exit(failure.exitCode || 2);
}

/** @returns {string} */
function usage() {
  return `Synchronize a filtered private tree to a public target.

Usage:
  sma sync-public --from <source> --to <target> [--config <file>] [--write] [--allow-no-gitleaks] [--json]
  sma sync-public --selftest

Options: --from, --to, --config, --write, --allow-no-gitleaks, --json, --quiet, --verbose, --selftest, --help
Examples:
  sma sync-public --from . --to ../public --json
  sma sync-public --from . --to ../public --write

Exit codes: 0 success; 2 usage/config; 1 leak/security block; 3 missing source; 4 apply/recovery failure.
Known limitation: --write requires gitleaks unless --allow-no-gitleaks is explicitly supplied.`;
}

/** @param {CliArgs} options @param {Execution} [execution] @returns {SyncReport} */
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
  recoverPendingApply(toRoot, options.write);

  const configPath = resolve(options.config || join(fromRoot, DEFAULT_CONFIG));
  const config = readConfig(configPath);
  const overlay = readPrivateOverlay(join(fromRoot, DEFAULT_PRIVATE_OVERLAY));
  const sourceFiles = collectFiles(fromRoot).filter((file) => isSelected(file, config) && !isPrivateFile(fromRoot, file, overlay));
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
    /** @type {string[]} */
    const adds = [];
    /** @type {string[]} */
    const changes = [];
    const removes = targetFiles.filter((file) => !stageSet.has(file)).sort();
    for (const file of stageFiles) {
      const targetPath = resolve(toRoot, file);
      if (!existsSync(targetPath)) {
        adds.push(file);
      } else if (!lstatSync(targetPath).isFile() || !readFileSync(resolve(stageRoot, file)).equals(readFileSync(targetPath))) {
        changes.push(file);
      }
    }

    /** @type {SyncReport} */
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

    const leakResult = runLeakGate(stageRoot, overlay.path);
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

    if (options.write) applyChanges(stageRoot, toRoot, adds, changes, removes, execution);
    report.status = 'passed';
    if (!execution.silent) return report;
    return report;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

/** @param {string} filePath @returns {PrivateOverlay} */
function readPrivateOverlay(filePath) {
  if (!existsSync(filePath)) return { path: filePath, privateGlobs: [], privatePatterns: [] };
  let payload;
  try { payload = JSON.parse(readFileSync(filePath, 'utf8')); } catch (error) {
    throw codedError('OVERLAY_INVALID', `cannot parse private overlay: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw codedError('OVERLAY_INVALID', 'private overlay must be a JSON object');
  const object = /** @type {Record<string, unknown>} */ (payload);
  const privateGlobs = optionalStringArray(object.private_globs, 'private_globs');
  const privatePatterns = [
    ...optionalStringArray(object.private_endpoint_patterns, 'private_endpoint_patterns'),
    ...optionalStringArray(object.private_name_patterns, 'private_name_patterns'),
  ];
  return { path: filePath, privateGlobs, privatePatterns };
}

/** @param {unknown} value @param {string} name */
function optionalStringArray(value, name) {
  if (value === undefined) return [];
  return validateStringArray(value, name);
}

/** @param {string} root @param {string} file @param {PrivateOverlay} overlay */
function isPrivateFile(root, file, overlay) {
  if (normalizePath(file) === DEFAULT_PRIVATE_OVERLAY) return true;
  if (overlay.privateGlobs.some((glob) => matchesGlob(file, glob))) return true;
  const text = decodeText(readFileSync(resolve(root, file)));
  if (text === null) return false;
  if (text.split(/\r?\n/).some((line) => /^\s*(?:(?:\/\/|#|;|\/\*+|\*|<!--)\s*)?@sma-private(?:\s*(?:\*\/|-->)\s*)?$/.test(line))) return true;
  const normalized = text.toLowerCase();
  return overlay.privatePatterns.some((pattern) => normalized.includes(pattern.toLowerCase()));
}

/** @param {string} filePath @returns {SyncConfig} */
function readConfig(filePath) {
  if (!existsSync(filePath)) throw codedError('CONFIG_NOT_FOUND', `sync config not found: ${filePath}`);
  let payload;
  try {
    payload = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw codedError('CONFIG_INVALID', `cannot parse sync config: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw codedError('CONFIG_INVALID', 'sync config must be a JSON object');
  }
  const configPayload = /** @type {{allowlist_globs?: unknown, exclude_globs?: unknown, replacements?: unknown}} */ (payload);
  const allowlistGlobs = validateStringArray(configPayload.allowlist_globs, 'allowlist_globs');
  if (allowlistGlobs.length === 0) throw codedError('CONFIG_INVALID', 'explicit allowlist required');
  const excludeGlobs = validateStringArray(configPayload.exclude_globs, 'exclude_globs');
  if (!Array.isArray(configPayload.replacements)) throw codedError('CONFIG_INVALID', 'replacements must be an array');
  const replacements = configPayload.replacements.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || !('from' in entry) || !('to' in entry)
        || typeof entry.from !== 'string' || typeof entry.to !== 'string' || !entry.from) {
      throw codedError('CONFIG_INVALID', `replacement ${index + 1} must contain a non-empty from string and a to string`);
    }
    return { from: entry.from, to: entry.to };
  }).sort((left, right) => right.from.length - left.from.length || left.from.localeCompare(right.from));
  return { allowlistGlobs, excludeGlobs, replacements };
}

/** @param {unknown} value @param {string} name @returns {string[]} */
function validateStringArray(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item)) {
    throw codedError('CONFIG_INVALID', `${name} must be an array of non-empty strings`);
  }
  return /** @type {string[]} */ (value);
}

/** @param {string} root @returns {string[]} */
function collectFiles(root) {
  /** @type {string[]} */
  const files = [];
  walk(root, '', files);
  return files.sort();
}

/** @param {string} root @param {string} relativeDir @param {string[]} files @returns {void} */
function walk(root, relativeDir, files) {
  const absoluteDir = resolve(root, relativeDir);
  let entries;
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch (error) {
    throw codedError('DIRECTORY_READ_FAILED', `${absoluteDir}: ${error instanceof Error ? error.message : String(error)}`);
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

/** @param {string} file @param {SyncConfig} config @returns {boolean} */
function isSelected(file, config) {
  const included = !config.allowlistGlobs.length || config.allowlistGlobs.some((glob) => matchesGlob(file, glob));
  return included && !config.excludeGlobs.some((glob) => matchesGlob(file, glob));
}

/** @param {string} file @param {string} glob @returns {boolean} */
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

/** @param {string} stageRoot @param {string} overlayPath @returns {import('node:child_process').SpawnSyncReturns<string>} */
function runLeakGate(stageRoot, overlayPath) {
  try {
    execFileSync('git', ['init', '-q'], { cwd: stageRoot, stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('git', ['add', '-f', '--', '.'], { cwd: stageRoot, stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    const failure = /** @type {Error & {stderr?: Buffer}} */ (error);
    const detail = failure.stderr?.toString('utf8').trim() || failure.message;
    throw codedError('STAGING_GIT_FAILED', detail);
  }
  const overlayArgs = existsSync(overlayPath) ? ['--overlay', overlayPath] : [];
  return spawnSync(process.execPath, [LEAK_GATE_PATH, '--json', ...overlayArgs], { cwd: stageRoot, encoding: 'utf8' });
}

/** @param {string} stageRoot @param {Execution} execution @returns {{available: boolean, status: number | null, stdout: string, stderr: string}} */
function runGitleaks(stageRoot, execution) {
  const spawn = execution.gitleaksSpawn || spawnSync;
  const result = spawn(
    'gitleaks',
    ['detect', '--source', stageRoot, '--no-git', '--config', GITLEAKS_CONFIG],
    { cwd: SMA_ROOT, encoding: 'utf8' },
  );
  if (/** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code === 'ENOENT') {
    return { available: false, status: null, stdout: '', stderr: result.error.message || '' };
  }
  if (result.error) {
    return { available: true, status: result.status ?? 2, stdout: String(result.stdout || ''), stderr: String(result.stderr || result.error.message || '') };
  }
  return {
    available: true,
    status: result.status ?? 2,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

/** @param {string} filePath @returns {string} */
function resolveRealPath(filePath) {
  const absolutePath = resolve(filePath);
  let existingPath = absolutePath;
  /** @type {string[]} */
  const missingSegments = [];
  while (!existsSync(existingPath)) {
    const parent = dirname(existingPath);
    if (parent === existingPath) break;
    missingSegments.unshift(basename(existingPath));
    existingPath = parent;
  }
  return resolve(realpathSync(existingPath), ...missingSegments);
}

/** @param {string} parentPath @param {string} childPath @returns {boolean} */
function containsPath(parentPath, childPath) {
  const rel = relative(parentPath, childPath);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** @param {string} stageRoot @param {string} toRoot @param {string[]} adds @param {string[]} changes @param {string[]} removes @param {Execution} [execution] */
function applyChanges(stageRoot, toRoot, adds, changes, removes, execution = {}) {
  const affectedFiles = [...new Set([...adds, ...changes, ...removes])].sort();
  const topLevelEntries = [...new Set(affectedFiles.map((file) => file.split('/')[0]))].sort();
  if (topLevelEntries.length === 0) return;

  const targetParent = dirname(toRoot);
  mkdirSync(targetParent, { recursive: true });
  const transactionRoot = mkdtempSync(join(targetParent, `.${basename(toRoot)}.sma-sync-public-`));
  const transactionStage = join(transactionRoot, 'stage');
  const backupRoot = join(transactionRoot, 'backup');
  mkdirSync(transactionStage, { recursive: true });
  mkdirSync(backupRoot, { recursive: true });

  const journalPath = applyJournalPath(toRoot);
  /** @type {ApplyJournal} */
  const journal = {
    version: APPLY_JOURNAL_VERSION,
    state: 'preparing',
    target_root: toRoot,
    target_root_existed: existsSync(toRoot),
    transaction_root: transactionRoot,
    entries: topLevelEntries.map((name) => ({
      name,
      had_original: existsSync(join(toRoot, name)),
      staged: false,
      state: 'pending',
    })),
  };

  try {
    for (const entry of journal.entries) {
      prepareTopLevelEntry(stageRoot, toRoot, transactionStage, entry.name, adds, changes, removes);
      entry.staged = existsSync(join(transactionStage, entry.name));
      entry.state = 'prepared';
    }
    journal.state = 'applying';
    writeApplyJournal(journalPath, journal);
    mkdirSync(toRoot, { recursive: true });

    let swapsCompleted = 0;
    for (const entry of journal.entries) {
      const targetPath = join(toRoot, entry.name);
      const backupPath = join(backupRoot, entry.name);
      const stagedPath = join(transactionStage, entry.name);
      entry.state = 'swapping';
      writeApplyJournal(journalPath, journal);
      if (entry.had_original) {
        renameSync(targetPath, backupPath);
        entry.state = 'old-moved';
        writeApplyJournal(journalPath, journal);
      }
      if (entry.staged) renameSync(stagedPath, targetPath);
      entry.state = 'new-installed';
      writeApplyJournal(journalPath, journal);
      swapsCompleted += 1;
      injectApplyCrash(swapsCompleted, execution);
    }

    journal.state = 'applied';
    writeApplyJournal(journalPath, journal);
    rmSync(journalPath, { force: true });
    rmSync(transactionRoot, { recursive: true, force: true });
  } catch (error) {
    try {
      if (existsSync(journalPath)) rollbackApplyJournal(journalPath, toRoot);
      else rmSync(transactionRoot, { recursive: true, force: true });
    } catch (rollbackError) {
      const applyMessage = error instanceof Error ? error.message : String(error);
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw codedError('APPLY_ROLLBACK_FAILED', `${applyMessage}; rollback failed: ${rollbackMessage}`);
    }
    throw error;
  }
}

/** @param {string} stageRoot @param {string} toRoot @param {string} transactionStage @param {string} topLevel @param {string[]} adds @param {string[]} changes @param {string[]} removes */
function prepareTopLevelEntry(stageRoot, toRoot, transactionStage, topLevel, adds, changes, removes) {
  const currentPath = join(toRoot, topLevel);
  const stagedPath = join(transactionStage, topLevel);
  if (existsSync(currentPath)) cpSync(currentPath, stagedPath, { recursive: true, preserveTimestamps: true });

  for (const file of removes.filter((candidate) => candidate === topLevel || candidate.startsWith(`${topLevel}/`))) {
    rmSync(join(transactionStage, file), { recursive: true, force: true });
  }
  for (const file of [...adds, ...changes].filter((candidate) => candidate === topLevel || candidate.startsWith(`${topLevel}/`))) {
    const sourcePath = join(stageRoot, file);
    const targetPath = join(transactionStage, file);
    ensureDirectory(dirname(targetPath), transactionStage);
    if (existsSync(targetPath) && lstatSync(targetPath).isDirectory()) {
      rmSync(targetPath, { recursive: true, force: true });
    }
    copyFileSync(sourcePath, targetPath);
  }
}

/** @param {string} directory @param {string} boundary */
function ensureDirectory(directory, boundary) {
  if (directory === boundary) return;
  if (existsSync(directory)) {
    if (lstatSync(directory).isDirectory()) return;
    rmSync(directory, { recursive: true, force: true });
  }
  ensureDirectory(dirname(directory), boundary);
  mkdirSync(directory);
}

/** @param {string} toRoot @param {boolean | undefined} write */
function recoverPendingApply(toRoot, write) {
  const journalPath = applyJournalPath(toRoot);
  if (!existsSync(journalPath)) return;
  if (!write) {
    throw codedError('APPLY_RECOVERY_REQUIRED', `interrupted sync journal found; rerun with --write to recover: ${journalPath}`);
  }
  rollbackApplyJournal(journalPath, toRoot);
}

/** @param {string} journalPath @param {string} expectedTargetRoot */
function rollbackApplyJournal(journalPath, expectedTargetRoot) {
  /** @type {ApplyJournal} */
  let journal;
  try {
    journal = /** @type {ApplyJournal} */ (JSON.parse(readFileSync(journalPath, 'utf8')));
  } catch (error) {
    throw codedError('APPLY_JOURNAL_INVALID', `cannot read rollback journal: ${error instanceof Error ? error.message : String(error)}`);
  }
  validateApplyJournal(journal, expectedTargetRoot);
  journal.state = 'rolling-back';
  writeApplyJournal(journalPath, journal);
  const backupRoot = join(journal.transaction_root, 'backup');

  for (const entry of [...journal.entries].reverse()) {
    const targetPath = join(expectedTargetRoot, entry.name);
    const backupPath = join(backupRoot, entry.name);
    if (existsSync(backupPath)) {
      rmSync(targetPath, { recursive: true, force: true });
      renameSync(backupPath, targetPath);
    } else if (!entry.had_original) {
      rmSync(targetPath, { recursive: true, force: true });
    } else if (!existsSync(targetPath)) {
      throw codedError('APPLY_RECOVERY_FAILED', `original entry is missing without a backup: ${entry.name}`);
    }
    entry.state = 'rolled-back';
    writeApplyJournal(journalPath, journal);
  }

  if (!journal.target_root_existed) rmSync(expectedTargetRoot, { recursive: true, force: true });
  rmSync(journalPath, { force: true });
  rmSync(journal.transaction_root, { recursive: true, force: true });
}

/** @param {ApplyJournal} journal @param {string} expectedTargetRoot */
function validateApplyJournal(journal, expectedTargetRoot) {
  const transactionParent = dirname(expectedTargetRoot);
  if (journal?.version !== APPLY_JOURNAL_VERSION || journal.target_root !== expectedTargetRoot) {
    throw codedError('APPLY_JOURNAL_INVALID', 'rollback journal does not match the requested target');
  }
  const transactionPrefix = `.${basename(expectedTargetRoot)}.sma-sync-public-`;
  if (
    typeof journal.transaction_root !== 'string'
    || !containsPath(transactionParent, journal.transaction_root)
    || journal.transaction_root === transactionParent
    || !basename(journal.transaction_root).startsWith(transactionPrefix)
  ) {
    throw codedError('APPLY_JOURNAL_INVALID', 'rollback journal transaction root is outside the target parent');
  }
  if (!Array.isArray(journal.entries) || journal.entries.some((entry) => (
    !entry || typeof entry.name !== 'string' || !entry.name || entry.name.includes('/') || entry.name === '.' || entry.name === '..'
  ))) {
    throw codedError('APPLY_JOURNAL_INVALID', 'rollback journal contains an invalid top-level entry');
  }
}

/** @param {string} journalPath @param {ApplyJournal} journal */
function writeApplyJournal(journalPath, journal) {
  const temporaryPath = `${journalPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(journal, null, 2)}\n`);
  renameSync(temporaryPath, journalPath);
}

/** @param {string} toRoot @returns {string} */
function applyJournalPath(toRoot) {
  return join(dirname(toRoot), `.${basename(toRoot)}.sma-sync-public.journal.json`);
}

/** @param {number} swapsCompleted @param {Execution} execution */
function injectApplyCrash(swapsCompleted, execution) {
  const configured = execution.crashAfterSwaps ?? Number.parseInt(process.env.SMA_SYNC_PUBLIC_TEST_CRASH_AFTER_SWAPS || '', 10);
  if (!Number.isInteger(configured) || configured < 1 || swapsCompleted !== configured) return;
  process.kill(process.pid, 'SIGKILL');
}

/** @param {Buffer} buffer @returns {string | null} */
function decodeText(buffer) {
  if (buffer.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

/** @param {string} text @param {string} needle @returns {number} */
function countOccurrences(text, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

/** @param {SyncReport} result @param {boolean | undefined} json @param {boolean | undefined} [quiet] */
function printResult(result, json, quiet = false) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (quiet) return;
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

/** @returns {void} */
function runSelftest() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'sma-sync-public-selftest-'));
  const machineLeak = ['/ho', 'me/testuser'].join('');
  try {
    /** @type {GitleaksCall[]} */
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

    const overlaySource = join(fixtureRoot, 'overlay-source');
    const overlayTarget = join(fixtureRoot, 'overlay-target');
    mkdirSync(join(overlaySource, 'registry'), { recursive: true });
    mkdirSync(join(overlaySource, 'internal'), { recursive: true });
    writeFileSync(join(overlaySource, 'registry/private-overlay.json'), JSON.stringify({
      private_globs: ['internal/**'],
      private_endpoint_patterns: ['https://private.invalid'],
      private_name_patterns: ['Internal Widget'],
    }));
    writeFileSync(join(overlaySource, 'public.txt'), 'public\n');
    writeFileSync(join(overlaySource, 'marked.txt'), '# @sma-private\n');
    writeFileSync(join(overlaySource, 'internal/globbed.txt'), 'clean\n');
    writeFileSync(join(overlaySource, 'endpoint.txt'), 'https://private.invalid\n');
    writeFileSync(join(overlaySource, 'name.txt'), 'Internal Widget\n');
    const overlayConfig = join(fixtureRoot, 'overlay-config.json');
    writeFileSync(overlayConfig, JSON.stringify({ allowlist_globs: ['**/*.txt'], exclude_globs: [], replacements: [] }));
    executeSync({ from: overlaySource, to: overlayTarget, config: overlayConfig, write: true }, passingGitleaks);
    assert(existsSync(join(overlayTarget, 'public.txt')), 'public overlay fixture was not copied');
    for (const privateFile of ['marked.txt', 'internal/globbed.txt', 'endpoint.txt', 'name.txt']) {
      assert(!existsSync(join(overlayTarget, privateFile)), `private overlay fixture was copied: ${privateFile}`);
    }
    for (const [privateFile, content, expectedCategory] of [
      ['marked.txt', '# @sma-private\n', 'private_marker'],
      ['internal/globbed.txt', 'clean\n', 'private_overlay'],
      ['endpoint.txt', 'https://private.invalid\n', 'private_endpoint'],
      ['name.txt', 'Internal Widget\n', 'private_name'],
    ]) {
      const planted = join(fixtureRoot, `planted-${privateFile.replaceAll('/', '-')}`);
      mkdirSync(join(planted, 'registry'), { recursive: true });
      writeFileSync(join(planted, 'registry/private-overlay.json'), readFileSync(join(overlaySource, 'registry/private-overlay.json')));
      mkdirSync(dirname(join(planted, privateFile)), { recursive: true });
      writeFileSync(join(planted, privateFile), content);
      const result = runLeakGate(planted, join(planted, 'registry/private-overlay.json'));
      assert(result.status === 1, `force-planted private fixture passed leak gate: ${privateFile}`);
      const plantedResult = /** @type {{hits: Array<{category: string}>}} */ (JSON.parse(result.stdout));
      assert(plantedResult.hits.some((hit) => hit.category === expectedCategory), `force-planted fixture missing ${expectedCategory}`);
    }

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
      blocked = /** @type {CodedError} */ (error).code === 'LEAK_GATE_FAILED';
    }
    assert(blocked, 'leak gate did not block write');
    assert(readFileSync(join(gateTarget, 'sentinel.txt'), 'utf8') === 'unchanged\n', 'blocked write changed target');
    assert(!existsSync(join(gateTarget, 'leak.txt')), 'blocked write copied leaking file');

    writeFileSync(join(gateSource, 'leak.txt'), 'owner=public-user\n');
    executeSync({ from: gateSource, to: gateTarget, config: gateConfig, write: true }, passingGitleaks);
    assert(readFileSync(join(gateTarget, 'leak.txt'), 'utf8') === 'owner=public-user\n', 'clean tree did not sync');

    const atomicSource = join(fixtureRoot, 'atomic-source');
    const atomicTarget = join(fixtureRoot, 'atomic-target');
    mkdirSync(join(atomicSource, 'alpha'), { recursive: true });
    mkdirSync(join(atomicSource, 'beta'), { recursive: true });
    mkdirSync(join(atomicTarget, 'alpha'), { recursive: true });
    mkdirSync(join(atomicTarget, 'beta'), { recursive: true });
    writeFileSync(join(atomicSource, 'alpha', 'value.txt'), 'new-alpha\n');
    writeFileSync(join(atomicSource, 'beta', 'value.txt'), 'new-beta\n');
    writeFileSync(join(atomicTarget, 'alpha', 'value.txt'), 'old-alpha\n');
    writeFileSync(join(atomicTarget, 'beta', 'value.txt'), 'old-beta\n');
    writeFileSync(join(atomicTarget, 'alpha', 'keep.bin'), 'unselected\n');
    const crashedApply = spawnSync(process.execPath, [
      TOOL_PATH,
      '--from', atomicSource,
      '--to', atomicTarget,
      '--config', gateConfig,
      '--write',
      '--allow-no-gitleaks',
    ], {
      encoding: 'utf8',
      env: { ...process.env, SMA_SYNC_PUBLIC_TEST_CRASH_AFTER_SWAPS: '1' },
    });
    assert(crashedApply.signal === 'SIGKILL', 'injected mid-apply crash did not kill the sync child');
    const atomicJournal = join(dirname(atomicTarget), `.${basename(atomicTarget)}.sma-sync-public.journal.json`);
    assert(existsSync(atomicJournal), 'mid-apply crash did not leave a rollback journal');
    assert(readFileSync(join(atomicTarget, 'alpha', 'value.txt'), 'utf8') === 'new-alpha\n', 'first top-level swap was not installed before the crash');
    assert(readFileSync(join(atomicTarget, 'beta', 'value.txt'), 'utf8') === 'old-beta\n', 'later top-level entry changed before its swap');
    expectErrorCode(
      () => executeSync({ from: atomicSource, to: atomicTarget, config: gateConfig }, passingGitleaks),
      'APPLY_RECOVERY_REQUIRED',
    );
    executeSync({ from: atomicSource, to: atomicTarget, config: gateConfig, write: true }, passingGitleaks);
    assert(readFileSync(join(atomicTarget, 'alpha', 'value.txt'), 'utf8') === 'new-alpha\n', 'recovery did not finish alpha');
    assert(readFileSync(join(atomicTarget, 'beta', 'value.txt'), 'utf8') === 'new-beta\n', 'recovery did not finish beta');
    assert(readFileSync(join(atomicTarget, 'alpha', 'keep.bin'), 'utf8') === 'unselected\n', 'top-level swap removed an unselected file');
    assert(!existsSync(atomicJournal), 'successful recovery did not remove the rollback journal');

    /** @type {string[]} */
    const missingWarnings = [];
    const missingGitleaks = mockMissingGitleaks(missingWarnings);
    const noGitleaksTarget = join(fixtureRoot, 'no-gitleaks-target');
    const dryRun = executeSync({ from: gateSource, to: noGitleaksTarget, config: gateConfig }, missingGitleaks);
    assert(dryRun.gitleaks?.status === 'unavailable', 'dry-run did not report unavailable gitleaks');
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
    /** @type {CodedError | undefined} */
    let gitleaksError;
    try {
      executeSync({ from: gateSource, to: gitleaksBlockedTarget, config: gateConfig, write: true }, failingGitleaks);
    } catch (error) {
      gitleaksError = /** @type {CodedError} */ (error);
    }
    assert(gitleaksError?.code === 'GITLEAKS_FAILED', 'gitleaks finding did not block write');
    assert(gitleaksError.report?.leak_gate?.status === 'passed', 'node leak gate did not run alongside gitleaks');
    assert(!existsSync(gitleaksBlockedTarget), 'failed gitleaks changed the target');
    console.log('SMA public sync selftest: passed');
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

/** @param {number} status @param {GitleaksCall[]} calls @returns {Execution} */
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

/** @param {string[]} warnings @returns {Execution} */
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

/** @param {GitleaksCall} call */
function assertGitleaksInvocation(call) {
  assert(call.command === 'gitleaks', 'staging verification did not spawn gitleaks');
  assert(call.args[0] === 'detect', 'gitleaks detect subcommand missing');
  assert(call.args[1] === '--source' && isAbsolute(call.args[2]), 'gitleaks staging --source missing');
  assert(call.args.slice(3).join(' ') === '--no-git --config .gitleaks.toml', 'gitleaks safety arguments differ');
  assert(call.options.cwd === SMA_ROOT, 'gitleaks config was not resolved from the SMA root');
}

/** @param {() => unknown} action @param {string} code @param {string} [messageIncludes] */
function expectErrorCode(action, code, messageIncludes = '') {
  /** @type {CodedError | undefined} */
  let error;
  try {
    action();
  } catch (caught) {
    error = /** @type {CodedError} */ (caught);
  }
  assert(error?.code === code, `expected ${code}, received ${error?.code || 'no error'}`);
  if (messageIncludes) assert(error.message.includes(messageIncludes), `missing error text: ${messageIncludes}`);
}

/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function assert(condition, message) {
  if (!condition) throw codedError('SELFTEST_FAILED', message);
}

/** @param {string} code @param {string} message @param {CodedError} [error] */
function printError(code, message, error = /** @type {CodedError} */ ({})) {
  const nextCommand = code === 'ARGUMENT_INVALID'
    ? 'Run `sma sync-public --help`.'
    : code === 'SOURCE_NOT_FOUND'
      ? 'Correct --from and retry.'
      : code === 'GITLEAKS_REQUIRED'
        ? 'Install gitleaks or explicitly pass --allow-no-gitleaks.'
        : 'Fix the reported sync condition, then retry with --json.';
  console.error(JSON.stringify({ area: 'cli:sync-public', severity: error.exitCode === 1 ? 'error' : 'warning', tool: 'sma-sync-public', code, message, next_command: nextCommand, context: { write: Boolean(args.write) } }));
}

/** @param {string} code @param {string} message @returns {CodedError} */
function codedError(code, message) {
  const error = /** @type {CodedError} */ (new Error(message));
  error.code = code;
  if (code === 'SOURCE_NOT_FOUND') error.exitCode = 3;
  else if (code.startsWith('APPLY_')) error.exitCode = 4;
  else if (['LEAK_GATE_FAILED', 'GITLEAKS_FAILED', 'GITLEAKS_REQUIRED'].includes(code)) error.exitCode = 1;
  else error.exitCode = 2;
  return error;
}

/** @param {string} value @returns {string} */
function normalizePath(value) {
  const normalized = value.split(sep).join('/').replace(/^\.\//, '');
  return isAbsolute(value) ? normalized.replace(/^\/+/, '') : normalized;
}

/** @param {string[]} list @returns {CliArgs} */
function parseArgs(list) {
  /** @type {CliArgs} */
  const out = {};
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];
    if (arg === '--allow-no-gitleaks') {
      out.allowNoGitleaks = true;
      continue;
    }
    if (arg === '--write' || arg === '--json' || arg === '--selftest' || arg === '--quiet' || arg === '--verbose' || arg === '--help' || arg === '-h') {
      if (arg === '--write') out.write = true;
      else if (arg === '--json') out.json = true;
      else if (arg === '--selftest') out.selftest = true;
      else if (arg === '--quiet') out.quiet = true;
      else if (arg === '--verbose') out.verbose = true;
      else out.help = true;
      continue;
    }
    if (arg === '--from' || arg === '--to' || arg === '--config') {
      const next = list[index + 1];
      if (!next || next.startsWith('--')) throw codedError('ARGUMENT_INVALID', `${arg} requires a path`);
      if (arg === '--from') out.from = next;
      else if (arg === '--to') out.to = next;
      else out.config = next;
      index += 1;
      continue;
    }
    throw codedError('ARGUMENT_INVALID', `unknown argument: ${arg}`);
  }
  if (out.quiet && out.verbose) throw codedError('ARGUMENT_INVALID', '--quiet and --verbose cannot be combined');
  return out;
}
