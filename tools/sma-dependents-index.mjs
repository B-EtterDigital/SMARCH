#!/usr/bin/env node
/**
 * WHAT: Builds an inverse index from source bricks to the projects that depend on them.
 * WHY: Source releases cannot be propagated safely without knowing every locked copy and fork.
 * HOW: Scans import locks, reuse receipts, and manifests, then groups evidence by source brick.
 * INPUTS: Portfolio project roots and an optional source-brick filter.
 * OUTPUTS: A dependency report on standard output or the generated dependents index file.
 * CALLERS: Release propagation commands and maintainers planning downstream updates.
 * Usage: `node tools/sma-dependents-index.mjs --source-brick example.brick --json`
 */
/**
 * sma-dependents-index.mjs — build the inverted "who has copies of which brick" index.
 *
 * Reads (does not modify):
 *   - ~/DEV/Projects/*\/.smarch/import-lock.json    (formal sma-clone provenance)
 *   - ~/DEV/Projects/*\/.smarch/reuse-receipts/*.json  (manual / additive copies)
 *   - ~/DEV/Projects/*\/(packages|web/src/modules|...)/<brick>/module.sweetspot.json
 *       → provenance.source_chain[*] (legacy / scanner-bootstrapped fallback)
 *
 * Writes:
 *   ~/DEV/SMARCH/registry/dependents.generated.json
 *   conforming to schemas/dependents-index.schema.json
 *
 * Use:
 *   node tools/sma-dependents-index.mjs --write
 *   node tools/sma-dependents-index.mjs --json | jq '.dependents["acme-lang.frontend-module..."]'
 *   node tools/sma-dependents-index.mjs --source-brick <id>   → just that brick's dependents
 *
 * Pure read-only across all projects. Re-run anytime, idempotent.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { argv, exit } from 'node:process';
import { createHash } from 'node:crypto';
import { PROJECTS_ROOT, smaPath } from "./lib/sma-paths.ts";


const SMA_REGISTRY = smaPath('registry');
const REGISTRY_SNAPSHOT = smaPath('registry/global-modules.generated.json');

const args = parseArgs(argv.slice(2));
if (args.help) {
  console.log(`Usage:
  sma-dependents-index.mjs [--write] [--json] [--source-brick <id>]
Reads each project's .smarch/import-lock.json and .smarch/reuse-receipts/*.json,
plus brick manifest provenance.source_chain entries, and emits an inverted index.
`);
  exit(0);
}

const sources = {};                // source_brick_id → metadata
const dependents = {};             // source_brick_id → [link, ...]
let importLocksFound = 0;
let reuseReceiptsFound = 0;
let projectsScanned = 0;

function pushDependent(srcId, link) {
  if (args.sourceBrick && srcId !== args.sourceBrick) return;
  dependents[srcId] ??= [];
  dependents[srcId].push(link);
  sources[srcId] ??= { dependent_count: 0 };
  sources[srcId].dependent_count = (sources[srcId].dependent_count ?? 0) + 1;
}

function ensureSourceMeta(srcId, srcProject) {
  sources[srcId] ??= { dependent_count: 0 };
  if (srcProject && !sources[srcId].source_project) sources[srcId].source_project = srcProject;
}

function scanProject(projectRoot) {
  projectsScanned++;
  const projectId = projectRoot.split('/').pop();
  const smarchDir = join(projectRoot, '.smarch');
  if (!existsSync(smarchDir)) return;

  // 1. Formal import lock (sma-clone v0 — import-lock.json) + new format (imports.json + build-lock.json)
  const lockPath = join(smarchDir, 'import-lock.json');
  if (existsSync(lockPath)) {
    importLocksFound++;
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
      const bricks = lock.resolved_bricks ?? [];
      for (const r of bricks) {
        const srcId = r.source_brick_id ?? r.brick_id ?? r.id;
        if (!srcId) continue;
        ensureSourceMeta(srcId, r.source_project);
        pushDependent(srcId, {
          target_project: lock.target?.project ?? projectId,
          target_root: projectRoot,
          target_path: r.target_path,
          target_brick_id: r.target_brick_id,
          version_imported: r.version,
          source_commit_imported: r.source_commit,
          imported_at: lock.lock?.generated_at,
          evidence_kind: 'import-lock',
          evidence_path: relative(PROJECTS_ROOT, lockPath),
          upgrade_status: 'unknown',
        });
      }
    } catch (e) {
      console.error(`[warn] could not parse ${lockPath}: ${e.message}`);
    }
  }

  // 1b. Newer sma-clone format: .smarch/imports.json + .smarch/build-lock.json.
  const importsPath = join(smarchDir, 'imports.json');
  const buildLockPath = join(smarchDir, 'build-lock.json');
  if (existsSync(importsPath) && existsSync(buildLockPath)) {
    importLocksFound++;
    try {
      const imports = JSON.parse(readFileSync(importsPath, 'utf8'));
      const buildLock = JSON.parse(readFileSync(buildLockPath, 'utf8'));
      const resolved = buildLock.resolved_bricks ?? [];
      for (const r of resolved) {
        // sma-clone v1 uses artifact_id (canonical brick id);
        // older format used source_brick_id/brick_id/id.
        const srcId = r.artifact_id ?? r.source_brick_id ?? r.brick_id ?? r.id;
        if (!srcId || r.artifact_type === 'build') continue;
        ensureSourceMeta(srcId, r.source_project);
        pushDependent(srcId, {
          target_project: buildLock.target?.id ?? imports.imports?.[0]?.target_project ?? projectId,
          target_root: projectRoot,
          target_path: r.target_path ?? r.path,
          target_brick_id: srcId,
          version_imported: r.release_version ?? r.version,
          source_commit_imported: r.source_commit,
          imported_at: imports.imports?.[0]?.imported_at ?? buildLock.lock?.generated_at,
          evidence_kind: 'import-lock',
          evidence_path: relative(PROJECTS_ROOT, importsPath),
          upgrade_status: 'unknown',
        });
      }
    } catch (e) {
      console.error(`[warn] could not parse ${importsPath}: ${e.message}`);
    }
  }

  // 2. Reuse receipts (informal / additive)
  const receiptsDir = join(smarchDir, 'reuse-receipts');
  if (existsSync(receiptsDir) && statSync(receiptsDir).isDirectory()) {
    for (const f of readdirSync(receiptsDir)) {
      if (!f.endsWith('.json')) continue;
      reuseReceiptsFound++;
      try {
        const r = JSON.parse(readFileSync(join(receiptsDir, f), 'utf8'));
        for (const item of r.items ?? []) {
          const srcId = item.source_brick_id;
          if (!srcId) continue;
          ensureSourceMeta(srcId, r.source?.project);
          pushDependent(srcId, {
            target_project: r.target?.project ?? projectId,
            target_root: r.target?.root ?? projectRoot,
            target_path: item.target_path,
            target_brick_id: item.target_brick_id,
            source_commit_imported: r.source?.commit,
            imported_at: r.generated_at,
            evidence_kind: 'reuse-receipt',
            evidence_path: relative(PROJECTS_ROOT, join(receiptsDir, f)),
            upgrade_status: 'unknown',
          });
        }
      } catch (e) {
        console.error(`[warn] could not parse ${f}: ${e.message}`);
      }
    }
  }

  // 3. Brick manifest source-chain fallback
  for (const brickDir of findBrickDirs(projectRoot)) {
    const manifestPath = join(brickDir, 'module.sweetspot.json');
    if (!existsSync(manifestPath)) continue;
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
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

function findBrickDirs(root) {
  const out = [];
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
function enrichSources() {
  for (const srcId of Object.keys(sources)) {
    const srcProject = sources[srcId].source_project;
    if (!srcProject) continue;
    const projectDir = findProjectDir(srcProject);
    if (!projectDir) continue;
    for (const brickDir of findBrickDirs(projectDir)) {
      const manifestPath = join(brickDir, 'module.sweetspot.json');
      if (!existsSync(manifestPath)) continue;
      try {
        const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (m.brick?.id === srcId) {
          sources[srcId].source_path = relative(projectDir, brickDir);
          sources[srcId].latest_version = m.brick.version;
          if (m.brick?.replication?.policy) {
            sources[srcId].replication_policy = m.brick.replication.policy;
          }
          break;
        }
      } catch { /* skip */ }
    }
  }
}

function findProjectDir(projectId) {
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
  console.log(`Dependents index — ${result.stats.unique_source_bricks} source brick(s), ${result.stats.total_dependent_links} link(s) across ${result.stats.projects_scanned} project(s).`);
  console.log(`  import-locks:    ${result.stats.import_locks_found}`);
  console.log(`  reuse-receipts:  ${result.stats.reuse_receipts_found}`);
  if (args.sourceBrick) {
    const links = dependents[args.sourceBrick] ?? [];
    console.log(`\n${args.sourceBrick} (${links.length} dependent${links.length === 1 ? '' : 's'}):`);
    for (const l of links) {
      console.log(`  - ${l.target_project}  ${l.target_path ?? ''}  [${l.evidence_kind}]  imported@${(l.source_commit_imported ?? '').slice(0, 7) || 'unknown'}`);
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

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') out.write = true;
    else if (a === '--json') out.json = true;
    else if (a === '--source-brick') out.sourceBrick = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}
