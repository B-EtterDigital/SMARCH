#!/usr/bin/env node

/**
 * WHAT: Verifies curated build manifests, component bricks, checks, release evidence, and portability claims.
 * WHY: Promotion needs a current, machine-readable answer about whether a build is actually installable and release-backed.
 * HOW: Reads builds, the [registry](../docs/GLOSSARY.md#registry), and releases, then emits a report consumed by promotion and packet tools.
 * Usage: `node tools/sma-build-verify.ts --help`
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const DEFAULTS = {
  root: path.resolve(repoRoot, "builds"),
  registry: path.resolve(repoRoot, "scans/all-projects/latest.registry.json"),
  releases: path.resolve(repoRoot, "releases/release-index.generated.json"),
  maxChecks: 200,
};

const BUILD_ID_RE = /^[a-z0-9][a-z0-9._-]{2,120}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,120}$/;
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const SIGNAL_AREAS = ["readiness", "installability", "updateability", "publishability"];

const VERIFICATION_RANK = {
  unverified: 0,
  candidate: 1,
  verified: 2,
  canonical: 3,
};

const TRUST_RANK = {
  blocked: 0,
  low: 1,
  medium: 2,
  strong: 3,
  high: 4,
};

const BUILD_STATUS_RANK = {
  experimental: 0,
  candidate: 1,
  verified: 2,
  canonical: 3,
  deprecated: 1,
  unsafe: 0,
};

const TRUST_TIER_RANK = {
  experimental: 0,
  reviewed: 1,
  verified: 2,
  canonical: 3,
};

const HELP_TEXT = `SMARCH curated build verifier

Usage:
  node tools/sma-build-verify.ts [options]
  node tools/sma-build-verify.ts --manifest builds/acme-studio/ai-image-generation.build.sweetspot.json

Verify curated build manifests as real SMARCH assets. The verifier checks more
than JSON shape: registry linkage, source-path existence, brick coverage,
verification evidence, clone/update surfaces, release linkage, and publishing
readiness.

Options:
  --manifest <path>     Verify a specific build manifest. Repeat to verify many.
  --root <dir>          Root directory to scan for *.build.sweetspot.json files.
                        Default: builds
  --registry <file>     Merged registry snapshot to validate brick/project links.
                        Default: scans/all-projects/latest.registry.json
  --releases <file>     Optional release index for release-link and trust checks.
                        Default: releases/release-index.generated.json when present
  --no-releases         Skip release-index inspection entirely.
  --out <file>          Write the JSON report to this file.
  --max-checks <n>      Max detailed checks stored per build. Default: 200
  --compact             Omit per-check detail from the output.
  --stdout             Print JSON report to stdout.
  --help                Show this help text.

Examples:
  node tools/sma-build-verify.ts --stdout
  node tools/sma-build-verify.ts --manifest builds/<project>/<build>.build.sweetspot.json
  node tools/sma-build-verify.ts --root builds --out builds/build-verify.generated.json
`;

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const registryContext = await loadRegistryContext(options.registry);
  const releaseContext = await loadReleaseContext(options);
  const manifestFiles = options.manifests.length
    ? uniqStrings(options.manifests.map((value) => path.resolve(value)))
    : await collectBuildManifests(options.root);

  if (manifestFiles.length === 0) {
    throw new Error(`No build manifests found under ${options.root}`);
  }

  const builds = [];
  const skipped = [];

  for (const filePath of manifestFiles) {
    const parsed = await readJson(filePath);
    if (!parsed.ok) {
      skipped.push({
        path: relativeRepoPath(filePath),
        reason: "invalid_json",
        error: parsed.error,
      });
      continue;
    }
    builds.push(await verifyBuildManifest(parsed.value, filePath, {
      registryContext,
      releaseContext,
      maxChecks: options.maxChecks,
      compact: options.compact,
    }));
  }

  builds.sort((left, right) => compareStrings(left.build_id || left.path, right.build_id || right.path));
  skipped.sort((left, right) => compareStrings(left.path, right.path));

  const report: Record<string, any> = {
    schema_version: "1.0.0",
    kind: "smarch-build-verification-report",
    generated_at: new Date().toISOString(),
    root: relativeRepoPath(options.root),
    registry_path: relativeRepoPath(options.registry),
    release_index_path: releaseContext.path ? relativeRepoPath(releaseContext.path) : null,
    release_index_available: releaseContext.available,
    summary: summarizeBuildReports(builds, skipped, releaseContext),
    builds,
    skipped,
  };

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.stdout || !options.out) {
    process.stdout.write(json);
  }
  if (options.out) {
    await fs.mkdir(path.dirname(options.out), { recursive: true });
    await fs.writeFile(options.out, json, "utf8");
  }
}

function parseArgs(argv): Record<string, any> {
  const options: Record<string, any> = {
    ...DEFAULTS,
    manifests: [],
    noReleases: false,
    out: "",
    compact: false,
    stdout: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--manifest" && next) {
      options.manifests.push(next);
      i += 1;
    } else if (arg === "--root" && next) {
      options.root = path.resolve(next);
      i += 1;
    } else if (arg === "--registry" && next) {
      options.registry = path.resolve(next);
      i += 1;
    } else if (arg === "--releases" && next) {
      options.releases = path.resolve(next);
      i += 1;
    } else if (arg === "--out" && next) {
      options.out = path.resolve(next);
      i += 1;
    } else if (arg === "--max-checks" && next) {
      options.maxChecks = Math.max(0, Number.parseInt(next, 10) || DEFAULTS.maxChecks);
      i += 1;
    } else if (arg === "--compact") {
      options.compact = true;
    } else if (arg === "--stdout") {
      options.stdout = true;
    } else if (arg === "--no-releases") {
      options.noReleases = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

async function collectBuildManifests(root) {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat || !stat.isDirectory()) return [];
  const files = [];
  await walkDirectory(root, files);
  return files.sort(compareStrings);
}

async function walkDirectory(directory, files) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareStrings(left.name, right.name));
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(fullPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".build.sweetspot.json")) {
      files.push(fullPath);
    }
  }
}

async function readJson(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function loadRegistryContext(registryPath) {
  const parsed = await readJson(registryPath);
  if (!parsed.ok || !isObject(parsed.value)) {
    throw new Error(`Could not read merged registry at ${registryPath}`);
  }

  const registry = parsed.value;
  const bricksById = new Map();
  for (const brick of safeArray(registry.bricks)) {
    if (isObject(brick) && isNonEmptyString(brick.id)) {
      bricksById.set(brick.id, brick);
    }
  }

  const projectsByAlias = new Map();
  for (const project of safeArray(registry.projects)) {
    if (!isObject(project)) continue;
    const aliases = projectAliases(project);
    for (const alias of aliases) {
      projectsByAlias.set(alias, project);
    }
  }

  return { registry, bricksById, projectsByAlias };
}

async function loadReleaseContext(options) {
  if (options.noReleases) {
    return { available: false, path: null, byArtifactId: new Map() };
  }

  const releasePath = path.resolve(options.releases);
  if (!existsSync(releasePath)) {
    return { available: false, path: releasePath, byArtifactId: new Map() };
  }

  const parsed = await readJson(releasePath);
  if (!parsed.ok || !isObject(parsed.value)) {
    return { available: false, path: releasePath, byArtifactId: new Map(), error: parsed.error };
  }

  const byArtifactId = new Map();
  for (const artifact of collectReleaseArtifacts(parsed.value.artifacts)) {
    if (!isObject(artifact) || artifact.artifact_type !== "build" || !isNonEmptyString(artifact.artifact_id)) continue;
    byArtifactId.set(artifact.artifact_id, artifact);
  }

  return { available: true, path: releasePath, byArtifactId };
}

function collectReleaseArtifacts(artifacts) {
  if (Array.isArray(artifacts)) return artifacts;
  if (!isObject(artifacts)) return [];
  if (isObject(artifacts.build)) return Object.values(artifacts.build);
  return Object.values(artifacts);
}

function projectAliases(project) {
  const aliases = new Set();
  if (isNonEmptyString(project.id)) aliases.add(project.id.toLowerCase());
  if (isNonEmptyString(project.root)) {
    aliases.add(path.basename(project.root).toLowerCase());
    aliases.add(path.basename(path.dirname(project.root)).toLowerCase());
  }
  return [...aliases];
}

function lookupProject(projectsByAlias, ...candidates) {
  for (const candidate of candidates) {
    if (!isNonEmptyString(candidate)) continue;
    const project = projectsByAlias.get(candidate.trim().toLowerCase());
    if (project) return project;
  }
  return null;
}

function createRecorder(maxChecks) {
  const counts = { pass: 0, warn: 0, fail: 0 };
  const checks = [];
  let truncated = 0;

  function push(level, code, message, options: Record<string, any> = {}) {
    counts[level] += 1;
    const check: Record<string, any> = {
      level,
      code,
      message,
      areas: uniqStrings(options.areas || []),
    };
    if (options.detail && isObject(options.detail) && Object.keys(options.detail).length > 0) {
      check.detail = options.detail;
    }
    if (checks.length < maxChecks) {
      checks.push(check);
    } else {
      truncated += 1;
    }
  }

  return {
    counts,
    get checks() {
      return checks;
    },
    get truncated() {
      return truncated;
    },
    pass(code, message, options = {}) {
      push("pass", code, message, options);
    },
    warn(code, message, options = {}) {
      push("warn", code, message, options);
    },
    fail(code, message, options = {}) {
      push("fail", code, message, options);
    },
  };
}

async function verifyBuildManifest(document, filePath, options: Record<string, any>) {
  const recorder = createRecorder(options.maxChecks);
  const manifest = isObject(document) ? document : {};
  const build = isObject(manifest.build) ? manifest.build : {};
  const source = isObject(manifest.source) ? manifest.source : {};
  const composition = isObject(manifest.composition) ? manifest.composition : {};
  const interfaces = isObject(manifest.interfaces) ? manifest.interfaces : {};
  const contracts = isObject(manifest.contracts) ? manifest.contracts : {};
  const verification = isObject(manifest.verification) ? manifest.verification : {};
  const clone = isObject(manifest.clone) ? manifest.clone : {};
  const upgrade = isObject(manifest.upgrade) ? manifest.upgrade : {};
  const publishing = isObject(manifest.publishing) ? manifest.publishing : {};
  const economics = isObject(manifest.economics) ? manifest.economics : {};
  const provenance = isObject(manifest.provenance) ? manifest.provenance : {};
  const sweetspot = isObject(manifest.sweetspot) ? manifest.sweetspot : {};

  const buildId = safeString(build.id);
  const buildName = safeString(build.name);
  const buildVersion = safeString(build.version);
  const manifestPath = relativeRepoPath(filePath);
  const manifestDirName = path.basename(path.dirname(filePath));
  const sourceProject = safeString(source.project);
  const buildPrefix = buildProjectPrefix(buildId);
  const project = lookupProject(options.registryContext.projectsByAlias, sourceProject, buildPrefix, manifestDirName);
  const projectRoot = isNonEmptyString(project?.root) ? path.resolve(project.root) : "";
  const releaseArtifact = isNonEmptyString(buildId) ? options.releaseContext.byArtifactId.get(buildId) || null : null;

  validateTopLevelBlocks(recorder, manifest);
  validateBuildIdentity(recorder, build, filePath, sourceProject, buildPrefix);

  if (manifest.schema_version === "1.0.0") {
    recorder.pass("schema.version", "schema_version is 1.0.0");
  } else {
    recorder.fail("schema.version", `schema_version should be 1.0.0, got "${safeString(manifest.schema_version) || "missing"}"`, { areas: ["readiness"] });
  }

  if (project) {
    recorder.pass("registry.project.present", `Source project "${project.id}" exists in merged registry`, { areas: ["readiness", "installability"] });
  } else {
    recorder.fail("registry.project.missing", `Source project "${sourceProject || buildPrefix || manifestDirName || "unknown"}" is not present in merged registry`, {
      areas: ["readiness", "installability"],
      detail: { source_project: sourceProject, build_prefix: buildPrefix, manifest_directory: manifestDirName },
    });
  }

  const sourcePaths = uniqStrings(source.paths);
  if (sourcePaths.length > 0) {
    recorder.pass("source.paths.present", `${sourcePaths.length} source path(s) declared`, { areas: ["readiness"] });
  } else {
    recorder.fail("source.paths.missing", "Build must declare source.paths", { areas: ["readiness", "installability"] });
  }

  const missingSourcePaths = [];
  const existingSourcePaths = [];
  for (const sourcePath of sourcePaths) {
    const check = await verifySourcePath(sourcePath, projectRoot);
    if (check.exists) {
      existingSourcePaths.push(sourcePath);
      recorder.pass("source.path.exists", `Source path exists: ${sourcePath}`, { areas: ["readiness"], detail: { path: sourcePath } });
    } else {
      missingSourcePaths.push(sourcePath);
      recorder.fail("source.path.missing", `Source path does not exist: ${sourcePath}`, { areas: ["readiness", "installability"], detail: { path: sourcePath } });
    }
  }

  const compositionRefs = safeArray(composition.brick_refs).filter(isObject);
  const optionalRefs = safeArray(composition.optional_bricks).filter(isObject);
  const derivedRefs = safeArray(source.derived_from_bricks).filter(isObject);
  const compositionById = new Map();
  const compositionIds = [];
  const requiredCompositionIds = [];
  const referencedBricks = [];
  const registryStatusCounts = {};
  const registryCloneCounts = {};
  let registryScoreTotal = 0;
  let registryScoreCount = 0;
  let failingBrickCount = 0;
  let projectBoundCount = 0;
  let candidateOrBetterCount = 0;

  if (compositionRefs.length > 0) {
    recorder.pass("composition.refs.present", `${compositionRefs.length} primary brick ref(s) declared`, { areas: ["readiness", "installability"] });
  } else {
    recorder.fail("composition.refs.missing", "Build must declare at least one composition.brick_refs entry", { areas: ["readiness", "installability"] });
  }

  const seenRefIds = new Set();
  const seenRefOrders = new Set();
  for (const ref of compositionRefs) {
    const refId = safeString(ref.brick_id);
    if (!isNonEmptyString(refId)) {
      recorder.fail("composition.ref.id.missing", "Every composition brick ref needs brick_id", { areas: ["readiness", "installability"] });
      continue;
    }
    compositionIds.push(refId);
    compositionById.set(refId, ref);
    if (seenRefIds.has(refId)) {
      recorder.fail("composition.ref.duplicate", `Duplicate composition brick ref "${refId}"`, { areas: ["readiness"] });
    } else {
      seenRefIds.add(refId);
    }

    if (Number.isInteger(ref.order)) {
      if (seenRefOrders.has(ref.order)) {
        recorder.warn("composition.ref.order.duplicate", `Repeated brick ref order "${ref.order}"`, { areas: ["readiness"], detail: { brick_id: refId } });
      } else {
        seenRefOrders.add(ref.order);
      }
    } else {
      recorder.warn("composition.ref.order.missing", `Brick ref "${refId}" should declare an integer order`, { areas: ["readiness"], detail: { brick_id: refId } });
    }

    if (!isNonEmptyString(ref.role)) {
      recorder.warn("composition.ref.role.missing", `Brick ref "${refId}" should declare a role`, { areas: ["readiness"], detail: { brick_id: refId } });
    }
    if (!isNonEmptyString(ref.path)) {
      recorder.warn("composition.ref.path.missing", `Brick ref "${refId}" should declare a source path`, { areas: ["installability"], detail: { brick_id: refId } });
    }

    const required = ref.required !== false;
    if (required) requiredCompositionIds.push(refId);

    const registryBrick = options.registryContext.bricksById.get(refId);
    if (!registryBrick) {
      recorder.fail("registry.brick.missing", `Brick ref "${refId}" is not present in merged registry`, { areas: ["readiness", "installability"], detail: { brick_id: refId } });
      continue;
    }

    referencedBricks.push({ ref, registryBrick });
    recorder.pass("registry.brick.present", `Brick ref "${refId}" resolved in merged registry`, { areas: ["readiness"], detail: { brick_id: refId } });

    const status = safeString(registryBrick.status) || "unknown";
    incrementCounter(registryStatusCounts, status);
    if (status === "project_bound") {
      projectBoundCount += 1;
      recorder.warn("registry.brick.project_bound", `Brick ref "${refId}" is still project_bound`, { areas: ["readiness", "publishability"], detail: { brick_id: refId } });
    }
    if (status === "candidate" || status === "canonical") candidateOrBetterCount += 1;

    const cloneReadiness = safeString(registryBrick.clone_readiness) || "unknown";
    incrementCounter(registryCloneCounts, cloneReadiness);
    if (required && (cloneReadiness === "manual_only" || cloneReadiness === "blocked")) {
      recorder.warn("registry.brick.clone_readiness", `Required brick "${refId}" is ${cloneReadiness}`, { areas: ["installability"], detail: { brick_id: refId, clone_readiness: cloneReadiness } });
    }

    const healthStatus = safeString(registryBrick.health?.status) || "unknown";
    if (healthStatus === "fail") {
      failingBrickCount += 1;
      recorder.fail("registry.brick.health_fail", `Registry brick "${refId}" has failing health`, { areas: ["readiness", "installability"], detail: { brick_id: refId } });
    } else if ((registryBrick.health?.warning_count || 0) > 0) {
      recorder.warn("registry.brick.health_warn", `Registry brick "${refId}" carries scanner warnings`, { areas: ["readiness"], detail: { brick_id: refId, warning_count: registryBrick.health.warning_count } });
    }

    if (typeof registryBrick.score === "number") {
      registryScoreTotal += registryBrick.score;
      registryScoreCount += 1;
    }

    if (isNonEmptyString(ref.path) && !matchesSourcePath(ref.path, safeArray(registryBrick.source_paths))) {
      recorder.warn("registry.brick.path_mismatch", `Declared path for "${refId}" does not match registry source_paths`, {
        areas: ["installability"],
        detail: { brick_id: refId, manifest_path: ref.path, registry_paths: safeArray(registryBrick.source_paths) },
      });
    }
  }

  const derivedIds = uniqStrings(derivedRefs.map((ref) => ref.brick_id));
  const missingDerivedIds = requiredCompositionIds.filter((brickId) => !derivedIds.includes(brickId));
  const extraDerivedIds = derivedIds.filter((brickId) => !compositionIds.includes(brickId));
  if (missingDerivedIds.length === 0 && extraDerivedIds.length === 0 && derivedIds.length > 0) {
    recorder.pass("source.derived_from_bricks.aligned", "source.derived_from_bricks aligns with composition brick refs", { areas: ["readiness"] });
  } else {
    if (missingDerivedIds.length > 0) {
      recorder.warn("source.derived_from_bricks.missing", "Some required composition bricks are not represented in source.derived_from_bricks", {
        areas: ["readiness"],
        detail: { brick_ids: missingDerivedIds },
      });
    }
    if (extraDerivedIds.length > 0) {
      recorder.warn("source.derived_from_bricks.extra", "source.derived_from_bricks includes bricks not present in composition.brick_refs", {
        areas: ["readiness"],
        detail: { brick_ids: extraDerivedIds },
      });
    }
  }

  const flowSummary = validateFlows(recorder, compositionById, safeArray(composition.flows));
  for (const missingBrickId of requiredCompositionIds.filter((brickId) => !flowSummary.usedBrickIds.has(brickId))) {
    recorder.warn("composition.flow.coverage", `Required brick "${missingBrickId}" is not referenced by any flow step`, {
      areas: ["readiness", "installability"],
      detail: { brick_id: missingBrickId },
    });
  }

  const interfaceSummary = validateInterfaces(recorder, interfaces, verification);
  const contractSummary = validateContracts(recorder, contracts, manifest.classification, build);
  const cloneSummary = validateCloneSurface(recorder, clone, {
    sourcePaths,
    requiredRefs: compositionRefs.filter((entry) => entry.required !== false),
    optionalRefs,
  });
  const upgradeSummary = validateUpgradeSurface(recorder, upgrade);
  const publishingSummary = validatePublishingSurface(recorder, publishing, build);
  validateEconomics(recorder, economics);
  validateProvenance(recorder, provenance, compositionIds);
  validateSweetspot(recorder, sweetspot, build);
  validateVerification(recorder, verification, build);

  const releaseSummary = validateReleaseLink(recorder, releaseArtifact, options.releaseContext, {
    buildId,
    buildVersion,
    buildStatus: safeString(build.status),
    requiredEnvCount: contractSummary.requiredEnvCount,
    sourcePathCount: sourcePaths.length,
  });

  const registrySummary = {
    source_project_found: Boolean(project),
    source_project_id: project?.id || sourceProject || buildPrefix || null,
    source_root: projectRoot ? relativeRepoPath(projectRoot) : null,
    source_path_count: sourcePaths.length,
    existing_source_path_count: existingSourcePaths.length,
    missing_source_paths: missingSourcePaths,
    referenced_brick_count: referencedBricks.length,
    missing_brick_count: compositionRefs.length - referencedBricks.length,
    required_brick_count: requiredCompositionIds.length,
    required_ready_brick_count: referencedBricks.filter(({ ref, registryBrick }) => ref.required !== false && safeString(registryBrick.clone_readiness) !== "blocked" && safeString(registryBrick.clone_readiness) !== "manual_only").length,
    average_brick_score: registryScoreCount ? Math.round(registryScoreTotal / registryScoreCount) : 0,
    status_counts: registryStatusCounts,
    clone_readiness_counts: registryCloneCounts,
    project_bound_member_count: projectBoundCount,
    candidate_or_better_member_count: candidateOrBetterCount,
    failing_member_count: failingBrickCount,
  };

  const publishabilitySignal = buildSignal("publishability", recorder.checks, {
    forceBlocked: publishing.publishable !== true,
  });
  const installabilitySignal = buildSignal("installability", recorder.checks, {
    forceBlocked: cloneSummary.requiredMappingMissingCount > 0 || registrySummary.missing_brick_count > 0 || missingSourcePaths.length > 0,
  });
  const updateabilitySignal = buildSignal("updateability", recorder.checks, {
    forceBlocked: upgradeSummary.missingCriticalFields > 0,
  });
  const readinessSignal = buildSignal("readiness", recorder.checks, {
    forceBlocked: registrySummary.missing_brick_count > 0 || missingSourcePaths.length > 0 || recorder.checks.some((check) => check.level === "fail" && check.areas.includes("readiness")),
  });

  const suggestedVerificationStatus = suggestVerificationStatus({
    build,
    verification,
    provenance,
    recorder,
    releaseSummary,
    registrySummary,
    installabilitySignal,
    updateabilitySignal,
    readinessSignal,
  });
  const suggestedTrustLevel = suggestTrustLevel({
    suggestedVerificationStatus,
    recorder,
    releaseSummary,
  });

  const topBlockers = topIssues(recorder.checks, 6);
  const booleans = {
    ready_for_adoption: readinessSignal.status !== "blocked" && installabilitySignal.status !== "blocked" && VERIFICATION_RANK[suggestedVerificationStatus] >= VERIFICATION_RANK.candidate,
    installable: installabilitySignal.status !== "blocked",
    updateable: updateabilitySignal.status !== "blocked",
    publishable: publishabilitySignal.status === "ready",
  };

  const report: Record<string, any> = {
    path: manifestPath,
    build_id: buildId || null,
    name: buildName || null,
    version: buildVersion || null,
    source_project: sourceProject || buildPrefix || null,
    declared_status: safeString(build.status) || null,
    declared_trust_tier: safeString(build.trust_tier) || null,
    counts: recorder.counts,
    verification: {
      declared_status: safeString(verification.status) || null,
      suggested_status: suggestedVerificationStatus,
      suggested_trust_level: suggestedTrustLevel,
    },
    signals: {
      readiness: readinessSignal,
      installability: installabilitySignal,
      updateability: updateabilitySignal,
      publishability: publishabilitySignal,
    },
    booleans,
    registry: registrySummary,
    release: releaseSummary,
    top_blockers: topBlockers,
  };

  if (!options.compact) {
    report.checks = recorder.checks;
    report.checks_truncated = recorder.truncated;
  }

  return report;
}

function validateTopLevelBlocks(recorder, manifest) {
  const requiredObjectBlocks = ["build", "source", "owner", "composition", "classification", "sweetspot", "interfaces", "contracts", "verification", "clone", "upgrade", "publishing", "economics", "provenance"];
  for (const key of requiredObjectBlocks) {
    if (isObject(manifest[key])) {
      recorder.pass("manifest.block.present", `Top-level "${key}" block present`, { areas: ["readiness"], detail: { block: key } });
    } else {
      recorder.fail("manifest.block.missing", `Top-level "${key}" block is required`, { areas: ["readiness"], detail: { block: key } });
    }
  }
}

function validateBuildIdentity(recorder, build, filePath, sourceProject, buildPrefix) {
  if (!isNonEmptyString(build.id)) {
    recorder.fail("build.id.missing", "build.id is required", { areas: ["readiness"] });
  } else if (!BUILD_ID_RE.test(build.id)) {
    recorder.fail("build.id.invalid", `build.id "${build.id}" is not registry-safe`, { areas: ["readiness"] });
  } else {
    recorder.pass("build.id.valid", `build.id "${build.id}" looks valid`, { areas: ["readiness"] });
  }

  if (!safeString(build.id).includes(".build.")) {
    recorder.fail("build.id.prefix", "build.id should include '.build.' to mark first-class builds", { areas: ["readiness"] });
  } else {
    recorder.pass("build.id.prefix", "build.id carries the build prefix", { areas: ["readiness"] });
  }

  if (isNonEmptyString(build.name)) recorder.pass("build.name.present", "build.name present", { areas: ["readiness"] });
  else recorder.fail("build.name.missing", "build.name is required", { areas: ["readiness"] });

  if (isNonEmptyString(build.slug) && SLUG_RE.test(build.slug)) {
    recorder.pass("build.slug.valid", `build.slug "${build.slug}" looks valid`, { areas: ["readiness"] });
    const expectedName = `${build.slug}.build.sweetspot.json`;
    if (path.basename(filePath) === expectedName) {
      recorder.pass("build.file.matches_slug", "Manifest filename matches build.slug", { areas: ["readiness"] });
    } else {
      recorder.warn("build.file.slug_mismatch", `Manifest filename should usually be "${expectedName}"`, {
        areas: ["readiness"],
        detail: { filename: path.basename(filePath), expected: expectedName },
      });
    }
  } else {
    recorder.fail("build.slug.invalid", "build.slug is missing or invalid", { areas: ["readiness"] });
  }

  if (isNonEmptyString(build.version) && SEMVER_RE.test(build.version)) {
    recorder.pass("build.version.valid", `build.version "${build.version}" is semver-like`, { areas: ["readiness", "updateability"] });
  } else {
    recorder.fail("build.version.invalid", `build.version "${safeString(build.version) || "missing"}" is not semver`, { areas: ["readiness", "updateability"] });
  }

  if (isNonEmptyString(sourceProject) && isNonEmptyString(buildPrefix)) {
    if (sourceProject === buildPrefix) {
      recorder.pass("build.project_prefix.aligned", "build.id prefix aligns with source.project", { areas: ["readiness"] });
    } else {
      recorder.warn("build.project_prefix.mismatch", `build.id prefix "${buildPrefix}" does not match source.project "${sourceProject}"`, {
        areas: ["readiness"],
        detail: { source_project: sourceProject, build_prefix: buildPrefix },
      });
    }
  }

  const buildDir = path.basename(path.dirname(filePath));
  if (isNonEmptyString(sourceProject) && buildDir === sourceProject) {
    recorder.pass("build.directory.aligned", "Build directory matches source.project", { areas: ["readiness"] });
  } else if (isNonEmptyString(sourceProject)) {
    recorder.warn("build.directory.mismatch", `Build directory "${buildDir}" does not match source.project "${sourceProject}"`, {
      areas: ["readiness"],
      detail: { build_directory: buildDir, source_project: sourceProject },
    });
  }

  const declaredStatus = safeString(build.status);
  const trustTier = safeString(build.trust_tier);
  if (declaredStatus) recorder.pass("build.status.present", `build.status "${declaredStatus}" declared`, { areas: ["readiness"] });
  else recorder.fail("build.status.missing", "build.status is required", { areas: ["readiness"] });

  if (trustTier) recorder.pass("build.trust_tier.present", `build.trust_tier "${trustTier}" declared`, { areas: ["readiness"] });
  else recorder.warn("build.trust_tier.missing", "build.trust_tier should be declared", { areas: ["readiness"] });

  if (BUILD_STATUS_RANK[declaredStatus] !== undefined && TRUST_TIER_RANK[trustTier] !== undefined && TRUST_TIER_RANK[trustTier] + 1 < BUILD_STATUS_RANK[declaredStatus]) {
    recorder.fail("build.status_trust_mismatch", `build.status "${declaredStatus}" is stronger than build.trust_tier "${trustTier}"`, { areas: ["readiness"] });
  }
}

async function verifySourcePath(sourcePath, projectRoot) {
  if (!isNonEmptyString(sourcePath)) return { exists: false };
  if (!projectRoot) return { exists: false };
  if (path.isAbsolute(sourcePath)) return { exists: false };
  const resolved = path.resolve(projectRoot, sourcePath);
  if (!resolved.startsWith(projectRoot)) return { exists: false };
  return { exists: await pathExists(resolved), resolved };
}

function validateFlows(recorder, compositionById, flows) {
  const usedBrickIds = new Set();

  if (flows.length === 0) {
    recorder.fail("composition.flows.missing", "Build should declare at least one composition flow", { areas: ["readiness", "installability"] });
    return { usedBrickIds };
  }

  recorder.pass("composition.flows.present", `${flows.length} flow(s) declared`, { areas: ["readiness"] });

  const seenFlowIds = new Set();
  for (const flow of flows) {
    const flowId = safeString(flow?.id);
    if (!flowId) {
      recorder.fail("composition.flow.id.missing", "Every flow needs an id", { areas: ["readiness"] });
      continue;
    }
    if (seenFlowIds.has(flowId)) {
      recorder.fail("composition.flow.id.duplicate", `Duplicate flow id "${flowId}"`, { areas: ["readiness"] });
    } else {
      seenFlowIds.add(flowId);
    }

    const steps = safeArray(flow?.steps).filter(isObject);
    if (steps.length === 0) {
      recorder.fail("composition.flow.steps.missing", `Flow "${flowId}" must declare steps`, { areas: ["readiness", "installability"], detail: { flow_id: flowId } });
      continue;
    }

    const seenStepIds = new Set();
    let previousOrder = -Infinity;
    for (const step of steps) {
      const stepId = safeString(step.id);
      if (!stepId) {
        recorder.fail("composition.step.id.missing", `Flow "${flowId}" contains a step without id`, { areas: ["readiness"], detail: { flow_id: flowId } });
      } else if (seenStepIds.has(stepId)) {
        recorder.fail("composition.step.id.duplicate", `Flow "${flowId}" repeats step id "${stepId}"`, { areas: ["readiness"], detail: { flow_id: flowId, step_id: stepId } });
      } else {
        seenStepIds.add(stepId);
      }

      if (!Number.isInteger(step.order)) {
        recorder.warn("composition.step.order.missing", `Flow "${flowId}" step "${stepId || "unknown"}" should declare integer order`, {
          areas: ["readiness"],
          detail: { flow_id: flowId, step_id: stepId },
        });
      } else if (step.order < previousOrder) {
        recorder.warn("composition.step.order.unsorted", `Flow "${flowId}" step "${stepId}" is out of order`, {
          areas: ["readiness"],
          detail: { flow_id: flowId, step_id: stepId, order: step.order, previous_order: previousOrder },
        });
        previousOrder = step.order;
      } else {
        previousOrder = step.order;
      }

      const stepBrickRefs = uniqStrings(step.brick_refs);
      if (stepBrickRefs.length === 0) {
        recorder.warn("composition.step.refs.missing", `Flow "${flowId}" step "${stepId || "unknown"}" should reference one or more brick refs`, {
          areas: ["readiness", "installability"],
          detail: { flow_id: flowId, step_id: stepId },
        });
      }

      for (const brickId of stepBrickRefs) {
        if (!compositionById.has(brickId)) {
          recorder.fail("composition.step.refs.unknown", `Flow "${flowId}" step "${stepId || "unknown"}" references unknown brick "${brickId}"`, {
            areas: ["readiness", "installability"],
            detail: { flow_id: flowId, step_id: stepId, brick_id: brickId },
          });
        } else {
          usedBrickIds.add(brickId);
        }
      }
    }
  }

  return { usedBrickIds };
}

function validateInterfaces(recorder, interfaces, verification) {
  const entrypoints = uniqStrings(interfaces.entrypoints);
  const apiEndpoints = uniqStrings(interfaces.api_endpoints);
  const commands = uniqStrings(interfaces.commands);
  const smokeCommands = uniqStrings(verification.smoke_commands);

  if (entrypoints.length + apiEndpoints.length + commands.length > 0) {
    recorder.pass("interfaces.surface.present", "Interfaces expose entrypoints, api_endpoints, or commands", { areas: ["readiness", "installability"] });
  } else {
    recorder.fail("interfaces.surface.missing", "Build needs at least one interface surface, endpoint, or command", { areas: ["readiness", "installability"] });
  }

  if (commands.length > 0 && smokeCommands.some((command) => commands.includes(command))) {
    recorder.pass("interfaces.commands.linked", "Interface commands overlap with verification smoke commands", { areas: ["readiness"] });
  } else if (commands.length > 0 && smokeCommands.length > 0) {
    recorder.warn("interfaces.commands.unlinked", "Interface commands and verification smoke commands do not overlap", { areas: ["readiness"] });
  }

  return { entrypoints, apiEndpoints, commands };
}

function validateContracts(recorder, contracts, classification, build) {
  const env = isObject(contracts.env) ? contracts.env : {};
  const rls = isObject(contracts.rls) ? contracts.rls : {};
  const auth = isObject(contracts.auth) ? contracts.auth : {};
  const network = isObject(contracts.network) ? contracts.network : {};
  const performance = isObject(contracts.performance) ? contracts.performance : {};
  const requiredEnv = safeArray(env.required).filter(isObject);
  const optionalEnv = safeArray(env.optional).filter(isObject);

  if (requiredEnv.length > 0 || optionalEnv.length > 0) {
    recorder.pass("contracts.env.present", `Build declares ${requiredEnv.length} required and ${optionalEnv.length} optional env var(s)`, { areas: ["installability", "publishability"] });
  } else {
    recorder.warn("contracts.env.missing", "Build does not declare any environment contract", { areas: ["installability", "publishability"] });
  }

  for (const item of requiredEnv) {
    if (isNonEmptyString(item.name)) {
      recorder.pass("contracts.env.required_entry", `Required env "${item.name}" declared`, { areas: ["installability"] });
    } else {
      recorder.fail("contracts.env.required_invalid", "Required env entry missing name", { areas: ["installability", "publishability"] });
    }
  }

  if (auth.required === true) {
    if (uniqStrings(auth.roles).length === 0 || uniqStrings(auth.modes).length === 0) {
      recorder.warn("contracts.auth.thin", "Auth contract is marked required but roles or modes are missing", { areas: ["readiness", "installability"] });
    } else {
      recorder.pass("contracts.auth.defined", "Auth contract declares modes and roles", { areas: ["installability"] });
    }
  }

  const buildRisk = safeString(classification?.risk) || safeString(build?.risk);
  const rlsStatus = safeString(rls.status);
  if (rls.required === true) {
    if (!rlsStatus) {
      recorder.fail("contracts.rls.status_missing", "RLS is required but contracts.rls.status is missing", { areas: ["readiness", "publishability"] });
    } else if (rlsStatus === "missing") {
      const level = buildRisk === "critical" || buildRisk === "high" ? "fail" : "warn";
      recorder[level]("contracts.rls.missing", "RLS is required but still marked missing", { areas: ["readiness", "publishability"] });
    } else if (rlsStatus === "partial") {
      recorder.warn("contracts.rls.partial", "RLS is required but still partial", { areas: ["readiness", "publishability"] });
    } else {
      recorder.pass("contracts.rls.defined", `RLS contract status is "${rlsStatus}"`, { areas: ["readiness", "publishability"] });
    }

    if (uniqStrings(rls.negative_tests).length === 0) {
      recorder.warn("contracts.rls.negative_tests_missing", "RLS contract should include negative tests", { areas: ["readiness", "publishability"] });
    }
  }

  if (uniqStrings(network.inbound_endpoints).length > 0 || uniqStrings(network.outbound_hosts).length > 0) {
    recorder.pass("contracts.network.present", "Network contract declares inbound or outbound surfaces", { areas: ["installability", "publishability"] });
  }

  if (typeof performance.latency_budget_ms === "number" && performance.latency_budget_ms > 0) {
    recorder.pass("contracts.performance.latency_budget", "Performance contract includes latency budget", { areas: ["readiness"] });
  } else {
    recorder.warn("contracts.performance.latency_budget_missing", "Performance contract should include latency budget", { areas: ["readiness"] });
  }

  return {
    requiredEnvCount: requiredEnv.length,
  };
}

function validateVerification(recorder, verification, build) {
  const smokeCommands = uniqStrings(verification.smoke_commands);
  const fixtureTargets = uniqStrings(verification.fixture_targets);
  const integrationTargets = uniqStrings(verification.integration_targets);
  const evidence = safeArray(verification.evidence).filter(isObject);
  const status = safeString(verification.status);

  if (status) recorder.pass("verification.status.present", `verification.status "${status}" declared`, { areas: ["readiness"] });
  else recorder.warn("verification.status.missing", "verification.status should be declared", { areas: ["readiness"] });

  if (smokeCommands.length + fixtureTargets.length > 0) {
    recorder.pass("verification.execution_surface", "Build declares smoke commands or fixture targets", { areas: ["readiness", "installability"] });
  } else {
    recorder.fail("verification.execution_surface_missing", "Build should declare at least one smoke command or fixture target", { areas: ["readiness", "installability"] });
  }

  if (integrationTargets.length > 0) {
    recorder.pass("verification.integration_targets", `${integrationTargets.length} integration target(s) declared`, { areas: ["readiness"] });
  } else {
    recorder.warn("verification.integration_targets_missing", "Build should declare integration targets", { areas: ["readiness"] });
  }

  if (evidence.length > 0) {
    recorder.pass("verification.evidence.present", `${evidence.length} evidence record(s) declared`, { areas: ["readiness"] });
  } else {
    recorder.warn("verification.evidence.missing", "Build should declare evidence records", { areas: ["readiness"] });
  }

  const declaredStatus = safeString(build.status);
  const verifiedEvidenceCount = evidence.filter((entry) => verificationEvidenceRank(entry.status) >= VERIFICATION_RANK.verified).length;
  if ((declaredStatus === "verified" || declaredStatus === "canonical") && verifiedEvidenceCount === 0) {
    recorder.fail("verification.evidence.too_weak", `Build status "${declaredStatus}" needs verified evidence, not only planned evidence`, { areas: ["readiness", "publishability"] });
  }
}

function validateCloneSurface(recorder, clone, { sourcePaths, requiredRefs, optionalRefs }) {
  const fileMap = safeArray(clone.file_map).filter(isObject);
  const fileMapSourcePaths = uniqStrings(fileMap.map((entry) => entry.source_path));
  const installSteps = uniqStrings(clone.install_steps);
  const postCloneChecks = uniqStrings(clone.post_clone_checks);
  const rollbackSteps = uniqStrings(clone.rollback_steps);
  const requiredPorts = uniqStrings(clone.required_ports);

  if (safeString(clone.readiness)) recorder.pass("clone.readiness.present", `clone.readiness "${clone.readiness}" declared`, { areas: ["installability"] });
  else recorder.fail("clone.readiness.missing", "clone.readiness is required", { areas: ["installability"] });

  if (fileMap.length > 0) recorder.pass("clone.file_map.present", `${fileMap.length} file_map entry(ies) declared`, { areas: ["installability", "updateability"] });
  else recorder.fail("clone.file_map.missing", "clone.file_map is required for installable build assets", { areas: ["installability", "updateability"] });

  if (installSteps.length > 0) recorder.pass("clone.install_steps.present", `${installSteps.length} install step(s) declared`, { areas: ["installability"] });
  else recorder.fail("clone.install_steps.missing", "clone.install_steps are required", { areas: ["installability"] });

  if (postCloneChecks.length > 0) recorder.pass("clone.post_clone_checks.present", `${postCloneChecks.length} post-clone check(s) declared`, { areas: ["installability"] });
  else recorder.fail("clone.post_clone_checks.missing", "clone.post_clone_checks are required", { areas: ["installability"] });

  if (rollbackSteps.length > 0) recorder.pass("clone.rollback_steps.present", `${rollbackSteps.length} rollback step(s) declared`, { areas: ["updateability"] });
  else recorder.fail("clone.rollback_steps.missing", "clone.rollback_steps are required for build updates", { areas: ["updateability"] });

  if (requiredPorts.length > 0) recorder.pass("clone.required_ports.present", `${requiredPorts.length} required port(s) declared`, { areas: ["installability", "updateability"] });
  else recorder.warn("clone.required_ports.missing", "clone.required_ports should be declared", { areas: ["installability", "updateability"] });

  let requiredMappingMissingCount = 0;
  for (const ref of requiredRefs) {
    const refPath = safeString(ref.path);
    if (!refPath) continue;
    if (pathCoveredByFileMap(refPath, fileMapSourcePaths)) {
      recorder.pass("clone.file_map.required_covered", `Required ref path "${refPath}" is covered by clone.file_map`, { areas: ["installability"], detail: { path: refPath } });
    } else {
      requiredMappingMissingCount += 1;
      recorder.fail("clone.file_map.required_missing", `Required ref path "${refPath}" is not covered by clone.file_map`, { areas: ["installability"], detail: { path: refPath } });
    }
  }

  for (const ref of optionalRefs) {
    const refPath = safeString(ref.path);
    if (!refPath) continue;
    if (!pathCoveredByFileMap(refPath, fileMapSourcePaths)) {
      recorder.warn("clone.file_map.optional_missing", `Optional ref path "${refPath}" is not covered by clone.file_map`, { areas: ["installability"], detail: { path: refPath } });
    }
  }

  for (const sourcePath of sourcePaths) {
    if (!pathCoveredByFileMap(sourcePath, fileMapSourcePaths)) {
      recorder.warn("clone.file_map.source_path_missing", `Declared source path "${sourcePath}" is not represented in clone.file_map`, {
        areas: ["installability"],
        detail: { path: sourcePath },
      });
    }
  }

  return { requiredMappingMissingCount };
}

function validateUpgradeSurface(recorder, upgrade) {
  let missingCriticalFields = 0;

  if (safeString(upgrade.channel)) recorder.pass("upgrade.channel.present", `upgrade.channel "${upgrade.channel}" declared`, { areas: ["updateability"] });
  else {
    missingCriticalFields += 1;
    recorder.fail("upgrade.channel.missing", "upgrade.channel is required", { areas: ["updateability"] });
  }

  if (safeString(upgrade.compatibility_policy)) recorder.pass("upgrade.compatibility_policy.present", "upgrade.compatibility_policy declared", { areas: ["updateability"] });
  else {
    missingCriticalFields += 1;
    recorder.fail("upgrade.compatibility_policy.missing", "upgrade.compatibility_policy is required", { areas: ["updateability"] });
  }

  if (typeof upgrade.rollback_supported === "boolean") {
    if (upgrade.rollback_supported) recorder.pass("upgrade.rollback_supported", "upgrade.rollback_supported is true", { areas: ["updateability"] });
    else recorder.warn("upgrade.rollback_supported.false", "upgrade.rollback_supported is false", { areas: ["updateability"] });
  } else {
    missingCriticalFields += 1;
    recorder.fail("upgrade.rollback_supported.missing", "upgrade.rollback_supported should be explicit", { areas: ["updateability"] });
  }

  if (uniqStrings(upgrade.migration_hooks).length > 0) recorder.pass("upgrade.migration_hooks.present", "upgrade.migration_hooks declared", { areas: ["updateability"] });
  else recorder.warn("upgrade.migration_hooks.missing", "upgrade.migration_hooks should be declared", { areas: ["updateability"] });

  if (uniqStrings(upgrade.breaking_change_signals).length > 0) recorder.pass("upgrade.breaking_change_signals.present", "upgrade.breaking_change_signals declared", { areas: ["updateability"] });
  else recorder.warn("upgrade.breaking_change_signals.missing", "upgrade.breaking_change_signals should be declared", { areas: ["updateability"] });

  return { missingCriticalFields };
}

function validatePublishingSurface(recorder, publishing, build) {
  const publishable = publishing.publishable;
  const visibility = safeString(publishing.visibility || build.visibility);
  const exposedDocs = uniqStrings(publishing.exposed_docs);
  const excludedAssets = uniqStrings(publishing.excluded_assets);

  if (typeof publishable !== "boolean") {
    recorder.fail("publishing.publishable.missing", "publishing.publishable must be true or false", { areas: ["publishability"] });
  } else if (publishable) {
    recorder.pass("publishing.publishable.enabled", "Build is marked publishable", { areas: ["publishability"] });
  } else {
    recorder.warn("publishing.publishable.disabled", "Build is explicitly not publishable outside the private pool", { areas: ["publishability"] });
  }

  if (isNonEmptyString(visibility)) {
    recorder.pass("publishing.visibility.present", `publishing.visibility "${visibility}" declared`, { areas: ["publishability"] });
  } else {
    recorder.fail("publishing.visibility.missing", "publishing.visibility is required", { areas: ["publishability"] });
  }

  if (publishable === true && visibility === "private") {
    recorder.fail("publishing.visibility_conflict", "Build cannot be publishable while publishing.visibility is private", { areas: ["publishability"] });
  }

  if (publishable === true && !isNonEmptyString(publishing.redaction_profile)) {
    recorder.fail("publishing.redaction_profile.missing", "Publishable builds need publishing.redaction_profile", { areas: ["publishability"] });
  } else if (isNonEmptyString(publishing.redaction_profile)) {
    recorder.pass("publishing.redaction_profile.present", "publishing.redaction_profile declared", { areas: ["publishability"] });
  }

  if (publishable === true && exposedDocs.length === 0) {
    recorder.warn("publishing.exposed_docs.missing", "Publishable builds should expose sanitized docs", { areas: ["publishability"] });
  } else if (exposedDocs.length > 0) {
    recorder.pass("publishing.exposed_docs.present", `${exposedDocs.length} exposed doc descriptor(s) declared`, { areas: ["publishability"] });
  }

  if (publishable === true && excludedAssets.length === 0) {
    recorder.warn("publishing.excluded_assets.missing", "Publishable builds should declare excluded assets", { areas: ["publishability"] });
  } else if (excludedAssets.length > 0) {
    recorder.pass("publishing.excluded_assets.present", `${excludedAssets.length} excluded asset rule(s) declared`, { areas: ["publishability"] });
  }

  if (publishable === true && (visibility === "community" || visibility === "public") && safeString(publishing.license) === "private") {
    recorder.fail("publishing.license_conflict", "Community/public publishable builds need a non-private license declaration", { areas: ["publishability"] });
  }

  return { publishable: publishable === true };
}

function validateEconomics(recorder, economics) {
  if (Number(economics.estimated_prompt_token_savings || 0) > 0) recorder.pass("economics.token_savings.present", "economics.estimated_prompt_token_savings is positive", { areas: ["readiness"] });
  else recorder.warn("economics.token_savings.missing", "economics.estimated_prompt_token_savings should be positive", { areas: ["readiness"] });

  if (Number(economics.estimated_clone_time_minutes || 0) > 0) recorder.pass("economics.clone_time.present", "economics.estimated_clone_time_minutes is positive", { areas: ["installability"] });
  else recorder.warn("economics.clone_time.missing", "economics.estimated_clone_time_minutes should be positive", { areas: ["installability"] });

  if (Number(economics.estimated_update_time_minutes || 0) > 0) recorder.pass("economics.update_time.present", "economics.estimated_update_time_minutes is positive", { areas: ["updateability"] });
  else recorder.warn("economics.update_time.missing", "economics.estimated_update_time_minutes should be positive", { areas: ["updateability"] });

  const maintenanceScore = Number(economics.maintenance_score || 0);
  if (maintenanceScore >= 70) recorder.pass("economics.maintenance_score.strong", `maintenance_score ${maintenanceScore} is strong`, { areas: ["readiness"] });
  else if (maintenanceScore >= 50) recorder.warn("economics.maintenance_score.review", `maintenance_score ${maintenanceScore} needs review`, { areas: ["readiness"] });
  else recorder.warn("economics.maintenance_score.low", `maintenance_score ${maintenanceScore} is low`, { areas: ["readiness"] });
}

function validateProvenance(recorder, provenance, compositionIds) {
  if (isObject(provenance.created_by) && isNonEmptyString(provenance.created_by.actor_id) && isNonEmptyString(provenance.created_by.timestamp)) {
    recorder.pass("provenance.created_by.present", "provenance.created_by is recorded", { areas: ["readiness", "publishability"] });
  } else {
    recorder.fail("provenance.created_by.missing", "provenance.created_by must record who created the build", { areas: ["readiness", "publishability"] });
  }

  const touchedBy = safeArray(provenance.touched_by).filter(isObject);
  if (touchedBy.length > 0) recorder.pass("provenance.touched_by.present", `${touchedBy.length} provenance.touched_by event(s) recorded`, { areas: ["readiness"] });
  else recorder.warn("provenance.touched_by.missing", "provenance.touched_by should record major edits", { areas: ["readiness"] });

  const sourceChain = safeArray(provenance.source_chain).filter(isObject);
  if (sourceChain.length === 0) {
    recorder.fail("provenance.source_chain.missing", "provenance.source_chain is required", { areas: ["readiness", "publishability"] });
    return;
  }

  recorder.pass("provenance.source_chain.present", `${sourceChain.length} source-chain event(s) recorded`, { areas: ["readiness", "publishability"] });
  const sourceIds = new Set(uniqStrings(sourceChain.map((entry) => entry.artifact_id)));
  const missingRefs = compositionIds.filter((brickId) => !sourceIds.has(brickId));
  if (missingRefs.length > 0) {
    recorder.warn("provenance.source_chain.incomplete", "Some composition bricks are not represented in provenance.source_chain", {
      areas: ["readiness", "publishability"],
      detail: { brick_ids: missingRefs },
    });
  }
}

function validateSweetspot(recorder, sweetspot, build) {
  const gates = ["ssa_v2", "ssi", "sstf", "spe", "srs", "ssra", "sas", "sva", "srls", "sev", "ssc", "sai"];
  let totalScore = 0;
  let scoreCount = 0;
  let missingCriticalGates = 0;

  for (const gate of gates) {
    const record = isObject(sweetspot[gate]) ? sweetspot[gate] : null;
    if (!record) {
      recorder.fail("sweetspot.gate.missing", `sweetspot.${gate} is required`, { areas: ["readiness"], detail: { gate } });
      continue;
    }
    if (typeof record.score === "number") {
      totalScore += record.score;
      scoreCount += 1;
    }
    if (!isNonEmptyString(record.status)) {
      recorder.fail("sweetspot.gate.status_missing", `sweetspot.${gate}.status is required`, { areas: ["readiness"], detail: { gate } });
      continue;
    }

    const status = safeString(record.status);
    if ((gate === "sstf" || gate === "srls" || gate === "sev" || gate === "sva") && (status === "missing" || status === "failing")) {
      missingCriticalGates += 1;
      const level = safeString(build.status) === "verified" || safeString(build.status) === "canonical" ? "fail" : "warn";
      recorder[level]("sweetspot.gate.critical_weak", `Critical gate ${gate} is "${status}"`, { areas: ["readiness", "publishability"], detail: { gate, status } });
    } else {
      recorder.pass("sweetspot.gate.present", `sweetspot.${gate} recorded as "${status}"`, { areas: ["readiness"], detail: { gate, status } });
    }
  }

  const averageScore = scoreCount ? Math.round(totalScore / scoreCount) : 0;
  if (averageScore >= 75) recorder.pass("sweetspot.average_score.strong", `Average sweetspot gate score is ${averageScore}`, { areas: ["readiness"] });
  else if (averageScore >= 60) recorder.warn("sweetspot.average_score.review", `Average sweetspot gate score is ${averageScore}`, { areas: ["readiness"] });
  else recorder.warn("sweetspot.average_score.low", `Average sweetspot gate score is ${averageScore}`, { areas: ["readiness"] });

  if ((safeString(build.status) === "verified" || safeString(build.status) === "canonical") && missingCriticalGates > 0) {
    recorder.fail("sweetspot.gate.verified_mismatch", "Verified/canonical builds cannot ship with missing critical Sweetspot gates", { areas: ["readiness", "publishability"] });
  }
}

function validateReleaseLink(recorder, releaseArtifact, releaseContext, buildContext) {
  if (!releaseContext.available) {
    recorder.pass("release.index.optional", "Release index not loaded; release checks skipped", { areas: ["updateability"] });
    return { available: false, artifact_found: false };
  }

  if (!releaseArtifact) {
    recorder.warn("release.artifact.missing", "No build release artifact found in release index", { areas: ["readiness", "updateability"] });
    return { available: true, artifact_found: false };
  }

  recorder.pass("release.artifact.present", "Build release artifact found in release index", { areas: ["readiness", "updateability"] });

  const latestRelease = isObject(releaseArtifact.latest_release) ? releaseArtifact.latest_release : releaseArtifact;
  const trustSummary = isObject(latestRelease.trust_summary) ? latestRelease.trust_summary : isObject(releaseArtifact.trust_summary) ? releaseArtifact.trust_summary : {};
  const latestVersion = safeString(latestRelease.version);
  const latestStatus = safeString(latestRelease.status);
  const latestVerification = safeString(trustSummary.verification_status || releaseArtifact.trust_summary?.latest_verification_status);
  const latestTrustLevel = safeString(trustSummary.trust_level || releaseArtifact.trust_summary?.latest_trust_level);
  const requiredEnvCount = Number(latestRelease.contract_summary?.required_env_count || 0);
  const includedPathCount = Number(latestRelease.content_summary?.included_path_count || 0);

  if (latestVersion === buildContext.buildVersion) {
    recorder.pass("release.version.aligned", "Release version matches build.version", { areas: ["updateability"] });
  } else {
    recorder.warn("release.version.mismatch", `Release version "${latestVersion || "unknown"}" differs from build.version "${buildContext.buildVersion || "unknown"}"`, {
      areas: ["updateability"],
      detail: { release_version: latestVersion, build_version: buildContext.buildVersion },
    });
  }

  if (latestStatus === "published") {
    recorder.pass("release.status.published", "Latest release artifact is published", { areas: ["updateability", "publishability"] });
  } else {
    recorder.warn("release.status.unpublished", `Latest release artifact status is "${latestStatus || "unknown"}"`, { areas: ["updateability", "publishability"] });
  }

  if (requiredEnvCount > 0 && buildContext.requiredEnvCount !== requiredEnvCount) {
    recorder.warn("release.contract_env.mismatch", "Release required_env count differs from manifest contracts.env.required count", {
      areas: ["updateability"],
      detail: { release_required_env_count: requiredEnvCount, manifest_required_env_count: buildContext.requiredEnvCount },
    });
  }

  if (includedPathCount > 0 && buildContext.sourcePathCount > includedPathCount) {
    recorder.warn("release.content.paths_thin", "Release included_path_count is smaller than manifest source.paths count", {
      areas: ["updateability"],
      detail: { release_included_path_count: includedPathCount, manifest_source_path_count: buildContext.sourcePathCount },
    });
  }

  if ((buildContext.buildStatus === "verified" || buildContext.buildStatus === "canonical") && verificationRank(latestVerification) < VERIFICATION_RANK.candidate) {
    recorder.fail("release.verification.too_weak", `Build status "${buildContext.buildStatus}" is stronger than latest release verification "${latestVerification || "unknown"}"`, {
      areas: ["readiness", "publishability"],
    });
  }

  return {
    available: true,
    artifact_found: true,
    release_count: Number(releaseArtifact.release_count || 0),
    latest_version: latestVersion || null,
    latest_status: latestStatus || null,
    latest_verification_status: latestVerification || null,
    latest_trust_level: latestTrustLevel || null,
    latest_channel: safeString(latestRelease.channel) || null,
    published_release_count: Number(releaseArtifact.trust_summary?.published_release_count || 0),
  };
}

function buildSignal(area, checks, options: Record<string, any> = {}) {
  const relevant = checks.filter((check) => safeArray(check.areas).includes(area) && check.level !== "pass");
  const failCount = relevant.filter((check) => check.level === "fail").length;
  const warnCount = relevant.filter((check) => check.level === "warn").length;
  let score = Math.max(0, 100 - (failCount * 34) - (warnCount * 12));
  let status = score >= 85 ? "ready" : score >= 65 ? "review" : "blocked";
  if (failCount > 0 && score >= 65) status = "review";
  if (options.forceBlocked) status = "blocked";
  if (options.forceBlocked) score = Math.min(score, 45);

  return {
    status,
    score,
    fail_count: failCount,
    warn_count: warnCount,
    blockers: topIssues(relevant, 5),
  };
}

function suggestVerificationStatus({ build, verification, provenance, recorder, releaseSummary, registrySummary, installabilitySignal, updateabilitySignal, readinessSignal }) {
  const smokeCommands = uniqStrings(verification.smoke_commands);
  const fixtureTargets = uniqStrings(verification.fixture_targets);
  const evidence = safeArray(verification.evidence).filter(isObject);
  const reviewedBy = safeArray(provenance.reviewed_by).filter(isObject);
  const hasVerifiedEvidence = evidence.some((entry) => verificationEvidenceRank(entry.status) >= VERIFICATION_RANK.verified) || reviewedBy.length > 0;
  const hasCandidateEvidence = evidence.some((entry) => verificationEvidenceRank(entry.status) >= VERIFICATION_RANK.candidate);
  const hasReleaseEvidence = verificationRank(releaseSummary.latest_verification_status) >= VERIFICATION_RANK.candidate;
  const declaredBuildStatus = safeString(build.status);

  if (recorder.counts.fail > 0 || readinessSignal.status === "blocked" || installabilitySignal.status === "blocked") {
    return "unverified";
  }

  if (
    declaredBuildStatus === "canonical" &&
    hasVerifiedEvidence &&
    releaseSummary.latest_status === "published" &&
    ["stable", "lts"].includes(safeString(releaseSummary.latest_channel)) &&
    verificationRank(releaseSummary.latest_verification_status) >= VERIFICATION_RANK.canonical &&
    updateabilitySignal.status === "ready" &&
    recorder.counts.warn <= 3
  ) {
    return "canonical";
  }

  if (
    (declaredBuildStatus === "verified" || hasVerifiedEvidence) &&
    hasReleaseEvidence &&
    smokeCommands.length > 0 &&
    registrySummary.missing_brick_count === 0 &&
    registrySummary.failing_member_count === 0 &&
    updateabilitySignal.status !== "blocked" &&
    recorder.counts.warn <= 8
  ) {
    return "verified";
  }

  if (
    (smokeCommands.length > 0 || fixtureTargets.length > 0 || hasCandidateEvidence || hasReleaseEvidence) &&
    registrySummary.missing_brick_count === 0 &&
    installabilitySignal.status !== "blocked"
  ) {
    return "candidate";
  }

  return "unverified";
}

function suggestTrustLevel({ suggestedVerificationStatus, recorder, releaseSummary }) {
  if (suggestedVerificationStatus === "canonical") return "high";
  if (suggestedVerificationStatus === "verified") {
    return recorder.counts.warn <= 3 && releaseSummary.latest_status === "published" ? "high" : "strong";
  }
  if (suggestedVerificationStatus === "candidate") {
    return verificationRank(releaseSummary.latest_verification_status) >= VERIFICATION_RANK.candidate ? "medium" : "low";
  }
  return recorder.counts.fail > 0 ? "blocked" : "low";
}

function summarizeBuildReports(builds, skipped, releaseContext) {
  const counts = { pass: 0, warn: 0, fail: 0 };
  const verificationStatuses = {};
  const trustLevels = {};
  const signalCounts = {
    readiness: {},
    installability: {},
    updateability: {},
    publishability: {},
  };
  let readyForAdoptionCount = 0;
  let installableCount = 0;
  let updateableCount = 0;
  let publishableCount = 0;
  let releaseLinkedCount = 0;
  const blockerMap = new Map();

  for (const build of builds) {
    counts.pass += Number(build.counts?.pass || 0);
    counts.warn += Number(build.counts?.warn || 0);
    counts.fail += Number(build.counts?.fail || 0);
    incrementCounter(verificationStatuses, build.verification?.suggested_status || "unverified");
    incrementCounter(trustLevels, build.verification?.suggested_trust_level || "low");
    for (const area of SIGNAL_AREAS) {
      incrementCounter(signalCounts[area], build.signals?.[area]?.status || "blocked");
    }
    if (build.booleans?.ready_for_adoption) readyForAdoptionCount += 1;
    if (build.booleans?.installable) installableCount += 1;
    if (build.booleans?.updateable) updateableCount += 1;
    if (build.booleans?.publishable) publishableCount += 1;
    if (build.release?.artifact_found) releaseLinkedCount += 1;

    for (const blocker of safeArray(build.top_blockers)) {
      if (!isNonEmptyString(blocker.code)) continue;
      const current = blockerMap.get(blocker.code) || {
        code: blocker.code,
        level: blocker.level || "warn",
        count: 0,
        builds: new Set(),
        message: blocker.message || "",
      };
      current.count += 1;
      current.builds.add(build.build_id || build.path);
      if (blocker.level === "fail") current.level = "fail";
      blockerMap.set(blocker.code, current);
    }
  }

  return {
    build_count: builds.length,
    skipped_count: skipped.length,
    counts,
    release_index_available: releaseContext.available,
    release_linked_build_count: releaseLinkedCount,
    verification_status_suggestions: verificationStatuses,
    trust_level_suggestions: trustLevels,
    signal_counts: signalCounts,
    ready_for_adoption_count: readyForAdoptionCount,
    installable_count: installableCount,
    updateable_count: updateableCount,
    publishable_count: publishableCount,
    top_blockers: [...blockerMap.values()]
      .sort((left, right) => severityRank(right.level) - severityRank(left.level) || right.count - left.count || compareStrings(left.code, right.code))
      .slice(0, 12)
      .map((entry) => ({
        code: entry.code,
        level: entry.level,
        count: entry.count,
        builds: [...entry.builds].slice(0, 8),
        message: entry.message,
      })),
  };
}

function topIssues(checks, limit) {
  return checks
    .filter((check) => check.level !== "pass")
    .sort((left, right) => severityRank(right.level) - severityRank(left.level) || compareStrings(left.code, right.code))
    .slice(0, limit)
    .map((check) => ({
      level: check.level,
      code: check.code,
      message: check.message,
      areas: check.areas,
      detail: check.detail || undefined,
    }));
}

function verificationEvidenceRank(value) {
  const normalized = safeString(value).toLowerCase();
  if (normalized === "canonical") return VERIFICATION_RANK.canonical;
  if (normalized === "verified" || normalized === "passing" || normalized === "passed") return VERIFICATION_RANK.verified;
  if (normalized === "candidate" || normalized === "partial") return VERIFICATION_RANK.candidate;
  return VERIFICATION_RANK.unverified;
}

function verificationRank(value) {
  return VERIFICATION_RANK[safeString(value).toLowerCase()] ?? -1;
}

function buildProjectPrefix(buildId) {
  if (!isNonEmptyString(buildId)) return "";
  const [prefix] = buildId.split(".build.");
  return prefix || "";
}

function severityRank(level) {
  if (level === "fail") return 2;
  if (level === "warn") return 1;
  return 0;
}

function pathCoveredByFileMap(candidatePath, fileMapSourcePaths) {
  const normalized = normalizePath(candidatePath);
  return fileMapSourcePaths.some((entry) => {
    const mapped = normalizePath(entry);
    return normalized === mapped || normalized.startsWith(`${mapped}/`) || mapped.startsWith(`${normalized}/`);
  });
}

function matchesSourcePath(manifestPathValue, registryPaths) {
  const normalizedManifest = normalizePath(manifestPathValue);
  return uniqStrings(registryPaths).some((entry) => {
    const normalizedRegistry = normalizePath(entry);
    return normalizedRegistry === normalizedManifest || normalizedRegistry.endsWith(`/${normalizedManifest}`) || normalizedManifest.endsWith(`/${normalizedRegistry}`);
  });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function relativeRepoPath(filePath) {
  return normalizePath(path.relative(repoRoot, path.resolve(filePath)));
}

function incrementCounter(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function uniqStrings(values) {
  return [...new Set(safeArray(values).map((value) => safeString(value)).filter(Boolean))];
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isNonEmptyString(value) {
  return safeString(value).length > 0;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(value) {
  return String(value || "").split(path.sep).join("/");
}

function compareStrings(left, right) {
  return String(left || "").localeCompare(String(right || ""));
}
