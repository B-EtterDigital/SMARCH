#!/usr/bin/env node
/**
 * What: Indexes release artifacts by type, identity, version, channel, and status.
 * Why: Consumers need a consistent latest-release view without scanning release files themselves.
 * How: Reads release records below a root and writes or prints a grouped release index.
 * Callers: Stores, dashboards, and release review tools consume the generated index.
 * Example: `node tools/sma-release-index.ts --help`
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const CHANNEL_ORDER = ["dev", "alpha", "beta", "candidate", "stable", "lts", "hotfix"];
const STATUS_ORDER = ["draft", "published", "deprecated", "superseded", "yanked"];
const VERIFICATION_ORDER = ["failed", "unverified", "candidate", "verified", "canonical"];
const TRUST_LEVEL_ORDER = ["blocked", "low", "medium", "strong", "high"];

const HELP_TEXT = `SMARCH release index generator

Usage:
  node tools/sma-release-index.ts [options]

Options:
  --root <dir>    Root directory to scan for release JSON artifacts. Default: releases
  --out <file>    Write the generated index JSON to this file.
  --stdout        Print the generated index JSON to stdout.
  --dry-run       Analyze and print to stdout without writing a file.
  --help          Show this help text.

Behavior:
  - Recursively scans <root> for .json files.
  - Includes only files that match the SMARCH release artifact shape.
  - Groups results by artifact type and artifact id.
  - Summarizes versions, latest releases, channels, statuses, and simple trust signals.
  - If neither --out nor --stdout is provided, writes to <root>/release-index.generated.json.
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

  const root = path.resolve(options.root || "releases");
  const outputPath = options.out
    ? path.resolve(options.out)
    : options.stdout
      ? null
      : path.join(root, "release-index.generated.json");

  const files = await collectJsonFiles(root);
  const summaries = [];
  const skipped = [];

  for (const file of files) {
    const parsed = await readJsonFile(file);
    if (!parsed.ok) {
      skipped.push({
        path: normalizePath(path.relative(root, file)),
        reason: "invalid_json",
        error: parsed.error,
      });
      continue;
    }
    const summary = summarizeReleaseArtifact(parsed.value, file, root);
    if (!summary.ok) {
      skipped.push({
        path: normalizePath(path.relative(root, file)),
        reason: summary.reason,
      });
      continue;
    }
    summaries.push(summary.value);
  }

  summaries.sort(compareReleaseSummaries);
  skipped.sort((left, right) => compareStrings(left.path, right.path) || compareStrings(left.reason, right.reason));

  const index = buildIndex({
    root,
    outputPath,
    releases: summaries,
    skipped,
  });

  if (options.stdout || options.dryRun) {
    process.stdout.write(`${JSON.stringify(index, null, 2)}\n`);
  }

  if (!options.dryRun && outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }
}

interface ReleaseIndexOptions { root: string; out: string | null; stdout: boolean; dryRun: boolean; help: boolean }
type CountMap = Record<string, number>;

function parseArgs(argv: string[]): ReleaseIndexOptions {
  const options: ReleaseIndexOptions = {
    root: "releases",
    out: null,
    stdout: false,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      options.root = requireValue(argv, ++index, "--root");
      continue;
    }
    if (arg === "--out") {
      options.out = requireValue(argv, ++index, "--out");
      continue;
    }
    if (arg === "--stdout") {
      options.stdout = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      options.stdout = true;
      continue;
    }
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function requireValue(argv: string[], index: number, flag: string) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

async function collectJsonFiles(root: string) {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Release root not found or not a directory: ${root}`);
  }

  const files: string[] = [];
  await walkDirectory(root, files);
  files.sort(compareStrings);
  return files;
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
    if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }
}

async function readJsonFile(filePath: string) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function summarizeReleaseArtifact(document: unknown, filePath: string, root: string) {
  if (!isObject(document)) {
    return { ok: false as const, reason: "not_object" };
  }

  const release = document.release;
  if (!isObject(release)) {
    return { ok: false as const, reason: "missing_release_block" };
  }

  if (release.artifact_type !== "brick" && release.artifact_type !== "build") {
    return { ok: false as const, reason: "unknown_artifact_type" };
  }
  const artifactType: "brick" | "build" = release.artifact_type;
  if (typeof release.artifact_id !== "string" || typeof release.version !== "string") {
    return { ok: false as const, reason: "missing_artifact_identity" };
  }

  const verification = isObject(document.verification) ? document.verification : {};
  const contracts = isObject(document.contracts) ? document.contracts : {};
  const content = isObject(document.content) ? document.content : {};

  const checkCounts = summarizeChecks(Array.isArray(verification.checks) ? verification.checks : []);
  const trustSummary = summarizeTrust({
    channel: release.channel,
    status: release.status,
    verificationStatus: verification.status,
    rollbackSupported: verification.rollback_supported === true,
    hasFailedChecks: checkCounts.failed > 0,
    breaking: release.breaking === true,
  });

  const relativePath = normalizePath(path.relative(root, filePath));
  const dependencyRefs = Array.isArray(contracts.dependency_refs) ? contracts.dependency_refs : [];

  return {
    ok: true as const,
    value: {
      artifact_type: artifactType,
      artifact_id: release.artifact_id,
      release_id: optionalString(release, "release_id") ?? `${release.artifact_id}@${release.version}`,
      version: release.version,
      channel: optionalString(release, "channel") ?? "unknown",
      status: optionalString(release, "status") ?? "unknown",
      source_project: optionalString(release, "source_project"),
      created_at: optionalString(release, "created_at"),
      published_at: optionalString(release, "published_at"),
      source_commit: optionalString(release, "source_commit"),
      registry_snapshot_sha: optionalString(release, "registry_snapshot_sha"),
      content_hash: optionalString(release, "content_hash"),
      path: relativePath,
      content_summary: summarizeContent(content),
      contract_summary: summarizeContracts(contracts, dependencyRefs),
      trust_summary: summarizeReleaseTrust(verification, release, checkCounts, trustSummary.trust_level),
    },
  };
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function summarizeContent(content: Record<string, unknown>) {
  return {
    included_path_count: arrayCount(content.included_paths), portable_doc_count: arrayCount(content.portable_docs),
    entrypoint_count: arrayCount(content.entrypoints), artifact_count: arrayCount(content.artifacts),
  };
}

function summarizeContracts(contracts: Record<string, unknown>, dependencyRefs: unknown[]) {
  return {
    runtime_count: arrayCount(contracts.runtimes), required_env_count: arrayCount(contracts.required_env),
    optional_env_count: arrayCount(contracts.optional_env), forbidden_env_count: arrayCount(contracts.forbidden_env),
    dependency_count: dependencyRefs.length,
    required_dependency_count: dependencyRefs.filter((entry) => !isObject(entry) || entry.required !== false).length,
    optional_dependency_count: dependencyRefs.filter((entry) => isObject(entry) && entry.required === false).length,
    public_interface_count: arrayCount(contracts.public_interfaces), data_class_count: arrayCount(contracts.data_classes),
    external_package_count: arrayCount(contracts.external_packages),
  };
}

function summarizeReleaseTrust(verification: Record<string, unknown>, release: Record<string, unknown>, checkCounts: ReturnType<typeof summarizeChecks>, trustLevel: string) {
  return {
    verification_status: optionalString(verification, "status") ?? "unknown", trust_level: trustLevel,
    rollback_supported: verification.rollback_supported === true, breaking: release.breaking === true, check_counts: checkCounts,
  };
}

function summarizeChecks(checks: unknown[]) {
  const counts = { passed: 0, failed: 0, skipped: 0, total: 0 };
  for (const check of checks) {
    if (!isObject(check)) {
      continue;
    }
    const status = check.status;
    if (status === "passed" || status === "failed" || status === "skipped") {
      counts[status] += 1;
      counts.total += 1;
    }
  }
  return counts;
}

type ReleaseSummary = Extract<ReturnType<typeof summarizeReleaseArtifact>, { ok: true }>['value'];

function summarizeTrust({ channel, status, verificationStatus, rollbackSupported, hasFailedChecks, breaking }: {
  channel: unknown; status: unknown; verificationStatus: unknown; rollbackSupported: boolean; hasFailedChecks: boolean; breaking: boolean;
}) {
  const verificationRank = verificationStatusRank(verificationStatus);
  let trustLevel = "low";

  if (isBlockedTrust(status, verificationStatus)) {
    trustLevel = "blocked";
  } else if (isStrongTrust(status, verificationStatus, rollbackSupported, hasFailedChecks)) {
    trustLevel = verificationStatus === "canonical" ? "high" : "strong";
  } else if (verificationRank >= verificationStatusRank("candidate") && status !== "draft" && !hasFailedChecks) {
    trustLevel = "medium";
  } else if (verificationRank >= verificationStatusRank("candidate")) {
    trustLevel = "medium";
  }

  if (breaking && trustLevel === "high") {
    trustLevel = "strong";
  }
  if ((channel === "dev" || channel === "alpha") && trustLevel === "high") {
    trustLevel = "strong";
  }

  return { trust_level: trustLevel };
}

function isBlockedTrust(status: unknown, verificationStatus: unknown) {
  return status === "yanked" || verificationStatus === "failed";
}

function isStrongTrust(status: unknown, verificationStatus: unknown, rollbackSupported: boolean, hasFailedChecks: boolean) {
  const verified = verificationStatus === "canonical" || verificationStatus === "verified";
  return verified && status === "published" && !hasFailedChecks && rollbackSupported;
}

function buildIndex({ root, outputPath, releases, skipped }: { root: string; outputPath: string | null; releases: ReleaseSummary[]; skipped: unknown[] }) {
  const artifactsByType = {
    brick: new Map<string, ReleaseSummary[]>(),
    build: new Map<string, ReleaseSummary[]>(),
  };

  const globalCounts = {
    channels: countTemplate(CHANNEL_ORDER),
    statuses: countTemplate(STATUS_ORDER),
    verification_statuses: countTemplate(VERIFICATION_ORDER),
    trust_levels: countTemplate(TRUST_LEVEL_ORDER),
  };

  for (const release of releases) {
    const groupMap = artifactsByType[release.artifact_type];
    const artifactReleases = groupMap.get(release.artifact_id) ?? [];
    if (!groupMap.has(release.artifact_id)) groupMap.set(release.artifact_id, artifactReleases);
    artifactReleases.push(release);

    incrementCount(globalCounts.channels, release.channel);
    incrementCount(globalCounts.statuses, release.status);
    incrementCount(globalCounts.verification_statuses, release.trust_summary.verification_status);
    incrementCount(globalCounts.trust_levels, release.trust_summary.trust_level);
  }

  const typeEntries: Record<string, Record<string, ReturnType<typeof summarizeArtifactGroup>>> = {};
  const typeSummaries: Record<string, ReturnType<typeof summarizeType>> = {};
  let artifactCount = 0;

  for (const artifactType of ["brick", "build"] as const) {
    const artifactMap = artifactsByType[artifactType];
    const artifactEntries: ReturnType<typeof summarizeArtifactGroup>[] = [];
    const artifactObject: Record<string, ReturnType<typeof summarizeArtifactGroup>> = {};

    for (const artifactId of [...artifactMap.keys()].sort(compareStrings)) {
      const grouped = artifactMap.get(artifactId);
      if (!grouped) continue;
      const groupedReleases = grouped.slice().sort(compareReleaseForArtifact);
      const entry = summarizeArtifactGroup(artifactType, artifactId, groupedReleases);
      artifactEntries.push(entry);
      artifactObject[artifactId] = entry;
      artifactCount += 1;
    }

    typeEntries[artifactType] = artifactObject;
    typeSummaries[artifactType] = summarizeType(artifactEntries);
  }

  return {
    schema_version: "1.0.0",
    kind: "smarch-release-index",
    root: normalizePath(root),
    output_path: outputPath ? normalizePath(outputPath) : null,
    summary: {
      release_count: releases.length,
      artifact_count: artifactCount,
      skipped_count: skipped.length,
      by_type: typeSummaries,
      channels: finalizeCounts(globalCounts.channels, CHANNEL_ORDER),
      statuses: finalizeCounts(globalCounts.statuses, STATUS_ORDER),
      verification_statuses: finalizeCounts(globalCounts.verification_statuses, VERIFICATION_ORDER),
      trust_levels: finalizeCounts(globalCounts.trust_levels, TRUST_LEVEL_ORDER),
    },
    artifacts: typeEntries,
    skipped,
  };
}

function summarizeArtifactGroup(artifactType: 'brick' | 'build', artifactId: string, releases: ReleaseSummary[]) {
  const [latestRelease = null] = releases;
  const latestByChannel: Partial<Record<string, ReturnType<typeof releaseSummaryRef>>> = {};
  const channelCounts = countTemplate(CHANNEL_ORDER), statusCounts = countTemplate(STATUS_ORDER);
  const verificationCounts = countTemplate(VERIFICATION_ORDER), trustCounts = countTemplate(TRUST_LEVEL_ORDER);
  const sourceProjects = new Set<string>();

  let publishedReleaseCount = 0, rollbackSupportedReleaseCount = 0;
  let breakingReleaseCount = 0, failingReleaseCount = 0;
  let latestPublished = null;
  let bestVerificationStatus = "failed";

  for (const release of releases) {
    incrementCount(channelCounts, release.channel);
    incrementCount(statusCounts, release.status);
    incrementCount(verificationCounts, release.trust_summary.verification_status);
    incrementCount(trustCounts, release.trust_summary.trust_level);

    addSourceProject(sourceProjects, release.source_project);
    if (release.status === "published") {
      publishedReleaseCount += 1;
      latestPublished ??= releaseSummaryRef(release);
    }
    if (release.trust_summary.rollback_supported) {
      rollbackSupportedReleaseCount += 1;
    }
    if (release.trust_summary.breaking) {
      breakingReleaseCount += 1;
    }
    if (isFailingRelease(release)) {
      failingReleaseCount += 1;
    }
    latestByChannel[release.channel] ??= releaseSummaryRef(release);
    if (verificationStatusRank(release.trust_summary.verification_status) > verificationStatusRank(bestVerificationStatus)) {
      bestVerificationStatus = release.trust_summary.verification_status;
    }
  }

  return {
    artifact_type: artifactType,
    artifact_id: artifactId,
    release_count: releases.length,
    source_projects: [...sourceProjects].sort(compareStrings),
    latest_release: latestRelease ? releaseSummaryRef(latestRelease) : null,
    latest_published_release: latestPublished,
    latest_by_channel: orderObjectByKnownKeys(latestByChannel, CHANNEL_ORDER),
    versions: releases.map(releaseSummaryRef),
    channels: finalizeCounts(channelCounts, CHANNEL_ORDER),
    statuses: finalizeCounts(statusCounts, STATUS_ORDER),
    verification_statuses: finalizeCounts(verificationCounts, VERIFICATION_ORDER),
    trust_summary: {
      latest_verification_status: latestRelease?.trust_summary.verification_status ?? "unknown",
      best_verification_status: bestVerificationStatus,
      latest_trust_level: latestRelease?.trust_summary.trust_level ?? "unknown",
      published_release_count: publishedReleaseCount,
      rollback_supported_release_count: rollbackSupportedReleaseCount,
      breaking_release_count: breakingReleaseCount,
      failing_release_count: failingReleaseCount,
      trust_levels: finalizeCounts(trustCounts, TRUST_LEVEL_ORDER),
    },
  };
}

function addSourceProject(projects: Set<string>, project: string | null) {
  if (project) projects.add(project);
}

function isFailingRelease(release: ReleaseSummary) {
  return release.trust_summary.check_counts.failed > 0 || release.trust_summary.verification_status === "failed";
}

function summarizeType(entries: ReturnType<typeof summarizeArtifactGroup>[]) {
  const channelCounts = countTemplate(CHANNEL_ORDER);
  const statusCounts = countTemplate(STATUS_ORDER);
  const verificationCounts = countTemplate(VERIFICATION_ORDER);
  const trustCounts = countTemplate(TRUST_LEVEL_ORDER);

  let releaseCount = 0;
  let publishedArtifactCount = 0;
  let stableOrLtsArtifactCount = 0;

  for (const entry of entries) {
    releaseCount += entry.release_count;
    if ((entry.statuses.published || 0) > 0) {
      publishedArtifactCount += 1;
    }
    if ((entry.channels.stable || 0) > 0 || (entry.channels.lts || 0) > 0) {
      stableOrLtsArtifactCount += 1;
    }

    mergeCounts(channelCounts, entry.channels);
    mergeCounts(statusCounts, entry.statuses);
    mergeCounts(verificationCounts, entry.verification_statuses);
    mergeCounts(trustCounts, entry.trust_summary.trust_levels);
  }

  return {
    artifact_count: entries.length,
    release_count: releaseCount,
    published_artifact_count: publishedArtifactCount,
    stable_or_lts_artifact_count: stableOrLtsArtifactCount,
    channels: finalizeCounts(channelCounts, CHANNEL_ORDER),
    statuses: finalizeCounts(statusCounts, STATUS_ORDER),
    verification_statuses: finalizeCounts(verificationCounts, VERIFICATION_ORDER),
    trust_levels: finalizeCounts(trustCounts, TRUST_LEVEL_ORDER),
  };
}

function releaseSummaryRef(release: ReleaseSummary) {
  return {
    release_id: release.release_id,
    version: release.version,
    channel: release.channel,
    status: release.status,
    created_at: release.created_at,
    published_at: release.published_at,
    path: release.path,
    content_hash: release.content_hash,
    content_summary: release.content_summary,
    contract_summary: release.contract_summary,
    trust_summary: release.trust_summary,
  };
}

function compareReleaseSummaries(left: ReleaseSummary, right: ReleaseSummary) {
  return (
    compareStrings(left.artifact_type, right.artifact_type) ||
    compareStrings(left.artifact_id, right.artifact_id) ||
    compareReleaseForArtifact(left, right)
  );
}

function compareReleaseForArtifact(left: ReleaseSummary, right: ReleaseSummary) {
  return (
    compareSemver(right.version, left.version) ||
    compareStrings(right.created_at ?? "", left.created_at ?? "") ||
    compareStrings(left.release_id, right.release_id)
  );
}

function compareSemver(left: string, right: string) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) {
    return compareStrings(left, right);
  }
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  if (a.patch !== b.patch) {
    return a.patch - b.patch;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function parseSemver(value: string) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value || "");
  if (!match) {
    return null;
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function comparePrerelease(left: string[], right: string[]) {
  if (left.length === 0 && right.length === 0) {
    return 0;
  }
  if (left.length === 0) {
    return 1;
  }
  if (right.length === 0) {
    return -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.at(index);
    const b = right.at(index);
    if (a === undefined) {
      return -1;
    }
    if (b === undefined) {
      return 1;
    }
    const diff = comparePrereleasePart(a, b);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function comparePrereleasePart(left: string, right: string) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) return Number.parseInt(left, 10) - Number.parseInt(right, 10);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  return compareStrings(left, right);
}

function verificationStatusRank(value: unknown) {
  const index = VERIFICATION_ORDER.indexOf(String(value));
  return index === -1 ? -1 : index;
}

function countTemplate(keys: readonly string[]): CountMap {
  const counts: CountMap = {};
  for (const key of keys) {
    counts[key] = 0;
  }
  return counts;
}

function incrementCount(counts: CountMap, key: string) {
  if (!Object.prototype.hasOwnProperty.call(counts, key)) {
    counts[key] = 0;
  }
  counts[key] += 1;
}

function mergeCounts(target: CountMap, source: CountMap) {
  for (const [key, value] of Object.entries(source)) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = 0;
    }
    target[key] += value;
  }
}

function finalizeCounts(counts: CountMap, preferredOrder: readonly string[] = []) {
  const orderMap = new Map(preferredOrder.map((key, index) => [key, index]));
  const knownKeys = Object.keys(counts).sort((left, right) => {
    const leftIndex = orderMap.get(left) ?? Number.POSITIVE_INFINITY;
    const rightIndex = orderMap.get(right) ?? Number.POSITIVE_INFINITY;
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
    return compareStrings(left, right);
  });
  const ordered: CountMap = {};
  for (const key of knownKeys) {
    ordered[key] = counts[key];
  }
  return ordered;
}

function orderObjectByKnownKeys<T>(object: Record<string, T>, keys: readonly string[]) {
  const ordered: Record<string, T> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(object, key)) {
      ordered[key] = object[key];
    }
  }
  for (const key of Object.keys(object).sort(compareStrings)) {
    if (!Object.prototype.hasOwnProperty.call(ordered, key)) {
      ordered[key] = object[key];
    }
  }
  return ordered;
}

function arrayCount(value: unknown) {
  return Array.isArray(value) ? value.length : 0;
}

function normalizePath(value: string) {
  return value.split(path.sep).join("/");
}

function compareStrings(left: string, right: string) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
