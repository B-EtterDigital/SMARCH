#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

const analyzableSourceExtensions = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".swift", ".php", ".cs", ".sql",
  ".json", ".md", ".mdx", ".yaml", ".yml", ".toml", ".txt"
]);

const excludedDirNames = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vercel",
  ".vite",
  ".cache",
  ".idea",
  ".vscode",
  "coverage",
  "dist",
  "build",
  "node_modules",
  "vendor",
  "tmp",
  "temp",
  "logs"
]);

const archiveDirPatterns = [
  "__archive",
  "__archives",
  "_archive",
  "_archives",
  "archive",
  "archives",
  "old",
  "deprecated",
  "backup",
  "fix-push",
  "stream_preview_release"
];

function parseArgs(argv) {
  const options = {
    root: null,
    scan: null,
    projectId: "",
    manifests: [],
    allManifests: false,
    syncProjectId: false,
    dryRun: false,
    json: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--root" && next) {
      options.root = path.resolve(next);
      index += 1;
      continue;
    }

    if (arg === "--scan" && next) {
      options.scan = path.resolve(next);
      index += 1;
      continue;
    }

    if (arg === "--project-id" && next) {
      options.projectId = next;
      index += 1;
      continue;
    }

    if (arg === "--manifest" && next) {
      options.manifests.push(path.resolve(next));
      index += 1;
      continue;
    }

    if (arg === "--all-manifests") {
      options.allManifests = true;
      continue;
    }

    if (arg === "--sync-project-id") {
      options.syncProjectId = true;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!options.root) {
    throw new Error("--root is required");
  }

  if (!options.scan && options.manifests.length === 0 && !options.allManifests) {
    throw new Error("Provide --scan, --manifest, or --all-manifests");
  }

  if (options.syncProjectId && !options.projectId) {
    throw new Error("--sync-project-id requires --project-id");
  }

  return options;
}

