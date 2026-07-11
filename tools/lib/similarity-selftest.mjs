#!/usr/bin/env node
/**
 * WHAT: Exercises the fuzzy source-similarity primitive against representative copy and mismatch cases.
 * WHY: A theft signal must tolerate harmless edits without calling unrelated programs duplicates.
 * HOW: Compares fixed snippets and file sets, then asserts score thresholds, symmetry, and determinism.
 * INPUTS: In-memory source samples covering formatting, renaming, structural edits, and unrelated code.
 * OUTPUTS: A passed-group count on standard output, or an assertion failure and nonzero exit.
 * CALLERS: Developers and provenance test gates run this executable directly.
 * @example node tools/lib/similarity-selftest.mjs
 */
/**
 * Self-test for the fuzzy source-similarity primitive. Proves the properties a
 * theft detector needs beyond exact-hash matching:
 *   - identical text                    -> ~1.0
 *   - one-character (structural) change -> still very high (> 0.9)
 *   - reformatted (whitespace/indent)   -> high (> 0.9)
 *   - variable renamed throughout       -> high (> 0.8)
 *   - completely unrelated code         -> low (< 0.3)
 *   - symmetry: sim(a,b) === sim(b,a)
 *   - file-set aggregation is symmetric and separates copies from strangers
 * Run: node tools/lib/similarity-selftest.mjs
 */
import assert from 'node:assert/strict';
import {
  normalizeSource, kGramShingles, winnow, simhash, hamming, jaccard,
  similarity, fileSetSimilarity,
} from './similarity.mjs';

let n = 0;
const ok = (name, fn) => { fn(); n += 1; };
const r3 = (x) => Math.round(x * 1000) / 1000;
const achieved = {};

// A realistically sized source file so winnowing has room to work.
const BIG = `
// inventory service — computes restock plans for the warehouse
import { database } from "./db";

function computeRestock(items, threshold) {
  const plans = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.quantity < threshold) {
      const deficit = threshold - item.quantity;
      const order = { sku: item.sku, amount: deficit * 2, urgent: deficit > 10 };
      plans.push(order);
    } else if (item.quantity > threshold * 5) {
      plans.push({ sku: item.sku, amount: 0, overstocked: true });
    }
  }
  return plans.sort((a, b) => b.amount - a.amount);
}

function summarize(plans) {
  let total = 0;
  const urgent = [];
  for (const plan of plans) {
    total += plan.amount;
    if (plan.urgent) { urgent.push(plan.sku); }
  }
  return { total, urgentCount: urgent.length, urgent };
}

export { computeRestock, summarize };
`;

/* ---- primitive sanity ---- */
ok('normalizeSource folds comments/whitespace/literals/identifiers', () => {
  const a = normalizeSource('  const  x =   42; // hi\n');
  const b = normalizeSource('const y=99;/* bye */');
  // identifiers -> v, numbers -> num, keyword `const` kept, comments gone
  assert.deepEqual(a, ['const', 'v', '=', 'num', ';']);
  assert.deepEqual(a, b);
});

ok('kGramShingles / winnow / simhash / hamming basics', () => {
  const toks = normalizeSource(BIG);
  const sh = kGramShingles(toks, 5);
  assert.ok(sh.length > 20, 'enough shingles');
  assert.equal(sh[0].split(' ').length, 5, '5-gram width');
  const fp = winnow(sh, 4);
  assert.ok(fp.size > 0 && fp.size <= sh.length, 'winnow selects a subset');
  const h = simhash(sh);
  assert.match(h, /^[0-9a-f]{16}$/, 'simhash is 16-hex');
  assert.equal(hamming(h, h), 0, 'hamming to self is 0');
  assert.equal(jaccard(fp, fp), 1, 'jaccard to self is 1');
});

/* ---- required similarity thresholds ---- */
ok('identical text -> ~1.0', () => {
  const s = similarity(BIG, BIG);
  achieved.identical = s;
  assert.ok(Math.abs(s - 1) < 1e-9, `identical should be 1.0, got ${s}`);
});

ok('one-character (structural) change -> > 0.9', () => {
  // flip a single operator: `deficit * 2` -> `deficit + 2` (one char, changes tokens)
  const changed = BIG.replace('amount: deficit * 2', 'amount: deficit + 2');
  assert.notEqual(changed, BIG, 'edit applied');
  const s = similarity(BIG, changed);
  achieved.oneChar = s;
  assert.ok(s > 0.9, `one-char change should be > 0.9, got ${r3(s)}`);
  assert.ok(s < 1, 'one-char change is not identical');
});

