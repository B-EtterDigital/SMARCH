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

main().catch((error) => {
  console.error(error?.stack || String(error));
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

function parseArgs(argv): Record<string, any> {
  const options: Record<string, any> = {
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

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

async function collectJsonFiles(root) {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Release root not found or not a directory: ${root}`);
  }

  const files = [];
  await walkDirectory(root, files);
  files.sort(compareStrings);
  return files;
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
    if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }
}

async function readJsonFile(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function summarizeReleaseArtifact(document, filePath, root) {
  if (!isObject(document)) {
    return { ok: false, reason: "not_object" };
  }

  const release = document.release;
  if (!isObject(release)) {
    return { ok: false, reason: "missing_release_block" };
  }

  if (release.artifact_type !== "brick" && release.artifact_type !== "build") {
    return { ok: false, reason: "unknown_artifact_type" };
  }
  if (typeof release.artifact_id !== "string" || typeof release.version !== "string") {
    return { ok: false, reason: "missing_artifact_identity" };
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
    ok: true,
    value: {
      artifact_type: release.artifact_type,
      artifact_id: release.artifact_id,
      release_id: typeof release.release_id === "string"
        ? release.release_id
        : `${release.artifact_id}@${release.version}`,
      version: release.version,
      channel: typeof release.channel === "string" ? release.channel : "unknown",
      status: typeof release.status === "string" ? release.status : "unknown",
      source_project: typeof release.source_project === "string" ? release.source_project : null,
      created_at: typeof release.created_at === "string" ? release.created_at : null,
      published_at: typeof release.published_at === "string" ? release.published_at : null,
      source_commit: typeof release.source_commit === "string" ? release.source_commit : null,
      registry_snapshot_sha: typeof release.registry_snapshot_sha === "string" ? release.registry_snapshot_sha : null,
      content_hash: typeof release.content_hash === "string" ? release.content_hash : null,
      path: relativePath,
      content_summary: {
        included_path_count: arrayCount(content.included_paths),
        portable_doc_count: arrayCount(content.portable_docs),
        entrypoint_count: arrayCount(content.entrypoints),
        artifact_count: Array.isArray(content.artifacts) ? content.artifacts.length : 0,
      },
      contract_summary: {
        runtime_count: arrayCount(contracts.runtimes),
        required_env_count: arrayCount(contracts.required_env),
        optional_env_count: arrayCount(contracts.optional_env),
        forbidden_env_count: arrayCount(contracts.forbidden_env),
        dependency_count: dependencyRefs.length,
        required_dependency_count: dependencyRefs.filter((entry) => entry && entry.required !== false).length,
        optional_dependency_count: dependencyRefs.filter((entry) => entry && entry.required === false).length,
        public_interface_count: arrayCount(contracts.public_interfaces),
        data_class_count: arrayCount(contracts.data_classes),
        external_package_count: arrayCount(contracts.external_packages),
      },
      trust_summary: {
        verification_status: typeof verification.status === "string" ? verification.status : "unknown",
        trust_level: trustSummary.trust_level,
        rollback_supported: verification.rollback_supported === true,
        breaking: release.breaking === true,
        check_counts: checkCounts,
      },
    },
  };
}

function summarizeChecks(checks) {
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

function summarizeTrust({ channel, status, verificationStatus, rollbackSupported, hasFailedChecks, breaking }) {
  const verificationRank = verificationStatusRank(verificationStatus);
  let trustLevel = "low";

  if (status === "yanked" || verificationStatus === "failed") {
    trustLevel = "blocked";
  } else if (
    (verificationStatus === "canonical" || verificationStatus === "verified") &&
    status === "published" &&
    !hasFailedChecks &&
    rollbackSupported
  ) {
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

function buildIndex({ root, outputPath, releases, skipped }) {
  const artifactsByType = {
    brick: new Map(),
    build: new Map(),
  };

  const globalCounts = {
    channels: countTemplate(CHANNEL_ORDER),
    statuses: countTemplate(STATUS_ORDER),
    verification_statuses: countTemplate(VERIFICATION_ORDER),
    trust_levels: countTemplate(TRUST_LEVEL_ORDER),
  };

  for (const release of releases) {
    const groupMap = artifactsByType[release.artifact_type];
    if (!groupMap.has(release.artifact_id)) {
      groupMap.set(release.artifact_id, []);
    }
    groupMap.get(release.artifact_id).push(release);

    incrementCount(globalCounts.channels, release.channel);
    incrementCount(globalCounts.statuses, release.status);
    incrementCount(globalCounts.verification_statuses, release.trust_summary.verification_status);
    incrementCount(globalCounts.trust_levels, release.trust_summary.trust_level);
  }

  const typeEntries = {};
  const typeSummaries = {};
  let artifactCount = 0;

  for (const artifactType of ["brick", "build"]) {
    const artifactMap = artifactsByType[artifactType];
    const artifactEntries = [];
    const artifactObject = {};

    for (const artifactId of [...artifactMap.keys()].sort(compareStrings)) {
      const groupedReleases = artifactMap.get(artifactId).slice().sort(compareReleaseForArtifact);
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

function summarizeArtifactGroup(artifactType, artifactId, releases) {
  const latestRelease = releases[0] || null;
  const latestByChannel = {};
  const channelCounts = countTemplate(CHANNEL_ORDER);
  const statusCounts = countTemplate(STATUS_ORDER);
  const verificationCounts = countTemplate(VERIFICATION_ORDER);
  const trustCounts = countTemplate(TRUST_LEVEL_ORDER);
  const sourceProjects = new Set();

  let publishedReleaseCount = 0;
  let rollbackSupportedReleaseCount = 0;
  let breakingReleaseCount = 0;
  let failingReleaseCount = 0;
  let latestPublished = null;
  let bestVerificationStatus = "failed";

  for (const release of releases) {
    incrementCount(channelCounts, release.channel);
    incrementCount(statusCounts, release.status);
    incrementCount(verificationCounts, release.trust_summary.verification_status);
    incrementCount(trustCounts, release.trust_summary.trust_level);

    if (release.source_project) {
      sourceProjects.add(release.source_project);
    }
    if (release.status === "published") {
      publishedReleaseCount += 1;
      if (!latestPublished) {
        latestPublished = releaseSummaryRef(release);
      }
    }
    if (release.trust_summary.rollback_supported) {
      rollbackSupportedReleaseCount += 1;
    }
    if (release.trust_summary.breaking) {
      breakingReleaseCount += 1;
    }
    if (release.trust_summary.check_counts.failed > 0 || release.trust_summary.verification_status === "failed") {
      failingReleaseCount += 1;
    }
    if (!latestByChannel[release.channel]) {
      latestByChannel[release.channel] = releaseSummaryRef(release);
    }
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
      latest_verification_status: latestRelease?.trust_summary?.verification_status || "unknown",
      best_verification_status: bestVerificationStatus,
      latest_trust_level: latestRelease?.trust_summary?.trust_level || "unknown",
      published_release_count: publishedReleaseCount,
      rollback_supported_release_count: rollbackSupportedReleaseCount,
      breaking_release_count: breakingReleaseCount,
      failing_release_count: failingReleaseCount,
      trust_levels: finalizeCounts(trustCounts, TRUST_LEVEL_ORDER),
    },
  };
}

function summarizeType(entries) {
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

function releaseSummaryRef(release) {
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

function compareReleaseSummaries(left, right) {
  return (
    compareStrings(left.artifact_type, right.artifact_type) ||
    compareStrings(left.artifact_id, right.artifact_id) ||
    compareReleaseForArtifact(left, right)
  );
}

function compareReleaseForArtifact(left, right) {
  return (
    compareSemver(right.version, left.version) ||
    compareStrings(right.created_at || "", left.created_at || "") ||
    compareStrings(left.release_id, right.release_id)
  );
}

function compareSemver(left, right) {
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

function parseSemver(value) {
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

function comparePrerelease(left, right) {
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
    const a = left[index];
    const b = right[index];
    if (a === undefined) {
      return -1;
    }
    if (b === undefined) {
      return 1;
    }
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const diff = Number.parseInt(a, 10) - Number.parseInt(b, 10);
      if (diff !== 0) {
        return diff;
      }
      continue;
    }
    if (aNumeric && !bNumeric) {
      return -1;
    }
    if (!aNumeric && bNumeric) {
      return 1;
    }
    const diff = compareStrings(a, b);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function verificationStatusRank(value) {
  const index = VERIFICATION_ORDER.indexOf(value);
  return index === -1 ? -1 : index;
}

function countTemplate(keys) {
  const counts = {};
  for (const key of keys) {
    counts[key] = 0;
  }
  return counts;
}

function incrementCount(counts, key) {
  if (!Object.prototype.hasOwnProperty.call(counts, key)) {
    counts[key] = 0;
  }
  counts[key] += 1;
}

function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = 0;
    }
    target[key] += Number(value) || 0;
  }
}

function finalizeCounts(counts, preferredOrder = []) {
  const orderMap = new Map(preferredOrder.map((key, index) => [key, index]));
  const knownKeys = Object.keys(counts).sort((left, right) => {
    const leftIndex = orderMap.has(left) ? orderMap.get(left) : Number.POSITIVE_INFINITY;
    const rightIndex = orderMap.has(right) ? orderMap.get(right) : Number.POSITIVE_INFINITY;
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }
    return compareStrings(left, right);
  });
  const ordered = {};
  for (const key of knownKeys) {
    ordered[key] = counts[key];
  }
  return ordered;
}

function orderObjectByKnownKeys(object, keys) {
  const ordered = {};
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

function arrayCount(value) {
  return Array.isArray(value) ? value.length : 0;
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
