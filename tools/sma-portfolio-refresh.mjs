#!/usr/bin/env node
/**
 * What: Refreshes portfolio registry, state, and dashboard artifacts through one queue.
 * Why: Independent refresh chains can duplicate expensive scans and race on shared outputs.
 * How: Accepts project and changed-file hints, reuses fresh work, and invokes required generators.
 * Callers: Agents and controller scripts use it after changes that affect portfolio visibility.
 * Example: `node tools/sma-portfolio-refresh.mjs --help`
 */
/**
 * sma-portfolio-refresh.mjs — queued/debounced Gen3 portfolio refresh.
 *
 * Normal agents should call this instead of chaining:
 *   npm run scan:safe && npm run state:safe && npm run gen3:dashboard
 *
 * If another registry scan is already active, this command waits for it and
 * reuses the result instead of starting a second full scan. Fresh artifacts are
 * skipped by age, which keeps controller visibility cheap while many agents are
 * working.
 */

import { PROJECTS_ROOT } from "./lib/sma-paths.mjs";
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exit } from 'node:process';

const toolsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(toolsDir, '..');

const DEFAULTS = {
  root: PROJECTS_ROOT,
  registry: resolve(repoRoot, 'registry/global-modules.generated.json'),
  portfolioRegistry: resolve(repoRoot, 'scans/all-projects/latest.registry.json'),
  state: resolve(repoRoot, 'wiki/SMA_STATE.generated.json'),
  dashboard: resolve(repoRoot, 'wiki/GEN3_DASHBOARD.generated.html'),
  leases: resolve(repoRoot, 'registry/active-leases.generated.json'),
  scanFreshSeconds: 300,
  projectScanFreshSeconds: 180,
  stateFreshSeconds: 45,
  dashboardFreshSeconds: 45,
  waitSeconds: 900,
  pollSeconds: 5,
};

/**
 * @typedef {object} PortfolioRefreshArgs
 * @property {string[]} projects
 * @property {string[]} changedFiles
 * @property {string} root
 * @property {string} registry
 * @property {string} portfolioRegistry
 * @property {string} state
 * @property {string} dashboard
 * @property {string} leases
 * @property {number|string} scanFreshSeconds
 * @property {number|string} projectScanFreshSeconds
 * @property {number|string} stateFreshSeconds
 * @property {number|string} dashboardFreshSeconds
 * @property {number|string} waitSeconds
 * @property {number|string} pollSeconds
 * @property {number|string} [provenanceFreshSeconds]
 * @property {number|string} [anchorFreshSeconds]
 * @property {boolean} [help]
 * @property {boolean} [force]
 * @property {boolean} [json]
 * @property {boolean} [noScan]
 * @property {boolean} [noState]
 * @property {boolean} [noDashboard]
 * @property {boolean} [noProvenance]
 */

const args = parseArgs(process.argv.slice(2));

try {
  if (args.help) {
    usage();
    exit(0);
  }
  const summary = await refreshPortfolio();
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else printSummary(summary);
} catch (err) {
  console.error(`sma-portfolio-refresh: ${err.message}`);
  exit(/** @type {Error & {code?: number}} */ (err).code || 1);
}

function usage() {
  console.log(`Usage:
  sma-portfolio-refresh.mjs [--force] [--json]
                            [--project <id>] [--project <id> ...]
                            [--changed-file <path>] [--changed-file <path> ...]
                            [--no-scan] [--no-state] [--no-dashboard]
                            [--scan-fresh-seconds <n>]
                            [--project-scan-fresh-seconds <n>]
                            [--state-fresh-seconds <n>]
                            [--dashboard-fresh-seconds <n>]
                            [--wait-seconds <n>] [--poll-seconds <n>]

Default behavior:
  - run scan only when the registry is older than 300s,
  - if a registry scan is active, wait and reuse it instead of starting another,
  - run state/dashboard only when older than 45s,
  - use SMA leases for every generated artifact write.

Project-scoped refresh:
  - --project <id> scans only the named portfolio project(s),
  - writes scans/<id>/latest.registry.json and merges scans/all-projects/latest.registry.json,
  - bare --project calls reuse a fresh project registry for ${DEFAULTS.projectScanFreshSeconds}s,
  - refreshes state/dashboard after a project scan or known state-impact change.

Changed-file refresh:
  - code-only changed files skip registry scan and normal freshness still applies,
  - .smarch/agent-context and conflict logs skip registry scan but force state/dashboard,
  - manifests, agent rules, package/build/deploy surfaces still force the scan phase.

Use --force when a controller explicitly needs a fresh full portfolio scan.
`);
}

