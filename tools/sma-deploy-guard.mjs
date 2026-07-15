// STF: state=contract tier=T1 observes=tools/lib/deploy-guard-core.mjs,docs/SMA_DEPLOY_GUARD.md tqs=4
// Guarded deploy engine — the only sanctioned way to ship to an external
// deploy target in an SMA project. See docs/SMA_DEPLOY_GUARD.md.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  GUARD_VERSION, buildStamp, evaluatePreconditions, validateDeployConfig,
} from './lib/deploy-guard-core.mjs';

const HELP = `sma deploy-guard v${GUARD_VERSION} — serialized, stamped, verified deploys

Usage: node tools/sma-deploy-guard.mjs --why "<what this deploy is>" [options]
  --why "<text>"            required: recorded in the live stamp
  --config <path>           sma.deploy.json (default: search upward from cwd)
  --dry-run                 evaluate all refusals, deploy nothing
  --json                    machine-readable report
  --force "<reason>"        override the fast-forward check (rollbacks only);
                            ALSO requires env SMA_DEPLOY_FORCE_ACK=1
  --allow-unverified-live   proceed when the live stamp cannot be fetched
  --status                  fetch and print the live stamp, then exit
  --help

Refuses (exit 11) unless ALL preconditions hold:
  1. running inside the canonical tree declared in sma.deploy.json
  2. tree is clean (everything committed)
  3. HEAD is pushed to its upstream
  4. the live stamp's commit is an ancestor of HEAD (fast-forward only)
  5. the live stamp is reachable (or bootstrap/override)
Then: atomic lock (exit 12 if held) -> stamp -> build -> deploy -> verify the
live stamp matches (exit 13 if production serves anything else).`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--json') out.json = true;
    else if (a === '--allow-unverified-live') out.allowUnverifiedLive = true;
    else if (a === '--status') out.status = true;
    else if (a === '--help') out.help = true;
    else if (a === '--why') out.why = argv[(i += 1)];
    else if (a === '--config') out.config = argv[(i += 1)];
    else if (a === '--force') out.force = argv[(i += 1)];
    else throw usage(`unknown option: ${a}`);
  }
  return out;
}
const usage = (msg) => Object.assign(new Error(msg), { exitCode: 2 });

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function findConfig(explicit) {
  if (explicit) return resolve(explicit);
  let dir = process.cwd();
  while (true) {
    const candidate = join(dir, 'sma.deploy.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw usage('no sma.deploy.json found from cwd upward (pass --config)');
    dir = parent;
  }
}

async function fetchLive(url, timeoutMs = 10_000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });
    if (res.status === 404) return { status: 'missing' };
    if (!res.ok) return { status: 'unreachable', error: `HTTP ${res.status}` };
    return { status: 'ok', stamp: await res.json() };
  } catch (error) {
    return { status: 'unreachable', error: error.message };
  }
}

function gatherFacts(config, live) {
  const top = git(['rev-parse', '--show-toplevel'], process.cwd());
  if (!top.ok) throw usage('not inside a git repository — the guard only deploys committed trees');
  const cwdRoot = resolve(top.out);
  const dirty = git(['status', '--porcelain'], cwdRoot).out;
  const upstream = git(['rev-parse', '--abbrev-ref', '@{u}'], cwdRoot);
  const ahead = upstream.ok ? Number(git(['rev-list', '--count', '@{u}..HEAD'], cwdRoot).out || '0') : 0;
  const liveCommit = live.stamp?.commit;
  return {
    cwdRoot,
    dirtyCount: dirty ? dirty.split('\n').length : 0,
    head: git(['rev-parse', 'HEAD'], cwdRoot).out,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], cwdRoot).out,
    upstream: { exists: upstream.ok, ahead },
    live,
    liveCommitKnown: liveCommit ? git(['cat-file', '-e', `${liveCommit}^{commit}`], cwdRoot).ok : false,
    liveIsAncestor: liveCommit ? git(['merge-base', '--is-ancestor', liveCommit, 'HEAD'], cwdRoot).ok : false,
  };
}

function acquireLock(config, why) {
  const lockDir = join(config.canonicalRoot, '.sma', 'deploy-lock');
  const meta = join(lockDir, 'meta.json');
  mkdirSync(dirname(lockDir), { recursive: true }); // parent .sma/; the lock itself must be non-recursive to stay atomic
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(lockDir, { recursive: false });
      writeFileSync(meta, JSON.stringify({ pid: process.pid, when: new Date().toISOString(), why }, null, 2));
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch {
      let holder = null;
      try { holder = JSON.parse(readFileSync(meta, 'utf8')); } catch { /* racing or corrupt */ }
      const ageMs = (() => { try { return Date.now() - statSync(lockDir).mtimeMs; } catch { return 0; } })();
      if (ageMs > config.lock.ttlSeconds * 1000) {
        rmSync(lockDir, { recursive: true, force: true });
        continue; // stale lock reaped; retry once
      }
      throw Object.assign(
        new Error(`deploy lock held${holder ? ` by pid ${holder.pid} since ${holder.when} ("${holder.why}")` : ''} — another deploy to this target is in flight`),
        { exitCode: 12 },
      );
    }
  }
  throw Object.assign(new Error('could not acquire deploy lock'), { exitCode: 12 });
}

