#!/usr/bin/env node
/**
 * sma — umbrella entry point for SMARCH tools.
 *
 * Dispatches `sma <command> [args...]` to the matching sma-<command>.mjs.
 * Commands map roughly 1:1 to the tools in this directory; the umbrella exists
 * to give a stable, short surface area instead of `node tools/sma-foo.mjs`.
 *
 * Usage:
 *   sma <command> [...args]
 *   sma list                    → list all commands
 *   sma help                    → this text
 *   sma <command> --help        → forwarded to the underlying tool
 *
 * Examples:
 *   sma lease acquire --resource-kind brick --resource X --intent "..."
 *   sma context append --project Y --brick X --kind edit_applied --intent "..."
 *   sma store install --brick X --version 0.2.0 --target /path/to/project
 *   sma doctor --project X
 *   sma gen3 dashboard
 *
 * Install once, anywhere:
 *   npm link                         (then `sma <cmd>` works in any cwd)
 *   alias sma="node ~/DEV/SMARCH/tools/sma.mjs"
 */

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const TOOLS_DIR = dirname(__filename);

// Command → (script-relative-to-tools-dir, optional sub-arg-injection)
// First entry under each key wins; aliases follow it.
const COMMANDS = {
  // multi-agent layer
  lease:           { script: 'sma-lease.mjs',          desc: 'Soft locks on bricks/regen targets' },
  context:         { script: 'sma-context.mjs',        desc: 'Append-only agent-context log' },
  conflict:        { script: 'sma-conflict.mjs',       desc: 'Report and resolve Gen3 agent collisions' },
  'context-check': { script: 'sma-context-check.mjs',  desc: 'CI gate: modified manifests have context' },
  'context-replay':{ script: 'sma-context-replay.mjs', desc: 'Render a brick\'s log as a story' },
  merge:           { script: 'sma-merge.mjs',          desc: 'Divergence proposals from context chains' },
  'start-edit':    { script: 'sma-start-edit.mjs',     desc: 'Acquire lease + log edit_planned in one shot' },
  'end-edit':      { script: 'sma-end-edit.mjs',       desc: 'Log edit_applied + release lease' },
  'validate-gen3': { script: 'sma-validate-gen3.mjs',  desc: 'Schema-validate Gen-3 surfaces' },
  seed:            { script: 'sma-seed.mjs',           desc: 'Demo: replay recent commits as full edit cycles' },
  stats:           { script: 'sma-stats.mjs',          desc: 'Adoption metrics over time' },
  'controller-snapshot': { script: 'sma-controller-snapshot.mjs', desc: 'Read-only leases/conflicts/graphs/dirty snapshot' },
  'portfolio-refresh': { script: 'sma-portfolio-refresh.mjs', desc: 'Queued/debounced scan + state + Gen3 dashboard refresh' },

  // release-store + propagation
  store:           { script: 'sma-store.mjs',          desc: 'Install releases by id+version' },
  'store-remote':  { script: 'sma-store-remote.mjs',   desc: 'STUB: hosted release-store (federation)' },
  release:         { script: 'sma-release.mjs',        desc: 'Cut a release artifact from a manifest' },
  clone:           { script: 'sma-clone.mjs',          desc: 'Copy a brick/build into a target project' },
  propagate:       { script: 'sma-propagate.mjs',      desc: 'Push a release to dependents' },

  // backfill + manifests
  backfill:        { script: 'sma-touch-backfill.mjs', desc: 'Add structured-why touch_event to a manifest' },
  'touch-backfill':{ script: 'sma-touch-backfill.mjs', desc: 'Alias of backfill' },
  'backfill-plan': { script: 'sma-backfill-plan.mjs',  desc: 'Select 500+ bricks-that-matter (write plan)' },
  'backfill-run':  { script: 'sma-backfill-run.mjs',   desc: 'Execute a backfill plan (dry-run by default)' },
  'backfill-summary': { script: 'sma-backfill-summary.mjs', desc: 'Roll up every backfill batch report' },
  'backfill-bulk':    { script: 'sma-backfill-bulk.mjs',    desc: 'Apply hand-written intents to many bricks (CSV/JSON)' },
  scaffold:        { script: 'sma-manifest-scaffold.mjs', desc: 'Scaffold a manifest from inferred metadata' },

  // dashboards + reports
  state:           { script: 'sma-state.mjs',          desc: 'Regenerate the state snapshot' },
  doctor:          { script: 'sma-doctor.mjs',         desc: 'Health report (global or --project)' },
  scan:            { script: 'sma-scan.mjs',           desc: 'Scan all projects, regenerate registry' },
  ci:              { script: 'sma-ci.mjs',             desc: 'Full pipeline (scan, validate, security, wiki)' },
  wiki:            { script: 'sma-wiki.mjs',           desc: 'Regenerate the brick wiki' },
  validate:        { script: 'sma-validate.mjs',       desc: 'Validate manifests against schemas' },
  security:        { script: 'sma-security-gate.mjs',  desc: 'Run the security gate' },

  // backlog
  backlog:         { script: 'sma-backlog.mjs',        desc: 'Per-project backlog of imperfections' },
  'why-blocked':   { script: 'sma-why-blocked.mjs',    desc: 'Explain why a project/brick is blocked' },

  // gen3 namespaced
  gen3:            { router: 'gen3' },
};

