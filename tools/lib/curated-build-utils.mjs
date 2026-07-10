import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultPaths, maybeReadJson } from "./sma-adoption.mjs";
import { parseArgs as parseFlatArgs } from "./adoption-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".nuxt", ".turbo", "dist", "build", "coverage"]);

export const defaultCuratedBuildPaths = {
  repoRoot,
  state: defaultPaths.state,
  registry: defaultPaths.registry,
  buildIndex: defaultPaths.buildIndex,
  verification: path.resolve(repoRoot, "security/build-verification.generated.json"),
  promotion: path.resolve(repoRoot, "security/build-promotion.generated.json"),
  publishIndex: path.resolve(repoRoot, "publish/publish-index.generated.json"),
  releaseIndex: path.resolve(repoRoot, "releases/release-index.generated.json"),
  buildsRoot: path.resolve(repoRoot, "builds"),
};

export function toArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizePath(value) {
  return String(value || "").split(path.sep).join("/").replace(/^\.\//, "");
}

export function uniqueStrings(values) {
  return [...new Set(toArray(values).flatMap((value) => {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    return [String(value)];
  }).map((value) => String(value).trim()).filter(Boolean))];
}

export function relativeFromRepo(targetPath) {
  return normalizePath(path.relative(repoRoot, targetPath));
}

export function parseArgs(argv, booleanFlags = ["stdout", "dry-run", "help"]) {
  return parseFlatArgs(argv, { booleanFlags });
}

export function selectedBuildIdsFromArgs(args = {}) {
  return new Set(
    []
      .concat(args.build || [])
      .concat(toArray(args._).filter((value) => String(value).startsWith("build:")).map((value) => String(value).slice(6)))
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
  );
}

export function filterCuratedBuilds(curatedBuilds, args = {}) {
  const selected = selectedBuildIdsFromArgs(args);
  return toArray(curatedBuilds).filter((entry) => selected.size === 0 || selected.has(entry.build_id));
}

export function buildHandoffPaths(build) {
  const projectId = String(build?.source_project || "");
  const buildId = String(build?.build_id || build?.artifact_id || "");
  return {
    queue_doc: `handoffs/repo-queues/${projectId}.md`,
    repo_prompt: `handoffs/repo-builds/${buildId}.prompt.md`,
    build_packets: "handoffs/build-packets.generated.json",
    repo_queues: "handoffs/repo-queues.generated.json",
    publish_leaks: "publish/publish-leaks.generated.json",
    manifest_scaffolds: "scaffolds/build-manifest-repairs.generated.json",
    scaffold_output: "scaffolds/build-manifest-repairs.generated.json",
    release_drafts: "releases/release-drafts.generated.json",
    acceptance_definitions: "docs/CURATED_BUILD_ACCEPTANCE_DEFINITIONS.md",
    verification_templates: "templates/build-verification/",
  };
}

export async function loadCuratedBuildContext(options = {}) {
  const paths = {
    state: path.resolve(options.state || defaultCuratedBuildPaths.state),
    registry: path.resolve(options.registry || defaultCuratedBuildPaths.registry),
    buildIndex: path.resolve(options["build-index"] || options.buildIndex || defaultCuratedBuildPaths.buildIndex),
    verification: path.resolve(options.verification || defaultCuratedBuildPaths.verification),
    promotion: path.resolve(options.promotion || defaultCuratedBuildPaths.promotion),
    publishIndex: path.resolve(options["publish-index"] || options.publishIndex || defaultCuratedBuildPaths.publishIndex),
    releaseIndex: path.resolve(options["release-index"] || options.releaseIndex || defaultCuratedBuildPaths.releaseIndex),
    buildsRoot: path.resolve(options.root || options["builds-root"] || defaultCuratedBuildPaths.buildsRoot),
  };

  const [state, registry, buildIndex, verification, promotion, publishIndex, releaseIndex] = await Promise.all([
    maybeReadJson(paths.state),
    maybeReadJson(paths.registry),
    maybeReadJson(paths.buildIndex),
    maybeReadJson(paths.verification),
    maybeReadJson(paths.promotion),
    maybeReadJson(paths.publishIndex),
    maybeReadJson(paths.releaseIndex),
  ]);

  if (!state) throw new Error(`missing state snapshot at ${paths.state}`);
  if (!registry) throw new Error(`missing merged registry at ${paths.registry}`);

  const manifestEntries = await collectBuildManifests(paths.buildsRoot);
  const manifestsByBuildId = new Map(manifestEntries.filter((entry) => entry.buildId).map((entry) => [entry.buildId, entry]));
  const projectsById = new Map(toArray(registry.projects).map((entry) => [String(entry.id || entry.project), entry]));
  const promotionByBuildId = new Map(toArray(promotion?.promotion_queue).filter((entry) => entry?.build_id).map((entry) => [entry.build_id, entry]));
  const verificationByBuildId = new Map(toArray(verification?.builds).filter((entry) => entry?.build_id).map((entry) => [entry.build_id, entry]));
  const releaseByBuildId = new Map(Object.entries(releaseIndex?.artifacts?.build || {}));
  const publishBundlesByBuildId = await collectPublishBundlesByBuildId(publishIndex, manifestsByBuildId, projectsById);

  const curatedBuilds = await materializeCuratedBuilds({
    state,
    manifestsByBuildId,
    projectsById,
    promotionByBuildId,
    verificationByBuildId,
    releaseByBuildId,
    publishBundlesByBuildId,
  });

  return {
    repoRoot,
    paths,
    state,
    registry,
    buildIndex,
    verification,
    promotion,
    publishIndex,
    releaseIndex,
    projectsById,
    manifestsByBuildId,
    promotionByBuildId,
    verificationByBuildId,
    releaseByBuildId,
    publishBundlesByBuildId,
    curatedBuilds,
  };
}

export function summarizeBlockerCodes(entries, limit = 8) {
  const counts = new Map();
  for (const entry of toArray(entries)) {
    const code = entry?.code || entry?.rule_id || "unknown";
    const current = counts.get(code) || { code, message: entry?.message || entry?.summary || "", count: 0 };
    current.count += 1;
    counts.set(code, current);
  }
  return [...counts.values()]
    .sort((left, right) => right.count - left.count || String(left.code).localeCompare(String(right.code)))
    .slice(0, limit);
}

export function firstActionsForBuild(build) {
  const actions = [];
  const push = (value) => {
    const text = String(value || "").trim();
    if (text) actions.push(text);
  };

  for (const blocker of toArray(build.promotion?.blockers)) {
    switch (blocker.code) {
      case "verification.evidence":
        push("Replace review-only verification with real smoke/evidence artifacts.");
        break;
      case "clone.readiness":
        push("Reduce clone/manual-review gaps and tighten file_map plus post-clone checks.");
        break;
      case "release.status":
      case "release_not_published":
        push("Keep the release in draft until verification and private-publish review are strong enough to justify publishing.");
        break;
      case "publishing.publishable":
      case "publishing.visibility":
      case "not_marked_publishable":
        push("Do not toggle publishability yet; first remove leak blockers and finish verification evidence.");
        break;
      default:
        break;
    }
  }

  for (const finding of toArray(build.publishBundle?.top_blockers)) {
    switch (finding.rule_id) {
      case "absolute-local-path":
        push("Replace absolute local paths with artifact-local aliases or relative examples.");
        break;
      case "internal-url":
        push("Replace internal URLs with contract-safe placeholders or public examples.");
        break;
      case "secret-assignment":
        push("Move secret-like assignments behind env contracts and scrub inline values from reusable surfaces.");
        break;
      case "publish-policy-disabled":
        push("Keep publishing disabled until the private publish review is clean.");
        break;
      default:
        break;
    }
  }

  return uniqueStrings(actions).slice(0, 8);
}

async function materializeCuratedBuilds({
  state,
  manifestsByBuildId,
  projectsById,
  promotionByBuildId,
  verificationByBuildId,
  releaseByBuildId,
  publishBundlesByBuildId,
}) {
  const rows = [];
  for (const entry of toArray(state?.build_plane?.curated_builds)) {
    const buildId = entry.artifact_id;
    if (!buildId) continue;
    const manifestEntry = manifestsByBuildId.get(buildId) || null;
    const projectEntry = projectsById.get(String(entry.source_project || "")) || null;
    const promotionEntry = promotionByBuildId.get(buildId) || null;
    const verificationEntry = verificationByBuildId.get(buildId) || null;
    const releaseEntry = releaseByBuildId.get(buildId) || null;
    const publishBundle = publishBundlesByBuildId.get(buildId) || null;
    const sourceRoots = await resolveSourceRoots(manifestEntry?.manifest, projectEntry?.root);
    const leakHotspots = summarizeLeakHotspots(publishBundle?.report, sourceRoots);
    rows.push({
      ...entry,
      build_id: buildId,
      manifest: manifestEntry?.manifest || null,
      manifest_path: manifestEntry?.relativePath || entry.manifest_path || null,
      project_root: projectEntry?.root || null,
      project_state: (state.projects || []).find((project) => project.project === entry.source_project) || null,
      promotion: promotionEntry,
      verificationEntry,
      release: releaseEntry,
      publishBundle,
      source_roots: sourceRoots,
      leak_hotspots: leakHotspots,
      first_actions: firstActionsForBuild({
        promotion: promotionEntry,
        publishBundle,
      }),
    });
  }
  return rows.sort((left, right) => String(left.source_project || "").localeCompare(String(right.source_project || "")) || String(left.name || "").localeCompare(String(right.name || "")));
}

async function collectBuildManifests(rootPath) {
  const stat = await fs.stat(rootPath).catch(() => null);
  if (!stat || !stat.isDirectory()) return [];

  const files = [];
  async function walk(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".build.sweetspot.json")) {
        const manifest = await maybeReadJson(fullPath);
        files.push({
          absolutePath: fullPath,
          relativePath: relativeFromRepo(fullPath),
          buildId: manifest?.build?.id || null,
          manifest,
        });
      }
    }
  }

  await walk(rootPath);
  return files;
}

