#!/usr/bin/env node
/**
 * WHAT: Sends one prompt to the shared Codex runner and prints the structured result.
 * WHY: Developers need a minimal command for testing runner configuration, caching, and response schemas outside larger pipelines.
 * HOW: Reads a prompt from an argument, file, or standard input and delegates to the runner used by the other Codex tools.
 * Usage: `node tools/sma-codex.mjs --prompt "Reply with PONG"`
 */
/**
 * Thin CLI for the codex-runner. Useful for ad-hoc shell tests.
 *
 *   node tools/sma-codex.mjs --prompt "Summarize the SMA framework in one sentence"
 *   node tools/sma-codex.mjs --prompt-file ./prompt.txt --schema ./schema.json
 *   echo "Reply with PONG" | node tools/sma-codex.mjs --stdin
 */
import fs from "node:fs/promises";
import path from "node:path";
import { codex } from "./lib/codex-runner.mjs";

function parseArgs(argv) {
  const opts = { prompt: "", promptFile: "", schema: "", stdin: false, model: "gpt-5.4", noCache: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const n = argv[i + 1];
    if (a === "--prompt" && n) { opts.prompt = n; i += 1; }
    else if (a === "--prompt-file" && n) { opts.promptFile = path.resolve(n); i += 1; }
    else if (a === "--schema" && n) { opts.schema = path.resolve(n); i += 1; }
    else if (a === "--stdin") opts.stdin = true;
    else if (a === "--model" && n) { opts.model = n; i += 1; }
    else if (a === "--no-cache") opts.noCache = true;
  }
  return opts;
}

async function readStdin() {
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  let prompt = o.prompt;
  if (o.promptFile) prompt = await fs.readFile(o.promptFile, "utf8");
  if (o.stdin || (!prompt && !process.stdin.isTTY)) prompt = await readStdin();
  if (!prompt) { console.error("error: provide --prompt, --prompt-file, or pipe to stdin"); process.exit(2); }

  let schema = null;
  if (o.schema) schema = JSON.parse(await fs.readFile(o.schema, "utf8"));

  const r = await codex({ prompt, schema, model: o.model, noCache: o.noCache });
  if (r.ok && r.data !== undefined) console.log(JSON.stringify(r.data, null, 2));
  else if (r.ok && r.text !== undefined) console.log(r.text);
  else { console.error(JSON.stringify(r, null, 2)); process.exit(1); }
}

main();
