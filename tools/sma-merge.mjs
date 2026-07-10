#!/usr/bin/env node
/**
 * sma-merge.mjs — generate merge proposals from divergent agent-context chains.
 *
 * Path:    <project>/.smarch/merge-proposals/<brick-id>-<unix-ms>.json
 * Schema:  schemas/merge-proposal.schema.json
 *
 * Why this exists:
 *   When two agents work on the same brick (lease lapsed, manual override, push
 *   from a different machine), git-level conflict resolution loses the *intent*
 *   that drove each set of edits. This tool groups agent-context events by
 *   session_id, detects file-level overlap between sessions, and writes a
 *   proposal that surfaces both intent chains side by side. Humans (or an
 *   orchestrator agent) decide.
 *
 * Subcommands:
 *   propose   --project <id> --brick <id> [--since <iso>] [--write] [--json]
 *               → analyze events, detect divergent chains. With --write,
 *                 persist a proposal under .smarch/merge-proposals/.
 *
 *   list      --project <id> [--unresolved] [--json]
 *
 *   show      --project <id> --proposal <id> [--json]
 *
 *   resolve   --project <id> --proposal <id>
 *             --kind accepted_a|accepted_b|manual_merge|discarded_a|discarded_b|fork
 *             [--notes "..."] [--by <id>]
 */

import { PROJECTS_ROOT } from "./lib/sma-paths.mjs";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { argv, exit, env } from 'node:process';
import { randomBytes } from 'node:crypto';


const SCHEMA_VERSION = '1.0.0';

const RESOLUTION_KINDS = new Set([
  'accepted_a',
  'accepted_b',
  'manual_merge',
  'discarded_a',
  'discarded_b',
  'fork',
]);

const cmd = argv[2];
const args = parseArgs(argv.slice(3));