async function collectPublishBundlesByBuildId(publishIndex, manifestsByBuildId, projectsById) {
  const bundles = new Map();
  for (const bundle of toArray(publishIndex?.bundles)) {
    const buildId = bundle?.artifact?.original_id;
    if (!buildId) continue;
    const bundleDir = path.resolve(repoRoot, bundle.bundle_path || "");
    const report = await maybeReadJson(path.join(bundleDir, "publish-report.json"));
    const manifestEntry = manifestsByBuildId.get(buildId) || null;
    const projectRoot = projectsById.get(String(manifestEntry?.manifest?.source?.project || ""))?.root || null;
    const sourceRoots = await resolveSourceRoots(manifestEntry?.manifest, projectRoot);
    bundles.set(buildId, {
      ...bundle,
      report,
      bundle_dir: relativeFromRepo(bundleDir),
      resolved_findings: resolvePublishFindings(report, sourceRoots),
    });
  }
  return bundles;
}

async function resolveSourceRoots(manifest, projectRoot) {
  const roots = [];
  for (const declaredPath of toArray(manifest?.source?.paths)) {
    const absolutePath = path.isAbsolute(declaredPath)
      ? path.resolve(declaredPath)
      : projectRoot
        ? path.resolve(projectRoot, declaredPath)
        : null;
    const exists = absolutePath ? Boolean(await fs.stat(absolutePath).catch(() => null)) : false;
    const aliasMap = exists ? await buildAliasMapForPath(absolutePath, roots.length + 1) : new Map();
    roots.push({
      index: roots.length + 1,
      declared_path: declaredPath,
      absolute_path: absolutePath,
      exists,
      alias_map: aliasMap,
    });
  }
  return roots;
}

