#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const script = "~/DEV/SMARCH/tools/sma-ci.mjs";
const result = spawnSync(process.execPath, [script, ...args], { stdio: "inherit" });

process.exit(result.status ?? 1);

