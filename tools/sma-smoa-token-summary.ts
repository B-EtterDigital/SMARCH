#!/usr/bin/env node
/**
 * WHAT: Produces the required per-agent token and cost summary for a multi-agent run.
 * WHY: Delivery accounting must come from primary logs and must never guess missing prices.
 * HOW: Reads Claude and Codex session logs plus the pinned model-price file.
 * OUTPUTS: Prints a table or structured data with costs, percentages, and savings baselines.
 * CALLERS: [SMOA](../docs/GLOSSARY.md) orchestrators run it before final delivery.
 * USAGE: `node tools/sma-smoa-token-summary.ts --window-days 7 --json`
 * Glossary: [API](../docs/GLOSSARY.md).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

type TokenSum = { input: number; cacheWrite: number; cacheRead: number; output: number; calls: number };
type CodexSum = { model: string; input: number; cached: number; output: number; id: string };
type Price = Record<string, number> & { key?: string };

const args = process.argv.slice(2);
const opt = (name: string, dflt: any): any => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const has = (name: string): boolean => args.includes(`--${name}`);

const WINDOW_DAYS = Number(opt('window-days', '7'));
const NOW = Date.now();
const WINDOW_START = NOW - WINDOW_DAYS * 864e5;
const CODEX_SINCE = Date.parse(opt('codex-since', new Date(NOW - 864e5).toISOString()));
const CLAUDE_SESSION = opt('claude-session', null);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRICES_PATH = path.join(HERE, '..', 'skills', 'sweetspot-moa', 'model-prices.json');
const PRICES: any = JSON.parse(fs.readFileSync(PRICES_PATH, 'utf8'));

function priceFor(model: string): Price | null {
  if (!model) return null;
  const keys = Object.keys(PRICES.perMTok).sort((a, b) => b.length - a.length);
  const hit = keys.find((k) => model.startsWith(k) || model.includes(k));
  return hit ? { key: hit, ...PRICES.perMTok[hit] } : null;
}

// ---- Claude Code logs -------------------------------------------------
// One line per event; assistant messages carry message.model + message.usage.
// Multi-block messages repeat the same usage -> dedupe on requestId/message.id.
async function scanClaudeFile(file: string, onMsg: (message: any) => void): Promise<void> {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  const seen = new Set();
  for await (const line of rl) {
    if (!line.includes('"usage"')) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    const u = obj?.message?.usage;
    if (!u || typeof u.output_tokens !== 'number') continue;
    const key = obj.requestId || obj.message.id || `${file}:${obj.timestamp}`;
    if (seen.has(key)) continue;
    seen.add(key);
    onMsg({
      ts: Date.parse(obj.timestamp || 0),
      model: obj.message.model || 'unknown',
      input: u.input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      output: u.output_tokens || 0,
    });
  }
}

function claudeCost(sum: TokenSum, p: Price): number {
  return (sum.input * p.input + sum.cacheWrite * (p.cacheWrite ?? p.input * 1.25) +
    sum.cacheRead * (p.cacheRead ?? p.input * 0.1) + sum.output * p.output) / 1e6;
}

function addTo(bucket: TokenSum, m: any): void {
  bucket.input += m.input; bucket.cacheWrite += m.cacheWrite;
  bucket.cacheRead += m.cacheRead; bucket.output += m.output; bucket.calls += 1;
}
const emptySum = (): TokenSum => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, calls: 0 });

// Planner row: the given session file, summed per model.
const planner: Record<string, TokenSum> = {};
if (CLAUDE_SESSION && fs.existsSync(CLAUDE_SESSION)) {
  await scanClaudeFile(CLAUDE_SESSION, (m) => {
    planner[m.model] ??= emptySum(); addTo(planner[m.model], m);
  });
}

// 7-day denominators: every project session file with mtime in the window.
const weekly: Record<string, TokenSum> = {}; // model -> sum
const projRoot = path.join(os.homedir(), '.claude', 'projects');
for (const dir of fs.existsSync(projRoot) ? fs.readdirSync(projRoot) : []) {
  const d = path.join(projRoot, dir);
  let entries; try { entries = fs.readdirSync(d); } catch { continue; }
  for (const f of entries) {
    if (!f.endsWith('.jsonl')) continue;
    const fp = path.join(d, f);
    if (fs.statSync(fp).mtimeMs < WINDOW_START) continue;
    await scanClaudeFile(fp, (m) => {
      if (m.ts < WINDOW_START) return;
      weekly[m.model] ??= emptySum(); addTo(weekly[m.model], m);
    });
  }
}

// ---- codex logs --------------------------------------------------------
// Cumulative totals: take the LAST token_count event per session file.
// input_tokens INCLUDES cached_input_tokens.
function readSlice(fp: string, start: number, len: number): string {
  const fd = fs.openSync(fp, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8', 0, n);
  } finally { fs.closeSync(fd); }
}

function scanCodexFile(fp: string): CodexSum | null {
  const size = fs.statSync(fp).size;
  // model appears in the session meta near the head; totals are cumulative,
  // so the last token_count event near EOF is the session total.
  const head = readSlice(fp, 0, Math.min(size, 64 * 1024));
  const tailLen = Math.min(size, 512 * 1024);
  const tail = readSlice(fp, size - tailLen, tailLen);
  const model = head.match(/"model":"([^"]+)"/)?.[1] || tail.match(/"model":"([^"]+)"/)?.[1] || 'gpt-5.5';
  const events = [...tail.matchAll(/"total_token_usage":\{[^}]*\}/g)];
  if (!events.length) return null;
  let last; try { last = JSON.parse(`{${events.at(-1)[0]}}`).total_token_usage; } catch { return null; }
  return {
    model,
    input: last.input_tokens || 0,
    cached: last.cached_input_tokens || 0,
    output: last.output_tokens || 0,
    id: path.basename(fp, '.jsonl').replace(/^rollout-/, '').slice(-12),
  };
}

function codexCost(s: CodexSum, p: Price): number {
  return ((s.input - s.cached) * p.input + s.cached * (p.cachedInput ?? p.input) + s.output * p.output) / 1e6;
}

const codexRoot = path.join(os.homedir(), '.codex', 'sessions');
const codexRun: CodexSum[] = [];   // sessions since --codex-since  -> agent rows
const codexWeek: CodexSum[] = [];  // sessions in the 7d window     -> denominator
(function walk(dir: string): void {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { walk(fp); continue; }
    if (!e.name.endsWith('.jsonl')) continue;
    const mtime = fs.statSync(fp).mtimeMs;
    if (mtime < WINDOW_START) continue;
    const s = scanCodexFile(fp);
    if (!s) continue;
    codexWeek.push(s);
    if (mtime >= CODEX_SINCE) codexRun.push(s);
  }
})(codexRoot);

// ---- assemble ----------------------------------------------------------
const unpriced = new Set();
const usd = (model: string, fn: (price: Price) => number): number | null => {
  const p = priceFor(model);
  if (!p) { unpriced.add(model); return null; }
  return fn(p);
};

const fableWeek = Object.entries(weekly).filter(([m]) => m.includes('fable'))
  .reduce((acc, [m, s]) => acc + (usd(m, (p) => claudeCost(s, p)) ?? 0), 0);
const claudeWeekUsd = Object.entries(weekly)
  .reduce((acc, [m, s]) => acc + (usd(m, (p) => claudeCost(s, p)) ?? 0), 0);
const codexWeekUsd = codexWeek.reduce((acc, s) => acc + (usd(s.model, (p) => codexCost(s, p)) ?? 0), 0);
const allWeek = claudeWeekUsd + codexWeekUsd;

const fmt = (n: number): string => n.toLocaleString('en-US');
const money = (n: number | null): string => n == null ? 'unavailable' : `$${n.toFixed(2)}`;
const pct = (cost: number | null, denom: number, label: string): string =>
  cost == null ? 'unavailable — model unpriced' :
  denom > 0 ? `${((cost / denom) * 100).toFixed(2)}%` : `unavailable — ${label} denominator is 0`;

const rows: any[] = [];
for (const [model, s] of Object.entries(planner)) {
  const cost = usd(model, (p) => claudeCost(s, p));
  rows.push({
    agent: 'Planner (this session)', model, calls: s.calls,
    tokens: `${fmt(s.input + s.cacheWrite + s.cacheRead)} in (${fmt(s.cacheRead)} cache-read) / ${fmt(s.output)} out`,
    cost, fablePct: pct(cost, fableWeek, 'Fable 7d'), allPct: pct(cost, allWeek, 'all-models 7d'),
  });
}
for (const s of codexRun) {
  const cost = usd(s.model, (p) => codexCost(s, p));
  rows.push({
    agent: `codex ${s.id}`, model: s.model, calls: 1,
    tokens: `${fmt(s.input)} in (${fmt(s.cached)} cached) / ${fmt(s.output)} out`,
    cost, fablePct: pct(cost, fableWeek, 'Fable 7d'), allPct: pct(cost, allWeek, 'all-models 7d'),
  });
}

const off = codexRun.reduce((a, s) => ({ input: a.input + s.input, cached: a.cached + s.cached, output: a.output + s.output }), { input: 0, cached: 0, output: 0 });
const offTotal = off.input + off.output;
const actualCodex = codexRun.reduce((a, s) => a + (usd(s.model, (p) => codexCost(s, p)) ?? 0), 0);
const soloAt = (key: string): number | null => {
  const p = PRICES.perMTok[key];
  if (!p) return null;
  return ((off.input - off.cached) * p.input + off.cached * p.cacheRead + off.output * p.output) / 1e6;
};
const saveLine = (name: string, key: string): string => {
  const solo = soloAt(key);
  return `Saved vs ${name} solo: ${fmt(offTotal)} tokens offloaded | ` +
    (solo == null ? 'est. unavailable — baseline unpriced' : `est. ${money(Math.max(0, solo - actualCodex))} saved`);
};

if (has('json')) {
  console.log(JSON.stringify({ rows, offloaded: off, actualCodexUsd: actualCodex, fableWeekUsd: fableWeek, allWeekUsd: allWeek, unpriced: [...unpriced], pricesAsOf: PRICES.asOf }, null, 2));
} else {
  console.log(`SMOA token summary  (prices as of ${PRICES.asOf}; costs imputed at published API rates)`);
  console.log(`| Agent | Model | Calls | Tokens in/out | API cost | % Fable 7d | % all models 7d |`);
  console.log(`|---|---|---|---|---|---|---|`);
  for (const r of rows) console.log(`| ${r.agent} | ${r.model} | ${r.calls} | ${r.tokens} | ${money(r.cost)} | ${r.fablePct} | ${r.allPct} |`);
  console.log('');
  console.log(saveLine('Fable-5', 'claude-fable-5'));
  console.log(saveLine('Opus 4.8', 'claude-opus-4-8'));
  console.log('');
  console.log(`7-day denominators (exact, from local logs): Fable ${money(fableWeek)} | all tracked models ${money(allWeek)} (claude ${money(claudeWeekUsd)} + codex ${money(codexWeekUsd)})`);
  if (unpriced.size) console.log(`⚠ unpriced models excluded from denominators: ${[...unpriced].join(', ')} — add them to model-prices.json`);
}