async function buildAliasMapForPath(rootPath, rootIndex) {
  const stat = await fs.stat(rootPath).catch(() => null);
  if (!stat) return new Map();
  const files = stat.isDirectory() ? await collectDirectoryFiles(rootPath) : [rootPath];
  const map = new Map();
  let fileIndex = 0;
  for (const filePath of files.sort((left, right) => left.localeCompare(right))) {
    const ext = path.extname(filePath).toLowerCase() || ".txt";
    const alias = `source/${String(rootIndex).padStart(3, "0")}/${String(fileIndex).padStart(4, "0")}${ext}`;
    map.set(alias, {
      actual_path: relativeFromRepo(filePath),
      absolute_path: filePath,
      root_relative_path: normalizePath(stat.isDirectory() ? path.relative(rootPath, filePath) : path.basename(filePath)),
    });
    fileIndex += 1;
  }
  return map;
}

async function collectDirectoryFiles(rootPath) {
  const output = [];
  async function walk(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(entryPath);
        continue;
      }
      if (entry.isFile()) output.push(entryPath);
    }
  }
  await walk(rootPath);
  return output;
}

function resolvePublishFindings(report, sourceRoots) {
  return toArray(report?.findings).map((finding) => {
    const location = String(finding?.location || "");
    const rootMatch = /^source\/(\d{3})\//.exec(location);
    let actualPath = null;
    let declaredRootPath = null;
    if (rootMatch) {
      const rootIndex = Number(rootMatch[1]);
      const root = sourceRoots[rootIndex - 1];
      const aliasEntry = root?.alias_map?.get(location) || null;
      actualPath = aliasEntry?.actual_path || null;
      declaredRootPath = root?.declared_path || null;
    }
    return {
      ...finding,
      actual_path: actualPath,
      declared_root_path: declaredRootPath,
    };
  });
}

function summarizeLeakHotspots(report, sourceRoots) {
  const counts = new Map();
  for (const finding of resolvePublishFindings(report, sourceRoots).filter((entry) => entry.scope === "source")) {
    const key = `${finding.rule_id || "unknown"}::${finding.actual_path || finding.location || "unknown"}`;
    const current = counts.get(key) || {
      rule_id: finding.rule_id || "unknown",
      summary: finding.summary || finding.message || "Finding recorded.",
      actual_path: finding.actual_path || null,
      declared_root_path: finding.declared_root_path || null,
      recommendation: finding.recommendation || null,
      count: 0,
      samples: [],
    };
    current.count += 1;
    if (current.samples.length < 3) current.samples.push(finding.evidence || "");
    counts.set(key, current);
  }

  return [...counts.values()]
    .sort((left, right) => right.count - left.count || String(left.actual_path || "").localeCompare(String(right.actual_path || "")))
    .slice(0, 12);
}
