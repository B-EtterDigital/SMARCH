#!/usr/bin/env node
/**
 * What: Scans selected first-class projects and assembles portfolio scan artifacts.
 * Why: The control plane needs one consistent inventory instead of disconnected project snapshots.
 * How: Discovers projects, runs the project scanner, and can merge results and refresh follow-ups.
 * Callers: Portfolio refresh and operators use it for bounded or complete registry updates.
 * Example: `node tools/sma-portfolio-scan.ts --help`
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { discoverPortfolioProjects, portfolioProjectsRoot } from "./lib/portfolio-projects.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const scansRoot = path.resolve(repoRoot, "scans");
const mergedRegistryPath = path.resolve(scansRoot, "all-projects/latest.registry.json");
const stateScriptPath = path.resolve(repoRoot, "tools/sma-state.ts");
const repoQueuesScriptPath = path.resolve(repoRoot, "tools/sma-repo-queues.ts");
const mergeScriptPath = path.resolve(repoRoot, "tools/sma-merge-registries.ts");
const scanScriptPath = path.resolve(repoRoot, "tools/sma-scan.ts");

interface PortfolioScanArgs {
  project: string[];
  priorityOnly: boolean;
  includeScanned: boolean;
  merge: boolean;
  refresh: boolean;
  stdout: boolean;
  dryRun: boolean;
  help: boolean;
  limit: number | null;
  offset: number;
  existingScanIds: Set<string>;
}

const HELP_TEXT = `Usage: node tools/sma-portfolio-scan.ts [options]

Scan first-class portfolio projects from $SMA_PROJECTS_ROOT into SMA scan outputs.

Options:
  --project <id>          Scan only this project id. Repeatable.
  --limit <n>             Limit the number of projects scanned in this run.
  --offset <n>            Skip the first n target projects after filtering.
  --priority-only         Scan only priority-tier projects.
  --all                   Include already-scanned projects. Default scans unscanned-only.
  --no-merge              Do not rebuild scans/all-projects/latest.registry.json after scanning.
  --no-refresh            Do not regenerate state and repo queues after merging.
  --stdout                Print selected targets before execution.
  --dry-run               Print target selection only; do not run scans.
  --help                  Show this help text.
`;

// eslint-disable-next-line max-lines-per-function, complexity -- Declarative report, compatibility, or fixture assembly stays contiguous so field order and side-effect order remain auditable; splitting would not reduce conceptual complexity.
function parseArgs(argv: string[]): PortfolioScanArgs {
  const options: PortfolioScanArgs = {
    project: [],
    priorityOnly: false,
    includeScanned: false,
    merge: true,
    refresh: true,
    stdout: false,
    dryRun: false,
    help: false,
    limit: null,
    offset: 0,
    existingScanIds: new Set(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--project" && next) {
      options.project.push(next.trim());
      i += 1;
      continue;
    }
    if (arg === "--limit" && next) {
      options.limit = Number.parseInt(next, 10);
      i += 1;
      continue;
    }
    if (arg === "--offset" && next) {
      options.offset = Number.parseInt(next, 10) || 0;
      i += 1;
      continue;
    }
    if (arg === "--priority-only") {
      options.priorityOnly = true;
      continue;
    }
    if (arg === "--all") {
      options.includeScanned = true;
      continue;
    }
    if (arg === "--no-merge") {
      options.merge = false;
      continue;
    }
    if (arg === "--no-refresh") {
      options.refresh = false;
      continue;
    }
    if (arg === "--stdout") {
      options.stdout = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
  }

  return options;
}

function registryPathForProject(projectId: string): string {
  return path.resolve(scansRoot, projectId, "latest.registry.json");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runNodeScript(scriptPath: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${path.basename(scriptPath)} exited with code ${String(code)}`));
    });
  });
}

bootstrap().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

async function bootstrap() {
  const args = parseArgs(process.argv.slice(2));
  args.existingScanIds = new Set(await discoverExistingScanIds());

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  await mainWithArgs(args);
}

// eslint-disable-next-line max-lines-per-function -- Declarative report, compatibility, or fixture assembly stays contiguous so field order and side-effect order remain auditable; splitting would not reduce conceptual complexity.
async function mainWithArgs(args: PortfolioScanArgs): Promise<void> {
  const portfolioProjects = await discoverPortfolioProjects();
  const selectedIds = new Set(args.project);
  let targets = portfolioProjects.filter((entry) => {
    if (selectedIds.size > 0 && !selectedIds.has(entry.id)) return false;
    if (args.priorityOnly && entry.priority_tier !== "priority") return false;
    if (!args.includeScanned && args.existingScanIds.has(entry.id)) return false;
    return true;
  });

  if (args.offset > 0) targets = targets.slice(args.offset);
  if (args.limit != null) targets = targets.slice(0, args.limit);

  const preview = {
    root: path.relative(repoRoot, portfolioProjectsRoot),
    selected_count: targets.length,
    targets: targets.map((entry) => ({
      id: entry.id,
      name: entry.name,
      relative_root: entry.relative_root,
      priority_tier: entry.priority_tier,
      existing_scan: args.existingScanIds.has(entry.id),
    })),
  };

  if (args.stdout || args.dryRun) {
    process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
  }

  if (args.dryRun) return;

  const scanned = [];
  for (const target of targets) {
    const outPath = registryPathForProject(target.id);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await runNodeScript(scanScriptPath, [
      "--root", target.absolute_root,
      "--project-id", target.id,
      "--out", outPath,
    ]);
    scanned.push({
      id: target.id,
      out: path.relative(repoRoot, outPath),
      root: target.relative_root,
    });
  }

  let merged = false;
  if (args.merge) {
    const scanRefs = [];
    for (const entry of portfolioProjects) {
      const file = registryPathForProject(entry.id);
      if (await pathExists(file)) {
        scanRefs.push({ id: entry.id, file });
      }
    }

    if (scanRefs.length > 0) {
      const mergeArgs = scanRefs.flatMap((entry) => ["--registry", `${entry.id}=${entry.file}`]);
      mergeArgs.push("--out", mergedRegistryPath);
      await runNodeScript(mergeScriptPath, mergeArgs);
      merged = true;
    }
  }

  if (merged && args.refresh) {
    await runNodeScript(stateScriptPath, []);
    await runNodeScript(repoQueuesScriptPath, []);
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    scanned_count: scanned.length,
    scanned,
    merged,
    refreshed: merged && args.refresh,
  }, null, 2)}\n`);
}

async function discoverExistingScanIds(): Promise<string[]> {
  const entries = await fs.readdir(scansRoot, { withFileTypes: true }).catch(() => []);
  const ids = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(scansRoot, entry.name, "latest.registry.json");
    if (await pathExists(file)) ids.push(entry.name);
  }
  return ids;
}
