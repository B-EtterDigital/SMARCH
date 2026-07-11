#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, asCliError, emitFailure, requireValue } from "./cli-contract.mjs";

const TOOL_PATH = fileURLToPath(import.meta.url);
const TEMPLATE_ROOT = path.resolve(path.dirname(TOOL_PATH), "../templates/capsule");

export function usage() {
  return `Create a runnable capsule brick from the canonical template.

Usage:
  sma brick-new --id <brick.id> --directory <path> [--name <name>] [--force] [--json]

Options: --id, --directory, --name, --force, --json, --quiet, --verbose, --help

Examples:
  sma brick-new --id acme.identity --directory ./identity
  sma brick-new --id acme.identity --directory ./identity --json

Exit codes: 0 success; 2 usage; 3 destination exists; 4 template/creation failure.
Known limitation: --force replaces only the requested destination directory.`;
}

export function parseArgs(argv) {
  const options = { force: false, json: false, quiet: false, verbose: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--id", "--directory", "--name"].includes(arg)) { options[arg.slice(2)] = requireValue(argv, index, arg, "Run `sma brick-new --help`."); index += 1; }
    else if (["--force", "--json", "--quiet", "--verbose"].includes(arg)) options[arg.slice(2)] = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new CliError("USAGE_ERROR", `Unknown option: ${arg}`, { exitCode: 2, nextCommand: "Run `sma brick-new --help`." });
  }
  if (options.quiet && options.verbose) throw new CliError("USAGE_ERROR", "--quiet and --verbose cannot be combined.", { exitCode: 2, nextCommand: "Choose one output mode and retry." });
  return options;
}

export function createBrick(options, dependencies = {}) {
  if (!options.id || !/^[a-z0-9][a-z0-9._-]*$/i.test(options.id)) throw new CliError("USAGE_ERROR", "--id must be a non-empty dot-safe identifier.", { exitCode: 2, nextCommand: "Retry with `--id namespace.brick`." });
  if (!options.directory) throw new CliError("USAGE_ERROR", "--directory is required.", { exitCode: 2, nextCommand: "Run `sma brick-new --help`." });
  const destination = path.resolve(options.directory);
  const template = dependencies.templateRoot || TEMPLATE_ROOT;
  if (!existsSync(template)) throw new CliError("TEMPLATE_NOT_FOUND", `Capsule template not found: ${template}`, { exitCode: 4, nextCommand: "Restore `templates/capsule`, then retry." });
  if (existsSync(destination) && !options.force) throw new CliError("DESTINATION_EXISTS", `Destination already exists: ${destination}`, { exitCode: 3, nextCommand: "Choose another directory or retry with --force." });
  if (options.force) rmSync(destination, { recursive: true, force: true });
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(template, destination, { recursive: true, filter: (source) => !source.includes(`${path.sep}graphify-out`) });
  const manifestPath = path.join(destination, "module.sweetspot.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.brick.id = options.id;
  manifest.brick.name = options.name || options.id.split(/[._-]/).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
  manifest.source.project = options.id.split(".")[0];
  manifest.provenance.created_by.timestamp = new Date().toISOString();
  manifest.provenance.created_by.summary = `Created ${options.id} from the canonical capsule template.`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ok: true, id: options.id, directory: destination, files: ["module.sweetspot.json", "src/index.ts", "fixtures/run.json", "README.md", "CONSTRAINTS.md"] };
}

export function run(argv, dependencies = {}) {
  let options;
  try {
    options = parseArgs(argv);
    if (options.help) { process.stdout.write(`${usage()}\n`); return 0; }
    const result = createBrick(options, dependencies);
    if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else if (!options.quiet) process.stdout.write(`brick-new: created ${result.id} at ${result.directory}\n`);
    if (options.verbose) process.stderr.write(`brick-new: copied ${result.files.length} canonical files\n`);
    return 0;
  } catch (error) {
    const failure = error instanceof CliError ? error : asCliError(error, { code: "CREATION_FAILED", exitCode: 4, nextCommand: "Verify the template and destination permissions, then retry." });
    if (options?.json) process.stdout.write(`${JSON.stringify({ ok: false, error: { code: failure.code, message: failure.message } })}\n`);
    return emitFailure("brick-new", failure, { directory: options?.directory || null });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === TOOL_PATH) process.exitCode = run(process.argv.slice(2));