async function refreshPortfolio() {
  const projectIds = uniqueStrings(args.projects || []);
  const changedFiles = uniqueStrings(args.changedFiles || []);
  const impact = classifyChangedFiles(changedFiles);
  const noScan = Boolean(args.noScan) || (changedFiles.length > 0 && !impact.requiresScan);
  const summary = {
    generated_at: new Date().toISOString(),
    force: Boolean(args.force),
    scope: projectIds.length ? 'project' : 'global',
    projects: projectIds,
    changed_files: changedFiles,
    impact,
    phases: [],
  };

  let scanPhase = null;
  if (!noScan) {
    scanPhase = await maybeRefresh(scanPhaseConfig(projectIds, impact, changedFiles));
    summary.phases.push(scanPhase);
  } else if (!args.noScan && changedFiles.length > 0) {
    summary.phases.push({
      phase: 'scan',
      status: impact.requiresState ? 'skipped-context-only' : 'skipped-no-impact',
      artifact: projectIds.length ? relative(args.portfolioRegistry) : relative(args.registry),
      changed_file_count: changedFiles.length,
    });
  }

  const scanUpdated = scanPhase && ['refreshed', 'refreshed-after-wait', 'coalesced-fresh'].includes(scanPhase.status);
  const stateNeeded = Boolean(impact.requiresState && changedFiles.length > 0);

  // Provenance/license/seal ledgers ride along with every registry refresh so
  // new bricks are ledgered automatically — no retro-backfill. Incremental:
  // only new/changed bricks pay the git+seal cost. Forced when the scan
  // actually produced new bricks; otherwise freshness-gated.
  if (!args.noProvenance) {
    const provenancePhase = await maybeRefresh({
      name: 'provenance',
      artifactPath: resolve(repoRoot, 'registry/provenance-ledger.generated.json'),
      freshSeconds: numberArg(args.provenanceFreshSeconds, DEFAULTS.scanFreshSeconds),
      force: scanUpdated,
      resourceKind: 'registry-regen',
      resource: 'provenance-ledger',
      intent: 'queued provenance ledger refresh (incremental)',
      ttl: 900,
      renewEvery: 300,
      command: [
        process.execPath,
        resolve(toolsDir, 'sma-provenance-ledger.mjs'),
        '--registry', DEFAULTS.portfolioRegistry,
      ],
    });
    summary.phases.push(provenancePhase);
    const provenanceUpdated = provenancePhase
      && ['refreshed', 'refreshed-after-wait', 'coalesced-fresh'].includes(provenancePhase.status);
    summary.phases.push(await maybeRefresh({
      name: 'anchor',
      artifactPath: resolve(repoRoot, 'registry/anchor.generated.json'),
      freshSeconds: numberArg(args.anchorFreshSeconds, DEFAULTS.scanFreshSeconds),
      force: scanUpdated || provenanceUpdated,
      resourceKind: 'registry-regen',
      resource: 'provenance-anchor',
      intent: 'queued provenance anchor refresh',
      ttl: 300,
      command: [
        process.execPath,
        resolve(toolsDir, 'sma-anchor.mjs'),
      ],
    }));
  }

  if (!args.noState) {
    summary.phases.push(await maybeRefresh({
      name: 'state',
      artifactPath: args.state,
      freshSeconds: numberArg(args.stateFreshSeconds, DEFAULTS.stateFreshSeconds),
      force: scanUpdated || stateNeeded,
      resourceKind: 'state-regen',
      resource: 'global',
      intent: 'queued portfolio state refresh',
      ttl: 600,
      command: [
        process.execPath,
        resolve(toolsDir, 'sma-state.mjs'),
      ],
    }));
  }

  if (!args.noDashboard) {
    summary.phases.push(await maybeRefresh({
      name: 'dashboard',
      artifactPath: args.dashboard,
      freshSeconds: numberArg(args.dashboardFreshSeconds, DEFAULTS.dashboardFreshSeconds),
      force: scanUpdated || stateNeeded,
      resourceKind: 'wiki-regen',
      resource: 'gen3-dashboard',
      intent: 'queued gen3 dashboard refresh',
      ttl: 300,
      command: [
        process.execPath,
        resolve(toolsDir, 'sma-gen3-dashboard.mjs'),
        'build',
      ],
    }));
  }

  return summary;
}

