// STF: state=contract tier=T1 observes=tools/lib/deploy-guard-core.mjs,tools/sma-deploy-guard.mjs tqs=4
import assert from 'node:assert/strict';
import test from 'node:test';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REFUSALS, evaluatePreconditions, validateDeployConfig,
} from '../lib/deploy-guard-core.mjs';

const CLI = new URL('../sma-deploy-guard.mjs', import.meta.url).pathname;

const baseFacts = (over = {}) => ({
  cwdRoot: '/repo', dirtyCount: 0, head: 'aaa', branch: 'main',
  upstream: { exists: true, ahead: 0 },
  live: { status: 'ok', stamp: { commit: 'aaa', id: 'x' } },
  liveCommitKnown: true, liveIsAncestor: true,
  ...over,
});
const cfg = validateDeployConfig({
  project: 'demo', canonicalRoot: '/repo', deploy: 'true',
  stampPath: 'public/deploy-stamp.json', liveStampUrl: 'http://x/deploy-stamp.json',
});
const codes = (facts, options) => evaluatePreconditions({ config: cfg, facts, options }).refusals.map((r) => r.code);

test('core: clean canonical fast-forward state passes', () => {
  assert.deepEqual(codes(baseFacts()), []);
});

test('core: each refusal fires on its own violation', () => {
  assert.deepEqual(codes(baseFacts({ cwdRoot: '/tmp/snapshot' })), [REFUSALS.NOT_CANONICAL]);
  assert.deepEqual(codes(baseFacts({ dirtyCount: 3 })), [REFUSALS.DIRTY]);
  assert.deepEqual(codes(baseFacts({ upstream: { exists: false, ahead: 0 } })), [REFUSALS.NO_UPSTREAM]);
  assert.deepEqual(codes(baseFacts({ upstream: { exists: true, ahead: 2 } })), [REFUSALS.UNPUSHED]);
  assert.deepEqual(codes(baseFacts({ live: { status: 'unreachable', error: 'boom' } })), [REFUSALS.LIVE_UNREACHABLE]);
  assert.deepEqual(codes(baseFacts({ liveIsAncestor: false })), [REFUSALS.LIVE_NOT_ANCESTOR]);
  assert.deepEqual(codes(baseFacts({ liveCommitKnown: false, liveIsAncestor: false })), [REFUSALS.LIVE_NOT_ANCESTOR]);
});

test('core: bootstrap (404) passes with warning; force converts non-ancestor to recorded override', () => {
  const boot = evaluatePreconditions({ config: cfg, facts: baseFacts({ live: { status: 'missing' } }) });
  assert.ok(boot.ok && boot.warnings.some((w) => w.includes('bootstrap')));
  const forced = evaluatePreconditions({
    config: cfg, facts: baseFacts({ liveIsAncestor: false }), options: { force: 'rollback bad release' },
  });
  assert.ok(forced.ok);
  assert.equal(forced.overrides[0].kind, 'force');
});

test('core: config validation rejects relative canonicalRoot', () => {
  assert.throws(() => validateDeployConfig({ ...cfg, canonicalRoot: 'repo' }), /ABSOLUTE/);
});

// ---- end-to-end with real git repos + a local stamp host ------------------
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' });
const guard = (cwd, args, env = {}) =>
  spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

