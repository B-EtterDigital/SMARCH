#!/usr/bin/env node
/**
 * WHAT: Orchestrates the complete Codex-assisted enrichment, connection, test, promotion, and wiki pipeline.
 * WHY: Operators need a repeatable stage order so derived metadata and documentation are rebuilt from compatible inputs.
 * HOW: Passes filters to each child command, streams their results, and is called for bounded or full portfolio refreshes.
 * Usage: `node tools/sma-codex-all.mjs --only filter --limit 1`
 */
/**
 * sma-codex-all: run the full Codex-powered pipeline end-to-end.
 *
 * Order:
 *   1. sma-filter            (fast, pure JS)
 *   2. sma-codex-enrich      (LLM — semantic metadata)
 *   3. sma-codex-connect     (LLM — cross-brick graph)
 *   4. sma-codex-test        (LLM — sibling tests)
 *   5. sma-promote           (pure JS — status flips)
 *   6. sma-codex-wiki        (LLM — MSDN-style pages)
 *   7. sma-codex-wiki-index  (pure JS — tag / archetype / project indices)
 *   8. sma-scan + merge + sma-wiki   (rebuild classical wiki)
 *
 * All optional filters are passed through: --project, --filter, --limit,
 * --concurrency, --min-score.
 *
 * Usage:
 *   node tools/sma-codex-all.mjs                                # everything
 *   node tools/sma-codex-all.mjs --project acme-desktop --limit 30       # smoke-test
 *   node tools/sma-codex-all.mjs --filter workos                # just auth group
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { smaPath } from "./lib/sma-paths.mjs";

function parseArgs(argv) {
  const passthrough = [];
  const opts = { skip: new Set(), only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const n = argv[i + 1];
    if (a === "--skip" && n) { for (const s of n.split(",")) opts.skip.add(s.trim()); i += 1; continue; }
    if (a === "--only" && n) { opts.only = new Set(n.split(",").map((s) => s.trim())); i += 1; continue; }
    passthrough.push(a);
    if (n && !n.startsWith("--")) { passthrough.push(n); i += 1; }
  }
  return { passthrough, opts };
}

function run(cmd, args, label) {
  return new Promise((resolve, reject) => {
    console.log(`\n>>> ${label}: node ${args.join(" ")}`);
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited ${code}`));
    });
  });
}

async function main() {
  const { passthrough, opts } = parseArgs(process.argv.slice(2));
  const tools = path.resolve(smaPath("tools"));

  const steps = [
    { id: "filter",    cmd: "node", args: [`${tools}/sma-filter.mjs`] },
    { id: "enrich",    cmd: "node", args: [`${tools}/sma-codex-enrich.mjs`, ...passthrough] },
    { id: "connect",   cmd: "node", args: [`${tools}/sma-codex-connect.mjs`, ...passthrough] },
    { id: "tests",     cmd: "node", args: [`${tools}/sma-codex-test.mjs`, ...passthrough] },
    { id: "promote",   cmd: "node", args: [`${tools}/sma-promote.mjs`] },
    { id: "wiki",      cmd: "node", args: [`${tools}/sma-codex-wiki.mjs`, ...passthrough] },
    { id: "wiki-idx",  cmd: "node", args: [`${tools}/sma-codex-wiki-index.mjs`] }
  ];

  for (const step of steps) {
    if (opts.skip.has(step.id)) { console.log(`skip ${step.id}`); continue; }
    if (opts.only && !opts.only.has(step.id)) { console.log(`skip ${step.id} (not in --only)`); continue; }
    await run(step.cmd, step.args, step.id);
  }

  console.log("\n=== sma-codex-all complete ===");
}

main().catch((err) => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });
