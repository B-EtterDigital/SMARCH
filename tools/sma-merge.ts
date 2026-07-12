#!/usr/bin/env node
/**
 * WHAT: Proposes and records resolutions for divergent agent-context edit chains.
 * WHY: Concurrent verified work can overlap and needs an explicit, reviewable merge decision.
 * HOW: Groups context chains, detects file overlap, recommends order, and persists proposals.
 * INPUTS: A propose, list, show, or resolve command with project and brick identities.
 * OUTPUTS: Merge proposals, proposal listings, or recorded resolution events.
 * CALLERS: Controllers reconciling parallel work before integration.
 * Usage: `node tools/sma-merge.ts --help`
 */
/**
 * sma-merge.ts — generate merge proposals from divergent agent-context chains.
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

import { PROJECTS_ROOT } from "./lib/sma-paths.ts";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { randomBytes } from 'node:crypto';
import { buildMergeWhyProposal, renderMergeWhyMarkdown, runMergeWhySelftest, type MergeWhyEvent } from './lib/merge-why.ts';


const SCHEMA_VERSION = '1.0.0';

interface MergeArgs {
  project: string;
  brick: string;
  since: string;
  proposal: string;
  kind: string;
  notes: string;
  by: string;
  write: boolean;
  json: boolean;
  unresolved: boolean;
  fromIntents: boolean;
}
interface MergeEvent extends MergeWhyEvent {
  event_id?: string;
  session_id?: string;
  agent_id?: string;
  actor_id?: string;
  actor_kind?: string;
  model?: string;
  intent?: string;
  files_touched?: string[];
  lease_id?: string;
  verification?: { status?: string };
}
interface MergeChain {
  session_id?: string;
  agent_id?: string;
  actor_kind?: string;
  model?: string;
  started_at: string;
  ended_at: string;
  events: MergeEvent[];
}
type MergeProposal = ReturnType<typeof buildProposal> & {
  resolved_at?: string; resolved_by?: string; resolution_kind?: string; resolution_notes?: string;
};

const RESOLUTION_KINDS = new Set([
  'accepted_a',
  'accepted_b',
  'manual_merge',
  'discarded_a',
  'discarded_b',
  'fork',
]);

const cmd = argv.at(2);
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
    case '--selftest':
      runMergeWhySelftest();
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
  console.error(`sma-merge: ${err instanceof Error ? err.message : String(err)}`);
  exit(1);
}

function usage() {
  console.log(`Usage:
  sma-merge.ts propose  --project <id> --brick <id> [--since <iso>] [--from-intents] [--write] [--json]
  sma-merge.ts list     --project <id> [--unresolved] [--json]
  sma-merge.ts show     --project <id> --proposal <id> [--json]
  sma-merge.ts resolve  --project <id> --proposal <id> --kind <kind> [--notes "..."] [--by <id>]

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
    const msg = `no divergence: only ${String(chains.length)} chain(s) for ${args.brick}`;
    if (args.json) console.log(JSON.stringify({ status: 'no_divergence', chains: chains.length }));
    else console.log(msg);
    exit(0);
  }

  const [chainA, chainB] = chains.slice().sort((a, b) => b.events.length - a.events.length).slice(0, 2);
  if (args.fromIntents) {
    const proposalId = `mp-${args.brick.replace(/[^a-z0-9_-]/gi, '_')}-${String(Date.now())}-${randomBytes(3).toString('hex')}`;
    const proposal = buildMergeWhyProposal({
      schemaVersion: SCHEMA_VERSION, proposalId, project: args.project, brickId: args.brick, generatedAt: nowIso(),
      sides: [toMergeWhySide('A', chainA), toMergeWhySide('B', chainB)],
    });
    const markdown = renderMergeWhyMarkdown(proposal);
    if (args.write) persistIntentSynthesis(args.project, proposalId, markdown);
    console.log(args.json ? JSON.stringify(proposal, null, 2) : markdown.trimEnd());
    if (args.write && !args.json) console.log(`\nwritten → .smarch/merge-proposals/${proposalId}.why.md`);
    return;
  }

  const overlap = detectFileOverlap(chains);
  if (!overlap.hasOverlap) {
    const msg = `${String(chains.length)} chains found but no file overlap; not a divergence`;
    if (args.json) console.log(JSON.stringify({ status: 'no_overlap', chains: chains.length }));
    else console.log(msg);
    exit(0);
  }

  // Reduce to the two most active chains for the proposal. Multi-way merges
  // are still proposed pairwise; we always emit a 2-chain proposal.
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

function toMergeWhySide(label: 'A' | 'B', chain: MergeChain) {
  return { label, chain_id: `chain-${label}-${chain.session_id ?? chain.agent_id ?? 'unknown'}`, ...chain };
}

function persistIntentSynthesis(projectId: string, proposalId: string, markdown: string) {
  const dir = resolve(projectRoot(projectId), '.smarch/merge-proposals');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${proposalId}.why.md`);
  writeFileSync(`${path}.tmp`, markdown);
  renameSync(`${path}.tmp`, path);
}

function buildProposal(chainA: MergeChain, chainB: MergeChain, _overlap: { hasOverlap: boolean; file?: string }) {
  const proposalId = `mp-${args.brick.replace(/[^a-z0-9_-]/gi, '_')}-${String(Date.now())}-${randomBytes(3).toString('hex')}`;
  const filesA = new Set(chainA.events.flatMap((e) => e.files_touched ?? []));
  const filesB = new Set(chainB.events.flatMap((e) => e.files_touched ?? []));
  const files: { path: string; status: string }[] = [];
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

function serializeChain(label: string, chain: MergeChain) {
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

function recommend(chainA: MergeChain, chainB: MergeChain) {
  const verifiedA = countVerified(chainA);
  const verifiedB = countVerified(chainB);
  if (verifiedA > verifiedB) {
    return { preferred_chain: `chain-A-${String(chainA.session_id ?? chainA.agent_id)}`, reason: `chain A has ${String(verifiedA)} pass verifications vs ${String(verifiedB)}` };
  }
  if (verifiedB > verifiedA) {
    return { preferred_chain: `chain-B-${String(chainB.session_id ?? chainB.agent_id)}`, reason: `chain B has ${String(verifiedB)} pass verifications vs ${String(verifiedA)}` };
  }
  // Fall back to recency
  if (Date.parse(chainA.ended_at) > Date.parse(chainB.ended_at)) {
    return { preferred_chain: `chain-A-${String(chainA.session_id ?? chainA.agent_id)}`, reason: 'most recent activity' };
  }
  if (Date.parse(chainB.ended_at) > Date.parse(chainA.ended_at)) {
    return { preferred_chain: `chain-B-${String(chainB.session_id ?? chainB.agent_id)}`, reason: 'most recent activity' };
  }
  return { preferred_chain: 'manual', reason: 'no clear signal — both chains equal on verification and recency' };
}

function countVerified(chain: MergeChain) {
  return chain.events.filter((event) => event.verification?.status === 'pass').length;
}

function groupIntoChains(events: MergeEvent[]) {
  // Bucket by session_id; if missing, by agent_id; if missing, fold into a synthetic 'unknown'.
  const buckets = new Map<string, MergeEvent[]>();
  for (const e of events) {
    const key = e.session_id ?? e.actor_id ?? e.agent_id ?? 'unknown';
    const bucket = buckets.get(key);
    if (bucket) bucket.push(e);
    else buckets.set(key, [e]);
  }
  const chains: MergeChain[] = [];
  for (const [, evs] of buckets) {
    evs.sort((a: { timestamp: string; }, b: { timestamp: string; }) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const head = evs[0];
    chains.push({
      session_id: head.session_id,
      agent_id: head.actor_id ?? head.agent_id,
      actor_kind: head.actor_kind,
      model: head.model,
      started_at: head.timestamp,
      ended_at: evs[evs.length - 1].timestamp,
      events: evs,
    });
  }
  return chains;
}

function detectFileOverlap(chains: MergeChain[]) {
  const sets = chains.map((c) => new Set(c.events.flatMap((e) => e.files_touched ?? [])));
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      for (const f of sets[i]) if (sets[j].has(f)) return { hasOverlap: true, file: f };
    }
  }
  return { hasOverlap: false };
}

function persistProposal(projectId: string, proposal: ReturnType<typeof buildProposal>) {
  const dir = resolve(projectRoot(projectId), '.smarch/merge-proposals');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${proposal.proposal_id}.json`);
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(proposal, null, 2) + '\n');
  renameSync(tmp, path);
}

function printProposal(p: ReturnType<typeof buildProposal>) {
  console.log(`proposal: ${p.proposal_id}`);
  console.log(`brick:    ${p.brick_id}`);
  console.log(`recommendation: ${p.recommendation.preferred_chain} — ${p.recommendation.reason}`);
  for (const c of p.chains) {
    console.log(`\n--- ${c.chain_id} ---`);
    console.log(`agent:   ${String(c.agent_id)}`);
    if (c.session_id) console.log(`session: ${c.session_id}`);
    if (c.model) console.log(`model:   ${c.model}`);
    console.log(`window:  ${c.started_at} → ${c.ended_at}`);
    console.log(`intents:`);
    for (const i of c.intents) console.log(`  · ${String(i)}`);
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
  const files = readdirSync(dir).filter((f: string) => f.endsWith('.json'));
  const rows: MergeProposal[] = [];
  for (const f of files) {
    try {
      const p = readProposal(resolve(dir, f));
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
    const status = p.resolved_at ? `resolved:${String(p.resolution_kind)}` : 'open';
    console.log(`${pad(p.proposal_id, 50)} ${pad(p.brick_id, 50)} ${pad(status, 12)} ${p.recommendation.preferred_chain}`);
  }
}

function runShow() {
  requireArg('project', '--project');
  requireArg('proposal', '--proposal');
  const path = resolve(projectRoot(args.project), '.smarch/merge-proposals', `${args.proposal}.json`);
  if (!existsSync(path)) throw new Error(`proposal not found: ${args.proposal}`);
  const p = readProposal(path);
  if (args.json) {
    console.log(JSON.stringify(p, null, 2));
    return;
  }
  printProposal(p);
  if (p.resolved_at) {
    console.log(`\nresolved: ${String(p.resolution_kind)} at ${p.resolved_at} by ${String(p.resolved_by)}`);
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
  const p = readProposal(path);
  p.resolved_at = nowIso();
  p.resolved_by = args.by;
  p.resolution_kind = args.kind;
  if (args.notes) p.resolution_notes = args.notes;
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(p, null, 2) + '\n');
  renameSync(tmp, path);
  console.log(`resolved ${p.proposal_id} as ${p.resolution_kind}`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function projectRoot(projectId: string) {
  if (existsSync(resolve(PROJECTS_ROOT, projectId))) return resolve(PROJECTS_ROOT, projectId);
  for (const ent of readdirSync(PROJECTS_ROOT)) {
    if (ent.toLowerCase().includes(projectId.toLowerCase())) {
      return resolve(PROJECTS_ROOT, ent);
    }
  }
  throw new Error(`project not found: ${projectId}`);
}

function readContextLog(projectId: string, brickId: string): MergeEvent[] {
  const safe = brickId.replace(/[^a-z0-9._-]/gi, '_');
  const path = resolve(projectRoot(projectId), '.smarch/agent-context', `${safe}.ndjson`);
  if (!existsSync(path)) return [];
  const out: MergeEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed: unknown = JSON.parse(t);
      if (isMergeEvent(parsed)) out.push(parsed);
    } catch { /* skip */ }
  }
  return out;
}