function run(command, cwd, label) {
  console.log(`[deploy-guard] ${label}: ${command}`);
  const r = spawnSync(command, { cwd, shell: true, stdio: 'inherit' });
  if (r.status !== 0) throw Object.assign(new Error(`${label} failed (exit ${r.status})`), { exitCode: 1 });
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP); return 0; }
  const configPath = findConfig(options.config);
  const config = validateDeployConfig(JSON.parse(readFileSync(configPath, 'utf8')));

  const live = await fetchLive(config.liveStampUrl);
  if (options.status) {
    console.log(JSON.stringify(live, null, 2));
    return live.status === 'ok' ? 0 : 1;
  }
  if (!options.why && !options.dryRun) throw usage('--why "<what this deploy is>" is required');
  if (options.force && process.env.SMA_DEPLOY_FORCE_ACK !== '1') {
    throw usage('--force is a human-confirmed rollback: set SMA_DEPLOY_FORCE_ACK=1 to acknowledge');
  }

  const facts = gatherFacts(config, live);
  const verdict = evaluatePreconditions({ config, facts, options });
  for (const w of verdict.warnings) console.log(`[deploy-guard] WARN ${w}`);
  if (!verdict.ok) {
    for (const r of verdict.refusals) console.error(`[deploy-guard] REFUSED ${r.code}: ${r.detail}\n  -> ${r.remedy}`);
    if (options.json) console.log(JSON.stringify({ ok: false, ...verdict, facts: { ...facts, live: live.status } }, null, 2));
    return 11;
  }
  if (options.dryRun) {
    console.log('[deploy-guard] dry-run: all preconditions PASS — a real deploy would proceed');
    if (options.json) console.log(JSON.stringify({ ok: true, ...verdict }, null, 2));
    return 0;
  }

  const release = acquireLock(config, options.why);
  try {
    // A racing deploy may have shipped while we evaluated; re-check under the lock.
    const liveNow = await fetchLive(config.liveStampUrl);
    const factsNow = gatherFacts(config, liveNow);
    const verdictNow = evaluatePreconditions({ config, facts: factsNow, options });
    if (!verdictNow.ok) {
      for (const r of verdictNow.refusals) console.error(`[deploy-guard] REFUSED (post-lock) ${r.code}: ${r.detail}`);
      return 11;
    }
    const stamp = buildStamp({
      config,
      facts: factsNow,
      why: options.why,
      overrides: verdictNow.overrides,
      id: randomUUID().slice(0, 13),
      now: new Date().toISOString(),
      deployer: `${userInfo().username}@${hostname()}`,
    });
    const stampAbs = join(config.canonicalRoot, config.stampPath);
    mkdirSync(dirname(stampAbs), { recursive: true });
    writeFileSync(stampAbs, `${JSON.stringify(stamp, null, 2)}\n`);
    console.log(`[deploy-guard] stamp ${stamp.id} (commit ${stamp.commit.slice(0, 10)}) -> ${config.stampPath}`);

    if (config.build) run(config.build, config.canonicalRoot, 'build');
    run(config.deploy, config.canonicalRoot, 'deploy');

    const { attempts, delaySeconds } = config.verify;
    for (let i = 1; i <= attempts; i += 1) {
      const check = await fetchLive(config.liveStampUrl);
      if (check.status === 'ok' && check.stamp?.id === stamp.id) {
        console.log(`[deploy-guard] VERIFIED — production serves stamp ${stamp.id}`);
        if (options.json) console.log(JSON.stringify({ ok: true, stamp }, null, 2));
        return 0;
      }
      if (i < attempts) await sleep(delaySeconds * 1000);
      else {
        const liveId = check.stamp?.id ?? check.status;
        console.error(`[deploy-guard] VERIFY FAILED — expected stamp ${stamp.id}, production serves ${liveId}` +
          (check.stamp?.deployer ? ` (deployed by ${check.stamp.deployer}: "${check.stamp.why ?? ''}")` : ''));
        return 13;
      }
    }
    return 13;
  } finally {
    release();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`[deploy-guard] ${error.message}`);
    process.exit(error.exitCode ?? 1);
  },
);
