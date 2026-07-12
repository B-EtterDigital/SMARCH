#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

const smaRoot = "$SMARCH_DIR";
const args = process.argv.slice(2);
const script = path.join(smaRoot, "tools", "sma-wiki.mjs");
const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });

process.exit(result.status ?? 1);