const GEN3_SUBCOMMANDS = {
  status:     { script: 'sma-parallel-preflight.mjs', desc: 'Parallel readiness + big-picture TLDR' },
  watch:      { script: 'sma-wave-monitor.mjs', desc: 'Live cleanup wave monitor' },
  observe:    { script: 'sma-wave-observe.mjs', desc: 'Persist observed cleanup wave outcomes' },
  dispatch:   { script: 'sma-cleanup-packets.mjs', args: ['wave', '--write-dispatch'], desc: 'Persist a cleanup wave dispatch manifest' },
  dashboard:  { script: 'sma-gen3-dashboard.mjs', desc: 'Build wiki/GEN3_DASHBOARD.generated.html' },
  refresh:    { script: 'sma-portfolio-refresh.mjs', desc: 'Queued/debounced scan + state + dashboard refresh' },
  wiki:       { script: 'sma-wiki-gen3.mjs',      desc: 'Build wiki/gen3/ diff + tree pages' },
  snapshot:   { script: 'sma-controller-snapshot.mjs', desc: 'Read-only controller snapshot' },
};

const cmd = process.argv[2];
const rest = process.argv.slice(3);

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
  printUsage();
  process.exit(cmd ? 0 : 2);
}

if (cmd === 'list' || cmd === 'commands') {
  printList();
  process.exit(0);
}

const entry = COMMANDS[cmd];
if (!entry) {
  console.error(`sma: unknown command "${cmd}"`);
  console.error('try `sma list` to see all commands');
  process.exit(2);
}

if (entry.router === 'gen3') {
  const sub = rest[0];
  const subEntry = sub ? GEN3_SUBCOMMANDS[sub] : null;
  if (!sub || sub === 'help' || sub === '--help') {
    printGen3Usage();
    process.exit(sub ? 0 : 2);
  }
  if (!subEntry) {
    console.error(`sma gen3: unknown subcommand "${sub}"`);
    printGen3Usage();
    process.exit(2);
  }
  dispatch(subEntry.script, [...(subEntry.args || []), ...rest.slice(1)]);
} else {
  dispatch(entry.script, rest);
}

function dispatch(script, argv) {
  const path = resolve(TOOLS_DIR, script);
  if (!existsSync(path)) {
    console.error(`sma: tool not found at ${path}`);
    process.exit(2);
  }
  const child = spawn(process.execPath, [path, ...argv], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  child.on('error', (e) => {
    console.error(`sma: spawn failed: ${e.message}`);
    process.exit(1);
  });
}

function printUsage() {
  console.log(`sma — SMARCH umbrella CLI

Usage:
  sma <command> [...args]
  sma list                            list all commands with one-liners
  sma <command> --help                forwarded to the underlying tool

Multi-agent:
  sma lease         soft-lock on bricks/regen targets
  sma context       append-only intent log per brick
  sma conflict      report/resolve agent collisions
  sma portfolio-refresh queued/debounced scan + state + dashboard refresh
  sma context-check CI gate for context coverage
  sma merge         divergence proposals

Release & propagation:
  sma store         install by id+version  (Pierre-shape)
  sma release       cut a release artifact
  sma clone         copy a brick/build into a project
  sma propagate     push a release to dependents

Backfill & manifests:
  sma backfill      add structured-why touch_event to a manifest
  sma scaffold      scaffold a manifest

Dashboards & reports:
  sma state         regen state snapshot
  sma doctor        health report
  sma scan          regen global registry
  sma ci            full pipeline
  sma wiki          regen brick wiki
  sma validate      validate manifests
  sma security      security gate

Gen-3 augmentations:
  sma gen3 status      parallel readiness + big-picture TLDR
  sma gen3 watch       live cleanup wave monitor
  sma gen3 dispatch    persist cleanup wave dispatch manifest
  sma gen3 observe     persist observed cleanup wave outcomes
  sma gen3 refresh     queued/debounced scan + state + dashboard refresh
  sma gen3 dashboard   wiki/GEN3_DASHBOARD.generated.html
  sma gen3 wiki        wiki/gen3/ (diff + tree pages)

Backlog:
  sma backlog       per-project backlog
  sma why-blocked   explain a block

See docs/MULTI_AGENT_OPERATIONS.md.
`);
}

function printList() {
  const rows = [];
  for (const [name, entry] of Object.entries(COMMANDS)) {
    if (entry.router === 'gen3') continue;
    rows.push([name, entry.desc, entry.script]);
  }
  for (const [name, entry] of Object.entries(GEN3_SUBCOMMANDS)) {
    rows.push([`gen3 ${name}`, entry.desc, entry.script]);
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]));
  const w = Math.max(...rows.map((r) => r[0].length));
  for (const [name, desc, script] of rows) {
    console.log(`${name.padEnd(w)}  ${desc}  (${script})`);
  }
}

function printGen3Usage() {
  console.log(`sma gen3 <subcommand>

Subcommands:`);
  for (const [name, entry] of Object.entries(GEN3_SUBCOMMANDS)) {
    console.log(`  ${name.padEnd(12)} ${entry.desc}`);
  }
}