function readProposal(filePath: string): MergeProposal {
  const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
  if (!isRecord(parsed) || typeof parsed.proposal_id !== 'string' || typeof parsed.brick_id !== 'string'
    || !Array.isArray(parsed.chains) || !Array.isArray(parsed.files) || !isRecord(parsed.recommendation)) {
    throw new Error(`invalid merge proposal: ${filePath}`);
  }
  return parsed as MergeProposal;
}

function isMergeEvent(value: unknown): value is MergeEvent {
  return isRecord(value) && typeof value.timestamp === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nowIso() {
  return new Date().toISOString();
}

function requireArg(key: keyof MergeArgs, flag: string) {
  if (args[key] === '') {
    throw new Error(`missing ${flag}`);
  }
}

function pad(s: string, n: number) {
  return s.slice(0, n).padEnd(n);
}

// eslint-disable-next-line complexity -- The flat flag parser keeps supported booleans and value options auditable in one pass.
function parseArgs(list: string[]): MergeArgs {
  const out: MergeArgs = {
    project: '', brick: '', since: '', proposal: '', kind: '', notes: '', by: '',
    write: false, json: false, unresolved: false, fromIntents: false,
  };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const camel = key.replace(/-([a-z])/g, (_match: string, character: string) => character.toUpperCase());
    const next = list.at(i + 1);
    const isBool = next === undefined || next.startsWith('--');
    if (isBool) {
      if (camel === 'write' || camel === 'json' || camel === 'unresolved' || camel === 'fromIntents') out[camel] = true;
      continue;
    }
    if (camel === 'project' || camel === 'brick' || camel === 'since' || camel === 'proposal'
      || camel === 'kind' || camel === 'notes' || camel === 'by') out[camel] = next;
    i += 1;
  }
  return out;
}
