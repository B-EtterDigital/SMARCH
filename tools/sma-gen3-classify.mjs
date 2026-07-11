#!/usr/bin/env node
/**
 * WHAT: Classifies a changed path into its configured module and coordination lane.
 * WHY: Agents need a deterministic ownership answer before choosing edit and verification rules.
 * HOW: Matches one normalized path against module patterns and shared hot-path patterns.
 * INPUTS: A changed file and the repository's generation-three configuration.
 * OUTPUTS: A structured module and lane decision with the matching ownership details.
 * CALLERS: Agents, automated checks, and dispatch tools selecting safe work lanes.
 * Usage: `node tools/sma-gen3-classify.mjs --changed-file tools/sma-graphify.ts`
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';

const CONFIG_PATH = resolve('sma.gen3.json');

/** @typedef {{ id?: string, path?: string, paths?: string[], lane_default?: string, laneDefault?: string }} PathEntry */
/** @typedef {{ modules: PathEntry[], hot_paths?: PathEntry[], shared_hot_paths?: PathEntry[], sharedHotPaths?: PathEntry[] }} Gen3Config */
/** @typedef {{ changedFile: string | null, json: boolean, selftest: boolean }} CliArgs */
/** @typedef {{ module: string | null, lane: string }} Classification */

try {
  const args = parseArgs(argv.slice(2));
  const config = readConfig(CONFIG_PATH);

  if (args.selftest) {
    runSelftest(config);
    exit(0);
  }

  if (!args.changedFile) {
    fail('missing required --changed-file <path>', 2);
  }

  console.log(JSON.stringify(classifyPath(config, args.changedFile)));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ error: message }));
  const exitCode = error && typeof error === 'object' && 'exitCode' in error
    && typeof error.exitCode === 'number' ? error.exitCode : 1;
  exit(exitCode);
}

/** @param {string[]} values @returns {CliArgs} */
function parseArgs(values) {
  /** @type {CliArgs} */
  const parsed = {
    changedFile: null,
    json: false,
    selftest: false,
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];

    if (value === '--changed-file') {
      const changedFile = values[index + 1];
      if (!changedFile || changedFile.startsWith('--')) {
        fail('missing value for --changed-file', 2);
      }
      parsed.changedFile = changedFile;
      index += 1;
      continue;
    }

    if (value === '--json') {
      parsed.json = true;
      continue;
    }

    if (value === '--selftest') {
      parsed.selftest = true;
      continue;
    }

    fail(`unknown argument: ${value}`, 2);
  }

  return parsed;
}

/** @param {string} path @returns {Gen3Config} */
function readConfig(path) {
  const config = JSON.parse(readFileSync(path, 'utf8'));

  if (!Array.isArray(config.modules)) {
    throw new Error('sma.gen3.json must define a modules array');
  }

  if (!Array.isArray(sharedHotPaths(config))) {
    throw new Error('sma.gen3.json must define a shared hot paths array');
  }

  return config;
}

/** @param {Gen3Config} config @param {string} changedFile @returns {Classification} */
function classifyPath(config, changedFile) {
  const normalizedPath = normalizePath(changedFile);
  const module = config.modules.find((candidate) =>
    pathsFor(candidate).some((pattern) => matchesPath(normalizedPath, pattern)),
  );

  const isSharedHotPath = sharedHotPaths(config).some((candidate) =>
    pathsFor(candidate).some((pattern) => matchesPath(normalizedPath, pattern)),
  );

  if (isSharedHotPath) {
    return {
      module: module?.id ?? null,
      lane: 'shared-hot-path',
    };
  }

  if (module) {
    return {
      module: module.id ?? null,
      lane: module.lane_default ?? module.laneDefault ?? 'single-module',
    };
  }

  return {
    module: null,
    lane: 'unmapped',
  };
}

/** @param {Gen3Config} config @returns {PathEntry[]} */
function sharedHotPaths(config) {
  return config.hot_paths ?? config.shared_hot_paths ?? config.sharedHotPaths ?? [];
}

/** @param {PathEntry} entry @returns {string[]} */
function pathsFor(entry) {
  if (Array.isArray(entry.paths)) return entry.paths;
  if (typeof entry.path === 'string') return [entry.path];
  return [];
}

/** @param {string} path @param {string} pattern @returns {boolean} */
function matchesPath(path, pattern) {
  const normalizedPattern = normalizePath(pattern);
  const expression = normalizedPattern
    .split('**')
    .map((part) => part
      .replace(/[.+^$(){}|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]'))
    .join('.*');

  return new RegExp(`^${expression}$`).test(path);
}

/** @param {string} path @returns {string} */
function normalizePath(path) {
  return String(path)
    .replaceAll('\\\\', '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

/** @param {Gen3Config} config */
function runSelftest(config) {
  assertClassification(config, 'tools/sma-lease.ts', {
    module: 'coord',
    lane: 'single-module',
  });
  assertClassification(config, 'package.json', {
    module: null,
    lane: 'shared-hot-path',
  });
  assertClassification(config, 'nonexistent', {
    module: null,
    lane: 'unmapped',
  });

  console.log(JSON.stringify({ ok: true, assertions: 3 }));
}

/** @param {Gen3Config} config @param {string} path @param {Classification} expected */
function assertClassification(config, path, expected) {
  const actual = classifyPath(config, path);
  if (actual.module !== expected.module || actual.lane !== expected.lane) {
    throw new Error(
      `selftest failed for ${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

/** @param {string} message @param {number} exitCode @returns {never} */
function fail(message, exitCode) {
  const error = /** @type {Error & {exitCode?: number}} */ (new Error(message));
  error.exitCode = exitCode;
  throw error;
}
