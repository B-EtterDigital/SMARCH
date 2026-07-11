#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getServerCard } from "./tools/server-card.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputPath = path.join(repoRoot, ".well-known/mcp/server-card.json");

export function renderServerCard() {
  return `${JSON.stringify(getServerCard(), null, 2)}\n`;
}

export async function generateServerCard({ check = false } = {}) {
  const expected = renderServerCard();
  if (check) {
    let actual;
    try {
      actual = await readFile(outputPath, "utf8");
    } catch {
      throw new Error(`MCP_SERVER_CARD_STALE: missing ${path.relative(repoRoot, outputPath)}`);
    }
    if (actual !== expected) {
      throw new Error("MCP_SERVER_CARD_STALE: run `node tools/mcp/generate-server-card.mjs`");
    }
    return outputPath;
  }
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, expected);
  return outputPath;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) {
    console.error("Usage: node tools/mcp/generate-server-card.mjs [--check]");
    process.exitCode = 2;
  } else {
    generateServerCard({ check: args.includes("--check") })
      .then((filePath) => console.log(`${args.includes("--check") ? "fresh" : "wrote"}: ${path.relative(repoRoot, filePath)}`))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
