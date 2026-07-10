#!/usr/bin/env node
/**
 * sma-reuse-receipt.mjs — record a brick/build inheritance from one project to another.
 *
 * Use after `sma-clone.mjs` (or after a manual copy) to capture:
 *   - which bricks landed where
 *   - how many tokens that saved (estimate via sma-token-count)
 *   - how many tokens the integration cost
 *   - what imperfections need to land in the target's backlog
 *
 * Writes <target_root>/.smarch/reuse-receipts/<id>.json conforming to
 * schemas/reuse-receipt.schema.json.
 *
 * Usage:
 *   sma-reuse-receipt.mjs \
 *     --target /path/to/target_project \
 *     --target-project acme-lang \
 *     --source-project acme-desktop \
 *     --source-commit 9810778b7c... \
 *     --item packages/modcap:source=web/src/modules/modcap:kind=brick \
 *     --item packages/modcore:kind=brick \
 *     --infra-tokens 6500 \
 *     --backlog-id acme-lang-001 \
 *     --backlog-id acme-lang-002 \
 *     --write
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, join, extname, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { argv, exit } from 'node:process';

const args = parseArgs(argv.slice(2));
if (args.help || !args.target || !args.targetProject || !args.sourceProject) {
  console.log(`Usage:
  sma-reuse-receipt.mjs --target <root> --target-project <id> --source-project <id> [--source-commit <sha>] \\
    --item <target_path>[:source=<src_path>][:kind=<kind>] (repeatable) \\
    [--infra-tokens N] [--backlog-id ID]... \\
    [--multiplier 3.8] [--write] [--json]
`);
  exit(args.help ? 0 : 2);
}

const MULTIPLIER = Number(args.multiplier ?? 3.8);
const targetRoot = resolve(args.target);
const items = (args.item ?? []).map((spec) => {
  const [tpath, ...rest] = spec.split(':');
  const opts = Object.fromEntries(rest.map((kv) => kv.split('=')));
  return { target_path: tpath, source_path: opts.source, kind: opts.kind ?? 'brick' };
});

if (!items.length) {
  console.error('at least one --item required');
  exit(2);
}

function countDir(dir) {
  if (!existsSync(dir)) return { files: 0, loc: 0, static_tokens: 0 };
  let files = 0, loc = 0, chars = 0;
  function walk(d) {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.next', 'dist', 'build', '.git', '.expo'].includes(ent.name)) continue;
      const p = join(d, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      const ext = extname(p).toLowerCase();
      if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.sql', '.md'].includes(ext)) continue;
      const buf = readFileSync(p, 'utf8');
      files++; loc += buf.split('\n').length; chars += buf.length;
    }
  }
  walk(dir);
  return { files, loc, static_tokens: Math.round(chars / 3.7) };
}

const itemReports = items.map((it) => {
  const fullPath = resolve(targetRoot, it.target_path);
  const stats = countDir(fullPath);
  return {
    source_brick_id: it.source_path
      ? `${args.sourceProject}.${it.source_path.replace(/\//g, '-')}`
      : `${args.sourceProject}.${it.target_path.split('/').pop()}`,
    target_path: it.target_path,
    kind: it.kind,
    loc: stats.loc,
    files: stats.files,
    token_estimate: stats.static_tokens,
  };
});

const totalLoc = itemReports.reduce((a, b) => a + b.loc, 0);
const totalStatic = itemReports.reduce((a, b) => a + b.token_estimate, 0);
const realistic = Math.round(totalStatic * MULTIPLIER);
const infra = Number(args.infraTokens ?? 0);

const receipt = {
  schema_version: '1.0.0',
  id: `${args.targetProject}:${args.sourceProject}@${(args.sourceCommit ?? 'HEAD').slice(0, 12)}:${new Date().toISOString()}`,
  generated_at: new Date().toISOString(),
  source: {
    project: args.sourceProject,
    commit: args.sourceCommit ?? '',
    registry_path: `~/DEV/SMARCH/scans/${args.sourceProject}/latest.registry.json`,
  },
  target: {
    project: args.targetProject,
    root: targetRoot,
    commit: tryGitHead(targetRoot),
  },
  items: itemReports,
  estimates: {
    loc_inherited_total: totalLoc,
    tokens_saved_estimate: {
      lower: totalStatic,
      upper: realistic,
      method: `heuristic chars/3.7; multiplier=${MULTIPLIER}`,
      factors: {
        direct_generation: totalStatic,
        iteration_roundtrips: Math.round(totalStatic * (MULTIPLIER - 2.2)),
        design_discussion: Math.round(totalStatic * 1.2),
      },
    },
    infrastructure_cost_tokens: infra,
    wall_clock_minutes_saved_estimate: Math.round(totalLoc / 30), // ~30 LOC/min for Claude on novel code
  },
  backlog_entry_ids: args.backlogId ?? [],
  provenance: {
    actor_kind: args.actor ?? 'ai_model',
    actor_id: args.actorId ?? 'claude-opus-4-7',
    model: args.model ?? 'claude-opus-4-7',
    session_id: args.sessionId ?? '',
  },
};

if (args.write) {
  const outDir = resolve(targetRoot, '.smarch/reuse-receipts');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outName = `${args.sourceProject}-${(args.sourceCommit ?? 'head').slice(0, 12)}-${Date.now()}.json`;
  const outPath = join(outDir, outName);
  writeFileSync(outPath, JSON.stringify(receipt, null, 2));
  console.log(`wrote ${outPath}`);
}

if (args.json) {
  console.log(JSON.stringify(receipt, null, 2));
} else {
  console.log(`reuse receipt: ${receipt.id}`);
  console.log(`  inherited:    ${itemReports.length} item(s), ${totalLoc} LOC, ${totalStatic.toLocaleString()} static tokens`);
  console.log(`  saved (lo):   ${totalStatic.toLocaleString()} tokens (direct generation only)`);
  console.log(`  saved (hi):   ${realistic.toLocaleString()} tokens (with iteration + discussion)`);
  console.log(`  infra cost:   ${infra.toLocaleString()} tokens`);
  console.log(`  net:          ${(realistic - infra).toLocaleString()} tokens (high estimate)`);
  console.log(`  backlog:      ${(args.backlogId ?? []).length} entry(s) opened in target project`);
}

function tryGitHead(dir) {
  try { return execSync('git rev-parse HEAD', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return ''; }
}

function parseArgs(argv) {
  const out = { item: [], backlogId: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--target-project') out.targetProject = argv[++i];
    else if (a === '--source-project') out.sourceProject = argv[++i];
    else if (a === '--source-commit') out.sourceCommit = argv[++i];
    else if (a === '--item') out.item.push(argv[++i]);
    else if (a === '--infra-tokens') out.infraTokens = argv[++i];
    else if (a === '--multiplier') out.multiplier = argv[++i];
    else if (a === '--backlog-id') out.backlogId.push(argv[++i]);
    else if (a === '--actor') out.actor = argv[++i];
    else if (a === '--actor-id') out.actorId = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--session-id') out.sessionId = argv[++i];
    else if (a === '--write') out.write = true;
    else if (a === '--json') out.json = true;
  }
  return out;
}
