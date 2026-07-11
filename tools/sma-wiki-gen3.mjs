#!/usr/bin/env node
/**
 * WHAT: Builds opt-in release-diff and source-tree pages for the Gen3 wiki.
 * WHY: Maintainers need visual release history without changing the main wiki generator.
 * HOW: Reads versioned release records and renders brick-filtered pages into a separate tree.
 * OUTPUTS: Writes diff and tree pages or lists pages already emitted.
 * CALLERS: The sma gen3 wiki route invokes it under a serialized wiki lease.
 * USAGE: `node tools/sma-wiki-gen3.mjs list --out wiki/gen3`
 * Glossary: [Gen3](../docs/GLOSSARY.md).
 */

import { SMA_ROOT } from "./lib/sma-paths.mjs";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { renderBrickDiffPage, renderBrickTreePage } from './lib/gen3-renderers.mjs';


const RELEASES_DIR = resolve(SMA_ROOT, 'releases');
const DEFAULT_OUT = resolve(SMA_ROOT, 'wiki/gen3');

const cmd = argv[2];
const args = parseArgs(argv.slice(3));

try {
  switch (cmd) {
    case 'build':
      runBuild();
      break;
    case 'list':
      runList();
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      usage();
      exit(cmd ? 0 : 2);
      break;
    default:
      console.error(`unknown subcommand: ${cmd}`);
      usage();
      exit(2);
  }
} catch (err) {
  console.error(`sma-wiki-gen3: ${err.message}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-wiki-gen3.mjs build  [--out <dir>] [--brick <id>] [--clean]
  sma-wiki-gen3.mjs list   [--out <dir>]
`);
}

function runBuild() {
  const outDir = args.out ? resolve(args.out) : DEFAULT_OUT;
  if (args.clean && existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  if (!existsSync(RELEASES_DIR)) {
    console.log('(no releases/ dir; nothing to render)');
    return;
  }

  const bricks = readdirSync(RELEASES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) => !args.brick || id === args.brick);

  let total = 0;
  for (const id of bricks) {
    const brickDir = resolve(RELEASES_DIR, id);
    const versions = readdirSync(brickDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ v: f.replace(/\.json$/, ''), path: resolve(brickDir, f) }))
      .sort((a, b) => semverCompare(a.v, b.v));

    if (!versions.length) continue;

    const brickOut = resolve(outDir, id);
    if (!existsSync(brickOut)) mkdirSync(brickOut, { recursive: true });

    // diff pages between adjacent versions
    for (let i = 1; i < versions.length; i++) {
      const a = versions[i - 1];
      const b = versions[i];
      const html = renderBrickDiffPage({
        brickId: id,
        versionA: a.v,
        versionB: b.v,
        releaseAPath: a.path,
        releaseBPath: b.path,
      });
      const outPath = resolve(brickOut, `diff-${a.v}__${b.v}.html`);
      writeFileSync(outPath, html);
      total += 1;
    }

    // tree page from the latest release
    const latest = versions[versions.length - 1];
    const release = JSON.parse(readFileSync(latest.path, 'utf8'));
    const paths = release?.content?.included_paths ?? [];
    const treeHtml = renderBrickTreePage({ brickId: id, paths });
    writeFileSync(resolve(brickOut, 'tree.html'), treeHtml);
    total += 1;
  }

  console.log(`wrote ${total} page(s) under ${outDir}`);
}

function runList() {
  const outDir = args.out ? resolve(args.out) : DEFAULT_OUT;
  if (!existsSync(outDir)) {
    console.log(`(no output yet at ${outDir}; run \`sma-wiki-gen3.mjs build\`)`);
    return;
  }
  const walk = (dir, prefix = '') => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const sub = `${prefix}${ent.name}`;
      if (ent.isDirectory()) walk(resolve(dir, ent.name), sub + '/');
      else console.log(sub);
    }
  };
  walk(outDir);
}

function semverCompare(a, b) {
  const pa = String(a).split(/[.+-]/).map((p) => Number.isNaN(Number(p)) ? p : Number(p));
  const pb = String(b).split(/[.+-]/).map((p) => Number.isNaN(Number(p)) ? p : Number(p));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === typeof y) return x < y ? -1 : 1;
    return typeof x === 'number' ? -1 : 1;
  }
  return 0;
}

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = list[i + 1];
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) {
      out[camel] = true;
      continue;
    }
    out[camel] = next;
    i += 1;
  }
  return out;
}
