#!/usr/bin/env node
/* Dependency evidence is loaded from external JSON, so defensive runtime guards remain required. */
/* Dependency evidence scanning is a flat set of independent format handlers; complexity counts each handler guard. */
/* eslint @typescript-eslint/no-unnecessary-condition: "off", complexity: "off" */
/**
 * WHAT: Builds an inverse index from source bricks to the projects that depend on them.
 * WHY: Source releases cannot be propagated safely without knowing every locked copy and fork.
 * HOW: Scans import locks, reuse receipts, and manifests, then groups evidence by source brick.
 * INPUTS: Portfolio project roots and an optional source-brick filter.
 * OUTPUTS: A dependency report on standard output or the generated dependents index file.
 * CALLERS: Release propagation commands and maintainers planning downstream updates.
 * Usage: `node tools/sma-dependents-index.ts --source-brick example.brick --json`
 */
/**
 * sma-dependents-index.ts — build the inverted "who has copies of which brick" index.
 *
 * Reads (does not modify):
 *   - $SMA_PROJECTS_ROOT/*\/.smarch/import-lock.json    (formal sma-clone provenance)
 *   - $SMA_PROJECTS_ROOT/*\/.smarch/reuse-receipts/*.json  (manual / additive copies)
 *   - $SMA_PROJECTS_ROOT/*\/(packages|web/src/modules|...)/<brick>/module.sweetspot.json
 *       → provenance.source_chain[*] (legacy / scanner-bootstrapped fallback)
 *
 * Writes:
 *   registry/dependents.generated.json
 *   conforming to schemas/dependents-index.schema.json
 *
 * Use:
 *   node tools/sma-dependents-index.ts --write
 *   node tools/sma-dependents-index.ts --json | jq '.dependents["acme-lang.frontend-module..."]'
 *   node tools/sma-dependents-index.ts --source-brick <id>   → just that brick's dependents
 *
 * Pure read-only across all projects. Re-run anytime, idempotent.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import {  join, relative } from 'node:path';
import { argv, exit } from 'node:process';
import { createHash } from 'node:crypto';
import { PROJECTS_ROOT, smaPath } from "./lib/sma-paths.ts";


const SMA_REGISTRY = smaPath('registry');
const REGISTRY_SNAPSHOT = smaPath('registry/global-modules.generated.json');

interface CliArgs {
  help?: boolean;
  json?: boolean;
  sourceBrick?: string;
  write?: boolean;
}

interface SourceMeta {
  dependent_count: number;
  latest_version?: string;
  replication_policy?: string;
  source_path?: string;
  source_project?: string;
}

interface DependentLink {
  evidence_kind: 'import-lock' | 'reuse-receipt' | 'provenance-source-chain';
  evidence_path: string;
  imported_at?: string;
  source_commit_imported?: string;
  target_brick_id?: string;
  target_path?: string;
  target_project?: string;
  target_root: string;
  upgrade_status: 'unknown';
  version_imported?: string;
}

interface ResolvedBrick {
  artifact_id?: string;
  artifact_type?: string;
  brick_id?: string;
  id?: string;
  path?: string;
  release_version?: string;
  source_brick_id?: string;
  source_commit?: string;
  source_project?: string;
  target_brick_id?: string;
  target_path?: string;
  version?: string;
}

interface ImportLock {
  lock?: { generated_at?: string };
  resolved_bricks?: ResolvedBrick[];
  target?: { id?: string; project?: string };
}

interface ImportsFile {
  imports?: { imported_at?: string; target_project?: string }[];
}

interface ReuseReceipt {
  generated_at?: string;
  items?: { source_brick_id?: string; target_brick_id?: string; target_path?: string }[];
  source?: { commit?: string; project?: string };
  target?: { project?: string; root?: string };
}

interface BrickManifest {
  brick?: { id?: string; replication?: { policy?: string }; version?: string };
  provenance?: { source_chain?: { brick_id?: string; commit?: string; project?: string; timestamp?: string }[] };
  source?: { project?: string };
}

const args = parseArgs(argv.slice(2));
if (args.help) {
  console.log(`Usage:
  sma-dependents-index.ts [--write] [--json] [--source-brick <id>]
Reads each project's .smarch/import-lock.json and .smarch/reuse-receipts/*.json,
plus brick manifest provenance.source_chain entries, and emits an inverted index.
`);
  exit(0);
}

const sources: Record<string, SourceMeta> = {};                // source_brick_id → metadata
const dependents: Record<string, DependentLink[]> = {};             // source_brick_id → [link, ...]
let importLocksFound = 0;
let reuseReceiptsFound = 0;
let projectsScanned = 0;

function pushDependent(srcId: string, link: DependentLink): void {
  if (args.sourceBrick && srcId !== args.sourceBrick) return;
  dependents[srcId] ??= [];
  dependents[srcId].push(link);
  sources[srcId] ??= { dependent_count: 0 };
  sources[srcId].dependent_count = (sources[srcId].dependent_count ?? 0) + 1;
}

function ensureSourceMeta(srcId: string, srcProject?: string): void {
  sources[srcId] ??= { dependent_count: 0 };
  if (srcProject && !sources[srcId].source_project) sources[srcId].source_project = srcProject;
}

function scanLegacyImportLock(projectRoot: string, projectId: string | undefined, smarchDir: string): void {
  const lockPath = join(smarchDir, 'import-lock.json');
  if (!existsSync(lockPath)) return;
  importLocksFound++;
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as ImportLock;
    for (const record of lock.resolved_bricks ?? []) {
      const sourceId = record.source_brick_id ?? record.brick_id ?? record.id;
      if (!sourceId) continue;
      ensureSourceMeta(sourceId, record.source_project);
      pushDependent(sourceId, {
        target_project: lock.target?.project ?? projectId, target_root: projectRoot,
        target_path: record.target_path, target_brick_id: record.target_brick_id,
        version_imported: record.version, source_commit_imported: record.source_commit,
        imported_at: lock.lock?.generated_at, evidence_kind: 'import-lock',
        evidence_path: relative(PROJECTS_ROOT, lockPath), upgrade_status: 'unknown',
      });
    }
  } catch (error: unknown) {
    console.error(`[warn] could not parse ${lockPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function scanModernImportLock(projectRoot: string, projectId: string | undefined, smarchDir: string): void {
  const importsPath = join(smarchDir, 'imports.json');
  const buildLockPath = join(smarchDir, 'build-lock.json');
  if (!existsSync(importsPath) || !existsSync(buildLockPath)) return;
  importLocksFound++;
  try {
    const imports = JSON.parse(readFileSync(importsPath, 'utf8')) as ImportsFile;
    const buildLock = JSON.parse(readFileSync(buildLockPath, 'utf8')) as ImportLock;
    for (const record of buildLock.resolved_bricks ?? []) {
      const sourceId = record.artifact_id ?? record.source_brick_id ?? record.brick_id ?? record.id;
      if (!sourceId || record.artifact_type === 'build') continue;
      ensureSourceMeta(sourceId, record.source_project);
      pushDependent(sourceId, {
        target_project: buildLock.target?.id ?? imports.imports?.[0]?.target_project ?? projectId,
        target_root: projectRoot, target_path: record.target_path ?? record.path, target_brick_id: sourceId,
        version_imported: record.release_version ?? record.version, source_commit_imported: record.source_commit,
        imported_at: imports.imports?.[0]?.imported_at ?? buildLock.lock?.generated_at,
        evidence_kind: 'import-lock', evidence_path: relative(PROJECTS_ROOT, importsPath), upgrade_status: 'unknown',
      });
    }
  } catch (error: unknown) {
    console.error(`[warn] could not parse ${importsPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function scanReuseReceipts(projectRoot: string, projectId: string | undefined, smarchDir: string): void {
  const receiptsDir = join(smarchDir, 'reuse-receipts');
  if (!existsSync(receiptsDir) || !statSync(receiptsDir).isDirectory()) return;
  for (const file of readdirSync(receiptsDir)) {
    if (!file.endsWith('.json')) continue;
    reuseReceiptsFound++;
    try {
      const receipt = JSON.parse(readFileSync(join(receiptsDir, file), 'utf8')) as ReuseReceipt;
      for (const item of receipt.items ?? []) {
        const sourceId = item.source_brick_id;
        if (!sourceId) continue;
        ensureSourceMeta(sourceId, receipt.source?.project);
        pushDependent(sourceId, {
          target_project: receipt.target?.project ?? projectId, target_root: receipt.target?.root ?? projectRoot,
          target_path: item.target_path, target_brick_id: item.target_brick_id,
          source_commit_imported: receipt.source?.commit, imported_at: receipt.generated_at,
          evidence_kind: 'reuse-receipt', evidence_path: relative(PROJECTS_ROOT, join(receiptsDir, file)), upgrade_status: 'unknown',
        });
      }
    } catch (error: unknown) {
      console.error(`[warn] could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function scanSourceChains(projectRoot: string, projectId: string | undefined): void {
  for (const brickDir of findBrickDirs(projectRoot)) {
    const manifestPath = join(brickDir, 'module.sweetspot.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as BrickManifest;
      const targetId = m.brick?.id;
      const sourceChain = m.provenance?.source_chain ?? [];
      // First entry = create event in the target project. Skip self-references.
      for (const ev of sourceChain) {
        if (!ev.brick_id || ev.project === m.source?.project) continue;
        const srcId = ev.brick_id;
        const already = (dependents[srcId] ?? []).some(
          (l) => l.target_project === projectId && l.target_path === relative(projectRoot, brickDir),
        );
        if (already) continue;
        ensureSourceMeta(srcId, ev.project);
        pushDependent(srcId, {
          target_project: projectId,
          target_root: projectRoot,
          target_path: relative(projectRoot, brickDir),
          target_brick_id: targetId,
          source_commit_imported: ev.commit,
          imported_at: ev.timestamp,
          evidence_kind: 'provenance-source-chain',
          evidence_path: relative(PROJECTS_ROOT, manifestPath),
          upgrade_status: 'unknown',
        });
      }
    } catch { /* skip */ }
  }
}