function printHelp() {
  console.log(`Refresh stale manifest budget metadata from current source files.

Usage:
  node tools/sma-refresh-manifest-budgets.mjs --root <project-root> --scan <scan-file>
  node tools/sma-refresh-manifest-budgets.mjs --root <project-root> --all-manifests --project-id <id> --sync-project-id

Options:
  --root <path>          Project root to read source files from
  --scan <path>          Project scan JSON; uses manifest drift entries to choose manifests
  --manifest <path>      Refresh one manifest (repeatable)
  --all-manifests        Refresh every *.sweetspot.json under the root
  --project-id <id>      First-class SMA project id
  --sync-project-id      Rewrite source.project / brick.id / hierarchy.group_id prefix to --project-id
  --dry-run              Report changes without writing
  --json                 Print JSON summary
`);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function toSlashPath(targetPath) {
  return targetPath.split(path.sep).join("/");
}

function isExcludedDirName(name) {
  if (excludedDirNames.has(name)) {
    return true;
  }

  const lower = name.toLowerCase();
  return archiveDirPatterns.some((pattern) => lower.includes(pattern));
}

function isAnalyzableSourceFile(filePath) {
  return analyzableSourceExtensions.has(path.extname(filePath).toLowerCase());
}

async function walkAnalyzableFiles(targetPath, files = []) {
  let stats;

  try {
    stats = await fs.stat(targetPath);
  } catch {
    return files;
  }

  if (stats.isFile()) {
    if (isAnalyzableSourceFile(targetPath)) {
      files.push(targetPath);
    }

    return files;
  }

  if (!stats.isDirectory()) {
    return files;
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      if (isExcludedDirName(entry.name)) {
        continue;
      }

      await walkAnalyzableFiles(fullPath, files);
      continue;
    }

    if (entry.isFile() && isAnalyzableSourceFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

function normalizeSourcePath(projectRoot, sourcePath) {
  const requestedPath = String(sourcePath || "").split("/").join(path.sep);
  const projectDirName = path.basename(projectRoot);
  const prefixedPattern = new RegExp(`^${projectDirName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\\\/]`);

  if (prefixedPattern.test(requestedPath)) {
    return requestedPath.replace(prefixedPattern, "");
  }

  return requestedPath;
}

async function manifestCandidatesForSourcePath(projectRoot, sourcePath) {
  const normalized = normalizeSourcePath(projectRoot, sourcePath);
  const absoluteTarget = path.resolve(projectRoot, normalized);
  const candidates = [];

  try {
    const stats = await fs.stat(absoluteTarget);

    if (stats.isDirectory()) {
      candidates.push(path.join(absoluteTarget, "module.sweetspot.json"));
    } else if (stats.isFile()) {
      candidates.push(`${absoluteTarget}.module.sweetspot.json`);
    }
  } catch {
    // ignore
  }

  return candidates;
}

async function collectManifestPaths(options) {
  const manifestPaths = new Set(options.manifests);

  if (options.allManifests) {
    const stack = [options.root];

    while (stack.length > 0) {
      const current = stack.pop();
      const entries = await fs.readdir(current, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);

        if (entry.isDirectory()) {
          if (isExcludedDirName(entry.name)) {
            continue;
          }

          stack.push(fullPath);
          continue;
        }

        if (entry.isFile() && (entry.name === "module.sweetspot.json" || entry.name.endsWith(".module.sweetspot.json"))) {
          manifestPaths.add(fullPath);
        }
      }
    }
  }

  if (options.scan) {
    const scan = JSON.parse(await fs.readFile(options.scan, "utf8"));
    const entries = scan?.scanner_report?.manifest_drift?.entries || [];

    for (const entry of entries) {
      if (!["max_file_lines_drift", "file_count_drift", "feature_line_drift"].includes(entry.kind)) {
        continue;
      }

      const candidates = await manifestCandidatesForSourcePath(options.root, entry.path || "");

      for (const candidate of candidates) {
        if (await pathExists(candidate)) {
          manifestPaths.add(candidate);
        }
      }
    }
  }

  return [...manifestPaths].sort();
}

function maybeRewriteProjectIdentity(manifest, projectId) {
  if (!projectId) {
    return false;
  }

  let changed = false;

  if (manifest.source?.project && manifest.source.project !== projectId) {
    manifest.source.project = projectId;
    changed = true;
  }

  if (manifest.brick?.id && manifest.brick.id.includes(".")) {
    const [, ...rest] = manifest.brick.id.split(".");
    const nextId = [projectId, ...rest].join(".");

    if (nextId !== manifest.brick.id) {
      manifest.brick.id = nextId;
      changed = true;
    }
  }

  if (manifest.hierarchy?.group_id && manifest.hierarchy.group_id.includes(":")) {
    const [, ...rest] = manifest.hierarchy.group_id.split(":");
    const nextGroupId = [projectId, ...rest].join(":");

    if (nextGroupId !== manifest.hierarchy.group_id) {
      manifest.hierarchy.group_id = nextGroupId;
      changed = true;
    }
  }

  return changed;
}

function ensureQualityBlocks(manifest) {
  manifest.quality ||= {};
  manifest.quality.line_count ||= {};
  manifest.quality.code_budget ||= {};
}

async function computeBudget(projectRoot, manifest) {
  const sourcePath = manifest?.source?.paths?.[0];

  if (!sourcePath) {
    return null;
  }

  const normalized = normalizeSourcePath(projectRoot, sourcePath);
  const absoluteTarget = path.resolve(projectRoot, normalized);
  const files = await walkAnalyzableFiles(absoluteTarget, []);

  let featureLines = 0;
  let maxFileLines = 0;
  let over600Count = 0;

  for (const filePath of files) {
    const sourceText = await fs.readFile(filePath, "utf8");
    const lineCount = sourceText.split(/\r?\n/).length;
    featureLines += lineCount;
    maxFileLines = Math.max(maxFileLines, lineCount);

    if (lineCount > 600) {
      over600Count += 1;
    }
  }

  return {
    sourcePath,
    fileCount: files.length,
    featureLines,
    maxFileLines,
    over600Count
  };
}

async function refreshManifest(projectRoot, manifestPath, options) {
  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw);
  const budget = await computeBudget(projectRoot, manifest);

  if (!budget) {
    return {
      manifest: manifestPath,
      changed: false,
      skipped: true,
      reason: "missing source.paths[0]"
    };
  }

  ensureQualityBlocks(manifest);
  let changed = false;

  if ((manifest.quality.line_count?.max_file_lines || 0) !== budget.maxFileLines) {
    manifest.quality.line_count.max_file_lines = budget.maxFileLines;
    changed = true;
  }

  if ((manifest.quality.line_count?.over_600_count || 0) !== budget.over600Count) {
    manifest.quality.line_count.over_600_count = budget.over600Count;
    changed = true;
  }

  if ((manifest.quality.code_budget?.feature_lines || 0) !== budget.featureLines) {
    manifest.quality.code_budget.feature_lines = budget.featureLines;
    changed = true;
  }

  if ((manifest.quality.code_budget?.file_count || 0) !== budget.fileCount) {
    manifest.quality.code_budget.file_count = budget.fileCount;
    changed = true;
  }

  if (options.syncProjectId) {
    changed = maybeRewriteProjectIdentity(manifest, options.projectId) || changed;
  }

  if (changed && !options.dryRun) {
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return {
    manifest: manifestPath,
    changed,
    skipped: false,
    budget
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestPaths = await collectManifestPaths(options);
  const results = [];

  for (const manifestPath of manifestPaths) {
    results.push(await refreshManifest(options.root, manifestPath, options));
  }

  const summary = {
    root: options.root,
    manifest_count: manifestPaths.length,
    changed_count: results.filter((result) => result.changed).length,
    skipped_count: results.filter((result) => result.skipped).length,
    results: results.map((result) => ({
      manifest: toSlashPath(path.relative(options.root, result.manifest)),
      changed: result.changed,
      skipped: result.skipped,
      reason: result.reason || null,
      budget: result.budget || null
    }))
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Refreshed ${summary.changed_count}/${summary.manifest_count} manifest(s) under ${options.root}`);

  for (const result of summary.results.filter((entry) => entry.changed)) {
    console.log(`- ${result.manifest}`);
  }

  if (summary.skipped_count > 0) {
    console.log(`Skipped ${summary.skipped_count} manifest(s) with missing source paths.`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