function scanPhaseConfig(projectIds, impact, changedFiles) {
  if (projectIds.length > 0) {
    const knownScanImpact = changedFiles.length > 0 && impact.requiresScan;
    return {
      name: 'scan',
      artifactPath: projectScanArtifact(projectIds),
      freshSeconds: numberArg(args.projectScanFreshSeconds, DEFAULTS.projectScanFreshSeconds),
      force: knownScanImpact,
      resourceKind: 'registry-regen',
      resource: 'portfolio-projects',
      intent: `queued project portfolio refresh: ${projectIds.join(', ')}`,
      ttl: 900,
      renewEvery: 300,
      command: [
        process.execPath,
        resolve(toolsDir, 'sma-portfolio-scan.mjs'),
        '--all',
        '--no-refresh',
        ...projectIds.flatMap((projectId) => ['--project', projectId]),
      ],
    };
  }

  return {
    name: 'scan',
    artifactPath: args.registry,
    freshSeconds: numberArg(args.scanFreshSeconds, DEFAULTS.scanFreshSeconds),
    resourceKind: 'registry-regen',
    resource: 'global-modules',
    intent: 'queued portfolio registry refresh',
    ttl: 900,
    renewEvery: 300,
    command: [
      process.execPath,
      resolve(toolsDir, 'sma-scan.mjs'),
      '--root', args.root,
      '--out', args.registry,
    ],
  };
}

function projectScanArtifact(projectIds) {
  if (projectIds.length === 1) {
    return resolve(repoRoot, 'scans', projectIds[0], 'latest.registry.json');
  }
  return args.portfolioRegistry;
}

async function maybeRefresh(phase) {
  const fresh = artifactFreshness(phase.artifactPath);
  if (!args.force && !phase.force && fresh.exists && fresh.age_seconds <= phase.freshSeconds) {
    return {
      phase: phase.name,
      status: 'skipped-fresh',
      artifact: relative(phase.artifactPath),
      age_seconds: fresh.age_seconds,
      freshness_seconds: phase.freshSeconds,
    };
  }

  const active = findActiveLease(phase.resourceKind, phase.resource);
  if (active) {
    await waitForLeaseClear(phase, active);
    const afterWait = artifactFreshness(phase.artifactPath);
    if (!args.force && !phase.force && afterWait.exists && afterWait.age_seconds <= phase.freshSeconds) {
      return {
        phase: phase.name,
        status: 'coalesced-fresh',
        artifact: relative(phase.artifactPath),
        age_seconds: afterWait.age_seconds,
        freshness_seconds: phase.freshSeconds,
        waited_for_lease: active.lease_id,
        holder_agent: active.agent_id,
        holder_intent: active.intent,
      };
    }

    runLeasedPhase(phase);
    const refreshed = artifactFreshness(phase.artifactPath);
    return {
      phase: phase.name,
      status: 'refreshed-after-wait',
      artifact: relative(phase.artifactPath),
      age_seconds: refreshed.age_seconds,
      waited_for_lease: active.lease_id,
      holder_agent: active.agent_id,
      holder_intent: active.intent,
    };
  }

  runLeasedPhase(phase);
  const refreshed = artifactFreshness(phase.artifactPath);
  return {
    phase: phase.name,
    status: 'refreshed',
    artifact: relative(phase.artifactPath),
    age_seconds: refreshed.age_seconds,
  };
}