ok('reformatted (whitespace/indent) -> > 0.9', () => {
  // realistic reflow: reindent, respace after commas/semicolons, extra blank
  // lines. Preserves newlines (so line comments still terminate) and never
  // touches `/` (so comment/division markers survive intact).
  const reflowed = BIG
    .split('\n')
    .map((line) => `    ${line.trim().replace(/([,;])/g, '$1 ').replace(/ {2,}/g, ' ')}`)
    .join('\n\n');
  assert.notEqual(reflowed, BIG, 'reflow applied');
  const s = similarity(BIG, reflowed);
  achieved.reformatted = s;
  assert.ok(s > 0.9, `reformatted should be > 0.9, got ${r3(s)}`);
});

ok('variable renamed throughout -> > 0.8', () => {
  // rename identifiers consistently (does NOT touch keywords / structure)
  const renamed = BIG
    .replace(/\bitems\b/g, 'stockList')
    .replace(/\bthreshold\b/g, 'floorLevel')
    .replace(/\bplans\b/g, 'orderPlan')
    .replace(/\bindex\b/g, 'cursor')
    .replace(/\bdeficit\b/g, 'shortfall')
    .replace(/\bplan\b/g, 'entry')
    .replace(/\bcomputeRestock\b/g, 'buildOrders')
    .replace(/\bsummarize\b/g, 'rollup');
  assert.notEqual(renamed, BIG, 'rename applied');
  const s = similarity(BIG, renamed);
  achieved.renamed = s;
  assert.ok(s > 0.8, `renamed should be > 0.8, got ${r3(s)}`);
});

ok('completely unrelated code -> < 0.3', () => {
  const other = `
    #!/usr/bin/env python
    def fibonacci(count):
        """generate the first n fibonacci numbers"""
        sequence = [0, 1]
        while len(sequence) < count:
            sequence.append(sequence[-1] + sequence[-2])
        return sequence[:count]

    class Greeter:
        def __init__(self, name):
            self.name = name
        def hello(self):
            return "hi " + self.name
  `;
  const s = similarity(BIG, other);
  achieved.unrelated = s;
  assert.ok(s < 0.3, `unrelated should be < 0.3, got ${r3(s)}`);
});

/* ---- symmetry ---- */
ok('similarity is symmetric', () => {
  const other = 'function add(a, b) { return a + b; } const z = add(1, 2);';
  assert.equal(similarity(BIG, other), similarity(other, BIG));
  const changed = BIG.replace('deficit * 2', 'deficit + 2');
  assert.equal(similarity(BIG, changed), similarity(changed, BIG));
});

/* ---- file-set aggregation ---- */
ok('fileSetSimilarity: symmetric, separates copies from strangers', () => {
  const setA = [
    { path: 'a/restock.js', text: BIG },
    { path: 'a/util.js', text: 'export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));' },
  ];
  // B contains a renamed copy of restock.js plus an unrelated file
  const copy = BIG.replace(/\bitems\b/g, 'goods').replace(/\bthreshold\b/g, 'cap');
  const setB = [
    { path: 'b/main.py', text: 'def f(x):\n    return x * x + 1\n' },
    { path: 'b/restock.js', text: copy },
  ];
  const strangers = [
    { path: 'c/x.rs', text: 'fn main() { println!("{}", 41); }' },
  ];
  const sCopy = fileSetSimilarity(setA, setB);
  const sStranger = fileSetSimilarity(setA, strangers);
  achieved.fileSetCopy = sCopy;
  achieved.fileSetStranger = sStranger;
  assert.equal(sCopy, fileSetSimilarity(setB, setA), 'fileSetSimilarity symmetric');
  assert.ok(sCopy > sStranger, 'a lifted-file set scores higher than strangers');
  assert.ok(sStranger < 0.3, `stranger set should be low, got ${r3(sStranger)}`);
});

console.log(`similarity selftest: ${n} groups passed`);
console.log('achieved scores:');
for (const [k, v] of Object.entries(achieved)) console.log(`  ${k.padEnd(16)} ${r3(v)}`);
