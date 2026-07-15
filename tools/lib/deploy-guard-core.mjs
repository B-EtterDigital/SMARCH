// STF: state=contract tier=T1 observes=tools/sma-deploy-guard.mjs,docs/SMA_DEPLOY_GUARD.md tqs=3
// Pure decision logic for the guarded-deploy engine (no fs/net/git here).
// Doctrine: SMA Gen3 "External Deploy Targets" — a deploy target is a shared
// hot path; last-writer-wins CLI deploys clobbered production twice on
// 2026-07-15 (once concurrent, once SEQUENTIAL from an unintegrated tree).
// The guard therefore REFUSES instead of trusting agents:
//   R1 not-canonical-tree  deploys run only from the declared canonical root
//   R2 dirty-tree          only clean committed trees ship (stamp = commit)
//   R3 unpushed            HEAD must exist on the upstream (no local-only prod)
//   R4 live-not-ancestor   fast-forward only: live stamp's commit must be an
//                          ancestor of HEAD ("integrate first") — this is the
//                          rule that stops sequential clobbers
//   R5 live-unreachable    cannot prove R4 → refuse (bootstrap 404 is fine)
// plus an atomic deploy lock and post-deploy stamp verification in the CLI.

export const GUARD_VERSION = '1.0.0';

export const REFUSALS = {
  NOT_CANONICAL: 'not-canonical-tree',
  DIRTY: 'dirty-tree',
  NO_UPSTREAM: 'no-upstream',
  UNPUSHED: 'unpushed',
  LIVE_UNREACHABLE: 'live-unreachable',
  LIVE_NOT_ANCESTOR: 'live-not-ancestor',
};

export function validateDeployConfig(cfg) {
  const fail = (msg) => { throw new Error(`sma.deploy.json: ${msg}`); };
  if (!cfg || typeof cfg !== 'object') fail('not an object');
  for (const key of ['project', 'canonicalRoot', 'deploy', 'stampPath', 'liveStampUrl']) {
    if (typeof cfg[key] !== 'string' || !cfg[key].trim()) fail(`"${key}" (string) is required`);
  }
  if (!cfg.canonicalRoot.startsWith('/')) fail('"canonicalRoot" must be an ABSOLUTE path — that is what catches snapshot/copy deploys');
  if (!/^https?:\/\//.test(cfg.liveStampUrl)) fail('"liveStampUrl" must be an http(s) URL');
  if (cfg.build !== undefined && typeof cfg.build !== 'string') fail('"build" must be a string command');
  const verify = cfg.verify ?? {};
  if (verify.attempts !== undefined && (!Number.isInteger(verify.attempts) || verify.attempts < 1)) fail('"verify.attempts" must be a positive integer');
  if (verify.delaySeconds !== undefined && !(verify.delaySeconds >= 0)) fail('"verify.delaySeconds" must be >= 0');
  return {
    build: null,
    requirePushed: true,
    ...cfg,
    verify: { attempts: 12, delaySeconds: 5, ...verify },
    lock: { ttlSeconds: 1800, ...(cfg.lock ?? {}) },
  };
}

// facts: gathered by the CLI —
//   cwdRoot            git toplevel of the invoking directory (resolved)
//   dirtyCount         number of dirty/untracked paths
//   head, branch       current commit + branch
//   upstream           { exists: bool, ahead: n } for HEAD@{u}
//   live               { status: 'ok'|'missing'|'unreachable', stamp?, error? }
//   liveCommitKnown    live stamp's commit exists in this repo
//   liveIsAncestor     live stamp's commit is an ancestor of HEAD
// options: { force?: string, allowUnverifiedLive?: bool }
export function evaluatePreconditions({ config, facts, options = {} }) {
  const refusals = [];
  const warnings = [];
  const overrides = [];
  const refuse = (code, detail, remedy) => refusals.push({ code, detail, remedy });

  if (facts.cwdRoot !== config.canonicalRoot) {
    refuse(REFUSALS.NOT_CANONICAL,
      `running from ${facts.cwdRoot}, but the canonical tree is ${config.canonicalRoot}`,
      'work in and deploy from the canonical tree — snapshots/copies go stale and clobber other lanes');
  }
  if (facts.dirtyCount > 0) {
    refuse(REFUSALS.DIRTY,
      `${facts.dirtyCount} dirty/untracked path(s) — a dirty deploy creates production state that exists in no tree`,
      'commit (or drop) everything first; the stamp must record the exact commit that is live');
  }
  if (config.requirePushed) {
    if (!facts.upstream.exists) {
      refuse(REFUSALS.NO_UPSTREAM, 'HEAD has no upstream branch', 'push the branch (git push -u) so other lanes can integrate what production runs');
    } else if (facts.upstream.ahead > 0) {
      refuse(REFUSALS.UNPUSHED, `HEAD is ${facts.upstream.ahead} commit(s) ahead of upstream`, 'push first — production must never run commits other lanes cannot fetch');
    }
  }

  if (facts.live.status === 'unreachable') {
    if (options.allowUnverifiedLive) {
      warnings.push(`live stamp unreachable (${facts.live.error}) — proceeding on --allow-unverified-live`);
      overrides.push({ kind: 'unverified-live', detail: String(facts.live.error) });
    } else {
      refuse(REFUSALS.LIVE_UNREACHABLE,
        `cannot fetch ${config.liveStampUrl} (${facts.live.error}) — the fast-forward check cannot run`,
        'fix connectivity or pass --allow-unverified-live (recorded in the stamp) if the target is knowingly down');
    }
  } else if (facts.live.status === 'missing') {
    warnings.push('no live stamp yet (bootstrap deploy) — fast-forward check skipped');
  } else if (facts.live.stamp?.commit) {
    if (!facts.liveCommitKnown) {
      forceOrRefuse(`production is serving commit ${facts.live.stamp.commit} which this repo does not contain (deployed by ${facts.live.stamp.deployer ?? 'unknown'})`,
        'git fetch + integrate that work first — deploying now would destroy it');
    } else if (!facts.liveIsAncestor) {
      forceOrRefuse(`production commit ${facts.live.stamp.commit} is NOT an ancestor of HEAD ${facts.head} — your tree lacks work that is live`,
        'integrate first (merge/rebase the live commit), then deploy; use --force "<reason>" ONLY for a human-confirmed rollback');
    }
  } else {
    warnings.push('live stamp has no commit field (pre-guard deploy) — fast-forward check skipped');
  }

  function forceOrRefuse(detail, remedy) {
    if (options.force) {
      warnings.push(`OVERRIDE (--force): ${detail}`);
      overrides.push({ kind: 'force', reason: options.force, detail });
    } else {
      refuse(REFUSALS.LIVE_NOT_ANCESTOR, detail, remedy);
    }
  }

  return { ok: refusals.length === 0, refusals, warnings, overrides };
}

export function buildStamp({ config, facts, why, overrides, id, now, deployer }) {
  return {
    id,
    project: config.project,
    commit: facts.head,
    branch: facts.branch,
    tree: config.canonicalRoot,
    deployer,
    when: now,
    why,
    guardVersion: GUARD_VERSION,
    ...(overrides.length ? { overrides } : {}),
  };
}