async function waitForLeaseClear(phase, active) {
  const waitSeconds = numberArg(args.waitSeconds, DEFAULTS.waitSeconds);
  const pollSeconds = Math.max(1, numberArg(args.pollSeconds, DEFAULTS.pollSeconds));
  const started = Date.now();
  if (!args.json) {
    console.log(`[portfolio-refresh] ${phase.name}: waiting for ${active.resource_kind}:${active.resource_id} lease ${active.lease_id}`);
  }

  while (Date.now() - started <= waitSeconds * 1000) {
    await sleep(pollSeconds * 1000);
    const current = findActiveLease(phase.resourceKind, phase.resource);
    if (!current) return;
  }

  const err = /** @type {Error & {code?: number}} */ (new Error(`${phase.name}: timed out waiting for ${active.resource_kind}:${active.resource_id} (${active.lease_id})`));
  err.code = 10;
  throw err;
}

function runLeasedPhase(phase) {
  const leaseArgs = [
    resolve(toolsDir, 'sma-lease.mjs'),
    'run',
    '--resource-kind', phase.resourceKind,
    '--resource', phase.resource,
    '--intent', phase.intent,
    '--ttl', String(phase.ttl),
    '--project', 'sma',
  ];
  if (phase.renewEvery) {
    leaseArgs.push('--renew-every', String(phase.renewEvery));
  }
  leaseArgs.push('--', ...phase.command);

  const res = spawnSync(process.execPath, leaseArgs, {
    cwd: repoRoot,
    stdio: args.json ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    const err = /** @type {Error & {code?: number}} */ (new Error(`${phase.name} refresh failed with exit ${res.status}`));
    err.code = res.status || 1;
    throw err;
  }
}

function findActiveLease(resourceKind, resource) {
  const leases = readActiveLeases();
  return leases.find((lease) => (
    lease.resource_kind === resourceKind
    && lease.resource_id === resource
  )) || null;
}

function readActiveLeases() {
  if (!existsSync(args.leases)) return [];
  try {
    const parsed = JSON.parse(readFileSync(args.leases, 'utf8'));
    const now = Date.now();
    return (parsed.leases || []).filter((lease) => Date.parse(lease.expires_at) > now);
  } catch {
    return [];
  }
}

function artifactFreshness(artifactPath) {
  if (!existsSync(artifactPath)) return { exists: false, age_seconds: Infinity };
  let timestamp = null;
  try {
    const parsed = JSON.parse(readFileSync(artifactPath, 'utf8'));
    timestamp = parsed.generated_at || parsed.generatedAt || null;
  } catch {
    // HTML dashboard and other non-JSON artifacts fall back to mtime.
  }
  const mtime = statSync(artifactPath).mtimeMs;
  const artifactMs = timestamp ? Date.parse(timestamp) : mtime;
  const effectiveMs = Number.isFinite(artifactMs) ? artifactMs : mtime;
  return {
    exists: true,
    age_seconds: Math.max(0, Math.round((Date.now() - effectiveMs) / 1000)),
  };
}

function printSummary(summary) {
  console.log('SMA portfolio refresh');
  console.log(`generated: ${summary.generated_at}`);
  for (const phase of summary.phases) {
    const bits = [
      phase.phase,
      phase.status,
      phase.artifact,
      phase.age_seconds !== undefined ? `age=${phase.age_seconds}s` : null,
      phase.waited_for_lease ? `coalesced=${phase.waited_for_lease}` : null,
    ].filter(Boolean);
    console.log(`  - ${bits.join(' ')}`);
  }
}

/** @returns {PortfolioRefreshArgs} */
function parseArgs(list) {
  /** @type {PortfolioRefreshArgs} */
  const out = { ...DEFAULTS, projects: [], changedFiles: [] };
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i];
    const next = list[i + 1];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (arg === '--force') { out.force = true; continue; }
    if (arg === '--json') { out.json = true; continue; }
    if (arg === '--no-scan') { out.noScan = true; continue; }
    if (arg === '--no-state') { out.noState = true; continue; }
    if (arg === '--no-dashboard') { out.noDashboard = true; continue; }
    if ((arg === '--project' || arg === '--changed-project') && next) {
      out.projects.push(next);
      i += 1;
      continue;
    }
    if (arg === '--changed-file' && next) {
      out.changedFiles.push(next);
      i += 1;
      continue;
    }
    if (!arg.startsWith('--') || next === undefined || next.startsWith('--')) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      out[key] = next;
      i += 1;
    }
  }
  out.registry = resolve(repoRoot, String(out.registry));
  out.portfolioRegistry = resolve(repoRoot, String(out.portfolioRegistry));
  out.state = resolve(repoRoot, String(out.state));
  out.dashboard = resolve(repoRoot, String(out.dashboard));
  out.leases = resolve(repoRoot, String(out.leases));
  return out;
}

