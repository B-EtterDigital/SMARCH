#!/usr/bin/env node
/**
 * WHAT: Generates the portfolio's Markdown and web wiki from current registry state.
 * WHY: Reusable bricks need browsable evidence, ownership, interfaces, and readiness in one place.
 * HOW: Reads registry, state, and source manifests, then renders project and brick pages.
 * OUTPUTS: Writes the wiki tree selected by --out.
 * CALLERS: The sma command router and continuous-integration pipeline regenerate this catalog.
 * USAGE: node tools/sma-wiki.ts --help
 * Glossary: [SMA](../docs/GLOSSARY.md).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachFeatureCluster } from "./lib/feature-clusters.ts";
import { smaPath } from "./lib/sma-paths.ts";
import { brickMarkdown, brickWallHtml, catalogMarkdown, featureClustersHtml, maybeReadJson, readManifest } from "./lib/wiki-bricks.ts";
import { dashboardHtml } from "./lib/wiki-dashboard-page.ts";
import { projectMetadata } from "./lib/wiki-dashboard-helpers.ts";
import { courseHtml, projectHealthMarkdown, projectPage } from "./lib/wiki-project-pages.ts";
import { buildRegistryHtml, canonicalizationHtml, capabilitiesHtml, proofSurfaceHtml } from "./lib/wiki-surface-pages.ts";
import { slugify } from "./lib/wiki-utils.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const defaults = {
  registry: smaPath("registry/global-modules.generated.json"),
  state: smaPath("wiki/SMA_STATE.generated.json"),
  out: smaPath("wiki")
};

function parseArgs(argv: string[]): typeof defaults {
  const options = { ...defaults };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--registry" && next) {
      options.registry = path.resolve(next);
      i += 1;
    } else if (arg === "--state" && next) {
      options.state = path.resolve(next);
      i += 1;
    } else if (arg === "--out" && next) {
      options.out = path.resolve(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`SMA wiki generator

Usage:
  node tools/sma-wiki.ts --registry registry/global-modules.generated.json --state wiki/SMA_STATE.generated.json --out wiki
`);
      process.exit(0);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const registry = JSON.parse(await fs.readFile(options.registry, "utf8"));
  const bricks = registry.bricks || [];
  const metadata = await projectMetadata(registry.projects || []);
  const stateSnapshotPath = path.resolve(repoRoot, "wiki/SMA_STATE.generated.json");
  const stateSnapshot = await maybeReadJson(stateSnapshotPath);

  await fs.rm(path.join(options.out, "bricks"), { recursive: true, force: true });
  await fs.rm(path.join(options.out, "projects"), { recursive: true, force: true });
  await fs.mkdir(path.join(options.out, "bricks"), { recursive: true });
  await fs.mkdir(path.join(options.out, "courses"), { recursive: true });
  await fs.mkdir(path.join(options.out, "projects"), { recursive: true });

  for (const brick of bricks) {
    const slug = slugify(brick.id);
    const manifest = await readManifest(brick);
    attachFeatureCluster(brick, manifest);
    await fs.writeFile(path.join(options.out, "bricks", `${slug}.md`), brickMarkdown(brick, manifest));
  }

  await fs.writeFile(path.join(options.out, "BRICK_CATALOG.generated.md"), catalogMarkdown(bricks));
  await fs.writeFile(path.join(options.out, "PROJECT_HEALTH.generated.md"), projectHealthMarkdown(registry.projects || [], bricks));
  await fs.writeFile(path.join(options.out, "BRICK_WALL.generated.html"), brickWallHtml(registry, bricks));
  await fs.writeFile(path.join(options.out, "FEATURE_CLUSTERS.generated.html"), featureClustersHtml(registry, bricks));
  await fs.writeFile(path.join(options.out, "DASHBOARD.generated.html"), dashboardHtml(registry, bricks, metadata, stateSnapshot));
  await fs.writeFile(path.join(options.out, "PROOF.generated.html"), proofSurfaceHtml(registry, stateSnapshot));
  await fs.writeFile(path.join(options.out, "BUILD_REGISTRY.generated.html"), buildRegistryHtml(registry, stateSnapshot));
  await fs.writeFile(path.join(options.out, "CAPABILITIES.generated.html"), capabilitiesHtml(registry, stateSnapshot));
  await fs.writeFile(path.join(options.out, "CANONICALIZATION.generated.html"), canonicalizationHtml(registry, stateSnapshot));
  if (stateSnapshot) {
    await fs.writeFile(path.join(options.out, "SMA_STATE.generated.json"), `${JSON.stringify(stateSnapshot, null, 2)}\n`);
  }

  for (const project of registry.projects || []) {
    await fs.writeFile(path.join(options.out, "projects", `${slugify(project.id)}.md`), projectPage(project, bricks, registry.unmanifested_bricks || [], registry.candidate_groups || []));
  }

  await fs.writeFile(path.join(options.out, "courses", "sma-brick-course.generated.html"), courseHtml(bricks));

  console.log(`Generated ${bricks.length} brick page(s) and ${(registry.projects || []).length} project page(s) in ${options.out}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