function scanProject(projectRoot: string): void {
  projectsScanned++;
  const projectId = projectRoot.split('/').pop();
  const smarchDir = join(projectRoot, '.smarch');
  if (!existsSync(smarchDir)) return;
  scanLegacyImportLock(projectRoot, projectId, smarchDir);
  scanModernImportLock(projectRoot, projectId, smarchDir);
  scanReuseReceipts(projectRoot, projectId, smarchDir);
  scanSourceChains(projectRoot, projectId);
}

function findBrickDirs(root: string): string[] {
  const out: string[] = [];
  for (const subdir of ['packages', 'apps', 'web/src/modules', 'src/renderer/modules', 'apps/web/src/modules']) {
    const base = join(root, subdir);
    if (!existsSync(base)) continue;
    try {
      for (const ent of readdirSync(base, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        out.push(join(base, ent.name));
        // also two-deep (e.g. packages/modcap/services-advanced)
        const inner = join(base, ent.name);
        for (const sub of readdirSync(inner, { withFileTypes: true })) {
          if (!sub.isDirectory()) continue;
          if (existsSync(join(inner, sub.name, 'module.sweetspot.json'))) {
            out.push(join(inner, sub.name));
          }
        }
      }
    } catch { /* skip */ }
  }
  return out;
}

// Enrich source metadata from the source project's brick manifest if available
function enrichSources(): void {
  for (const srcId of Object.keys(sources)) {
    const srcProject = sources[srcId].source_project;
    if (!srcProject) continue;
    const projectDir = findProjectDir(srcProject);
    if (!projectDir) continue;
    for (const brickDir of findBrickDirs(projectDir)) {
      const manifestPath = join(brickDir, 'module.sweetspot.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as BrickManifest;
        if (m.brick?.id === srcId) {
          sources[srcId].source_path = relative(projectDir, brickDir);
          sources[srcId].latest_version = m.brick.version;
          if (m.brick.replication?.policy) {
            sources[srcId].replication_policy = m.brick.replication.policy;
          }
          break;
        }
      } catch { /* skip */ }
    }
  }
}

function findProjectDir(projectId: string): string | null {
  if (existsSync(join(PROJECTS_ROOT, projectId))) return join(PROJECTS_ROOT, projectId);
  for (const ent of readdirSync(PROJECTS_ROOT)) {
    if (ent.toLowerCase().includes(projectId.toLowerCase())) {
      return join(PROJECTS_ROOT, ent);
    }
  }
  return null;
}

// Walk all projects
for (const ent of readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
  if (!ent.isDirectory()) continue;
  if (ent.name.startsWith('.')) continue;
  scanProject(join(PROJECTS_ROOT, ent.name));
}

enrichSources();

const result = {
  schema_version: '1.0.0',
  generated_at: new Date().toISOString(),
  registry_snapshot_sha: existsSync(REGISTRY_SNAPSHOT)
    ? createHash('sha256').update(readFileSync(REGISTRY_SNAPSHOT)).digest('hex')
    : '',
  stats: {
    projects_scanned: projectsScanned,
    import_locks_found: importLocksFound,
    reuse_receipts_found: reuseReceiptsFound,
    unique_source_bricks: Object.keys(sources).length,
    total_dependent_links: Object.values(dependents).reduce((s, arr) => s + arr.length, 0),
  },
  sources,
  dependents,
};

if (args.write) {
  if (!existsSync(SMA_REGISTRY)) mkdirSync(SMA_REGISTRY, { recursive: true });
  const outPath = join(SMA_REGISTRY, 'dependents.generated.json');
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`wrote ${outPath}`);
}

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else if (!args.write) {
  // human summary
  console.log(`Dependents index — ${String(result.stats.unique_source_bricks)} source brick(s), ${String(result.stats.total_dependent_links)} link(s) across ${String(result.stats.projects_scanned)} project(s).`);
  console.log(`  import-locks:    ${String(result.stats.import_locks_found)}`);
  console.log(`  reuse-receipts:  ${String(result.stats.reuse_receipts_found)}`);
  if (args.sourceBrick) {
    const links = dependents[args.sourceBrick] ?? [];
    console.log(`\n${args.sourceBrick} (${String(links.length)} dependent${links.length === 1 ? '' : 's'}):`);
    for (const l of links) {
      console.log(`  - ${String(l.target_project)}  ${l.target_path ?? ''}  [${l.evidence_kind}]  imported@${(l.source_commit_imported ?? '').slice(0, 7) || 'unknown'}`);
    }
  } else {
    console.log('\nTop 10 most-depended-on source bricks:');
    const ranked = Object.entries(sources)
      .sort((a, b) => (b[1].dependent_count ?? 0) - (a[1].dependent_count ?? 0))
      .slice(0, 10);
    for (const [id, s] of ranked) {
      console.log(`  ${String(s.dependent_count).padStart(3)}  ${id}  (${s.source_project ?? '?'})`);
    }
  }
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') out.write = true;
    else if (a === '--json') out.json = true;
    else if (a === '--source-brick') out.sourceBrick = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}
