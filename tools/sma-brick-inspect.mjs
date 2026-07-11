#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, emitFailure, requireValue } from "./cli-contract.mjs";

const TOOL_PATH = fileURLToPath(import.meta.url);
const RUNNER = path.resolve(path.dirname(TOOL_PATH), "sma-brick-run.mjs");

export function usage() {
  return `Inspect a capsule manifest, declared gates, and real fixture results.

Usage:
  sma brick-inspect [--capsule] <directory> [--json] [--quiet | --verbose]

Examples:
  sma brick-inspect templates/capsule
  sma brick-inspect --capsule templates/capsule --json

Exit codes: 0 passing; 2 usage; 3 missing/invalid manifest; 4 fixture runner failure.
Known limitation: inspection executes the capsule fixtures using brick-run's default sandbox mode.`;
}

export function parseArgs(argv) {
  const options = { capsule: "", json: false, quiet: false, verbose: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--capsule") { options.capsule = requireValue(argv, index, arg, "Run `sma brick-inspect --help`."); index += 1; }
    else if (["--json", "--quiet", "--verbose"].includes(arg)) options[arg.slice(2)] = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg.startsWith("--")) throw new CliError("USAGE_ERROR", `Unknown option: ${arg}`, { exitCode: 2, nextCommand: "Run `sma brick-inspect --help`." });
    else if (options.capsule) throw new CliError("USAGE_ERROR", "Only one capsule directory may be supplied.", { exitCode: 2, nextCommand: "Run `sma brick-inspect --help`." });
    else options.capsule = arg;
  }
  if (options.quiet && options.verbose) throw new CliError("USAGE_ERROR", "--quiet and --verbose cannot be combined.", { exitCode: 2, nextCommand: "Choose one output mode and retry." });
  return options;
}

export function inspectBrick(options, dependencies = {}) {
  if (!options.capsule) throw new CliError("USAGE_ERROR", "A capsule directory is required.", { exitCode: 2, nextCommand: "Run `sma brick-inspect --help`." });
  const root = path.resolve(options.capsule);
  const manifestPath = path.join(root, "module.sweetspot.json");
  if (!existsSync(manifestPath)) throw new CliError("MANIFEST_NOT_FOUND", `Manifest not found: ${manifestPath}`, { exitCode: 3, nextCommand: "Run `sma brick-new --id <id> --directory <path>` or pass a capsule directory." });
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
  catch (error) { throw new CliError("MANIFEST_INVALID", `Manifest is not valid JSON: ${error.message}`, { exitCode: 3, nextCommand: `Fix ${manifestPath}, then retry.` }); }
  const result = (dependencies.spawnSync || spawnSync)(process.execPath, [RUNNER, root], { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new CliError("FIXTURE_RUNNER_FAILED", result.error.message, { exitCode: 4, nextCommand: `Run \`node tools/sma-brick-run.mjs ${root}\` for details.` });
  const fixtures = String(result.stdout || "").trim().split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { status: "FAIL", error: { code: "RUNNER_OUTPUT_INVALID", message: line } }; }
  });
  const report = { ok: result.status === 0 && fixtures.every((fixture) => fixture.status === "PASS"), directory: root, manifest: { id: manifest?.brick?.id || null, name: manifest?.brick?.name || null, version: manifest?.brick?.version || null, kind: manifest?.brick?.kind || null, status: manifest?.brick?.status || null }, gates: manifest?.quality?.verification || [], fixtures };
  if (!report.ok) throw new CliError("FIXTURES_FAILED", `Capsule fixture run failed with exit ${result.status}.`, { exitCode: 4, nextCommand: `Run \`node tools/sma-brick-run.mjs ${root}\` and fix the failing fixture.`, context: { report } });
  return report;
}

export function run(argv, dependencies = {}) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) { process.stdout.write(`${usage()}\n`); return 0; }
    const report = inspectBrick(options, dependencies);
    if (options.json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else if (!options.quiet) process.stdout.write(`brick-inspect: ${report.manifest.id}@${report.manifest.version}\n  gates: ${report.gates.length}; fixtures: ${report.fixtures.length}; status: passing\n`);
    if (options.verbose) process.stderr.write(`brick-inspect: inspected ${report.directory}\n`);
    return 0;
  } catch (error) {
    if (options?.json) process.stdout.write(`${JSON.stringify(error?.context?.report || { ok: false, error: { code: error?.code || "UNEXPECTED_ERROR", message: error instanceof Error ? error.message : String(error) } })}\n`);
    return emitFailure("brick-inspect", error, { capsule: options?.capsule || null });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === TOOL_PATH) process.exitCode = run(process.argv.slice(2));