try {
  switch (cmd) {
    case 'propose':
      runPropose();
      break;
    case 'list':
      runList();
      break;
    case 'show':
      runShow();
      break;
    case 'resolve':
      runResolve();
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
  console.error(`sma-merge: ${err.message}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-merge.mjs propose  --project <id> --brick <id> [--since <iso>] [--write] [--json]
  sma-merge.mjs list     --project <id> [--unresolved] [--json]
  sma-merge.mjs show     --project <id> --proposal <id> [--json]
  sma-merge.mjs resolve  --project <id> --proposal <id> --kind <kind> [--notes "..."] [--by <id>]

Resolution kinds: ${[...RESOLUTION_KINDS].join(', ')}
`);
}

// ── propose ──────────────────────────────────────────────────────────────────

function runPropose() {
  requireArg('project', '--project');
  requireArg('brick', '--brick');

  const events = readContextLog(args.project, args.brick);
  const since = args.since ? Date.parse(args.since) : 0;
  const filtered = events.filter((e) => Date.parse(e.timestamp) >= since);

  const chains = groupIntoChains(filtered);

  if (chains.length < 2) {
    const msg = `no divergence: only ${chains.length} chain(s) for ${args.brick}`;
    if (args.json) console.log(JSON.stringify({ status: 'no_divergence', chains: chains.length }));
    else console.log(msg);
    exit(0);
  }

  const overlap = detectFileOverlap(chains);
  if (!overlap.hasOverlap) {
    const msg = `${chains.length} chains found but no file overlap; not a divergence`;
    if (args.json) console.log(JSON.stringify({ status: 'no_overlap', chains: chains.length }));
    else console.log(msg);
    exit(0);
  }

  // Reduce to the two most active chains for the proposal. Multi-way merges
  // are still proposed pairwise; we always emit a 2-chain proposal.
  const [chainA, chainB] = chains.slice().sort((a, b) => b.events.length - a.events.length).slice(0, 2);
  const proposal = buildProposal(chainA, chainB, overlap);

  if (args.write) {
    persistProposal(args.project, proposal);
  }

  if (args.json) {
    console.log(JSON.stringify(proposal, null, 2));
  } else {
    printProposal(proposal);
    if (args.write) console.log(`written → .smarch/merge-proposals/${proposal.proposal_id}.json`);
  }
}

function buildProposal(chainA, chainB, overlap) {
  const proposalId = `mp-${args.brick.replace(/[^a-z0-9_-]/gi, '_')}-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const filesA = new Set(chainA.events.flatMap((e) => e.files_touched ?? []));
  const filesB = new Set(chainB.events.flatMap((e) => e.files_touched ?? []));
  const files = [];
  for (const f of new Set([...filesA, ...filesB])) {
    const inA = filesA.has(f);
    const inB = filesB.has(f);
    files.push({
      path: f,
      status: inA && inB ? 'diverged' : inA ? 'only_in_chain_a' : 'only_in_chain_b',
    });
  }

  const recommendation = recommend(chainA, chainB);

  return {
    schema_version: SCHEMA_VERSION,
    proposal_id: proposalId,
    brick_id: args.brick,
    project: args.project,
    generated_at: nowIso(),
    chains: [serializeChain('A', chainA), serializeChain('B', chainB)],
    files,
    recommendation,
  };
}

function serializeChain(label, chain) {
  return {
    chain_id: `chain-${label}-${chain.session_id ?? chain.agent_id ?? 'unknown'}`,
    agent_id: chain.agent_id,
    session_id: chain.session_id,
    actor_kind: chain.actor_kind,
    model: chain.model,
    started_at: chain.started_at,
    ended_at: chain.ended_at,
    intents: [...new Set(chain.events.map((e) => e.intent).filter(Boolean))],
    events: chain.events.map((e) => e.event_id),
    files_touched: [...new Set(chain.events.flatMap((e) => e.files_touched ?? []))],
    lease_ids: [...new Set(chain.events.map((e) => e.lease_id).filter(Boolean))],
  };
}

function recommend(chainA, chainB) {
  const verifiedA = countVerified(chainA);
  const verifiedB = countVerified(chainB);
  if (verifiedA > verifiedB) {
    return { preferred_chain: `chain-A-${chainA.session_id ?? chainA.agent_id}`, reason: `chain A has ${verifiedA} pass verifications vs ${verifiedB}` };
  }
  if (verifiedB > verifiedA) {
    return { preferred_chain: `chain-B-${chainB.session_id ?? chainB.agent_id}`, reason: `chain B has ${verifiedB} pass verifications vs ${verifiedA}` };
  }
  // Fall back to recency
  if (Date.parse(chainA.ended_at) > Date.parse(chainB.ended_at)) {
    return { preferred_chain: `chain-A-${chainA.session_id ?? chainA.agent_id}`, reason: 'most recent activity' };
  }
  if (Date.parse(chainB.ended_at) > Date.parse(chainA.ended_at)) {
    return { preferred_chain: `chain-B-${chainB.session_id ?? chainB.agent_id}`, reason: 'most recent activity' };
  }
  return { preferred_chain: 'manual', reason: 'no clear signal — both chains equal on verification and recency' };
}

function countVerified(chain) {
  return chain.events.filter((e) => e.verification && e.verification.status === 'pass').length;
}

function groupIntoChains(events) {
  // Bucket by session_id; if missing, by agent_id; if missing, fold into a synthetic 'unknown'.
  const buckets = new Map();
  for (const e of events) {
    const key = e.session_id || e.agent_id || 'unknown';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  }
  const chains = [];
  for (const [, evs] of buckets) {
    evs.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const head = evs[0];
    chains.push({
      session_id: head.session_id,
      agent_id: head.actor_id,
      actor_kind: head.actor_kind,
      model: head.model,
      started_at: head.timestamp,
      ended_at: evs[evs.length - 1].timestamp,
      events: evs,
    });
  }
  return chains;
}

function detectFileOverlap(chains) {
  const sets = chains.map((c) => new Set(c.events.flatMap((e) => e.files_touched ?? [])));
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      for (const f of sets[i]) if (sets[j].has(f)) return { hasOverlap: true, file: f };
    }
  }
  return { hasOverlap: false };
}

function persistProposal(projectId, proposal) {
  const dir = resolve(projectRoot(projectId), '.smarch/merge-proposals');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${proposal.proposal_id}.json`);
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(proposal, null, 2) + '\n');
  renameSync(tmp, path);
}

