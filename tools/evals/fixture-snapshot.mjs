#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const FIXTURE_ROOT = path.join(SCRIPT_DIR, "fixtures", "portfolio");
const SNAPSHOT_PATH = path.join(SCRIPT_DIR, "fixtures", "portfolio.snapshot.json");
const INTRO_DIR = path.join(REPO_ROOT, "docs", "intro");
const LESSON_REGISTRY_PATH = path.join(SCRIPT_DIR, "journeys", "lessons.mjs");
const SNAPSHOT_ROOT = "tools/evals/fixtures/portfolio";

/** @typedef {{ path: string, bytes: number, sha256: string }} SnapshotFile */
/** @typedef {{ schemaVersion: number, algorithm: string, root: string, digest: string, fileCount: number, totalBytes: number, files: SnapshotFile[] }} FixtureSnapshot */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is SnapshotFile} */
function isSnapshotFile(value) {
  return isRecord(value)
    && typeof value.path === "string"
    && typeof value.bytes === "number"
    && typeof value.sha256 === "string";
}

/** @param {unknown} value @returns {value is FixtureSnapshot} */
function isFixtureSnapshot(value) {
  return isRecord(value)
    && typeof value.schemaVersion === "number"
    && typeof value.algorithm === "string"
    && typeof value.root === "string"
    && typeof value.digest === "string"
    && typeof value.fileCount === "number"
    && typeof value.totalBytes === "number"
    && Array.isArray(value.files)
    && value.files.every(isSnapshotFile);
}

function usage() {
  console.log(`SMARCH fixture snapshot gate

Usage:
  node tools/evals/fixture-snapshot.mjs --write
  node tools/evals/fixture-snapshot.mjs --check
  node tools/evals/fixture-snapshot.mjs --selftest
`);
}

/** @param {string[]} argv */
function parseArgs(argv) {
  if (argv.length === 1 && ["--write", "--check", "--selftest"].includes(argv[0])) {
    return argv[0].slice(2);
  }
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    usage();
    process.exit(0);
  }
  throw new Error("Expected exactly one of --write, --check, or --selftest");
}

/** @param {import("node:crypto").BinaryLike} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} left @param {string} right */
function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** @param {string} root @returns {Promise<SnapshotFile[]>} */
async function collectFiles(root) {
  /** @type {SnapshotFile[]} */
  const files = [];

  /** @param {string} directory */
  async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        const bytes = await fs.readFile(absolutePath);
        files.push({
          path: path.relative(root, absolutePath).split(path.sep).join("/"),
          bytes: bytes.length,
          sha256: sha256(bytes)
        });
      }
    }
  }

  await walk(root);
  files.sort((left, right) => compareText(left.path, right.path));
  return files;
}

/** @param {SnapshotFile[]} files @param {string} [root] @returns {FixtureSnapshot} */
function buildSnapshot(files, root = SNAPSHOT_ROOT) {
  return {
    schemaVersion: 2,
    algorithm: "sha256",
    root,
    digest: sha256(JSON.stringify(files)),
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
    files
  };
}

/** @param {string} [root] */
async function snapshotTree(root = FIXTURE_ROOT) {
  return buildSnapshot(await collectFiles(root));
}

/** @param {FixtureSnapshot} snapshot */
function validateSnapshot(snapshot) {
  assert.equal(snapshot.schemaVersion, 2, "snapshot schemaVersion must be 2; run --write");
  assert.equal(snapshot.algorithm, "sha256", "snapshot algorithm must be sha256");
  assert.equal(snapshot.root, SNAPSHOT_ROOT, `snapshot root must be ${SNAPSHOT_ROOT}`);
  assert(Array.isArray(snapshot.files), "snapshot files must be an array; run --write");
  assert.deepEqual(snapshot, buildSnapshot(snapshot.files), "snapshot metadata does not match its file manifest");
}

/** @param {FixtureSnapshot} expected @param {FixtureSnapshot} actual */
function diffSnapshots(expected, actual) {
  const expectedByPath = new Map(expected.files.map((file) => [file.path, file]));
  const actualByPath = new Map(actual.files.map((file) => [file.path, file]));
  const diffs = [];

  for (const filePath of [...new Set([...expectedByPath.keys(), ...actualByPath.keys()])].sort()) {
    const before = expectedByPath.get(filePath);
    const after = actualByPath.get(filePath);
    if (!before) {
      if (after) diffs.push(`ADDED ${filePath} (${after.bytes} bytes, sha256 ${after.sha256})`);
      continue;
    }
    if (!after) {
      diffs.push(`REMOVED ${filePath} (${before.bytes} bytes, sha256 ${before.sha256})`);
    } else if (before.sha256 !== after.sha256 || before.bytes !== after.bytes) {
      diffs.push(
        `CHANGED ${filePath} (bytes ${before.bytes} -> ${after.bytes}; sha256 ${before.sha256} -> ${after.sha256})`
      );
    }
  }

  return diffs;
}

/** @param {string} source @returns {Set<string>} */
function registeredLessonsFromSource(source) {
  const match = source.match(/const\s+REGISTERED_LESSONS\s*=\s*new Set\(\[([\s\S]*?)\]\);/);
  assert(match, "could not find REGISTERED_LESSONS in tools/evals/journeys/lessons.mjs");
  const entries = [...match[1].matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)]
    .map((entry) => JSON.parse(`"${entry[1]}"`));
  assert(entries.length > 0, "REGISTERED_LESSONS must not be empty");
  return new Set(entries);
}