function numberArg(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function relative(targetPath) {
  return targetPath.startsWith(repoRoot) ? targetPath.slice(repoRoot.length + 1) : targetPath;
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function classifyChangedFiles(files) {
  if (!files.length) {
    return {
      requiresScan: true,
      requiresState: false,
      scanFileCount: 0,
      stateOnlyFileCount: 0,
      ignoredFileCount: 0,
      scanFiles: [],
      stateOnlyFiles: [],
    };
  }

  const scanFiles = [];
  const stateOnlyFiles = [];
  const ignoredFiles = [];

  for (const file of files.map(normalizePath)) {
    if (isStateOnlyPath(file)) {
      stateOnlyFiles.push(file);
    } else if (isScanImpactPath(file)) {
      scanFiles.push(file);
    } else {
      ignoredFiles.push(file);
    }
  }

  return {
    requiresScan: scanFiles.length > 0,
    requiresState: stateOnlyFiles.length > 0 || scanFiles.length > 0,
    scanFileCount: scanFiles.length,
    stateOnlyFileCount: stateOnlyFiles.length,
    ignoredFileCount: ignoredFiles.length,
    scanFiles,
    stateOnlyFiles,
  };
}

function isStateOnlyPath(file) {
  return file.startsWith('.smarch/agent-context/')
    || file.startsWith('.smarch/conflicts/')
    || file.startsWith('.smarch/leases/')
    || file === '.smarch/context.ndjson';
}

function isScanImpactPath(file) {
  return file === 'sma.gen3.json'
    || file === 'AGENTS.md'
    || file === 'CLAUDE.md'
    || file === 'agents.md'
    || file === 'package.json'
    || file === 'pnpm-lock.yaml'
    || file === 'package-lock.json'
    || file === 'yarn.lock'
    || file === 'pnpm-workspace.yaml'
    || file === 'electron-builder.json'
    || file.endsWith('.module.sweetspot.json')
    || file.startsWith('.github/workflows/')
    || file.startsWith('docs/compliance/')
    || file.startsWith('scripts/sma-')
    || file.startsWith('scripts/lib/sma-')
    || file.startsWith('scripts/compliance/')
    || file.startsWith('supabase/migrations/')
    || file.startsWith('supabase/functions/');
}

function normalizePath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .trim();
}
