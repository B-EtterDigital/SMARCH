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
const SIGNAL_AREAS = ["readiness", "installability", "updateability", "publishability"] as const;

const VERIFICATION_RANK = {
  unverified: 0,
  candidate: 1,
  verified: 2,
  canonical: 3,
};

const _TRUST_RANK = {
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

main().catch((error: unknown) => {
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

  builds.sort((left, right) => compareStrings(left.build_id ?? left.path, right.build_id ?? right.path));
  skipped.sort((left, right) => compareStrings(left.path, right.path));

  const report: JsonObject = {
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

type JsonObject = Record<string, unknown>;
type CheckLevel = "pass" | "warn" | "fail";
type SignalArea = (typeof SIGNAL_AREAS)[number];
type VerificationStatus = keyof typeof VERIFICATION_RANK;
type TrustLevel = keyof typeof _TRUST_RANK;
interface BuildCheck { level: CheckLevel; code: string; message: string; areas: string[]; detail?: JsonObject }
interface CheckOptions { areas?: unknown; detail?: unknown; forceBlocked?: boolean }
interface Recorder {
  counts: Record<CheckLevel, number>; checks: BuildCheck[]; truncated: number;
  pass(code: string, message: string, options?: CheckOptions): void;
  warn(code: string, message: string, options?: CheckOptions): void;
  fail(code: string, message: string, options?: CheckOptions): void;
}
interface BuildVerifyOptions {
  manifests: string[]; noReleases: boolean; out: string; compact: boolean; stdout: boolean; help: boolean;
  root: string; registry: string; releases: string; maxChecks: number;
}
interface VerifyOptions {
  maxChecks: number; compact: boolean;
  registryContext: Awaited<ReturnType<typeof loadRegistryContext>>;
  releaseContext: Awaited<ReturnType<typeof loadReleaseContext>>;
}
interface ReferencedBrick { ref: JsonObject; registryBrick: JsonObject }
interface RegistrySummary {
  missing_brick_count: number;
  failing_member_count: number;
  [key: string]: unknown;
}
interface ReleaseSummary {
  available: boolean;
  artifact_found: boolean;
  latest_status?: string | null;
  latest_verification_status?: string | null;
  latest_channel?: string | null;
  [key: string]: unknown;
}
interface BuildSignal {
  status: string;
  score: number;
  fail_count: number;
  warn_count: number;
  blockers: ReturnType<typeof topIssues>;
}
interface SuggestVerificationOptions {
  build: JsonObject;
  verification: JsonObject;
  provenance: JsonObject;
  recorder: Recorder;
  releaseSummary: ReleaseSummary;
  registrySummary: RegistrySummary;
  installabilitySignal: BuildSignal;
  updateabilitySignal: BuildSignal;
  readinessSignal: BuildSignal;
}
interface SuggestTrustOptions {
  suggestedVerificationStatus: VerificationStatus;
  recorder: Recorder;
  releaseSummary: ReleaseSummary;
}
interface VerifiedBuildReport extends JsonObject {
  path: string;
  build_id: string | null;
  counts: Record<CheckLevel, number>;
  verification: { suggested_status: VerificationStatus; suggested_trust_level: TrustLevel; [key: string]: unknown };
  signals: Record<SignalArea, BuildSignal>;
  booleans: { ready_for_adoption: boolean; installable: boolean; updateable: boolean; publishable: boolean };
  release: ReleaseSummary;
  top_blockers: ReturnType<typeof topIssues>;
}
interface SkippedBuild { path: string; reason: string; error?: string }
interface BlockerAggregate { code: string; level: CheckLevel; count: number; builds: Set<string>; message: string }
interface ManifestBlocks {
  manifest: JsonObject; build: JsonObject; source: JsonObject; composition: JsonObject; interfaces: JsonObject;
  contracts: JsonObject; verification: JsonObject; clone: JsonObject; upgrade: JsonObject; publishing: JsonObject;
  economics: JsonObject; provenance: JsonObject; sweetspot: JsonObject;
}
interface BuildResolution {
  buildId: string; buildName: string; buildVersion: string; manifestPath: string; manifestDirName: string;
  sourceProject: string; buildPrefix: string; project: JsonObject | null; projectRoot: string; releaseArtifact: JsonObject | null;
}
interface SourcePathSummary { sourcePaths: string[]; missingSourcePaths: string[]; existingSourcePaths: string[] }
interface CompositionSummary {
  compositionRefs: JsonObject[]; optionalRefs: JsonObject[]; derivedRefs: JsonObject[]; compositionById: Map<string, JsonObject>;
  compositionIds: string[]; requiredCompositionIds: string[]; referencedBricks: ReferencedBrick[];
  registryStatusCounts: Record<string, number>; registryCloneCounts: Record<string, number>;
  registryScoreTotal: number; registryScoreCount: number; failingBrickCount: number; projectBoundCount: number; candidateOrBetterCount: number;
}

function parseArgs(argv: string[]): BuildVerifyOptions {
  const options: BuildVerifyOptions = {
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
    } else if (arg === "--compact") {
      options.compact = true;
    } else if (arg === "--stdout") {
      options.stdout = true;
    } else if (arg === "--no-releases") {
      options.noReleases = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (next && applyBuildVerifyOption(options, arg, next)) {
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function applyBuildVerifyOption(options: BuildVerifyOptions, flag: string, value: string) {
  if (flag === "--root") options.root = path.resolve(value);
  else if (flag === "--registry") options.registry = path.resolve(value);
  else if (flag === "--releases") options.releases = path.resolve(value);
  else if (flag === "--out") options.out = path.resolve(value);
  else if (flag === "--max-checks") options.maxChecks = Math.max(0, Number.parseInt(value, 10) || DEFAULTS.maxChecks);
  else return false;
  return true;
}

async function collectBuildManifests(root: string) {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) return [];
  const files: string[] = [];
  await walkDirectory(root, files);
  return files.sort(compareStrings);
}

async function walkDirectory(directory: string, files: string[]) {
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

async function readJson(filePath: string) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function loadRegistryContext(registryPath: string) {
  const parsed = await readJson(registryPath);
  if (!parsed.ok || !isObject(parsed.value)) {
    throw new Error(`Could not read merged registry at ${registryPath}`);
  }

  const registry = parsed.value;
  const bricksById = new Map<string, JsonObject>();
  for (const brick of safeArray(registry.bricks)) {
    if (isObject(brick) && isNonEmptyString(brick.id)) {
      bricksById.set(brick.id, brick);
    }
  }

  const projectsByAlias = new Map<string, JsonObject>();
  for (const project of safeArray(registry.projects)) {
    if (!isObject(project)) continue;
    const aliases = projectAliases(project);
    for (const alias of aliases) {
      projectsByAlias.set(alias, project);
    }
  }

  return { registry, bricksById, projectsByAlias };
}

async function loadReleaseContext(options: ReturnType<typeof parseArgs>) {
  if (options.noReleases) {
    return { available: false, path: null, byArtifactId: new Map<string, JsonObject>() };
  }

  const releasePath = path.resolve(options.releases);
  if (!existsSync(releasePath)) {
    return { available: false, path: releasePath, byArtifactId: new Map<string, JsonObject>() };
  }

  const parsed = await readJson(releasePath);
  if (!parsed.ok || !isObject(parsed.value)) {
    return { available: false, path: releasePath, byArtifactId: new Map<string, JsonObject>(), error: parsed.error };
  }

  const byArtifactId = new Map<string, JsonObject>();
  for (const artifact of collectReleaseArtifacts(parsed.value.artifacts)) {
    if (!isObject(artifact) || artifact.artifact_type !== "build" || !isNonEmptyString(artifact.artifact_id)) continue;
    byArtifactId.set(artifact.artifact_id, artifact);
  }

  return { available: true, path: releasePath, byArtifactId };
}

function collectReleaseArtifacts(artifacts: unknown): unknown[] {
  if (Array.isArray(artifacts)) return artifacts;
  if (!isObject(artifacts)) return [];
  if (isObject(artifacts.build)) return Object.values(artifacts.build);
  return Object.values(artifacts);
}

function projectAliases(project: JsonObject) {
  const aliases = new Set<string>();
  if (isNonEmptyString(project.id)) aliases.add(project.id.toLowerCase());
  if (isNonEmptyString(project.root)) {
    aliases.add(path.basename(project.root).toLowerCase());
    aliases.add(path.basename(path.dirname(project.root)).toLowerCase());
  }
  return [...aliases];
}

function lookupProject(projectsByAlias: Map<string, JsonObject>, ...candidates: string[]) {
  for (const candidate of candidates) {
    if (!isNonEmptyString(candidate)) continue;
    const project = projectsByAlias.get(candidate.trim().toLowerCase());
    if (project) return project;
  }
  return null;
}

function createRecorder(maxChecks: number) {
  const counts = { pass: 0, warn: 0, fail: 0 };
  const checks: BuildCheck[] = [];
  let truncated = 0;

  function push(level: CheckLevel, code: string, message: string, options: CheckOptions = {}) {
    counts[level] += 1;
    const check: BuildCheck = {
      level,
      code,
      message,
      areas: uniqStrings(options.areas ?? []),
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
    pass(code: string, message: string, options = {}) {
      push("pass", code, message, options);
    },
    warn(code: string, message: string, options = {}) {
      push("warn", code, message, options);
    },
    fail(code: string, message: string, options = {}) {
      push("fail", code, message, options);
    },
  };
}

function manifestBlocks(document: unknown): ManifestBlocks {
  const manifest = isObject(document) ? document : {};
  const block = (key: string) => isObject(manifest[key]) ? manifest[key] : {};
  return { manifest, build: block("build"), source: block("source"), composition: block("composition"), interfaces: block("interfaces"),
    contracts: block("contracts"), verification: block("verification"), clone: block("clone"), upgrade: block("upgrade"),
    publishing: block("publishing"), economics: block("economics"), provenance: block("provenance"), sweetspot: block("sweetspot") };
}

function resolveBuildManifest(build: JsonObject, source: JsonObject, filePath: string, options: VerifyOptions): BuildResolution {
  const buildId = safeString(build.id);
  const manifestDirName = path.basename(path.dirname(filePath));
  const sourceProject = safeString(source.project);
  const buildPrefix = buildProjectPrefix(buildId);
  const project = lookupProject(options.registryContext.projectsByAlias, sourceProject, buildPrefix, manifestDirName);
  return { buildId, buildName: safeString(build.name), buildVersion: safeString(build.version), manifestPath: relativeRepoPath(filePath),
    manifestDirName, sourceProject, buildPrefix, project, projectRoot: isNonEmptyString(project?.root) ? path.resolve(project.root) : "",
    releaseArtifact: isNonEmptyString(buildId) ? options.releaseContext.byArtifactId.get(buildId) ?? null : null };
}

function validateSchemaAndProject(recorder: Recorder, manifest: JsonObject, resolution: BuildResolution) {
  if (manifest.schema_version === "1.0.0") recorder.pass("schema.version", "schema_version is 1.0.0");
  else recorder.fail("schema.version", `schema_version should be 1.0.0, got "${safeString(manifest.schema_version) || "missing"}"`, { areas: ["readiness"] });
  if (resolution.project) {
    recorder.pass("registry.project.present", `Source project "${String(resolution.project.id)}" exists in merged registry`, { areas: ["readiness", "installability"] });
    return;
  }
  recorder.fail("registry.project.missing", `Source project "${resolution.sourceProject || resolution.buildPrefix || resolution.manifestDirName || "unknown"}" is not present in merged registry`, {
    areas: ["readiness", "installability"], detail: { source_project: resolution.sourceProject, build_prefix: resolution.buildPrefix, manifest_directory: resolution.manifestDirName },
  });
}

async function validateSourcePaths(recorder: Recorder, source: JsonObject, projectRoot: string): Promise<SourcePathSummary> {
  const sourcePaths = uniqStrings(source.paths);
  if (sourcePaths.length > 0) recorder.pass("source.paths.present", `${String(sourcePaths.length)} source path(s) declared`, { areas: ["readiness"] });
  else recorder.fail("source.paths.missing", "Build must declare source.paths", { areas: ["readiness", "installability"] });
  const missingSourcePaths: string[] = [], existingSourcePaths: string[] = [];
  for (const sourcePath of sourcePaths) {
    if ((await verifySourcePath(sourcePath, projectRoot)).exists) {
      existingSourcePaths.push(sourcePath);
      recorder.pass("source.path.exists", `Source path exists: ${sourcePath}`, { areas: ["readiness"], detail: { path: sourcePath } });
    } else {
      missingSourcePaths.push(sourcePath);
      recorder.fail("source.path.missing", `Source path does not exist: ${sourcePath}`, { areas: ["readiness", "installability"], detail: { path: sourcePath } });
    }
  }
  return { sourcePaths, missingSourcePaths, existingSourcePaths };
}

function validateCompositionRefs(recorder: Recorder, composition: JsonObject, source: JsonObject, registry: VerifyOptions['registryContext']): CompositionSummary {
  const summary: CompositionSummary = {
    compositionRefs: safeArray(composition.brick_refs).filter(isObject), optionalRefs: safeArray(composition.optional_bricks).filter(isObject),
    derivedRefs: safeArray(source.derived_from_bricks).filter(isObject), compositionById: new Map(), compositionIds: [],
    requiredCompositionIds: [], referencedBricks: [], registryStatusCounts: {}, registryCloneCounts: {}, registryScoreTotal: 0,
    registryScoreCount: 0, failingBrickCount: 0, projectBoundCount: 0, candidateOrBetterCount: 0,
  };
  if (summary.compositionRefs.length > 0) recorder.pass("composition.refs.present", `${String(summary.compositionRefs.length)} primary brick ref(s) declared`, { areas: ["readiness", "installability"] });
  else recorder.fail("composition.refs.missing", "Build must declare at least one composition.brick_refs entry", { areas: ["readiness", "installability"] });
  const seenIds = new Set<string>(), seenOrders = new Set<unknown>();
  for (const ref of summary.compositionRefs) processCompositionRef(recorder, ref, registry, summary, seenIds, seenOrders);
  return summary;
}

function processCompositionRef(recorder: Recorder, ref: JsonObject, registry: VerifyOptions['registryContext'], summary: CompositionSummary, seenIds: Set<string>, seenOrders: Set<unknown>) {
  const refId = safeString(ref.brick_id);
  if (!isNonEmptyString(refId)) {
    recorder.fail("composition.ref.id.missing", "Every composition brick ref needs brick_id", { areas: ["readiness", "installability"] });
    return;
  }
  summary.compositionIds.push(refId);
  summary.compositionById.set(refId, ref);
  validateCompositionRefMetadata(recorder, ref, refId, seenIds, seenOrders);
  const required = ref.required !== false;
  if (required) summary.requiredCompositionIds.push(refId);
  const registryBrick = registry.bricksById.get(refId);
  if (!registryBrick) {
    recorder.fail("registry.brick.missing", `Brick ref "${refId}" is not present in merged registry`, { areas: ["readiness", "installability"], detail: { brick_id: refId } });
    return;
  }
  summary.referencedBricks.push({ ref, registryBrick });
  recorder.pass("registry.brick.present", `Brick ref "${refId}" resolved in merged registry`, { areas: ["readiness"], detail: { brick_id: refId } });
  recordRegistryBrick(recorder, ref, refId, required, registryBrick, summary);
}

function validateCompositionRefMetadata(recorder: Recorder, ref: JsonObject, refId: string, seenIds: Set<string>, seenOrders: Set<unknown>) {
  if (seenIds.has(refId)) recorder.fail("composition.ref.duplicate", `Duplicate composition brick ref "${refId}"`, { areas: ["readiness"] });
  else seenIds.add(refId);
  if (Number.isInteger(ref.order)) {
    if (seenOrders.has(ref.order)) recorder.warn("composition.ref.order.duplicate", `Repeated brick ref order "${String(ref.order)}"`, { areas: ["readiness"], detail: { brick_id: refId } });
    else seenOrders.add(ref.order);
  } else recorder.warn("composition.ref.order.missing", `Brick ref "${refId}" should declare an integer order`, { areas: ["readiness"], detail: { brick_id: refId } });
  if (!isNonEmptyString(ref.role)) recorder.warn("composition.ref.role.missing", `Brick ref "${refId}" should declare a role`, { areas: ["readiness"], detail: { brick_id: refId } });
  if (!isNonEmptyString(ref.path)) recorder.warn("composition.ref.path.missing", `Brick ref "${refId}" should declare a source path`, { areas: ["installability"], detail: { brick_id: refId } });
}

function recordRegistryBrick(recorder: Recorder, ref: JsonObject, refId: string, required: boolean, brick: JsonObject, summary: CompositionSummary) {
  const status = safeString(brick.status) || "unknown";
  incrementCounter(summary.registryStatusCounts, status);
  if (status === "project_bound") {
    summary.projectBoundCount += 1;
    recorder.warn("registry.brick.project_bound", `Brick ref "${refId}" is still project_bound`, { areas: ["readiness", "publishability"], detail: { brick_id: refId } });
  }
  if (status === "candidate" || status === "canonical") summary.candidateOrBetterCount += 1;
  const cloneReadiness = safeString(brick.clone_readiness) || "unknown";
  incrementCounter(summary.registryCloneCounts, cloneReadiness);
  if (required && (cloneReadiness === "manual_only" || cloneReadiness === "blocked")) recorder.warn("registry.brick.clone_readiness", `Required brick "${refId}" is ${cloneReadiness}`, { areas: ["installability"], detail: { brick_id: refId, clone_readiness: cloneReadiness } });
  recordRegistryHealth(recorder, refId, brick, summary);
  if (typeof brick.score === "number") { summary.registryScoreTotal += brick.score; summary.registryScoreCount += 1; }
  if (isNonEmptyString(ref.path) && !matchesSourcePath(ref.path, safeArray(brick.source_paths))) recorder.warn("registry.brick.path_mismatch", `Declared path for "${refId}" does not match registry source_paths`, {
    areas: ["installability"], detail: { brick_id: refId, manifest_path: ref.path, registry_paths: safeArray(brick.source_paths) },
  });
}

function recordRegistryHealth(recorder: Recorder, refId: string, brick: JsonObject, summary: CompositionSummary) {
  const health = isObject(brick.health) ? brick.health : {};
  const status = safeString(health.status) || "unknown";
  if (status === "fail") {
    summary.failingBrickCount += 1;
    recorder.fail("registry.brick.health_fail", `Registry brick "${refId}" has failing health`, { areas: ["readiness", "installability"], detail: { brick_id: refId } });
  } else if (Number(health.warning_count ?? 0) > 0) {
    recorder.warn("registry.brick.health_warn", `Registry brick "${refId}" carries scanner warnings`, { areas: ["readiness"], detail: { brick_id: refId, warning_count: health.warning_count } });
  }
}

function validateCompositionRelations(recorder: Recorder, composition: JsonObject, summary: CompositionSummary) {
  const derivedIds = uniqStrings(summary.derivedRefs.map((ref) => ref.brick_id));
  const missingDerivedIds = summary.requiredCompositionIds.filter((brickId) => !derivedIds.includes(brickId));
  const extraDerivedIds = derivedIds.filter((brickId) => !summary.compositionIds.includes(brickId));
  if (missingDerivedIds.length === 0 && extraDerivedIds.length === 0 && derivedIds.length > 0) {
    recorder.pass("source.derived_from_bricks.aligned", "source.derived_from_bricks aligns with composition brick refs", { areas: ["readiness"] });
  } else {
    if (missingDerivedIds.length > 0) recorder.warn("source.derived_from_bricks.missing", "Some required composition bricks are not represented in source.derived_from_bricks", { areas: ["readiness"], detail: { brick_ids: missingDerivedIds } });
    if (extraDerivedIds.length > 0) recorder.warn("source.derived_from_bricks.extra", "source.derived_from_bricks includes bricks not present in composition.brick_refs", { areas: ["readiness"], detail: { brick_ids: extraDerivedIds } });
  }
  const flowSummary = validateFlows(recorder, summary.compositionById, safeArray(composition.flows));
  for (const brickId of summary.requiredCompositionIds.filter((id) => !flowSummary.usedBrickIds.has(id))) {
    recorder.warn("composition.flow.coverage", `Required brick "${brickId}" is not referenced by any flow step`, { areas: ["readiness", "installability"], detail: { brick_id: brickId } });
  }
}

function validateManifestSurfaces(recorder: Recorder, blocks: ManifestBlocks, paths: SourcePathSummary, composition: CompositionSummary) {
  validateInterfaces(recorder, blocks.interfaces, blocks.verification);
  const contractSummary = validateContracts(recorder, blocks.contracts, isObject(blocks.manifest.classification) ? blocks.manifest.classification : {}, blocks.build);
  const cloneSummary = validateCloneSurface(recorder, blocks.clone, { sourcePaths: paths.sourcePaths,
    requiredRefs: composition.compositionRefs.filter((entry) => entry.required !== false), optionalRefs: composition.optionalRefs });
  const upgradeSummary = validateUpgradeSurface(recorder, blocks.upgrade);
  validatePublishingSurface(recorder, blocks.publishing, blocks.build);
  validateEconomics(recorder, blocks.economics);
  validateProvenance(recorder, blocks.provenance, composition.compositionIds);
  validateSweetspot(recorder, blocks.sweetspot, blocks.build);
  validateVerification(recorder, blocks.verification, blocks.build);
  return { contractSummary, cloneSummary, upgradeSummary };
}

function buildRegistrySummary(resolution: BuildResolution, paths: SourcePathSummary, composition: CompositionSummary): RegistrySummary {
  return {
    source_project_found: Boolean(resolution.project), source_project_id: firstText(resolution.project?.id, resolution.sourceProject, resolution.buildPrefix),
    source_root: resolution.projectRoot ? relativeRepoPath(resolution.projectRoot) : null, source_path_count: paths.sourcePaths.length,
    existing_source_path_count: paths.existingSourcePaths.length, missing_source_paths: paths.missingSourcePaths,
    referenced_brick_count: composition.referencedBricks.length, missing_brick_count: composition.compositionRefs.length - composition.referencedBricks.length,
    required_brick_count: composition.requiredCompositionIds.length,
    required_ready_brick_count: composition.referencedBricks.filter(({ ref, registryBrick }) => ref.required !== false && safeString(registryBrick.clone_readiness) !== "blocked" && safeString(registryBrick.clone_readiness) !== "manual_only").length,
    average_brick_score: composition.registryScoreCount ? Math.round(composition.registryScoreTotal / composition.registryScoreCount) : 0,
    status_counts: composition.registryStatusCounts, clone_readiness_counts: composition.registryCloneCounts,
    project_bound_member_count: composition.projectBoundCount, candidate_or_better_member_count: composition.candidateOrBetterCount,
    failing_member_count: composition.failingBrickCount,
  };
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) if (isNonEmptyString(value)) return value;
  return null;
}

function finalizeBuildReport(recorder: Recorder, blocks: ManifestBlocks, resolution: BuildResolution, paths: SourcePathSummary,
  registrySummary: RegistrySummary, surface: ReturnType<typeof validateManifestSurfaces>, releaseSummary: ReleaseSummary, compact: boolean): VerifiedBuildReport {
  const publishabilitySignal = buildSignal("publishability", recorder.checks, { forceBlocked: blocks.publishing.publishable !== true });
  const installabilitySignal = buildSignal("installability", recorder.checks, {
    forceBlocked: surface.cloneSummary.requiredMappingMissingCount > 0 || registrySummary.missing_brick_count > 0 || paths.missingSourcePaths.length > 0,
  });
  const updateabilitySignal = buildSignal("updateability", recorder.checks, { forceBlocked: surface.upgradeSummary.missingCriticalFields > 0 });
  const readinessSignal = buildSignal("readiness", recorder.checks, {
    forceBlocked: registrySummary.missing_brick_count > 0 || paths.missingSourcePaths.length > 0 || recorder.checks.some((check) => check.level === "fail" && check.areas.includes("readiness")),
  });
  const suggestedVerificationStatus = suggestVerificationStatus({ build: blocks.build, verification: blocks.verification,
    provenance: blocks.provenance, recorder, releaseSummary, registrySummary, installabilitySignal, updateabilitySignal, readinessSignal });
  const suggestedTrustLevel = suggestTrustLevel({ suggestedVerificationStatus, recorder, releaseSummary });
  const report: VerifiedBuildReport = {
    path: resolution.manifestPath, build_id: resolution.buildId || null, name: resolution.buildName || null,
    version: resolution.buildVersion || null, source_project: resolution.sourceProject || resolution.buildPrefix || null,
    declared_status: safeString(blocks.build.status) || null, declared_trust_tier: safeString(blocks.build.trust_tier) || null,
    counts: recorder.counts, verification: { declared_status: safeString(blocks.verification.status) || null,
      suggested_status: suggestedVerificationStatus, suggested_trust_level: suggestedTrustLevel },
    signals: { readiness: readinessSignal, installability: installabilitySignal, updateability: updateabilitySignal, publishability: publishabilitySignal },
    booleans: { ready_for_adoption: isReadyForAdoption(readinessSignal, installabilitySignal, suggestedVerificationStatus),
      installable: installabilitySignal.status !== "blocked", updateable: updateabilitySignal.status !== "blocked", publishable: publishabilitySignal.status === "ready" },
    registry: registrySummary, release: releaseSummary, top_blockers: topIssues(recorder.checks, 6),
  };
  if (!compact) { report.checks = recorder.checks; report.checks_truncated = recorder.truncated; }
  return report;
}

function isReadyForAdoption(readiness: BuildSignal, installability: BuildSignal, status: VerificationStatus) {
  return readiness.status !== "blocked" && installability.status !== "blocked" && VERIFICATION_RANK[status] >= VERIFICATION_RANK.candidate;
}

async function verifyBuildManifest(document: unknown, filePath: string, options: VerifyOptions) {
  const recorder = createRecorder(options.maxChecks);
  const blocks = manifestBlocks(document);
  const resolution = resolveBuildManifest(blocks.build, blocks.source, filePath, options);

  validateTopLevelBlocks(recorder, blocks.manifest);
  validateBuildIdentity(recorder, blocks.build, filePath, resolution.sourceProject, resolution.buildPrefix);

  validateSchemaAndProject(recorder, blocks.manifest, resolution);
  const pathSummary = await validateSourcePaths(recorder, blocks.source, resolution.projectRoot);

  const compositionSummary = validateCompositionRefs(recorder, blocks.composition, blocks.source, options.registryContext);
  validateCompositionRelations(recorder, blocks.composition, compositionSummary);
  const surface = validateManifestSurfaces(recorder, blocks, pathSummary, compositionSummary);
  const releaseSummary = validateReleaseLink(recorder, resolution.releaseArtifact, options.releaseContext, {
    buildId: resolution.buildId, buildVersion: resolution.buildVersion, buildStatus: safeString(blocks.build.status), requiredEnvCount: surface.contractSummary.requiredEnvCount,
    sourcePathCount: pathSummary.sourcePaths.length,
  });
  const registrySummary = buildRegistrySummary(resolution, pathSummary, compositionSummary);
  return finalizeBuildReport(recorder, blocks, resolution, pathSummary, registrySummary, surface, releaseSummary, options.compact);
}

function validateTopLevelBlocks(recorder: Recorder, manifest: JsonObject) {
  const requiredObjectBlocks = ["build", "source", "owner", "composition", "classification", "sweetspot", "interfaces", "contracts", "verification", "clone", "upgrade", "publishing", "economics", "provenance"];
  for (const key of requiredObjectBlocks) {
    if (isObject(manifest[key])) {
      recorder.pass("manifest.block.present", `Top-level "${key}" block present`, { areas: ["readiness"], detail: { block: key } });
    } else {
      recorder.fail("manifest.block.missing", `Top-level "${key}" block is required`, { areas: ["readiness"], detail: { block: key } });
    }
  }
}

function validateBuildIdentity(recorder: Recorder, build: JsonObject, filePath: string, sourceProject: string, buildPrefix: string) {
  validateBuildId(recorder, build);
  validateBuildSlug(recorder, build, filePath);
  validateBuildVersionAndLocation(recorder, build, filePath, sourceProject, buildPrefix);
  validateBuildTrust(recorder, build);
}

function validateBuildId(recorder: Recorder, build: JsonObject) {
  if (!isNonEmptyString(build.id)) recorder.fail("build.id.missing", "build.id is required", { areas: ["readiness"] });
  else if (!BUILD_ID_RE.test(build.id)) recorder.fail("build.id.invalid", `build.id "${build.id}" is not registry-safe`, { areas: ["readiness"] });
  else recorder.pass("build.id.valid", `build.id "${build.id}" looks valid`, { areas: ["readiness"] });
  if (safeString(build.id).includes(".build.")) recorder.pass("build.id.prefix", "build.id carries the build prefix", { areas: ["readiness"] });
  else recorder.fail("build.id.prefix", "build.id should include '.build.' to mark first-class builds", { areas: ["readiness"] });
  if (isNonEmptyString(build.name)) recorder.pass("build.name.present", "build.name present", { areas: ["readiness"] });
  else recorder.fail("build.name.missing", "build.name is required", { areas: ["readiness"] });
}

function validateBuildSlug(recorder: Recorder, build: JsonObject, filePath: string) {
  if (!isNonEmptyString(build.slug) || !SLUG_RE.test(build.slug)) {
    recorder.fail("build.slug.invalid", "build.slug is missing or invalid", { areas: ["readiness"] });
    return;
  }
  recorder.pass("build.slug.valid", `build.slug "${build.slug}" looks valid`, { areas: ["readiness"] });
  const expectedName = `${build.slug}.build.sweetspot.json`;
  if (path.basename(filePath) === expectedName) recorder.pass("build.file.matches_slug", "Manifest filename matches build.slug", { areas: ["readiness"] });
  else recorder.warn("build.file.slug_mismatch", `Manifest filename should usually be "${expectedName}"`, {
    areas: ["readiness"], detail: { filename: path.basename(filePath), expected: expectedName },
  });
}

function validateBuildVersionAndLocation(recorder: Recorder, build: JsonObject, filePath: string, sourceProject: string, buildPrefix: string) {
  if (isNonEmptyString(build.version) && SEMVER_RE.test(build.version)) recorder.pass("build.version.valid", `build.version "${build.version}" is semver-like`, { areas: ["readiness", "updateability"] });
  else recorder.fail("build.version.invalid", `build.version "${safeString(build.version) || "missing"}" is not semver`, { areas: ["readiness", "updateability"] });
  if (sourceProject && buildPrefix) {
    if (sourceProject === buildPrefix) recorder.pass("build.project_prefix.aligned", "build.id prefix aligns with source.project", { areas: ["readiness"] });
    else recorder.warn("build.project_prefix.mismatch", `build.id prefix "${buildPrefix}" does not match source.project "${sourceProject}"`, {
      areas: ["readiness"], detail: { source_project: sourceProject, build_prefix: buildPrefix },
    });
  }
  const buildDir = path.basename(path.dirname(filePath));
  if (sourceProject && buildDir === sourceProject) recorder.pass("build.directory.aligned", "Build directory matches source.project", { areas: ["readiness"] });
  else if (sourceProject) recorder.warn("build.directory.mismatch", `Build directory "${buildDir}" does not match source.project "${sourceProject}"`, {
    areas: ["readiness"], detail: { build_directory: buildDir, source_project: sourceProject },
  });
}

function validateBuildTrust(recorder: Recorder, build: JsonObject) {
  const status = safeString(build.status), trustTier = safeString(build.trust_tier);
  if (status) recorder.pass("build.status.present", `build.status "${status}" declared`, { areas: ["readiness"] });
  else recorder.fail("build.status.missing", "build.status is required", { areas: ["readiness"] });
  if (trustTier) recorder.pass("build.trust_tier.present", `build.trust_tier "${trustTier}" declared`, { areas: ["readiness"] });
  else recorder.warn("build.trust_tier.missing", "build.trust_tier should be declared", { areas: ["readiness"] });
  const statusRank = buildStatusRank(status), tierRank = trustTierRank(trustTier);
  if (statusRank !== null && tierRank !== null && tierRank + 1 < statusRank) {
    recorder.fail("build.status_trust_mismatch", `build.status "${status}" is stronger than build.trust_tier "${trustTier}"`, { areas: ["readiness"] });
  }
}
async function verifySourcePath(sourcePath: string, projectRoot: string) {
  if (!isNonEmptyString(sourcePath)) return { exists: false };
  if (!projectRoot) return { exists: false };
  if (path.isAbsolute(sourcePath)) return { exists: false };
  const resolved = path.resolve(projectRoot, sourcePath);
  if (!resolved.startsWith(projectRoot)) return { exists: false };
  return { exists: await pathExists(resolved), resolved };
}

function validateFlows(recorder: Recorder, compositionById: Map<string, JsonObject>, flows: unknown[]) {
  const usedBrickIds = new Set<string>();
  if (flows.length === 0) {
    recorder.fail("composition.flows.missing", "Build should declare at least one composition flow", { areas: ["readiness", "installability"] });
    return { usedBrickIds };
  }
  recorder.pass("composition.flows.present", `${String(flows.length)} flow(s) declared`, { areas: ["readiness"] });
  const seenFlowIds = new Set<string>();
  for (const rawFlow of flows) if (isObject(rawFlow)) validateFlow(recorder, rawFlow, compositionById, usedBrickIds, seenFlowIds);
  return { usedBrickIds };
}

function validateFlow(recorder: Recorder, flow: JsonObject, compositionById: Map<string, JsonObject>, usedBrickIds: Set<string>, seenFlowIds: Set<string>) {
  const flowId = safeString(flow.id);
  if (!flowId) {
    recorder.fail("composition.flow.id.missing", "Every flow needs an id", { areas: ["readiness"] });
    return;
  }
  if (seenFlowIds.has(flowId)) recorder.fail("composition.flow.id.duplicate", `Duplicate flow id "${flowId}"`, { areas: ["readiness"] });
  else seenFlowIds.add(flowId);
  const steps = safeArray(flow.steps).filter(isObject);
  if (steps.length === 0) {
    recorder.fail("composition.flow.steps.missing", `Flow "${flowId}" must declare steps`, { areas: ["readiness", "installability"], detail: { flow_id: flowId } });
    return;
  }
  const seenStepIds = new Set<string>();
  let previousOrder = -Infinity;
  for (const step of steps) previousOrder = validateFlowStep(recorder, flowId, step, compositionById, usedBrickIds, seenStepIds, previousOrder);
}

function validateFlowStep(recorder: Recorder, flowId: string, step: JsonObject, compositionById: Map<string, JsonObject>,
  usedBrickIds: Set<string>, seenStepIds: Set<string>, previousOrder: number) {
  const stepId = safeString(step.id);
  if (!stepId) recorder.fail("composition.step.id.missing", `Flow "${flowId}" contains a step without id`, { areas: ["readiness"], detail: { flow_id: flowId } });
  else if (seenStepIds.has(stepId)) recorder.fail("composition.step.id.duplicate", `Flow "${flowId}" repeats step id "${stepId}"`, { areas: ["readiness"], detail: { flow_id: flowId, step_id: stepId } });
  else seenStepIds.add(stepId);
  const nextOrder = validateStepOrder(recorder, flowId, stepId, step.order, previousOrder);
  const brickRefs = uniqStrings(step.brick_refs);
  if (brickRefs.length === 0) recorder.warn("composition.step.refs.missing", `Flow "${flowId}" step "${stepId || "unknown"}" should reference one or more brick refs`, {
    areas: ["readiness", "installability"], detail: { flow_id: flowId, step_id: stepId },
  });
  for (const brickId of brickRefs) {
    if (!compositionById.has(brickId)) recorder.fail("composition.step.refs.unknown", `Flow "${flowId}" step "${stepId || "unknown"}" references unknown brick "${brickId}"`, {
      areas: ["readiness", "installability"], detail: { flow_id: flowId, step_id: stepId, brick_id: brickId },
    });
    else usedBrickIds.add(brickId);
  }
  return nextOrder;
}

function validateStepOrder(recorder: Recorder, flowId: string, stepId: string, order: unknown, previousOrder: number) {
  const stepOrder = typeof order === "number" && Number.isInteger(order) ? order : null;
  if (stepOrder === null) {
    recorder.warn("composition.step.order.missing", `Flow "${flowId}" step "${stepId || "unknown"}" should declare integer order`, {
      areas: ["readiness"], detail: { flow_id: flowId, step_id: stepId },
    });
    return previousOrder;
  }
  if (stepOrder < previousOrder) recorder.warn("composition.step.order.unsorted", `Flow "${flowId}" step "${stepId}" is out of order`, {
    areas: ["readiness"], detail: { flow_id: flowId, step_id: stepId, order: stepOrder, previous_order: previousOrder },
  });
  return stepOrder;
}
function validateInterfaces(recorder: Recorder, interfaces: JsonObject, verification: JsonObject) {
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

function validateContracts(recorder: Recorder, contracts: JsonObject, classification: JsonObject, build: JsonObject) {
  const env = isObject(contracts.env) ? contracts.env : {};
  const requiredEnv = safeArray(env.required).filter(isObject);
  const optionalEnv = safeArray(env.optional).filter(isObject);
  validateEnvContract(recorder, requiredEnv, optionalEnv);
  validateAuthContract(recorder, isObject(contracts.auth) ? contracts.auth : {});
  validateRlsContract(recorder, isObject(contracts.rls) ? contracts.rls : {}, safeString(classification.risk) || safeString(build.risk));
  validateNetworkContract(recorder, isObject(contracts.network) ? contracts.network : {});
  validatePerformanceContract(recorder, isObject(contracts.performance) ? contracts.performance : {});
  return { requiredEnvCount: requiredEnv.length };
}

function validateEnvContract(recorder: Recorder, required: JsonObject[], optional: JsonObject[]) {
  if (required.length > 0 || optional.length > 0) recorder.pass("contracts.env.present", `Build declares ${String(required.length)} required and ${String(optional.length)} optional env var(s)`, { areas: ["installability", "publishability"] });
  else recorder.warn("contracts.env.missing", "Build does not declare any environment contract", { areas: ["installability", "publishability"] });
  for (const item of required) {
    if (isNonEmptyString(item.name)) recorder.pass("contracts.env.required_entry", `Required env "${item.name}" declared`, { areas: ["installability"] });
    else recorder.fail("contracts.env.required_invalid", "Required env entry missing name", { areas: ["installability", "publishability"] });
  }
}

function validateAuthContract(recorder: Recorder, auth: JsonObject) {
  if (auth.required !== true) return;
  if (uniqStrings(auth.roles).length === 0 || uniqStrings(auth.modes).length === 0) recorder.warn("contracts.auth.thin", "Auth contract is marked required but roles or modes are missing", { areas: ["readiness", "installability"] });
  else recorder.pass("contracts.auth.defined", "Auth contract declares modes and roles", { areas: ["installability"] });
}

function validateRlsContract(recorder: Recorder, rls: JsonObject, buildRisk: string) {
  if (rls.required !== true) return;
  const status = safeString(rls.status);
  if (!status) recorder.fail("contracts.rls.status_missing", "RLS is required but contracts.rls.status is missing", { areas: ["readiness", "publishability"] });
  else if (status === "missing") recorder[buildRisk === "critical" || buildRisk === "high" ? "fail" : "warn"]("contracts.rls.missing", "RLS is required but still marked missing", { areas: ["readiness", "publishability"] });
  else if (status === "partial") recorder.warn("contracts.rls.partial", "RLS is required but still partial", { areas: ["readiness", "publishability"] });
  else recorder.pass("contracts.rls.defined", `RLS contract status is "${status}"`, { areas: ["readiness", "publishability"] });
  if (uniqStrings(rls.negative_tests).length === 0) recorder.warn("contracts.rls.negative_tests_missing", "RLS contract should include negative tests", { areas: ["readiness", "publishability"] });
}

function validateNetworkContract(recorder: Recorder, network: JsonObject) {
  if (uniqStrings(network.inbound_endpoints).length > 0 || uniqStrings(network.outbound_hosts).length > 0) recorder.pass("contracts.network.present", "Network contract declares inbound or outbound surfaces", { areas: ["installability", "publishability"] });
}

function validatePerformanceContract(recorder: Recorder, performance: JsonObject) {
  if (typeof performance.latency_budget_ms === "number" && performance.latency_budget_ms > 0) recorder.pass("contracts.performance.latency_budget", "Performance contract includes latency budget", { areas: ["readiness"] });
  else recorder.warn("contracts.performance.latency_budget_missing", "Performance contract should include latency budget", { areas: ["readiness"] });
}
function validateVerification(recorder: Recorder, verification: JsonObject, build: JsonObject) {
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
    recorder.pass("verification.integration_targets", `${String(integrationTargets.length)} integration target(s) declared`, { areas: ["readiness"] });
  } else {
    recorder.warn("verification.integration_targets_missing", "Build should declare integration targets", { areas: ["readiness"] });
  }

  if (evidence.length > 0) {
    recorder.pass("verification.evidence.present", `${String(evidence.length)} evidence record(s) declared`, { areas: ["readiness"] });
  } else {
    recorder.warn("verification.evidence.missing", "Build should declare evidence records", { areas: ["readiness"] });
  }

  const declaredStatus = safeString(build.status);
  const verifiedEvidenceCount = evidence.filter((entry) => verificationEvidenceRank(entry.status) >= VERIFICATION_RANK.verified).length;
  if ((declaredStatus === "verified" || declaredStatus === "canonical") && verifiedEvidenceCount === 0) {
    recorder.fail("verification.evidence.too_weak", `Build status "${declaredStatus}" needs verified evidence, not only planned evidence`, { areas: ["readiness", "publishability"] });
  }
}

function validateCloneSurface(recorder: Recorder, clone: JsonObject, { sourcePaths, requiredRefs, optionalRefs }: {
  sourcePaths: string[]; requiredRefs: JsonObject[]; optionalRefs: JsonObject[];
}) {
  const fileMap = safeArray(clone.file_map).filter(isObject);
  const fileMapSourcePaths = uniqStrings(fileMap.map((entry) => entry.source_path));
  const installSteps = uniqStrings(clone.install_steps);
  const postCloneChecks = uniqStrings(clone.post_clone_checks);
  const rollbackSteps = uniqStrings(clone.rollback_steps);
  const requiredPorts = uniqStrings(clone.required_ports);

  if (safeString(clone.readiness)) recorder.pass("clone.readiness.present", `clone.readiness "${String(clone.readiness)}" declared`, { areas: ["installability"] });
  else recorder.fail("clone.readiness.missing", "clone.readiness is required", { areas: ["installability"] });

  if (fileMap.length > 0) recorder.pass("clone.file_map.present", `${String(fileMap.length)} file_map entry(ies) declared`, { areas: ["installability", "updateability"] });
  else recorder.fail("clone.file_map.missing", "clone.file_map is required for installable build assets", { areas: ["installability", "updateability"] });

  if (installSteps.length > 0) recorder.pass("clone.install_steps.present", `${String(installSteps.length)} install step(s) declared`, { areas: ["installability"] });
  else recorder.fail("clone.install_steps.missing", "clone.install_steps are required", { areas: ["installability"] });

  if (postCloneChecks.length > 0) recorder.pass("clone.post_clone_checks.present", `${String(postCloneChecks.length)} post-clone check(s) declared`, { areas: ["installability"] });
  else recorder.fail("clone.post_clone_checks.missing", "clone.post_clone_checks are required", { areas: ["installability"] });

  if (rollbackSteps.length > 0) recorder.pass("clone.rollback_steps.present", `${String(rollbackSteps.length)} rollback step(s) declared`, { areas: ["updateability"] });
  else recorder.fail("clone.rollback_steps.missing", "clone.rollback_steps are required for build updates", { areas: ["updateability"] });

  if (requiredPorts.length > 0) recorder.pass("clone.required_ports.present", `${String(requiredPorts.length)} required port(s) declared`, { areas: ["installability", "updateability"] });
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

function validateUpgradeSurface(recorder: Recorder, upgrade: JsonObject) {
  let missingCriticalFields = 0;

  if (safeString(upgrade.channel)) recorder.pass("upgrade.channel.present", `upgrade.channel "${String(upgrade.channel)}" declared`, { areas: ["updateability"] });
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

function validatePublishingSurface(recorder: Recorder, publishing: JsonObject, build: JsonObject) {
  const publishable = publishing.publishable;
  const visibility = safeString(publishing.visibility ?? build.visibility);
  validatePublishableFlag(recorder, publishable);
  validatePublishingVisibility(recorder, publishable, visibility);
  validatePublishingProfile(recorder, publishable, publishing);
  validatePublishingLists(recorder, publishable, uniqStrings(publishing.exposed_docs), uniqStrings(publishing.excluded_assets));
  if (publishable === true && (visibility === "community" || visibility === "public") && safeString(publishing.license) === "private") {
    recorder.fail("publishing.license_conflict", "Community/public publishable builds need a non-private license declaration", { areas: ["publishability"] });
  }
  return { publishable: publishable === true };
}

function validatePublishableFlag(recorder: Recorder, publishable: unknown) {
  if (typeof publishable !== "boolean") recorder.fail("publishing.publishable.missing", "publishing.publishable must be true or false", { areas: ["publishability"] });
  else if (publishable) recorder.pass("publishing.publishable.enabled", "Build is marked publishable", { areas: ["publishability"] });
  else recorder.warn("publishing.publishable.disabled", "Build is explicitly not publishable outside the private pool", { areas: ["publishability"] });
}

function validatePublishingVisibility(recorder: Recorder, publishable: unknown, visibility: string) {
  if (visibility) recorder.pass("publishing.visibility.present", `publishing.visibility "${visibility}" declared`, { areas: ["publishability"] });
  else recorder.fail("publishing.visibility.missing", "publishing.visibility is required", { areas: ["publishability"] });
  if (publishable === true && visibility === "private") recorder.fail("publishing.visibility_conflict", "Build cannot be publishable while publishing.visibility is private", { areas: ["publishability"] });
}

function validatePublishingProfile(recorder: Recorder, publishable: unknown, publishing: JsonObject) {
  if (publishable === true && !isNonEmptyString(publishing.redaction_profile)) recorder.fail("publishing.redaction_profile.missing", "Publishable builds need publishing.redaction_profile", { areas: ["publishability"] });
  else if (isNonEmptyString(publishing.redaction_profile)) recorder.pass("publishing.redaction_profile.present", "publishing.redaction_profile declared", { areas: ["publishability"] });
}

function validatePublishingLists(recorder: Recorder, publishable: unknown, docs: string[], assets: string[]) {
  if (publishable === true && docs.length === 0) recorder.warn("publishing.exposed_docs.missing", "Publishable builds should expose sanitized docs", { areas: ["publishability"] });
  else if (docs.length > 0) recorder.pass("publishing.exposed_docs.present", `${String(docs.length)} exposed doc descriptor(s) declared`, { areas: ["publishability"] });
  if (publishable === true && assets.length === 0) recorder.warn("publishing.excluded_assets.missing", "Publishable builds should declare excluded assets", { areas: ["publishability"] });
  else if (assets.length > 0) recorder.pass("publishing.excluded_assets.present", `${String(assets.length)} excluded asset rule(s) declared`, { areas: ["publishability"] });
}
function validateEconomics(recorder: Recorder, economics: JsonObject) {
  if (Number(economics.estimated_prompt_token_savings ?? 0) > 0) recorder.pass("economics.token_savings.present", "economics.estimated_prompt_token_savings is positive", { areas: ["readiness"] });
  else recorder.warn("economics.token_savings.missing", "economics.estimated_prompt_token_savings should be positive", { areas: ["readiness"] });

  if (Number(economics.estimated_clone_time_minutes ?? 0) > 0) recorder.pass("economics.clone_time.present", "economics.estimated_clone_time_minutes is positive", { areas: ["installability"] });
  else recorder.warn("economics.clone_time.missing", "economics.estimated_clone_time_minutes should be positive", { areas: ["installability"] });

  if (Number(economics.estimated_update_time_minutes ?? 0) > 0) recorder.pass("economics.update_time.present", "economics.estimated_update_time_minutes is positive", { areas: ["updateability"] });
  else recorder.warn("economics.update_time.missing", "economics.estimated_update_time_minutes should be positive", { areas: ["updateability"] });

  const maintenanceScore = Number(economics.maintenance_score ?? 0);
  if (maintenanceScore >= 70) recorder.pass("economics.maintenance_score.strong", `maintenance_score ${String(maintenanceScore)} is strong`, { areas: ["readiness"] });
  else if (maintenanceScore >= 50) recorder.warn("economics.maintenance_score.review", `maintenance_score ${String(maintenanceScore)} needs review`, { areas: ["readiness"] });
  else recorder.warn("economics.maintenance_score.low", `maintenance_score ${String(maintenanceScore)} is low`, { areas: ["readiness"] });
}

function validateProvenance(recorder: Recorder, provenance: JsonObject, compositionIds: string[]) {
  if (isObject(provenance.created_by) && isNonEmptyString(provenance.created_by.actor_id) && isNonEmptyString(provenance.created_by.timestamp)) {
    recorder.pass("provenance.created_by.present", "provenance.created_by is recorded", { areas: ["readiness", "publishability"] });
  } else {
    recorder.fail("provenance.created_by.missing", "provenance.created_by must record who created the build", { areas: ["readiness", "publishability"] });
  }

  const touchedBy = safeArray(provenance.touched_by).filter(isObject);
  if (touchedBy.length > 0) recorder.pass("provenance.touched_by.present", `${String(touchedBy.length)} provenance.touched_by event(s) recorded`, { areas: ["readiness"] });
  else recorder.warn("provenance.touched_by.missing", "provenance.touched_by should record major edits", { areas: ["readiness"] });

  const sourceChain = safeArray(provenance.source_chain).filter(isObject);
  if (sourceChain.length === 0) {
    recorder.fail("provenance.source_chain.missing", "provenance.source_chain is required", { areas: ["readiness", "publishability"] });
    return;
  }

  recorder.pass("provenance.source_chain.present", `${String(sourceChain.length)} source-chain event(s) recorded`, { areas: ["readiness", "publishability"] });
  const sourceIds = new Set(uniqStrings(sourceChain.map((entry) => entry.artifact_id)));
  const missingRefs = compositionIds.filter((brickId: string) => !sourceIds.has(brickId));
  if (missingRefs.length > 0) {
    recorder.warn("provenance.source_chain.incomplete", "Some composition bricks are not represented in provenance.source_chain", {
      areas: ["readiness", "publishability"],
      detail: { brick_ids: missingRefs },
    });
  }
}

function validateSweetspot(recorder: Recorder, sweetspot: JsonObject, build: JsonObject) {
  const gates = ["ssa_v2", "ssi", "sstf", "spe", "srs", "ssra", "sas", "sva", "srls", "sev", "ssc", "sai"];
  let totalScore = 0, scoreCount = 0, missingCriticalGates = 0;
  for (const gate of gates) {
    const result = validateSweetspotGate(recorder, gate, sweetspot[gate], safeString(build.status));
    totalScore += result.score;
    scoreCount += result.scored ? 1 : 0;
    missingCriticalGates += result.criticalWeak ? 1 : 0;
  }
  const averageScore = scoreCount ? Math.round(totalScore / scoreCount) : 0;
  if (averageScore >= 75) recorder.pass("sweetspot.average_score.strong", `Average sweetspot gate score is ${String(averageScore)}`, { areas: ["readiness"] });
  else if (averageScore >= 60) recorder.warn("sweetspot.average_score.review", `Average sweetspot gate score is ${String(averageScore)}`, { areas: ["readiness"] });
  else recorder.warn("sweetspot.average_score.low", `Average sweetspot gate score is ${String(averageScore)}`, { areas: ["readiness"] });
  if ((build.status === "verified" || build.status === "canonical") && missingCriticalGates > 0) recorder.fail("sweetspot.gate.verified_mismatch", "Verified/canonical builds cannot ship with missing critical Sweetspot gates", { areas: ["readiness", "publishability"] });
}

function validateSweetspotGate(recorder: Recorder, gate: string, value: unknown, buildStatus: string) {
  if (!isObject(value)) {
    recorder.fail("sweetspot.gate.missing", `sweetspot.${gate} is required`, { areas: ["readiness"], detail: { gate } });
    return { score: 0, scored: false, criticalWeak: false };
  }
  const score = typeof value.score === "number" ? value.score : 0;
  const status = safeString(value.status);
  if (!status) {
    recorder.fail("sweetspot.gate.status_missing", `sweetspot.${gate}.status is required`, { areas: ["readiness"], detail: { gate } });
    return { score, scored: typeof value.score === "number", criticalWeak: false };
  }
  const criticalWeak = ["sstf", "srls", "sev", "sva"].includes(gate) && (status === "missing" || status === "failing");
  if (criticalWeak) recorder[buildStatus === "verified" || buildStatus === "canonical" ? "fail" : "warn"]("sweetspot.gate.critical_weak", `Critical gate ${gate} is "${status}"`, { areas: ["readiness", "publishability"], detail: { gate, status } });
  else recorder.pass("sweetspot.gate.present", `sweetspot.${gate} recorded as "${status}"`, { areas: ["readiness"], detail: { gate, status } });
  return { score, scored: typeof value.score === "number", criticalWeak };
}
function validateReleaseLink(recorder: Recorder, releaseArtifact: JsonObject | null, releaseContext: Awaited<ReturnType<typeof loadReleaseContext>>, buildContext: JsonObject): ReleaseSummary {
  if (!releaseContext.available) {
    recorder.pass("release.index.optional", "Release index not loaded; release checks skipped", { areas: ["updateability"] });
    return { available: false, artifact_found: false };
  }
  if (!releaseArtifact) {
    recorder.warn("release.artifact.missing", "No build release artifact found in release index", { areas: ["readiness", "updateability"] });
    return { available: true, artifact_found: false };
  }
  recorder.pass("release.artifact.present", "Build release artifact found in release index", { areas: ["readiness", "updateability"] });
  const data = releaseLinkData(releaseArtifact);
  validateReleaseIdentity(recorder, data, buildContext);
  validateReleaseCoverage(recorder, data, buildContext);
  return { available: true, artifact_found: true, release_count: Number(releaseArtifact.release_count ?? 0),
    latest_version: data.latestVersion || null, latest_status: data.latestStatus || null,
    latest_verification_status: data.latestVerification || null, latest_trust_level: data.latestTrustLevel || null,
    latest_channel: safeString(data.latestRelease.channel) || null, published_release_count: Number(data.artifactTrust.published_release_count ?? 0) };
}

function releaseLinkData(releaseArtifact: JsonObject) {
  const latestRelease = isObject(releaseArtifact.latest_release) ? releaseArtifact.latest_release : releaseArtifact;
  const artifactTrust = isObject(releaseArtifact.trust_summary) ? releaseArtifact.trust_summary : {};
  const trustSummary = isObject(latestRelease.trust_summary) ? latestRelease.trust_summary : artifactTrust;
  const contractSummary = isObject(latestRelease.contract_summary) ? latestRelease.contract_summary : {};
  const contentSummary = isObject(latestRelease.content_summary) ? latestRelease.content_summary : {};
  return { latestRelease, artifactTrust, latestVersion: safeString(latestRelease.version), latestStatus: safeString(latestRelease.status),
    latestVerification: safeString(trustSummary.verification_status ?? artifactTrust.latest_verification_status),
    latestTrustLevel: safeString(trustSummary.trust_level ?? artifactTrust.latest_trust_level),
    requiredEnvCount: Number(contractSummary.required_env_count ?? 0), includedPathCount: Number(contentSummary.included_path_count ?? 0) };
}

function validateReleaseIdentity(recorder: Recorder, data: ReturnType<typeof releaseLinkData>, buildContext: JsonObject) {
  const buildVersion = safeString(buildContext.buildVersion);
  if (data.latestVersion === buildVersion) recorder.pass("release.version.aligned", "Release version matches build.version", { areas: ["updateability"] });
  else recorder.warn("release.version.mismatch", `Release version "${data.latestVersion || "unknown"}" differs from build.version "${buildVersion || "unknown"}"`, {
    areas: ["updateability"], detail: { release_version: data.latestVersion, build_version: buildContext.buildVersion },
  });
  if (data.latestStatus === "published") recorder.pass("release.status.published", "Latest release artifact is published", { areas: ["updateability", "publishability"] });
  else recorder.warn("release.status.unpublished", `Latest release artifact status is "${data.latestStatus || "unknown"}"`, { areas: ["updateability", "publishability"] });
}

function validateReleaseCoverage(recorder: Recorder, data: ReturnType<typeof releaseLinkData>, buildContext: JsonObject) {
  if (data.requiredEnvCount > 0 && buildContext.requiredEnvCount !== data.requiredEnvCount) recorder.warn("release.contract_env.mismatch", "Release required_env count differs from manifest contracts.env.required count", {
    areas: ["updateability"], detail: { release_required_env_count: data.requiredEnvCount, manifest_required_env_count: buildContext.requiredEnvCount },
  });
  if (data.includedPathCount > 0 && Number(buildContext.sourcePathCount ?? 0) > data.includedPathCount) recorder.warn("release.content.paths_thin", "Release included_path_count is smaller than manifest source.paths count", {
    areas: ["updateability"], detail: { release_included_path_count: data.includedPathCount, manifest_source_path_count: buildContext.sourcePathCount },
  });
  const buildStatus = safeString(buildContext.buildStatus);
  if ((buildStatus === "verified" || buildStatus === "canonical") && verificationRank(data.latestVerification) < VERIFICATION_RANK.candidate) recorder.fail("release.verification.too_weak", `Build status "${buildStatus}" is stronger than latest release verification "${data.latestVerification || "unknown"}"`, {
    areas: ["readiness", "publishability"],
  });
}
function buildSignal(area: string, checks: BuildCheck[], options: CheckOptions = {}): BuildSignal {
  const relevant = checks.filter((check) => safeArray(check.areas).includes(area) && check.level !== "pass");
  const failCount = relevant.filter((check: { level: string; }) => check.level === "fail").length;
  const warnCount = relevant.filter((check: { level: string; }) => check.level === "warn").length;
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

function suggestVerificationStatus({ build, verification, provenance, recorder, releaseSummary, registrySummary, installabilitySignal, updateabilitySignal, readinessSignal }: SuggestVerificationOptions): VerificationStatus {
  const smokeCommands = uniqStrings(verification.smoke_commands);
  const fixtureTargets = uniqStrings(verification.fixture_targets);
  const evidence = safeArray(verification.evidence).filter(isObject);
  const reviewedBy = safeArray(provenance.reviewed_by).filter(isObject);
  const hasVerifiedEvidence = evidence.some((entry) => verificationEvidenceRank(entry.status) >= VERIFICATION_RANK.verified) || reviewedBy.length > 0;
  const hasCandidateEvidence = evidence.some((entry) => verificationEvidenceRank(entry.status) >= VERIFICATION_RANK.candidate);
  const hasReleaseEvidence = verificationRank(releaseSummary.latest_verification_status) >= VERIFICATION_RANK.candidate;
  const declaredBuildStatus = safeString(build.status);

  const context = { declaredBuildStatus, hasVerifiedEvidence, hasCandidateEvidence, hasReleaseEvidence, smokeCommands,
    fixtureTargets, recorder, releaseSummary, registrySummary, installabilitySignal, updateabilitySignal, readinessSignal };
  if (isUnverifiedSuggestion(context)) return "unverified";
  if (isCanonicalSuggestion(context)) return "canonical";
  if (isVerifiedSuggestion(context)) return "verified";
  if (isCandidateSuggestion(context)) return "candidate";

  return "unverified";
}

interface SuggestionContext {
  declaredBuildStatus: string; hasVerifiedEvidence: boolean; hasCandidateEvidence: boolean; hasReleaseEvidence: boolean;
  smokeCommands: string[]; fixtureTargets: string[]; recorder: Recorder; releaseSummary: ReleaseSummary; registrySummary: RegistrySummary;
  installabilitySignal: BuildSignal; updateabilitySignal: BuildSignal; readinessSignal: BuildSignal;
}

function isUnverifiedSuggestion(context: SuggestionContext) {
  return context.recorder.counts.fail > 0 || context.readinessSignal.status === "blocked" || context.installabilitySignal.status === "blocked";
}

function isCanonicalSuggestion(context: SuggestionContext) {
  return context.declaredBuildStatus === "canonical" && context.hasVerifiedEvidence && context.releaseSummary.latest_status === "published"
    && ["stable", "lts"].includes(safeString(context.releaseSummary.latest_channel))
    && verificationRank(context.releaseSummary.latest_verification_status) >= VERIFICATION_RANK.canonical
    && context.updateabilitySignal.status === "ready" && context.recorder.counts.warn <= 3;
}

function isVerifiedSuggestion(context: SuggestionContext) {
  return (context.declaredBuildStatus === "verified" || context.hasVerifiedEvidence) && context.hasReleaseEvidence && context.smokeCommands.length > 0
    && context.registrySummary.missing_brick_count === 0 && context.registrySummary.failing_member_count === 0
    && context.updateabilitySignal.status !== "blocked" && context.recorder.counts.warn <= 8;
}

function isCandidateSuggestion(context: SuggestionContext) {
  return (context.smokeCommands.length > 0 || context.fixtureTargets.length > 0 || context.hasCandidateEvidence || context.hasReleaseEvidence)
    && context.registrySummary.missing_brick_count === 0 && context.installabilitySignal.status !== "blocked";
}

function suggestTrustLevel({ suggestedVerificationStatus, recorder, releaseSummary }: SuggestTrustOptions): TrustLevel {
  if (suggestedVerificationStatus === "canonical") return "high";
  if (suggestedVerificationStatus === "verified") {
    return recorder.counts.warn <= 3 && releaseSummary.latest_status === "published" ? "high" : "strong";
  }
  if (suggestedVerificationStatus === "candidate") {
    return verificationRank(releaseSummary.latest_verification_status) >= VERIFICATION_RANK.candidate ? "medium" : "low";
  }
  return recorder.counts.fail > 0 ? "blocked" : "low";
}

interface BuildSummaryAccumulator {
  counts: Record<CheckLevel, number>;
  verificationStatuses: Record<string, number>;
  trustLevels: Record<string, number>;
  signalCounts: Record<SignalArea, Record<string, number>>;
  readyForAdoptionCount: number;
  installableCount: number;
  updateableCount: number;
  publishableCount: number;
  releaseLinkedCount: number;
  blockerMap: Map<string, BlockerAggregate>;
}

function createBuildSummaryAccumulator(): BuildSummaryAccumulator {
  return {
    counts: { pass: 0, warn: 0, fail: 0 }, verificationStatuses: {}, trustLevels: {},
    signalCounts: {
    readiness: {},
    installability: {},
    updateability: {},
    publishability: {},
    },
    readyForAdoptionCount: 0, installableCount: 0, updateableCount: 0,
    publishableCount: 0, releaseLinkedCount: 0, blockerMap: new Map<string, BlockerAggregate>(),
  };
}

function addBuildToSummary(summary: BuildSummaryAccumulator, build: VerifiedBuildReport) {
  summary.counts.pass += build.counts.pass;
  summary.counts.warn += build.counts.warn;
  summary.counts.fail += build.counts.fail;
  incrementCounter(summary.verificationStatuses, build.verification.suggested_status);
  incrementCounter(summary.trustLevels, build.verification.suggested_trust_level);
  for (const area of SIGNAL_AREAS) incrementCounter(summary.signalCounts[area], build.signals[area].status);
  if (build.booleans.ready_for_adoption) summary.readyForAdoptionCount += 1;
  if (build.booleans.installable) summary.installableCount += 1;
  if (build.booleans.updateable) summary.updateableCount += 1;
  if (build.booleans.publishable) summary.publishableCount += 1;
  if (build.release.artifact_found) summary.releaseLinkedCount += 1;
  for (const blocker of build.top_blockers) {
      if (!isNonEmptyString(blocker.code)) continue;
      const current = summary.blockerMap.get(blocker.code) ?? {
        code: blocker.code,
        level: blocker.level,
        count: 0,
        builds: new Set<string>(),
        message: blocker.message,
      };
      current.count += 1;
      current.builds.add(build.build_id ?? build.path);
      if (blocker.level === "fail") current.level = "fail";
      summary.blockerMap.set(blocker.code, current);
  }
}

function summarizeBuildReports(builds: VerifiedBuildReport[], skipped: SkippedBuild[], releaseContext: Awaited<ReturnType<typeof loadReleaseContext>>) {
  const summary = createBuildSummaryAccumulator();
  for (const build of builds) addBuildToSummary(summary, build);

  return {
    build_count: builds.length,
    skipped_count: skipped.length,
    counts: summary.counts,
    release_index_available: releaseContext.available,
    release_linked_build_count: summary.releaseLinkedCount,
    verification_status_suggestions: summary.verificationStatuses,
    trust_level_suggestions: summary.trustLevels,
    signal_counts: summary.signalCounts,
    ready_for_adoption_count: summary.readyForAdoptionCount,
    installable_count: summary.installableCount,
    updateable_count: summary.updateableCount,
    publishable_count: summary.publishableCount,
    top_blockers: [...summary.blockerMap.values()]
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

function topIssues(checks: BuildCheck[], limit: number) {
  return checks
    .filter((check: { level: string; }) => check.level !== "pass")
    .sort((left, right) => severityRank(right.level) - severityRank(left.level) || compareStrings(left.code, right.code))
    .slice(0, limit)
    .map((check) => ({
      level: check.level,
      code: check.code,
      message: check.message,
      areas: check.areas,
      detail: check.detail ?? undefined,
    }));
}

function verificationEvidenceRank(value: unknown) {
  const normalized = safeString(value).toLowerCase();
  if (normalized === "canonical") return VERIFICATION_RANK.canonical;
  if (normalized === "verified" || normalized === "passing" || normalized === "passed") return VERIFICATION_RANK.verified;
  if (normalized === "candidate" || normalized === "partial") return VERIFICATION_RANK.candidate;
  return VERIFICATION_RANK.unverified;
}

function verificationRank(value: unknown) {
  return verificationEvidenceRank(value);
}

function buildStatusRank(value: string): number | null {
  switch (value) {
    case "experimental": return BUILD_STATUS_RANK.experimental;
    case "candidate": return BUILD_STATUS_RANK.candidate;
    case "verified": return BUILD_STATUS_RANK.verified;
    case "canonical": return BUILD_STATUS_RANK.canonical;
    case "deprecated": return BUILD_STATUS_RANK.deprecated;
    case "unsafe": return BUILD_STATUS_RANK.unsafe;
    default: return null;
  }
}

function trustTierRank(value: string): number | null {
  switch (value) {
    case "experimental": return TRUST_TIER_RANK.experimental;
    case "reviewed": return TRUST_TIER_RANK.reviewed;
    case "verified": return TRUST_TIER_RANK.verified;
    case "canonical": return TRUST_TIER_RANK.canonical;
    default: return null;
  }
}

function buildProjectPrefix(buildId: string) {
  if (!isNonEmptyString(buildId)) return "";
  const [prefix] = buildId.split(".build.");
  return prefix || "";
}

function severityRank(level: string) {
  if (level === "fail") return 2;
  if (level === "warn") return 1;
  return 0;
}

function pathCoveredByFileMap(candidatePath: string, fileMapSourcePaths: string[]) {
  const normalized = normalizePath(candidatePath);
  return fileMapSourcePaths.some((entry) => {
    const mapped = normalizePath(entry);
    return normalized === mapped || normalized.startsWith(`${mapped}/`) || mapped.startsWith(`${normalized}/`);
  });
}

function matchesSourcePath(manifestPathValue: string, registryPaths: unknown) {
  const normalizedManifest = normalizePath(manifestPathValue);
  return uniqStrings(registryPaths).some((entry) => {
    const normalizedRegistry = normalizePath(entry);
    return normalizedRegistry === normalizedManifest || normalizedRegistry.endsWith(`/${normalizedManifest}`) || normalizedManifest.endsWith(`/${normalizedRegistry}`);
  });
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function relativeRepoPath(filePath: string) {
  return normalizePath(path.relative(repoRoot, path.resolve(filePath)));
}

function incrementCounter(map: Record<string, number>, key: string) {
  map[key] = (map[key] || 0) + 1;
}

function uniqStrings(values: unknown) {
  return [...new Set(safeArray(values).map((value) => safeString(value)).filter(Boolean))];
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isNonEmptyString(value: unknown): value is string {
  return safeString(value).length > 0;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePath(value: string) {
  return (value || "").split(path.sep).join("/");
}

function compareStrings(left: string, right: string) {
  return (left || "").localeCompare((right || ""));
}
