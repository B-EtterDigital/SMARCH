#!/usr/bin/env node
/**
 * Package a community brick for gated curator intake.
 *
 * The submission-bundle schema module was not present when this tool landed,
 * so bundle.json uses the documented inline v1 shape enforced below.
 *
 * Usage:
 *   node tools/sma-submit.mjs --brick path/to/brick [--root .] [--out submissions]
 *   node tools/sma-submit.mjs --verify submissions/<bundle>.tar.gz
 *   node tools/sma-submit.mjs --selftest
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateManifest } from './sma-validate.mjs';

const TOOL_PATH = fileURLToPath(import.meta.url);
const SMA_ROOT = resolve(dirname(TOOL_PATH), '..');
const BUNDLE_KIND = 'sma.community-submission-bundle';
const BUNDLE_SCHEMA = 'https://sweetspot.local/schemas/submission-bundle/1.0.0-inline';
const OMIT_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.tmp', 'tmp', 'submissions']);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; index += 1; }
  }
  return args;
}

function usage() {
  return `SMA community brick submission

Usage:
  node tools/sma-submit.mjs --brick <directory> [--root <repo>] [--manifest <file>] [--out <directory>] [--json]
  node tools/sma-submit.mjs --verify <archive.tar.gz> [--json]
  node tools/sma-submit.mjs --selftest

The packaging command runs \`npm run gate:all\` and then \`npm run gate:leaks\`
in --root. Both must pass before an archive is emitted.`;
}

function normalizePath(value) {
  return value.split(sep).join('/').replace(/^\.\//, '');
}

function safeSlug(value) {
  const slug = String(value || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`cannot create a safe archive name from: ${value}`);
  return slug;
}

function isWithin(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`));
}

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(readFileSync(filePath));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  return result;
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runGate(root, script) {
  const command = `npm run ${script}`;
  const startedAt = new Date().toISOString();
  const result = run(npmCommand(), ['run', script], { cwd: root });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.status !== 0) {
    process.stderr.write(output);
    throw new Error(`${command} failed with exit ${result.status}`);
  }
  return {
    command,
    status: 'passed',
    exit_code: result.status,
    started_at: startedAt,
    output_sha256: sha256Buffer(Buffer.from(output)),
  };
}

function findManifest(brickDir, explicitManifest) {
  if (explicitManifest) {
    const candidate = resolve(explicitManifest);
    if (!existsSync(candidate)) throw new Error(`manifest not found: ${candidate}`);
    return candidate;
  }
  const canonical = resolve(brickDir, 'module.sweetspot.json');
  if (existsSync(canonical)) return canonical;
  const candidates = readdirSync(brickDir)
    .filter((name) => name.endsWith('.module.sweetspot.json'))
    .map((name) => resolve(brickDir, name));
  if (candidates.length !== 1) {
    throw new Error(`expected module.sweetspot.json or exactly one *.module.sweetspot.json in ${brickDir}`);
  }
  return candidates[0];
}

function collectSourceFiles(brickDir, manifestPath) {
  const files = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (OMIT_DIRS.has(entry.name)) continue;
      const absolute = resolve(dir, entry.name);
      if (!isWithin(brickDir, absolute)) throw new Error(`source path escaped brick directory: ${absolute}`);
      if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed in submissions: ${absolute}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && absolute !== manifestPath) files.push(absolute);
      else if (!entry.isFile()) throw new Error(`unsupported source entry: ${absolute}`);
    }
  }
  visit(brickDir);
  if (files.length === 0) throw new Error('brick contains no source files besides its manifest');
  return files;
}

function addFile(stagingRoot, destination, source, role, entries) {
  const target = resolve(stagingRoot, destination);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  const bytes = statSync(target).size;
  entries.push({ path: normalizePath(destination), role, bytes, sha256: sha256File(target) });
}

function addGeneratedFile(stagingRoot, destination, content, role, entries) {
  const target = resolve(stagingRoot, destination);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  entries.push({
    path: normalizePath(destination),
    role,
    bytes: statSync(target).size,
    sha256: sha256File(target),
  });
}

function curatorChecklist(manifest) {
  return `# Curator checklist: ${manifest.brick.id}\n\n`
    + `Bundle version: ${manifest.brick.version}\n\n`
    + `- [ ] Archive SHA-256 matches the value printed by \`sma-submit\`.\n`
    + `- [ ] \`node tools/sma-submit.mjs --verify <archive>\` passes.\n`
    + `- [ ] Trusted automated gates pass on the attached bundle.\n`
    + `- [ ] Manifest identity, source boundaries, and public API are accurate.\n`
    + `- [ ] License, authorship, and redistribution declarations are acceptable.\n`
    + `- [ ] No secrets, private data, generated dependencies, or unrelated files are present.\n`
    + `- [ ] Security, similarity, provenance, and quality evidence has been reviewed.\n`
    + `- [ ] Curator decision and rationale are recorded on the submission issue.\n`
    + `- [ ] Promotion gates pass before candidate/canonical status changes.\n`;
}

function validateInlineBundle(bundle) {
  const errors = [];
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) errors.push('bundle must be an object');
  if (bundle?.schema_version !== '1.0.0') errors.push('schema_version must be 1.0.0');
  if (bundle?.kind !== BUNDLE_KIND) errors.push(`kind must be ${BUNDLE_KIND}`);
  if (bundle?.schema !== BUNDLE_SCHEMA) errors.push(`schema must be ${BUNDLE_SCHEMA}`);
  if (!bundle?.brick || typeof bundle.brick.id !== 'string' || typeof bundle.brick.version !== 'string') {
    errors.push('brick.id and brick.version are required strings');
  }
  if (!Array.isArray(bundle?.files) || bundle.files.length < 4) errors.push('files must contain manifest, source, attestation, and checklist entries');
  const seen = new Set();
  for (const [index, entry] of (bundle?.files || []).entries()) {
    if (!entry || typeof entry.path !== 'string' || !entry.path || entry.path.startsWith('/') || entry.path.includes('\\')) {
      errors.push(`files[${index}].path is invalid`);
      continue;
    }
    if (posix.normalize(entry.path) !== entry.path || entry.path.split('/').includes('..')) errors.push(`files[${index}].path is unsafe`);
    if (seen.has(entry.path)) errors.push(`duplicate file entry: ${entry.path}`);
    seen.add(entry.path);
    if (!['manifest', 'source', 'attestation', 'checklist'].includes(entry.role)) errors.push(`files[${index}].role is invalid`);
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0) errors.push(`files[${index}].bytes is invalid`);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 || '')) errors.push(`files[${index}].sha256 is invalid`);
  }
  for (const role of ['manifest', 'source', 'attestation', 'checklist']) {
    if (!(bundle?.files || []).some((entry) => entry.role === role)) errors.push(`missing ${role} file entry`);
  }
  if (!Array.isArray(bundle?.verification?.gates) || bundle.verification.gates.length !== 2) errors.push('verification.gates must contain two results');
  for (const command of ['npm run gate:all', 'npm run gate:leaks']) {
    if (!(bundle?.verification?.gates || []).some((gate) => gate.command === command && gate.status === 'passed' && gate.exit_code === 0)) {
      errors.push(`missing passing gate evidence: ${command}`);
    }
  }
  return errors;
}

function ensureSafeArchive(archivePath) {
  const namesResult = run('tar', ['-tzf', archivePath]);
  if (namesResult.status !== 0) throw new Error(`cannot list archive: ${namesResult.stderr.trim()}`);
  const entries = namesResult.stdout.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0) throw new Error('archive is empty');
  const roots = new Set();
  const fileEntries = new Set();
  for (const entry of entries) {
    const withoutTrailingSlash = entry.replace(/\/$/, '');
    if (entry.startsWith('/') || entry.includes('\\') || entry.split('/').includes('..') || posix.normalize(entry).replace(/\/$/, '') !== withoutTrailingSlash) {
      throw new Error(`unsafe archive entry: ${entry}`);
    }
    roots.add(withoutTrailingSlash.split('/')[0]);
    if (!entry.endsWith('/')) {
      if (fileEntries.has(entry)) throw new Error(`duplicate archive entry: ${entry}`);
      fileEntries.add(entry);
    }
  }
  if (roots.size !== 1) throw new Error('archive must contain exactly one root directory');
  const verbose = run('tar', ['-tvzf', archivePath]);
  if (verbose.status !== 0) throw new Error(`cannot inspect archive: ${verbose.stderr.trim()}`);
  for (const line of verbose.stdout.split(/\r?\n/).filter(Boolean)) {
    if (!['-', 'd'].includes(line[0])) throw new Error('archive may contain only regular files and directories');
  }
  return [...roots][0];
}

function allFiles(root) {
  const result = [];
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`extracted bundle contains a symbolic link: ${absolute}`);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) result.push(normalizePath(relative(root, absolute)));
      else throw new Error(`extracted bundle contains unsupported entry: ${absolute}`);
    }
  }
  visit(root);
  return result.sort();
}

export function verifyArchive(archive) {
  const archivePath = resolve(archive);
  if (!existsSync(archivePath) || !lstatSync(archivePath).isFile()) throw new Error(`archive not found: ${archivePath}`);
  const rootName = ensureSafeArchive(archivePath);
  const temp = mkdtempSync(resolve(tmpdir(), 'sma-submit-verify-'));
  try {
    const extracted = run('tar', ['-xzf', archivePath, '-C', temp, '--no-same-owner', '--no-same-permissions']);
    if (extracted.status !== 0) throw new Error(`cannot extract archive: ${extracted.stderr.trim()}`);
    const bundleRoot = resolve(temp, rootName);
    const bundlePath = resolve(bundleRoot, 'bundle.json');
    if (!existsSync(bundlePath)) throw new Error('bundle.json is missing');
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
    const shapeErrors = validateInlineBundle(bundle);
    if (shapeErrors.length) throw new Error(`bundle shape invalid: ${shapeErrors.join('; ')}`);
    for (const entry of bundle.files) {
      const filePath = resolve(bundleRoot, entry.path);
      if (!isWithin(bundleRoot, filePath) || !existsSync(filePath) || !lstatSync(filePath).isFile()) throw new Error(`bundle file missing: ${entry.path}`);
      if (statSync(filePath).size !== entry.bytes) throw new Error(`size mismatch: ${entry.path}`);
      if (sha256File(filePath) !== entry.sha256) throw new Error(`SHA-256 mismatch: ${entry.path}`);
    }
    const expected = [...bundle.files.map((entry) => entry.path), 'bundle.json'].sort();
    const actual = allFiles(bundleRoot);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('archive contains files not declared by bundle.json');
    const manifest = JSON.parse(readFileSync(resolve(bundleRoot, 'manifest.json'), 'utf8'));
    const attestation = JSON.parse(readFileSync(resolve(bundleRoot, 'attestation.json'), 'utf8'));
    if (manifest.brick?.id !== bundle.brick.id || manifest.brick?.version !== bundle.brick.version) throw new Error('manifest identity does not match bundle.json');
    if (attestation.subject?.brick_id !== bundle.brick.id || attestation.predicate_type !== 'sma.community-submission/v1') {
      throw new Error('attestation identity or predicate type is invalid');
    }
    return {
      ok: true,
      archive: archivePath,
      archive_sha256: sha256File(archivePath),
      brick_id: bundle.brick.id,
      version: bundle.brick.version,
      file_count: bundle.files.filter((entry) => entry.role === 'source').length,
      gates: bundle.verification.gates,
    };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

export function createSubmission(options) {
  const root = resolve(options.root || process.cwd());
  const brickDir = resolve(root, options.brick);
  if (!existsSync(brickDir) || !lstatSync(brickDir).isDirectory()) throw new Error(`brick directory not found: ${brickDir}`);
  if (!isWithin(root, brickDir)) throw new Error('--brick must be inside --root');
  const manifestPath = findManifest(brickDir, options.manifest ? resolve(root, options.manifest) : null);
  if (!isWithin(brickDir, manifestPath)) throw new Error('manifest must be inside the brick directory');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const manifestReport = validateManifest(normalizePath(relative(root, manifestPath)), manifest);
  if (manifestReport.errors.length) {
    throw new Error(`manifest validation failed: ${manifestReport.errors.map((item) => `${item.code}: ${item.message}`).join('; ')}`);
  }
  const sources = collectSourceFiles(brickDir, manifestPath);
  const gates = [runGate(root, 'gate:all'), runGate(root, 'gate:leaks')];
  const createdAt = new Date().toISOString();
  const outputDir = resolve(root, options.out || 'submissions');
  mkdirSync(outputDir, { recursive: true });
  const name = `${safeSlug(manifest.brick.id)}-${safeSlug(manifest.brick.version)}-${createdAt.replace(/[:.]/g, '-')}`;
  const temp = mkdtempSync(resolve(tmpdir(), 'sma-submit-build-'));
  const staging = resolve(temp, name);
  mkdirSync(staging, { recursive: true });
  try {
    const entries = [];
    addFile(staging, 'manifest.json', manifestPath, 'manifest', entries);
    for (const source of sources) {
      addFile(staging, `files/${normalizePath(relative(brickDir, source))}`, source, 'source', entries);
    }
    const sourceEntries = entries.filter((entry) => entry.role === 'source');
    const attestation = {
      schema_version: '1.0.0',
      predicate_type: 'sma.community-submission/v1',
      generated_at: createdAt,
      subject: {
        brick_id: manifest.brick.id,
        version: manifest.brick.version,
        manifest_sha256: entries.find((entry) => entry.role === 'manifest').sha256,
        source_tree_sha256: sha256Buffer(Buffer.from(sourceEntries.map((entry) => `${entry.path}:${entry.sha256}`).join('\n'))),
      },
      submitter: {
        owner: manifest.owner?.primary || null,
        repository: manifest.source?.repository || null,
        license: manifest.license?.spdx || null,
      },
      claims: {
        manifest_validated: true,
        source_files_hashed: true,
        gate_all_passed: true,
        leak_gate_passed: true,
      },
      local_verification: gates,
      builder: { id: 'tools/sma-submit.mjs', bundle_schema: BUNDLE_SCHEMA },
    };
    addGeneratedFile(staging, 'attestation.json', `${JSON.stringify(attestation, null, 2)}\n`, 'attestation', entries);
    const checklist = curatorChecklist(manifest);
    addGeneratedFile(staging, 'CURATOR-CHECKLIST.md', checklist, 'checklist', entries);
    const bundle = {
      schema_version: '1.0.0',
      schema: BUNDLE_SCHEMA,
      kind: BUNDLE_KIND,
      created_at: createdAt,
      brick: {
        id: manifest.brick.id,
        name: manifest.brick.name,
        version: manifest.brick.version,
        status: manifest.brick.status,
      },
      files: entries.sort((a, b) => a.path.localeCompare(b.path)),
      verification: {
        digest: 'sha256',
        manifest_validator: 'tools/sma-validate.mjs',
        manifest_warning_count: manifestReport.warnings.length,
        gates,
      },
    };
    const errors = validateInlineBundle(bundle);
    if (errors.length) throw new Error(`internal bundle validation failed: ${errors.join('; ')}`);
    writeJson(resolve(staging, 'bundle.json'), bundle);
    const archivePath = resolve(outputDir, `${name}.tar.gz`);
    const archived = run('tar', ['-czf', archivePath, '-C', temp, name]);
    if (archived.status !== 0) throw new Error(`could not create archive: ${archived.stderr.trim()}`);
    const checklistPath = resolve(outputDir, `${name}-CURATOR-CHECKLIST.md`);
    writeFileSync(checklistPath, `${checklist}\nArchive SHA-256: \`${sha256File(archivePath)}\`\n`);
    const verified = verifyArchive(archivePath);
    return { ...verified, checklist: checklistPath };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function runSelftest() {
  const fixtureRoot = mkdtempSync(resolve(tmpdir(), 'sma-submit-selftest-'));
  try {
    const brickDir = resolve(fixtureRoot, 'fixture-brick');
    mkdirSync(brickDir, { recursive: true });
    const fixtureManifestPath = resolve(SMA_ROOT, 'tools/evals/fixtures/portfolio/acme-desktop/src/modules/activity-feed/module.sweetspot.json');
    const manifest = JSON.parse(readFileSync(fixtureManifestPath, 'utf8'));
    manifest.brick.id = 'fixture.community-brick';
    manifest.brick.name = 'Community Submission Fixture';
    manifest.brick.version = '1.0.0';
    manifest.source.project = 'sma-submit-selftest';
    manifest.source.paths = ['fixture-brick'];
    manifest.owner.primary = 'fixture-author';
    writeJson(resolve(brickDir, 'module.sweetspot.json'), manifest);
    writeFileSync(resolve(brickDir, 'index.mjs'), 'export const fixture = true;\n');
    writeFileSync(resolve(brickDir, 'README.md'), '# Public fixture brick\n');
    writeJson(resolve(fixtureRoot, 'package.json'), {
      private: true,
      scripts: {
        'gate:all': `node -e \"require('node:fs').writeFileSync('.gate-all-ran','passed')\"`,
        'gate:leaks': `node -e \"require('node:fs').writeFileSync('.gate-leaks-ran','passed')\"`,
      },
    });
    const initialized = run('git', ['init', '-q'], { cwd: fixtureRoot });
    if (initialized.status !== 0) throw new Error('selftest could not initialize fixture git repository');
    const added = run('git', ['add', '--', 'package.json', 'fixture-brick'], { cwd: fixtureRoot });
    if (added.status !== 0) throw new Error('selftest could not stage fixture files');
    const result = createSubmission({ root: fixtureRoot, brick: 'fixture-brick', out: 'out' });
    if (!result.ok || result.brick_id !== manifest.brick.id || result.file_count !== 2) throw new Error('selftest bundle verification result was incorrect');
    if (!existsSync(resolve(fixtureRoot, '.gate-all-ran'))) throw new Error('selftest gate:all did not execute');
    if (!existsSync(resolve(fixtureRoot, '.gate-leaks-ran'))) throw new Error('selftest gate:leaks did not execute');
    if (!existsSync(result.archive) || !existsSync(result.checklist)) throw new Error('selftest outputs were not emitted');
    console.log(`sma-submit selftest: passed (${basename(result.archive)})`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function printResult(result, json) {
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`sma-submit: verified ${result.brick_id}@${result.version}`);
    console.log(`  archive:   ${result.archive}`);
    console.log(`  sha256:    ${result.archive_sha256}`);
    console.log(`  sources:   ${result.file_count}`);
    if (result.checklist) console.log(`  checklist: ${result.checklist}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || Object.keys(args).length === 0) {
    console.log(usage());
    return;
  }
  if (args.selftest) return runSelftest();
  if (args.verify && args.verify !== true) return printResult(verifyArchive(args.verify), args.json);
  if (!args.brick || args.brick === true) throw new Error('--brick <directory> is required');
  return printResult(createSubmission(args), args.json);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === TOOL_PATH;
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`sma-submit: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
