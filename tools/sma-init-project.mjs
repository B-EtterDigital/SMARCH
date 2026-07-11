#!/usr/bin/env node
/**
 * WHAT: Initializes a target project with the minimum architecture metadata and directories.
 * WHY: New projects need a consistent starting contract before their first module is scanned.
 * HOW: Writes project and module metadata, creates support folders, and reports next commands.
 * INPUTS: Target path, project identity, name, platform, mode, and optional overwrite permission.
 * OUTPUTS: Scaffold files in the target plus a structured initialization summary.
 * CALLERS: Operators bootstrapping a new Sweetspot Modular Architecture project.
 * Usage: `node tools/sma-init-project.mjs --help`
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const smaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const defaults = {
  target: process.cwd(),
  projectId: "",
  name: "",
  platform: "all",
  mode: "new",
  overwrite: false
};

function parseArgs(argv) {
  const options = { ...defaults };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--target" && next) {
      options.target = path.resolve(next);
      i += 1;
    } else if (arg === "--project-id" && next) {
      options.projectId = next;
      i += 1;
    } else if (arg === "--name" && next) {
      options.name = next;
      i += 1;
    } else if (arg === "--platform" && next) {
      options.platform = next;
      i += 1;
    } else if (arg === "--mode" && next) {
      options.mode = next;
      i += 1;
    } else if (arg === "--overwrite") {
      options.overwrite = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Initialize an SMA project

Usage:
  node tools/sma-init-project.mjs \\
    --target /path/to/project \\
    --project-id my-project \\
    --name "My Project" \\
    --platform all \\
    --mode new

Modes:
  new       Prepare an empty/new project before coding starts
  existing  Add SMA rules and project index before scanning/refactoring existing code
`);
      process.exit(0);
    }
  }

  return options;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

function slug(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || stdout || `${command} exited ${code}`));
      }
    });
  });
}

async function writeJsonIfAllowed(filePath, value, overwrite) {
  if (!overwrite && await pathExists(filePath)) {
    return false;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return true;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectId = slug(options.projectId || path.basename(options.target));
  const name = options.name || projectId;

  await fs.mkdir(options.target, { recursive: true });

  const project = {
    id: projectId,
    name,
    root: options.target,
    repository: "",
    stack: ["sma"]
  };
  const projectJson = {
    schema_version: "1.0.0",
    project,
    sma: {
      status: options.mode === "new" ? "ready_for_first_brick" : "ready_for_existing_scan",
      setup_mode: options.mode,
      generated_at: new Date().toISOString(),
      manifest_policy: "Create or bootstrap a module.sweetspot.json before treating code as a reusable brick.",
      next_steps: options.mode === "new"
        ? [
          "Create the first feature as a small brick.",
          "Copy templates/brick/module.sweetspot.json into the brick root.",
          "Run SMA scan, validation, and security gate before release."
        ]
        : [
          "Run the dashboard first-time setup or scanner.",
          "Bootstrap missing manifests as project_bound.",
          "Use validation and security findings as the refactor backlog."
        ]
    }
  };
  const modulesJson = {
    schema_version: "1.0.0",
    project,
    modules: []
  };
  const projectWritten = await writeJsonIfAllowed(path.join(options.target, ".sweetspot", "project.json"), projectJson, options.overwrite);
  const modulesWritten = await writeJsonIfAllowed(path.join(options.target, ".sweetspot", "modules.json"), modulesJson, options.overwrite);

  await run("node", [
    path.join(smaRoot, "tools", "install-agent-skills.mjs"),
    "--target",
    options.target,
    "--platform",
    options.platform
  ], smaRoot);

  console.log(JSON.stringify({
    target: options.target,
    project_id: projectId,
    mode: options.mode,
    platform: options.platform,
    project_json_written: projectWritten,
    modules_json_written: modulesWritten,
    next_commands: [
      `node ~/DEV/SMARCH/tools/sma-scan.mjs --root ${options.target} --out ${path.join(options.target, ".sweetspot", "scans", "latest.registry.json")} --check`,
      `node ~/DEV/SMARCH/tools/sma-security-gate.mjs --root ${options.target}`,
      `node ~/DEV/SMARCH/tools/sma-compliance-gate.mjs --root ${options.target} --gate`,
      `node ~/DEV/SMARCH/tools/sma-wiki.mjs --registry ${path.join(options.target, ".sweetspot", "scans", "latest.registry.json")} --out ${path.join(options.target, ".sweetspot", "wiki")}`
    ]
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