test('e2e: bootstrap deploy verifies; snapshot copy and stale sequential deploys are refused', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'deploy-guard-'));
  const servedDir = join(root, 'served');
  mkdirSync(servedDir);
  // The stamp host must live in its own process: spawnSync below blocks this
  // process's event loop, so an in-process server could never answer the CLI.
  const serverScript = join(root, 'stamp-server.mjs');
  writeFileSync(serverScript, `
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.argv[2];
createServer((req, res) => {
  const f = join(dir, 'deploy-stamp.json');
  if (!existsSync(f)) { res.statusCode = 404; res.end(); return; }
  res.setHeader('content-type', 'application/json');
  res.end(readFileSync(f));
}).listen(0, '127.0.0.1', function onUp() { console.log(this.address().port); });
`);
  const serverProc = spawn('node', [serverScript, servedDir], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => serverProc.kill());
  const port = await new Promise((resolvePort, reject) => {
    serverProc.stdout.once('data', (d) => resolvePort(String(d).trim()));
    serverProc.once('exit', () => reject(new Error('stamp server died')));
  });
  const url = `http://127.0.0.1:${port}/deploy-stamp.json`;

  const origin = join(root, 'origin.git');
  sh(`git init --bare -q ${origin}`);
  const canonical = join(root, 'canonical');
  sh(`git clone -q ${origin} ${canonical}`);
  sh('git config user.email t@t && git config user.name t', canonical);
  const config = {
    project: 'demo',
    canonicalRoot: canonical,
    deploy: `cp public/deploy-stamp.json ${servedDir}/deploy-stamp.json`,
    stampPath: 'public/deploy-stamp.json',
    liveStampUrl: url,
    verify: { attempts: 3, delaySeconds: 0.05 },
  };
  writeFileSync(join(canonical, 'sma.deploy.json'), JSON.stringify(config));
  writeFileSync(join(canonical, '.gitignore'), 'public/deploy-stamp.json\n.sma/\n');
  writeFileSync(join(canonical, 'app.txt'), 'v1');
  sh('git checkout -q -B main && git add -A && git commit -qm v1 && git push -qu origin main', canonical);

  const boot = guard(canonical, ['--why', 'bootstrap']);
  assert.equal(boot.status, 0, boot.stderr + boot.stdout);
  assert.match(boot.stdout, /VERIFIED/);

  // stale snapshot copy: same protocol, wrong tree -> refused before any build
  const snapshot = join(root, 'snapshot');
  sh(`cp -r ${canonical} ${snapshot}`);
  writeFileSync(join(canonical, 'app.txt'), 'v2');
  sh('git commit -qam v2 && git push -q', canonical);
  const v2 = guard(canonical, ['--why', 'ship v2']);
  assert.equal(v2.status, 0, v2.stderr);
  const snap = guard(snapshot, ['--why', 'stale lane deploy', '--json']);
  assert.equal(snap.status, 11);
  assert.match(snap.stderr, /not-canonical-tree/);
  assert.match(snap.stderr, /live-not-ancestor/); // prod has v2, snapshot HEAD is v1

  // dirty and unpushed are refused in the canonical tree too
  writeFileSync(join(canonical, 'app.txt'), 'wip');
  assert.match(guard(canonical, ['--why', 'dirty']).stderr, /dirty-tree/);
  sh('git commit -qam v3', canonical);
  assert.match(guard(canonical, ['--why', 'unpushed']).stderr, /unpushed/);
  sh('git push -q', canonical);
  assert.equal(guard(canonical, ['--why', 'ship v3']).status, 0);

  // rollback (prod ahead of HEAD) needs --force AND the env acknowledgement
  sh('git reset -q --hard HEAD~1', canonical);
  const noAck = guard(canonical, ['--why', 'rollback', '--force', 'bad v3']);
  assert.equal(noAck.status, 2);
  const rollback = guard(canonical, ['--why', 'rollback', '--force', 'bad v3'], { SMA_DEPLOY_FORCE_ACK: '1' });
  assert.equal(rollback.status, 0, rollback.stderr + rollback.stdout);
  const liveStamp = JSON.parse(readFileSync(join(servedDir, 'deploy-stamp.json'), 'utf8'));
  assert.equal(liveStamp.overrides[0].reason, 'bad v3');

  // verify failure names the clobbering deploy loudly
  sh('git reset -q --hard origin/main', canonical);
  writeFileSync(join(canonical, 'sma.deploy.json'), JSON.stringify({ ...config, deploy: 'true' }));
  sh('git commit -qam swallow-deploy && git push -q', canonical);
  const swallowed = guard(canonical, ['--why', 'deploy that never lands']);
  assert.equal(swallowed.status, 13);
  assert.match(swallowed.stderr, /VERIFY FAILED/);

  // held lock refuses with exit 12
  mkdirSync(join(canonical, '.sma', 'deploy-lock'), { recursive: true });
  const locked = guard(canonical, ['--why', 'while locked']);
  assert.equal(locked.status, 12);
  assert.match(locked.stderr, /lock held/);
});