function printProposal(p) {
  console.log(`proposal: ${p.proposal_id}`);
  console.log(`brick:    ${p.brick_id}`);
  console.log(`recommendation: ${p.recommendation.preferred_chain} — ${p.recommendation.reason}`);
  for (const c of p.chains) {
    console.log(`\n--- ${c.chain_id} ---`);
    console.log(`agent:   ${c.agent_id}`);
    if (c.session_id) console.log(`session: ${c.session_id}`);
    if (c.model) console.log(`model:   ${c.model}`);
    console.log(`window:  ${c.started_at} → ${c.ended_at}`);
    console.log(`intents:`);
    for (const i of c.intents) console.log(`  · ${i}`);
    if (c.files_touched.length) console.log(`files:   ${c.files_touched.join(', ')}`);
  }
  console.log(`\nfile divergence:`);
  for (const f of p.files) console.log(`  [${f.status}] ${f.path}`);
}

// ── list / show / resolve ────────────────────────────────────────────────────

function runList() {
  requireArg('project', '--project');
  const dir = resolve(projectRoot(args.project), '.smarch/merge-proposals');
  if (!existsSync(dir)) {
    console.log('(no merge proposals)');
    return;
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const rows = [];
  for (const f of files) {
    try {
      const p = JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
      if (args.unresolved && p.resolved_at) continue;
      rows.push(p);
    } catch { /* skip malformed */ }
  }
  if (args.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    console.log('(no proposals match)');
    return;
  }
  console.log(`${pad('proposal_id', 50)} ${pad('brick', 50)} ${pad('status', 12)} preferred`);
  console.log('-'.repeat(140));
  for (const p of rows) {
    const status = p.resolved_at ? `resolved:${p.resolution_kind}` : 'open';
    console.log(`${pad(p.proposal_id, 50)} ${pad(p.brick_id, 50)} ${pad(status, 12)} ${p.recommendation?.preferred_chain ?? ''}`);
  }
}

function runShow() {
  requireArg('project', '--project');
  requireArg('proposal', '--proposal');
  const path = resolve(projectRoot(args.project), '.smarch/merge-proposals', `${args.proposal}.json`);
  if (!existsSync(path)) throw new Error(`proposal not found: ${args.proposal}`);
  const p = JSON.parse(readFileSync(path, 'utf8'));
  if (args.json) {
    console.log(JSON.stringify(p, null, 2));
    return;
  }
  printProposal(p);
  if (p.resolved_at) {
    console.log(`\nresolved: ${p.resolution_kind} at ${p.resolved_at} by ${p.resolved_by}`);
    if (p.resolution_notes) console.log(`notes: ${p.resolution_notes}`);
  }
}

function runResolve() {
  requireArg('project', '--project');
  requireArg('proposal', '--proposal');
  requireArg('kind', '--kind');
  if (!RESOLUTION_KINDS.has(args.kind)) throw new Error(`bad --kind: ${args.kind}`);
  const path = resolve(projectRoot(args.project), '.smarch/merge-proposals', `${args.proposal}.json`);
  if (!existsSync(path)) throw new Error(`proposal not found: ${args.proposal}`);
  const p = JSON.parse(readFileSync(path, 'utf8'));
  p.resolved_at = nowIso();
  p.resolved_by = args.by ?? env.SMA_AGENT ?? env.USER ?? 'unknown';
  p.resolution_kind = args.kind;
  if (args.notes) p.resolution_notes = args.notes;
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n');
  renameSync(tmp, path);
  console.log(`resolved ${p.proposal_id} as ${p.resolution_kind}`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function projectRoot(projectId) {
  if (existsSync(resolve(PROJECTS_ROOT, projectId))) return resolve(PROJECTS_ROOT, projectId);
  for (const ent of readdirSync(PROJECTS_ROOT)) {
    if (ent.toLowerCase().includes(projectId.toLowerCase())) {
      return resolve(PROJECTS_ROOT, ent);
    }
  }
  throw new Error(`project not found: ${projectId}`);
}

function readContextLog(projectId, brickId) {
  const safe = brickId.replace(/[^a-z0-9._-]/gi, '_');
  const path = resolve(projectRoot(projectId), '.smarch/agent-context', `${safe}.ndjson`);
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip */ }
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function requireArg(key, flag) {
  if (args[key] === undefined || args[key] === null || args[key] === '') {
    throw new Error(`missing ${flag}`);
  }
}

function pad(s, n) {
  return String(s ?? '').slice(0, n).padEnd(n);
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
