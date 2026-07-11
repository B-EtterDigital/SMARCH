#!/usr/bin/env node

/**
 * WHAT: Builds the searchable index of curated multi-brick builds.
 * WHY: Release and reuse tools need one ranked view instead of rediscovering build manifests and evidence independently.
 * HOW: Reads build manifests plus verification and release records, then writes or prints an index consumed by build tooling and controllers.
 * Usage: `node tools/sma-build-index.ts --dry-run --stdout`
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const STATUS_SCORES = {
  failed: 5,
  blocked: 10,
  missing: 18,
  absent: 18,
  unverified: 30,
  planned: 36,
  partial: 55,
  candidate: 68,
  passing: 74,
  verified: 86,
  canonical: 95,
};

const TRUST_SCORES = {
  blocked: 10,
  low: 30,
  medium: 62,
  strong: 84,
  high: 94,
};

const READINESS_SCORES = {
  blocked: 15,
  manual: 38,
  guided: 60,
  copy_ready: 88,
  ready: 88,
};

const defaults = {
  root: path.resolve(repoRoot, "builds"),
  releases: path.resolve(repoRoot, "releases/release-index.generated.json"),
  verificationRoot: path.resolve(repoRoot, "wiki/security"),
  out: path.resolve(repoRoot, "builds/build-index.generated.json"),
};

type JsonRecord = Record<string, unknown>;
interface CliOptions { dryRun: boolean; help: boolean; out: string; releases: string; root: string; stdout: boolean; verificationRoot: string }
interface Issue { code: string; dimension: string; message: string; severity: string }
interface BlockerCount extends Issue { count: number; sample_build_ids: string[] }
interface VerificationReport extends JsonRecord { check_counts?: unknown; evidence_count?: number; issues?: Issue[]; path?: string; status?: string; trust_level?: string }
interface BasicBuild { id: string; project?: string; slug?: string }
interface ScoredDimension { issues: Issue[]; label: string; ready: boolean; score: number }
interface IndexedBuild { build_id: string; brick_count: number; file?: string; flow_count?: number; installability: ScoredDimension; kind?: string | null; name: string; optional_brick_count: number; project: string | null; publishability: ScoredDimension; release_summary: { canonical_release_count: number; published_release_count: number; release_count: number }; required_brick_count: number; slug?: string | null; status: string | null; summary?: string | null; sweetspot?: JsonRecord; top_blockers: Issue[]; trust_tier: string | null; updateability: ScoredDimension; verification_health: ScoredDimension & { primary_status: string }; visibility: string | null; [key: string]: unknown }

const HELP_TEXT = `SMARCH curated build index generator

Usage:
  node tools/sma-build-index.ts
  node tools/sma-build-index.ts --root builds --releases releases/release-index.generated.json --out builds/build-index.generated.json

Options:
  --root <dir>               Build manifest root directory. Default: builds
  --releases <file>          Release index JSON for release linkage. Default: releases/release-index.generated.json
  --verification-root <dir>  Optional build verification report root. Default: wiki/security
  --out <file>               Output file. Default: builds/build-index.generated.json
  --stdout                   Print the generated index to stdout
  --dry-run                  Alias for --stdout without writing a file
  --help                     Show this help text
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

  const manifests = await collectBuildManifests(options.root);
  const releaseLookup = await loadReleaseLookup(options.releases);
  const verificationLookup = await loadVerificationLookup(options.verificationRoot);
  const builds: IndexedBuild[] = [];
  const skipped: { error?: string; path: string; reason: string }[] = [];

  for (const filePath of manifests) {
    const parsed = await readJson(filePath);
    if (parsed.ok === false) {
      skipped.push({
        path: normalizePath(path.relative(repoRoot, filePath)),
        reason: "invalid_json",
        error: parsed.error,
      });
      continue;
    }

    const summary = await summarizeBuildManifest(parsed.value, filePath, releaseLookup, verificationLookup);
    if (summary.ok === false) {
      skipped.push({
        path: normalizePath(path.relative(repoRoot, filePath)),
        reason: summary.reason,
      });
      continue;
    }

    builds.push(summary.value);
  }

  builds.sort(compareBuilds);
  skipped.sort((left, right) => compareStrings(left.path, right.path));

  const document = {
    generated_at: new Date().toISOString(),
    root: normalizePath(path.relative(repoRoot, options.root)),
    release_index_path: normalizePath(path.relative(repoRoot, options.releases)),
    verification_root: normalizePath(path.relative(repoRoot, options.verificationRoot)),
    summary: summarizeBuildIndex(builds),
    builds,
    skipped,
  };

  if (options.stdout || options.dryRun) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  }

  if (!options.dryRun) {
    await fs.mkdir(path.dirname(options.out), { recursive: true });
    await fs.writeFile(options.out, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    ...defaults,
    stdout: false,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const pathOption = {
      "--root": "root",
      "--releases": "releases",
      "--verification-root": "verificationRoot",
      "--out": "out",
    }[arg] as "root" | "releases" | "verificationRoot" | "out" | undefined;
    if (pathOption) {
      options[pathOption] = path.resolve(requireValue(argv, ++index, arg));
    } else if (arg === "--stdout") {
      options.stdout = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
      options.stdout = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

async function collectBuildManifests(root: string): Promise<string[]> {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) {
    return [];
  }
  const files: string[] = [];
  await walkDirectory(root, files);
  return files.sort(compareStrings);
}

async function walkDirectory(directory: string, files: string[]): Promise<void> {
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

async function readJson(filePath: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function loadReleaseLookup(filePath: string): Promise<Map<string, JsonRecord>> {
  const parsed = await readJson(filePath);
  if (!parsed.ok || !isObject(parsed.value)) {
    return new Map();
  }
  const artifacts = collectBuildArtifacts(parsed.value.artifacts);
  const lookup = new Map<string, JsonRecord>();
  for (const artifact of artifacts) {
    if (!isObject(artifact) || artifact.artifact_type !== "build" || typeof artifact.artifact_id !== "string") {
      continue;
    }
    lookup.set(artifact.artifact_id, artifact);
  }
  return lookup;
}

function collectBuildArtifacts(artifacts: unknown): unknown[] {
  if (Array.isArray(artifacts)) {
    return artifacts;
  }
  if (!isObject(artifacts)) {
    return [];
  }
  if (isObject(artifacts.build)) {
    return Object.values(artifacts.build);
  }
  return Object.values(artifacts);
}

async function loadVerificationLookup(root: string): Promise<Map<string, VerificationReport>> {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) {
    return new Map();
  }

  const files: string[] = [];
  await walkVerificationTree(root, files);
  const lookup = new Map<string, VerificationReport>();

  for (const filePath of files) {
    const parsed = await readJson(filePath);
    if (!parsed.ok || !isObject(parsed.value)) {
      continue;
    }
    const entry = summarizeVerificationReport(parsed.value, filePath);
    if (!entry) {
      continue;
    }
    for (const key of entry.keys) {
      if (!lookup.has(key)) {
        lookup.set(key, entry.report);
      }
    }
  }

  return lookup;
}

async function walkVerificationTree(directory: string, files: string[]): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareStrings(left.name, right.name));
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkVerificationTree(fullPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }
}

function summarizeVerificationReport(document: JsonRecord, filePath: string): { keys: Set<string>; report: VerificationReport } | null {
  const keys = new Set<string>();
  const build = isObject(document.build) ? document.build : {};
  const target = isObject(document.target) ? document.target : {};
  const summary = isObject(document.summary) ? document.summary : {};
  const verification = isObject(document.verification) ? document.verification : {};
  const health = isObject(document.health) ? document.health : {};
  addLookupKey(keys, document.artifact_id);
  addLookupKey(keys, document.build_id);
  addLookupKey(keys, document.slug);
  addLookupKey(keys, build.id);
  addLookupKey(keys, build.slug);
  addLookupKey(keys, target.artifact_id);
  addLookupKey(keys, target.build_id);
  addLookupKey(keys, target.slug);

  if (keys.size === 0) {
    return null;
  }

  const report: VerificationReport = {
    path: normalizePath(path.relative(repoRoot, filePath)),
    status: normalizeVerificationStatus(
      firstString(
        document.verification_status,
        document.status,
        summary.verification_status,
        verification.status,
        health.status,
      ),
    ),
    trust_level: normalizeTrustLevel(
      firstString(
        document.trust_level,
        summary.trust_level,
        verification.trust_level,
        health.trust_level,
      ),
    ),
    check_counts: normalizeCheckCounts(
      document.check_counts ??
      ((summary.check_counts ?? verification.check_counts) ?? health.check_counts),
    ),
    evidence_count: countEntries(document.evidence) || countEntries(verification.evidence) || countEntries(document.checks),
    issues: normalizeIssueList(((document.blockers ?? (document.findings ?? summary.blockers)) ?? verification.blockers) ?? []),
  };

  return { keys, report };
}

function addLookupKey(keys: Set<string>, value: unknown): void {
  if (!value) return;
  const normalized = normalizeLookupKey(value);
  if (normalized) keys.add(normalized);
}

async function loadBuildVerification(build: BasicBuild, filePath: string, verificationLookup: Map<string, VerificationReport>): Promise<VerificationReport | null> {
  const sidecarPaths = candidateVerificationSidecars(filePath);
  for (const sidecarPath of sidecarPaths) {
    const parsed = await readJson(sidecarPath);
    if (!parsed.ok || !isObject(parsed.value)) {
      continue;
    }
    const report = summarizeVerificationReport(parsed.value, sidecarPath)?.report;
    if (report) {
      return report;
    }
  }

  const keys = [
    build.id,
    build.slug,
    `${build.project ?? ""}/${build.slug ?? ""}`,
    path.basename(filePath, ".build.sweetspot.json"),
  ];

  for (const key of keys) {
    const report = verificationLookup.get(normalizeLookupKey(key));
    if (report) {
      return report;
    }
  }

  return null;
}

function candidateVerificationSidecars(filePath: string) {
  const base = filePath.replace(/\.build\.sweetspot\.json$/u, "");
  return [
    `${base}.verification.json`,
    `${base}.verify.json`,
    `${base}.verification.generated.json`,
  ];
}

async function summarizeBuildManifest(document: unknown, filePath: string, releaseLookup: Map<string, JsonRecord>, verificationLookup: Map<string, VerificationReport>): Promise<{ ok: false; reason: string } | { ok: true; value: IndexedBuild }> {
  if (!isObject(document) || !isObject(document.build)) {
    return { ok: false, reason: "missing_build_block" };
  }

  const build = document.build;
  if (typeof build.id !== "string" || typeof build.name !== "string") {
    return { ok: false, reason: "missing_build_identity" };
  }

  const source = isObject(document.source) ? document.source : {};
  const composition = isObject(document.composition) ? document.composition : {};
  const contracts = isObject(document.contracts) ? document.contracts : {};
  const sweetspot = isObject(document.sweetspot) ? document.sweetspot : {};
  const release = releaseLookup.get(build.id) ?? null;
  const verificationReport = await loadBuildVerification(
    {
      id: build.id,
      slug: typeof build.slug === "string" ? build.slug : "",
      project: typeof source.project === "string" ? source.project : "",
    },
    filePath,
    verificationLookup,
  );
  const brickRefs = Array.isArray(composition.brick_refs) ? composition.brick_refs : [];
  const requiredBrickRefs = brickRefs.filter((entry: { required: boolean; }) => entry.required);
  const optionalBrickRefs = brickRefs.filter((entry: { required: boolean; }) => entry && !entry.required);
  const flows = Array.isArray(composition.flows) ? composition.flows : [];
  const sourcePaths = Array.isArray(source.paths) ? source.paths : [];
  const releaseSummary = summarizeRelease(release);
  const verificationHealth = summarizeVerificationHealth(document, release, verificationReport);
  const publishability = summarizePublishability(document, release, releaseSummary, verificationHealth);
  const installability = summarizeInstallability(document, release, releaseSummary, verificationHealth);
  const updateability = summarizeUpdateability(document, release, releaseSummary, verificationHealth);
  const topBlockers = summarizeTopIssues([
    ...verificationHealth.issues,
    ...publishability.issues,
    ...installability.issues,
    ...updateability.issues,
  ]);

  return {
    ok: true,
    value: {
      build_id: build.id,
      name: build.name,
      slug: typeof build.slug === "string" ? build.slug : null,
      project: typeof source.project === "string" ? source.project : null,
      kind: typeof build.kind === "string" ? build.kind : null,
      status: typeof build.status === "string" ? build.status : null,
      version: typeof build.version === "string" ? build.version : null,
      visibility: typeof build.visibility === "string" ? build.visibility : null,
      stability: typeof build.stability === "string" ? build.stability : null,
      trust_tier: typeof build.trust_tier === "string" ? build.trust_tier : null,
      summary: typeof build.summary === "string" ? build.summary : null,
      domains: asStringArray(build.domain),
      runtimes: asStringArray(build.runtimes),
      source_path_count: sourcePaths.length,
      source_paths: sourcePaths.slice(0, 6),
      brick_count: brickRefs.length,
      required_brick_count: requiredBrickRefs.length,
      optional_brick_count: optionalBrickRefs.length,
      flow_count: flows.length,
      shared_contract_count: Array.isArray(composition.shared_contracts) ? composition.shared_contracts.length : 0,
      required_env_count: countContractEnv(contracts, "required"),
      optional_env_count: countContractEnv(contracts, "optional"),
      release_summary: releaseSummary,
      verification_report: verificationReport
        ? pick(verificationReport, ["path", "status", "trust_level", "check_counts", "evidence_count"])
        : null,
      verification_health: verificationHealth,
      publishability,
      installability,
      updateability,
      top_blockers: topBlockers,
      file: normalizePath(path.relative(repoRoot, filePath)),
      sweetspot: summarizeSweetspot(sweetspot),
    },
  };
}

function summarizeRelease(release: unknown) {
  if (!isObject(release)) {
    return {
      release_count: 0,
      latest_version: null,
      latest_channel: null,
      latest_status: null,
      latest_verification_status: null,
      best_verification_status: null,
      latest_trust_level: null,
      published_release_count: 0,
      canonical_release_count: 0,
      rollback_supported_release_count: 0,
      breaking_release_count: 0,
      failing_release_count: 0,
      latest_check_counts: {},
    };
  }

  const latest = isObject(release.latest_release) ? release.latest_release : {};
  const versions = Array.isArray(release.versions) ? release.versions : [];
  const trustSummary = isObject(release.trust_summary) ? release.trust_summary : {};
  const latestTrust = isObject(latest.trust_summary) ? latest.trust_summary : {};

  return {
    release_count: versions.length,
    latest_version: typeof latest.version === "string" ? latest.version : null,
    latest_channel: typeof latest.channel === "string" ? latest.channel : null,
    latest_status: typeof latest.status === "string" ? latest.status : null,
    latest_verification_status: normalizeVerificationStatus(
      typeof latest.verification_status === "string"
        ? latest.verification_status
        : latestTrust.verification_status,
    ),
    best_verification_status: normalizeVerificationStatus(trustSummary.best_verification_status),
    latest_trust_level: normalizeTrustLevel(
      typeof latestTrust.trust_level === "string"
        ? latestTrust.trust_level
        : trustSummary.latest_trust_level,
    ),
    published_release_count: versions.filter((entry) => isObject(entry) && entry.status === "published").length,
    canonical_release_count: versions.filter((entry) => isObject(entry) && normalizeVerificationStatus(entry.verification_status ?? (isObject(entry.trust_summary) ? entry.trust_summary.verification_status : undefined)) === "canonical").length,
    rollback_supported_release_count: Number(trustSummary.rollback_supported_release_count ?? 0),
    breaking_release_count: Number(trustSummary.breaking_release_count ?? 0),
    failing_release_count: Number(trustSummary.failing_release_count ?? 0),
    latest_check_counts: normalizeCheckCounts(latestTrust.check_counts),
  };
}

function summarizeVerificationHealth(document: JsonRecord, release: JsonRecord | null, verificationReport: VerificationReport | null) {
  const manifestVerification = isObject(document.verification) ? document.verification : {};
  const latestRelease = isObject(release?.latest_release) ? release.latest_release : {};
  const releaseTrust = isObject(latestRelease.trust_summary) ? latestRelease.trust_summary : {};
  const releaseAggregateTrust = isObject(release?.trust_summary) ? release.trust_summary : {};

  const manifestStatus = normalizeVerificationStatus(manifestVerification.status);
  const releaseStatus = normalizeVerificationStatus(
    releaseTrust.verification_status ?? releaseAggregateTrust.latest_verification_status,
  );
  const reportStatus = normalizeVerificationStatus(verificationReport?.status);
  const primarySource = reportStatus !== "missing"
    ? "verifier_report"
    : releaseStatus !== "missing"
      ? "latest_release"
      : manifestStatus !== "missing"
        ? "manifest"
        : "none";
  const primaryStatus = primarySource === "verifier_report"
    ? reportStatus
    : primarySource === "latest_release"
      ? releaseStatus
      : primarySource === "manifest"
        ? manifestStatus
        : "missing";
  const bestStatus = highestVerificationStatus([manifestStatus, releaseStatus, reportStatus]);
  const trustLevel = normalizeTrustLevel(
    (verificationReport?.trust_level ??
      releaseTrust.trust_level) ??
      releaseAggregateTrust.latest_trust_level,
  );
  const checkCounts = mergeCheckCounts(
    normalizeCheckCounts(manifestVerification.check_counts),
    normalizeCheckCounts(releaseTrust.check_counts),
    normalizeCheckCounts(verificationReport?.check_counts),
  );
  const smokeCommands = asStringArray(manifestVerification.smoke_commands);
  const integrationTargets = asStringArray(manifestVerification.integration_targets);
  const evidenceCount = countEntries(manifestVerification.evidence) + (verificationReport?.evidence_count ?? 0);

  let score = verificationScoreFor(primaryStatus);
  const bestScore = verificationScoreFor(bestStatus);
  const trustScore = trustScoreFor(trustLevel);
  score = Math.round((score * 3 + bestScore) / 4);
  if (trustScore) {
    score = Math.round((score * 4 + trustScore) / 5);
  }
  score += Math.min(12, (checkCounts.passed || 0) * 4);
  score -= Math.min(30, (checkCounts.failed || 0) * 15);
  if ((checkCounts.total || 0) === 0) score -= 8;
  if (smokeCommands.length > 0) score += 6;
  if (integrationTargets.length > 0) score += 4;
  if (evidenceCount > 0) score += Math.min(8, evidenceCount * 2);
  score = clampScore(score);

  const issues: Issue[] = [];
  if (primaryStatus === "failed" || primaryStatus === "blocked") {
    issues.push(issue("verification", "blocker", "verification_failed", "Verification evidence is failing or explicitly blocked."));
  } else if (primaryStatus === "unverified" || primaryStatus === "missing") {
    issues.push(issue("verification", "blocker", "verification_not_release_backed", "No strong verification evidence exists for the current build release."));
  } else if (primaryStatus === "partial" || primaryStatus === "planned") {
    issues.push(issue("verification", "warning", "verification_partial", "Verification evidence exists, but it is still partial or only planned."));
  }
  if ((checkCounts.failed || 0) > 0) {
    issues.push(issue("verification", "blocker", "failing_checks", `${String(checkCounts.failed)} verification check${checkCounts.failed === 1 ? "" : "s"} are failing.`));
  }
  if ((checkCounts.total || 0) === 0) {
    issues.push(issue("verification", "warning", "missing_check_counts", "No executed verification checks are recorded yet."));
  }
  if (smokeCommands.length === 0) {
    issues.push(issue("verification", "warning", "missing_smoke_commands", "No smoke commands are attached to the build manifest."));
  }
  if (evidenceCount === 0) {
    issues.push(issue("verification", "warning", "missing_verification_evidence", "No verification evidence entries are attached to this build."));
  }

  return {
    source: primarySource,
    primary_status: primaryStatus,
    best_status: bestStatus,
    manifest_status: manifestStatus !== "missing" ? manifestStatus : null,
    latest_release_status: releaseStatus !== "missing" ? releaseStatus : null,
    verifier_report_status: reportStatus !== "missing" ? reportStatus : null,
    trust_level: trustLevel !== "unknown" ? trustLevel : null,
    check_counts: checkCounts,
    smoke_command_count: smokeCommands.length,
    integration_target_count: integrationTargets.length,
    evidence_count: evidenceCount,
    score,
    label: scoreLabel(score),
    ready: score >= 70 && !hasSeverity(issues, "blocker"),
    issues: summarizeTopIssues(issues, 6),
  };
}

function summarizePublishability(document: JsonRecord, release: JsonRecord | null, releaseSummary: ReturnType<typeof summarizeRelease>, verificationHealth: ReturnType<typeof summarizeVerificationHealth>): ScoredDimension & Record<string, unknown> {
  const publishing = isObject(document.publishing) ? document.publishing : {};
  const build = isObject(document.build) ? document.build : {};
  const classification = isObject(document.classification) ? document.classification : {};
  const excludedAssets = asStringArray(publishing.excluded_assets);
  const exposedDocs = asStringArray(publishing.exposed_docs);
  const visibility = firstString(publishing.visibility, build.visibility, "private");
  const license = firstString(publishing.license, "private");
  const redactionProfile = firstString(publishing.redaction_profile, "");
  const publishable = publishing.publishable === true;
  const latestRelease = release && isObject(release.latest_release) ? release.latest_release : {};
  const contentSummary = isObject(latestRelease.content_summary) ? latestRelease.content_summary : {};
  const portableDocCount = Number(contentSummary.portable_doc_count ?? 0);

  let score = 22;
  if (publishable) score += 32;
  if (normalizeVisibility(visibility) === "public") score += 18;
  if (normalizeVisibility(visibility) === "community") score += 14;
  if (normalizeVisibility(visibility) === "private") score -= 10;
  if (license && !/private/i.test(license)) score += 12;
  if (!license || /private/i.test(license)) score -= 12;
  if (redactionProfile) score += 10;
  if (!redactionProfile) score -= 6;
  score += Math.min(10, exposedDocs.length * 4);
  score += Math.min(8, excludedAssets.length * 2);
  if (portableDocCount > 0) score += 6;
  if (verificationHealth.score >= 70) score += 5;
  if (["high", "critical"].includes(String(classification.risk ?? "").toLowerCase()) && excludedAssets.length === 0) {
    score -= 10;
  }
  if (releaseSummary.published_release_count > 0) {
    score += 4;
  }
  score = clampScore(score);

  const issues: Issue[] = [];
  if (!publishable) {
    issues.push(issue("publishability", "blocker", "not_marked_publishable", "Manifest explicitly marks this build as not publishable."));
  }
  if (normalizeVisibility(visibility) === "private") {
    issues.push(issue("publishability", "blocker", "private_visibility", "Build visibility is private, so community export is blocked."));
  }
  if (!license || /private/i.test(license)) {
    issues.push(issue("publishability", "blocker", "private_license", "License metadata is private or missing."));
  }
  if (!redactionProfile) {
    issues.push(issue("publishability", "warning", "missing_redaction_profile", "No redaction profile is recorded for publish-safe export."));
  }
  if (exposedDocs.length === 0 && portableDocCount === 0) {
    issues.push(issue("publishability", "warning", "missing_export_docs", "No exposed docs or portable docs are recorded for community publishing."));
  }
  if (["high", "critical"].includes(String(classification.risk ?? "").toLowerCase()) && excludedAssets.length === 0) {
    issues.push(issue("publishability", "warning", "sensitive_assets_not_excluded", "High-risk build has no excluded asset guidance for publish-safe export."));
  }

  return {
    score,
    label: scoreLabel(score),
    publishable,
    visibility: visibility || null,
    license: license || null,
    redaction_profile: redactionProfile || null,
    exposed_doc_count: exposedDocs.length,
    excluded_asset_count: excludedAssets.length,
    ready: publishable && score >= 70 && !hasSeverity(issues, "blocker"),
    issues: summarizeTopIssues(issues, 6),
  };
}

function summarizeInstallability(document: JsonRecord, release: JsonRecord | null, releaseSummary: ReturnType<typeof summarizeRelease>, verificationHealth: ReturnType<typeof summarizeVerificationHealth>): ScoredDimension & Record<string, unknown> {
  const clone = isObject(document.clone) ? document.clone : {};
  const contracts = isObject(document.contracts) ? document.contracts : {};
  const readiness = normalizeReadiness(clone.readiness);
  const installSteps = asStringArray(clone.install_steps);
  const postCloneChecks = asStringArray(clone.post_clone_checks);
  const requiredPorts = asStringArray(clone.required_ports);
  const fileMap = Array.isArray(clone.file_map) ? clone.file_map : [];
  const env = isObject(contracts.env) ? contracts.env : {};
  const requiredEnv = Array.isArray(env.required) ? env.required : [];

  let score = readinessScoreFor(readiness);
  if (releaseSummary.release_count > 0) score += 10;
  if (releaseSummary.release_count === 0) score -= 10;
  score += Math.min(8, installSteps.length * 2);
  score += Math.min(6, postCloneChecks.length * 2);
  score += Math.min(4, fileMap.length);
  if (clone.greenfield_support) score += 3;
  if (clone.matching_architecture_support) score += 3;
  score -= Math.min(15, requiredPorts.length * 2);
  if (requiredEnv.length > 6) score -= Math.min(8, requiredEnv.length - 6);
  if (verificationHealth.score < 55) score -= 6;
  score = clampScore(score);

  const issues: Issue[] = [];
  if (releaseSummary.release_count === 0) {
    issues.push(issue("installability", "blocker", "no_release_artifact", "No release artifact exists yet, so install flow is not release-backed."));
  }
  if (readiness === "blocked") {
    issues.push(issue("installability", "blocker", "clone_blocked", "Clone readiness is explicitly blocked."));
  } else if (readiness === "manual") {
    issues.push(issue("installability", "warning", "manual_clone_path", "Clone path is still manual, not guided or copy-ready."));
  }
  if (installSteps.length === 0) {
    issues.push(issue("installability", "blocker", "missing_install_steps", "No install steps are documented."));
  }
  if (postCloneChecks.length === 0) {
    issues.push(issue("installability", "warning", "missing_post_clone_checks", "No post-clone checks are recorded."));
  }
  if (requiredPorts.length > 0) {
    issues.push(issue("installability", "warning", "adapter_ports_required", `${String(requiredPorts.length)} required port${requiredPorts.length === 1 ? "" : "s"} still need target-side adaptation.`));
  }

  return {
    score,
    label: scoreLabel(score),
    readiness: readiness || null,
    release_backed: releaseSummary.release_count > 0,
    greenfield_support: Boolean(clone.greenfield_support),
    matching_architecture_support: Boolean(clone.matching_architecture_support),
    required_port_count: requiredPorts.length,
    install_step_count: installSteps.length,
    post_clone_check_count: postCloneChecks.length,
    file_map_count: fileMap.length,
    required_env_count: requiredEnv.length,
    ready: score >= 70 && !hasSeverity(issues, "blocker"),
    issues: summarizeTopIssues(issues, 6),
  };
}

function summarizeUpdateability(document: JsonRecord, release: JsonRecord | null, releaseSummary: ReturnType<typeof summarizeRelease>, verificationHealth: ReturnType<typeof summarizeVerificationHealth>): ScoredDimension & Record<string, unknown> {
  const upgrade = isObject(document.upgrade) ? document.upgrade : {};
  const clone = isObject(document.clone) ? document.clone : {};
  const migrationHooks = asStringArray(upgrade.migration_hooks);
  const rollbackSteps = asStringArray(clone.rollback_steps);
  const latestRelease = release && isObject(release.latest_release) ? release.latest_release : {};
  const trustSummary = isObject(latestRelease.trust_summary) ? latestRelease.trust_summary : {};
  const rollbackSupported = Boolean(upgrade.rollback_supported ?? trustSummary.rollback_supported);
  const compatibilityPolicy = firstString(upgrade.compatibility_policy, "");

  let score = releaseSummary.release_count > 0 ? 35 : 15;
  if (rollbackSupported) score += 25;
  if (compatibilityPolicy) score += 10;
  score += Math.min(10, migrationHooks.length * 4);
  score += Math.min(8, rollbackSteps.length * 2);
  score += Math.min(6, Math.max(0, releaseSummary.release_count - 1) * 2);
  if (verificationHealth.score >= 70) score += 6;
  score -= Math.min(20, (releaseSummary.breaking_release_count || 0) * 10);
  score -= Math.min(30, (releaseSummary.failing_release_count || 0) * 15);
  score = clampScore(score);

  const issues: Issue[] = [];
  if (releaseSummary.release_count === 0) {
    issues.push(issue("updateability", "blocker", "no_release_history", "No release history exists yet for upgrade planning."));
  }
  if (!rollbackSupported) {
    issues.push(issue("updateability", "blocker", "rollback_not_supported", "Rollback support is not attested for this build."));
  }
  if (!compatibilityPolicy) {
    issues.push(issue("updateability", "warning", "missing_compatibility_policy", "No compatibility policy is recorded for upgrades."));
  }
  if (migrationHooks.length === 0) {
    issues.push(issue("updateability", "warning", "missing_migration_hooks", "No migration hooks are recorded for upgrade handling."));
  }
  if ((releaseSummary.breaking_release_count || 0) > 0) {
    issues.push(issue("updateability", "warning", "breaking_release_history", "Breaking releases exist in the current release history."));
  }
  if ((releaseSummary.failing_release_count || 0) > 0) {
    issues.push(issue("updateability", "blocker", "failing_release_history", "Failing releases exist in the current release history."));
  }

  return {
    score,
    label: scoreLabel(score),
    rollback_supported: rollbackSupported,
    compatibility_policy: compatibilityPolicy || null,
    migration_hook_count: migrationHooks.length,
    rollback_step_count: rollbackSteps.length,
    release_count: releaseSummary.release_count,
    breaking_release_count: releaseSummary.breaking_release_count || 0,
    failing_release_count: releaseSummary.failing_release_count || 0,
    ready: score >= 70 && !hasSeverity(issues, "blocker"),
    issues: summarizeTopIssues(issues, 6),
  };
}

function summarizeTopIssues(issues: Issue[], limit = 5): Issue[] {
  return [...issues]
    .sort(compareIssues)
    .slice(0, limit)
    .map((entry) => ({ dimension: entry.dimension, severity: entry.severity, code: entry.code, message: entry.message }));
}

function compareIssues(left: Issue, right: Issue): number {
  return severityRank(right.severity) - severityRank(left.severity)
    || compareStrings(left.dimension || "", right.dimension || "")
    || compareStrings(left.code || "", right.code || "");
}

function severityRank(value: string) {
  if (value === "blocker") return 3;
  if (value === "warning") return 2;
  return 1;
}

function issue(dimension: string, severity: string, code: string, message: string) {
  return { dimension, severity, code, message };
}

function summarizeSweetspot(sweetspot: JsonRecord): Record<string, { score: number | null; status: string | null }> {
  const keys = Object.keys(sweetspot)
    .filter((key) => isObject(sweetspot[key]))
    .sort(compareStrings);

  const summary: Record<string, { score: number | null; status: string | null }> = {};
  for (const key of keys) {
    const block = sweetspot[key];
    if (!isObject(block)) continue;
    summary[key] = {
      status: typeof block.status === "string" ? block.status : null,
      score: typeof block.score === 'number' && Number.isFinite(block.score) ? block.score : null,
    };
  }
  return summary;
}

function summarizeBuildIndex(builds: IndexedBuild[]) {
  const summary = {
    build_count: builds.length,
    by_project: {},
    by_status: {},
    by_visibility: {},
    by_trust_tier: {},
    released_build_count: 0,
    published_build_count: 0,
    canonical_release_build_count: 0,
    verification: {
      average_score: average(builds.map((build) => build.verification_health.score)),
      ready_count: 0,
      by_status: {},
      by_label: {},
    },
    publishability: {
      average_score: average(builds.map((build) => build.publishability.score)),
      ready_count: 0,
      by_label: {},
    },
    installability: {
      average_score: average(builds.map((build) => build.installability.score)),
      ready_count: 0,
      by_label: {},
    },
    updateability: {
      average_score: average(builds.map((build) => build.updateability.score)),
      ready_count: 0,
      by_label: {},
    },
    top_blockers: [] as BlockerCount[],
  };

  const blockerCounts = new Map<string, BlockerCount>();

  for (const build of builds) {
    increment(summary.by_project, build.project ?? "unknown");
    increment(summary.by_status, build.status ?? "unknown");
    increment(summary.by_visibility, build.visibility ?? "unknown");
    increment(summary.by_trust_tier, build.trust_tier ?? "unknown");
    if ((build.release_summary.release_count || 0) > 0) summary.released_build_count += 1;
    if ((build.release_summary.published_release_count || 0) > 0) summary.published_build_count += 1;
    if ((build.release_summary.canonical_release_count || 0) > 0) summary.canonical_release_build_count += 1;

    increment(summary.verification.by_status, build.verification_health.primary_status || "missing");
    increment(summary.verification.by_label, build.verification_health.label || "blocked");
    increment(summary.publishability.by_label, build.publishability.label || "blocked");
    increment(summary.installability.by_label, build.installability.label || "blocked");
    increment(summary.updateability.by_label, build.updateability.label || "blocked");

    if (build.verification_health.ready) summary.verification.ready_count += 1;
    if (build.publishability.ready) summary.publishability.ready_count += 1;
    if (build.installability.ready) summary.installability.ready_count += 1;
    if (build.updateability.ready) summary.updateability.ready_count += 1;

    for (const blocker of build.top_blockers || []) {
      const key = `${blocker.dimension}:${blocker.code}`;
      if (!blockerCounts.has(key)) {
        blockerCounts.set(key, {
          dimension: blocker.dimension,
          code: blocker.code,
          severity: blocker.severity,
          message: blocker.message,
          count: 0,
          sample_build_ids: [],
        });
      }
      const row = blockerCounts.get(key);
      if (!row) continue;
      row.count += 1;
      if (row.sample_build_ids.length < 4) {
        row.sample_build_ids.push(build.build_id);
      }
    }
  }

  summary.top_blockers = [...blockerCounts.values()]
    .sort((left, right) => right.count - left.count || severityRank(right.severity) - severityRank(left.severity) || compareStrings(left.code, right.code))
    .slice(0, 12);

  return summary;
}

function countContractEnv(contracts: JsonRecord, key: string): number {
  const env = isObject(contracts.env) ? contracts.env : {};
  const entries = Array.isArray(env[key]) ? env[key] : [];
  return entries.length;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalizeVerificationStatus(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "missing";
  if (["failed", "fail", "error", "errors"].includes(normalized)) return "failed";
  if (["blocked", "deny"].includes(normalized)) return "blocked";
  if (["unverified", "unknown"].includes(normalized)) return "unverified";
  if (["planned", "todo"].includes(normalized)) return "planned";
  if (["partial", "partial_pass", "partial-pass"].includes(normalized)) return "partial";
  if (["candidate"].includes(normalized)) return "candidate";
  if (["passing", "pass", "passed", "ok"].includes(normalized)) return "passing";
  if (["verified"].includes(normalized)) return "verified";
  if (["canonical"].includes(normalized)) return "canonical";
  if (["missing", "none", "absent"].includes(normalized)) return "missing";
  return normalized;
}

function normalizeTrustLevel(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "unknown";
  if (["blocked", "deny"].includes(normalized)) return "blocked";
  if (["low"].includes(normalized)) return "low";
  if (["medium", "moderate"].includes(normalized)) return "medium";
  if (["strong"].includes(normalized)) return "strong";
  if (["high"].includes(normalized)) return "high";
  return normalized;
}

function normalizeReadiness(value: unknown): keyof typeof READINESS_SCORES {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "manual";
  if (["copy_ready", "copy-ready", "copy ready"].includes(normalized)) return "copy_ready";
  if (["ready"].includes(normalized)) return "ready";
  if (["guided"].includes(normalized)) return "guided";
  if (["blocked"].includes(normalized)) return "blocked";
  return "manual";
}

function normalizeVisibility(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "private";
  if (["public", "open"].includes(normalized)) return "public";
  if (["community", "shared"].includes(normalized)) return "community";
  return "private";
}

function normalizeIssueList(items: unknown): Issue[] {
  if (!Array.isArray(items)) return [];
  return items
    .map((entry) => {
      if (typeof entry === "string") {
        return issue("verification", "warning", slugify(entry), entry);
      }
      if (!isObject(entry)) return null;
      return issue(
        typeof entry.dimension === "string" ? entry.dimension : "verification",
        typeof entry.severity === "string" ? entry.severity : "warning",
        typeof entry.code === "string" ? entry.code : slugify((entry.message ?? (entry.notes ?? entry.title)) ?? "issue"),
        typeof entry.message === "string" ? entry.message : typeof entry.notes === "string" ? entry.notes : "Verification issue recorded.",
      );
    })
    .filter((entry): entry is Issue => entry !== null);
}

function normalizeCheckCounts(value: unknown): { passed: number; failed: number; skipped: number; total: number } {
  if (!isObject(value)) {
    return { passed: 0, failed: 0, skipped: 0, total: 0 };
  }
  const passed = toNumber(value.passed);
  const failed = toNumber(value.failed);
  const skipped = toNumber(value.skipped);
  const total = toNumber(value.total) || Math.max(0, passed + failed + skipped);
  return { passed, failed, skipped, total };
}

function mergeCheckCounts(...counts: { passed: number; failed: number; skipped: number; total: number; }[]) {
  return counts.reduce((acc, entry) => ({
    passed: Math.max(acc.passed, toNumber(entry.passed)),
    failed: Math.max(acc.failed, toNumber(entry.failed)),
    skipped: Math.max(acc.skipped, toNumber(entry.skipped)),
    total: Math.max(acc.total, toNumber(entry.total)),
  }), { passed: 0, failed: 0, skipped: 0, total: 0 });
}

function verificationScoreFor(status: string): number {
  const normalized = normalizeVerificationStatus(status);
  return normalized in STATUS_SCORES ? STATUS_SCORES[normalized as keyof typeof STATUS_SCORES] : 30;
}

function trustScoreFor(level: string): number {
  const normalized = normalizeTrustLevel(level);
  return normalized in TRUST_SCORES ? TRUST_SCORES[normalized as keyof typeof TRUST_SCORES] : 0;
}

function readinessScoreFor(readiness: string) {
  return READINESS_SCORES[normalizeReadiness(readiness)] || READINESS_SCORES.manual;
}

function highestVerificationStatus(statuses: string[]) {
  let bestStatus = "missing";
  let bestScore = -1;
  for (const status of statuses) {
    const normalized = normalizeVerificationStatus(status);
    const score = verificationScoreFor(normalized);
    if (score > bestScore) {
      bestScore = score;
      bestStatus = normalized;
    }
  }
  return bestStatus;
}

function scoreLabel(score: number): string {
  if (!Number.isFinite(score)) return "blocked";
  if (score >= 85) return "strong";
  if (score >= 70) return "workable";
  if (score >= 55) return "partial";
  return "blocked";
}

function average(values: (number | null | undefined)[]): number {
  const filtered = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (filtered.length === 0) return 0;
  return Math.round(filtered.reduce((sum, value) => sum + value, 0) / filtered.length);
}

function hasSeverity(issues: Issue[], severity: string): boolean {
  return issues.some((entry) => entry.severity === severity);
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function countEntries(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

function toNumber(value: unknown): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function pick(obj: JsonRecord, keys: string[]): JsonRecord {
  const out: JsonRecord = {};
  for (const key of keys) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] || 0) + 1;
}

function normalizeLookupKey(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizePath(value: unknown): string {
  return String(value).split(path.sep).join("/");
}

function slugify(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function compareBuilds(left: IndexedBuild, right: IndexedBuild): number {
  return (
    compareStrings(left.project ?? "", right.project ?? "") ||
    compareStrings(left.name || "", right.name || "") ||
    compareStrings(left.build_id || "", right.build_id || "")
  );
}

function compareStrings(left: string, right: string) {
  return left.localeCompare(right);
}

function isObject(value: unknown): value is JsonRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