/** @param {string[]} discovered @param {Set<string>} registered */
function lessonCoverageDiff(discovered, registered) {
  return discovered.filter((filename) => !registered.has(filename)).sort();
}

/** @param {string[]} discovered @param {Set<string>} registered */
function assertLessonCoverage(discovered, registered) {
  const missing = lessonCoverageDiff(discovered, registered);
  if (missing.length > 0) {
    throw new Error(`Lesson coverage missing from tools/evals/journeys/lessons.mjs:\n${missing.map((name) => `UNREGISTERED ${name}`).join("\n")}`);
  }
}

async function checkLessonCoverage() {
  const discovered = (await fs.readdir(INTRO_DIR))
    .filter((filename) => /^\d\d-.*\.md$/.test(filename))
    .sort();
  const source = await fs.readFile(LESSON_REGISTRY_PATH, "utf8");
  assertLessonCoverage(discovered, registeredLessonsFromSource(source));
  return discovered.length;
}

/** @param {string} [snapshotPath] @param {string} [fixtureRoot] */
async function writeSnapshot(snapshotPath = SNAPSHOT_PATH, fixtureRoot = FIXTURE_ROOT) {
  const snapshot = await snapshotTree(fixtureRoot);
  const temporaryPath = `${snapshotPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  await fs.rename(temporaryPath, snapshotPath);
  return snapshot;
}

/** @param {string} [snapshotPath] @param {string} [fixtureRoot] */
async function checkSnapshot(snapshotPath = SNAPSHOT_PATH, fixtureRoot = FIXTURE_ROOT) {
  /** @type {unknown} */
  const parsed = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  if (!isFixtureSnapshot(parsed)) throw new Error("fixture snapshot has an invalid shape; run --write");
  const expected = parsed;
  validateSnapshot(expected);
  const actual = await snapshotTree(fixtureRoot);
  const diffs = diffSnapshots(expected, actual);
  if (diffs.length > 0) {
    throw new Error(`Fixture snapshot drift (${diffs.length} file(s)):\n${diffs.join("\n")}`);
  }
  assert.equal(actual.digest, expected.digest, "fixture aggregate digest drifted without a file-level diff");
  return actual;
}

async function selftest() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "smarch-fixture-snapshot-"));
  const fixtureRoot = path.join(tempRoot, "portfolio");
  const snapshotPath = path.join(tempRoot, "portfolio.snapshot.json");

  try {
    await fs.mkdir(path.join(fixtureRoot, "nested"), { recursive: true });
    await fs.writeFile(path.join(fixtureRoot, "alpha.txt"), "alpha\n");
    await fs.writeFile(path.join(fixtureRoot, "nested", "beta.txt"), "beta\n");
    const written = await writeSnapshot(snapshotPath, fixtureRoot);
    assert.equal(written.fileCount, 2);
    await checkSnapshot(snapshotPath, fixtureRoot);

    await fs.writeFile(path.join(fixtureRoot, "alpha.txt"), "changed\n");
    await fs.rm(path.join(fixtureRoot, "nested", "beta.txt"));
    await fs.writeFile(path.join(fixtureRoot, "gamma.txt"), "gamma\n");
    const drifted = await snapshotTree(fixtureRoot);
    const diffs = diffSnapshots(written, drifted);
    assert(diffs.some((line) => line.startsWith("CHANGED alpha.txt")), "changed file must be reported");
    assert(diffs.some((line) => line.startsWith("REMOVED nested/beta.txt")), "removed file must be reported");
    assert(diffs.some((line) => line.startsWith("ADDED gamma.txt")), "added file must be reported");
    await assert.rejects(() => checkSnapshot(snapshotPath, fixtureRoot), /Fixture snapshot drift/);

    assert.doesNotThrow(() => assertLessonCoverage(["00-known.md"], new Set(["00-known.md"])));
    assert.throws(
      () => assertLessonCoverage(["00-known.md", "19-missing.md"], new Set(["00-known.md"])),
      /UNREGISTERED 19-missing\.md/,
      "an unregistered lesson must fail closed"
    );
    const lessonCount = await checkLessonCoverage();
    console.log(`PASS fixture snapshot selftest: drift and coverage negatives rejected; ${lessonCount} lesson(s) registered.`);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

try {
  const mode = parseArgs(process.argv.slice(2));
  if (mode === "write") {
    const lessonCount = await checkLessonCoverage();
    const snapshot = await writeSnapshot();
    console.log(`WROTE ${SNAPSHOT_PATH}: ${snapshot.fileCount} file(s), ${snapshot.totalBytes} bytes, ${snapshot.digest}; ${lessonCount} lesson(s) registered.`);
  } else if (mode === "check") {
    const errors = [];
    let snapshot;
    let lessonCount;
    try {
      snapshot = await checkSnapshot();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    try {
      lessonCount = await checkLessonCoverage();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (errors.length > 0) throw new Error(errors.join("\n\n"));
    if (!snapshot || lessonCount === undefined) throw new Error("fixture snapshot check produced no result");
    console.log(`PASS fixture snapshot: ${snapshot.fileCount} file(s), ${snapshot.totalBytes} bytes, ${snapshot.digest}; ${lessonCount} lesson(s) registered.`);
  } else {
    await selftest();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
