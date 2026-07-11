#!/usr/bin/env node

/**
 * WHAT: Plans and optionally applies evidence-backed status promotions for curated builds.
 * WHY: A build must not become verified or canonical until its verification, release, and backlog evidence supports that claim.
 * HOW: Reads build manifests and generated evidence, writes a promotion plan, and is called by release controllers after verification.
 * Usage: `node tools/sma-build-promote.ts --dry-run --stdout`
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const defaults = {
  root: path.resolve(repoRoot, "builds"),
  verification: path.resolve(repoRoot, "security/build-verification.generated.json"),
  releases: path.resolve(repoRoot, "releases/release-index.generated.json"),
  out: path.resolve(repoRoot, "security/build-promotion.generated.json")
};

const HELP_TEXT = `SMARCH curated build promotion planner

Usage:
  node tools/sma-build-promote.ts
  node tools/sma-build-promote.ts --build acme-studio.build.ai-image-generation.capability --stdout

Options:
  --root <dir>          Build manifest root directory. Default: builds
  --verification <file> Build verification report. Default: security/build-verification.generated.json
  --releases <file>     Release index JSON. Default: releases/release-index.generated.json
  --build <id>          Limit planning to one build id. Repeatable.
  --out <file>          Output file. Default: security/build-promotion.generated.json
  --write               Apply safe manifest promotions (candidate -> verified -> canonical) when the plan allows it.
  --stdout              Print the plan JSON to stdout.
  --dry-run             Alias for --stdout without writing a file.
  --help                Show this help.

Notes:
  - The planner never marks a build publishable automatically.
  - --write updates manifest build.status and build.trust_tier only when the verifier gates pass.
  - Release publication remains a separate human-controlled step.
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

  const manifests = await collectBuildManifests(options.root);
  const verificationReport = await maybeReadJson(options.verification);
  const releaseIndex = await maybeReadJson(options.releases);
  const verificationLookup = new Map(
    toArray(verificationReport?.builds)
      .map((entry) => normalizeVerificationEntry(entry))
      .filter(Boolean)
      .map((entry) => [entry.build_id, entry])
  );
  const releaseLookup = new Map(Object.entries(releaseIndex?.artifacts?.build || {}));

  const filteredBuildIds = new Set(options.builds);
  const plans = [];
  let appliedCount = 0;

  for (const manifestPath of manifests) {
    const manifest = await maybeReadJson(manifestPath);
    if (!manifest?.build?.id) continue;
    const buildId = manifest.build.id;
    if (filteredBuildIds.size && !filteredBuildIds.has(buildId)) continue;
    const verification = verificationLookup.get(buildId) || null;
    const releaseArtifact = releaseLookup.get(buildId) || null;
    const plan = planPromotion({ manifest, manifestPath, verification, releaseArtifact });
    plans.push(plan);

    if (options.write && plan.apply_manifest_promotion) {
      const changed = await applyManifestPromotion(manifestPath, manifest, plan);
      if (changed) appliedCount += 1;
    }
  }

  plans.sort((left, right) =>
    priorityRank(right.priority) - priorityRank(left.priority)
    || Number(right.readiness_score || 0) - Number(left.readiness_score || 0)
    || String(left.build_id || "").localeCompare(String(right.build_id || ""))
  );

  const document = {
    generated_at: new Date().toISOString(),
    build_root: relativeFromRepo(options.root),
    verification_report_path: relativeFromRepo(options.verification),
    release_index_path: relativeFromRepo(options.releases),
    summary: summarizePlans(plans, appliedCount),
    promotion_queue: plans
  };

  if (options.stdout || options.dryRun) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  }

  if (!options.dryRun) {
    await fs.mkdir(path.dirname(options.out), { recursive: true });
    await fs.writeFile(options.out, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
}

function parseArgs(argv): Record<string, any> {
  const options: Record<string, any> = {
    ...defaults,
    builds: [],
    write: false,
    stdout: false,
    dryRun: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      options.root = path.resolve(requireValue(argv, ++index, "--root"));
      continue;
    }
    if (arg === "--verification") {
      options.verification = path.resolve(requireValue(argv, ++index, "--verification"));
      continue;
    }
    if (arg === "--releases") {
      options.releases = path.resolve(requireValue(argv, ++index, "--releases"));
      continue;
    }
    if (arg === "--build") {
      options.builds.push(requireValue(argv, ++index, "--build"));
      continue;
    }
    if (arg === "--out") {
      options.out = path.resolve(requireValue(argv, ++index, "--out"));
      continue;
    }
    if (arg === "--write") {
      options.write = true;
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
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
  return value;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

async function maybeReadJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function normalizeVerificationEntry(entry) {
  if (!entry?.build_id) return null;
  const suggestedStatus = String(
    entry?.verification?.suggested_status
    || entry?.suggested_build_status
    || ""
  ).trim().toLowerCase();

  return {
    build_id: entry.build_id,
    verified_ready: entry?.booleans?.ready_for_adoption === true || ["verified", "canonical"].includes(suggestedStatus),
    publish_ready: entry?.booleans?.publishable === true,
    readiness_score: Number(entry?.signals?.readiness?.score || entry?.readiness_score || 0),
    publishability_score: Number(entry?.signals?.publishability?.score || entry?.publishability_score || 0),
    updateability_score: Number(entry?.signals?.updateability?.score || entry?.updateability_score || 0),
    suggested_build_status: suggestedStatus === "unverified" ? "candidate" : (suggestedStatus || "candidate"),
    top_blockers: toArray(entry?.top_blockers).map((blocker) => ({
      code: blocker?.code,
      level: blocker?.level || blocker?.severity || null,
      message: blocker?.message || blocker?.summary || null
    })),
    release_summary: {
      latest_status: entry?.release?.latest_status || entry?.release_summary?.latest_status || null,
      published_release_count: Number(entry?.release?.published_release_count || entry?.release_summary?.published_release_count || 0)
    }
  };
}

async function collectBuildManifests(root) {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat || !stat.isDirectory()) return [];
  const files = [];
  async function walk(currentPath) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".build.sweetspot.json")) files.push(fullPath);
    }
  }
  await walk(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function relativeFromRepo(targetPath) {
  return String(path.relative(repoRoot, targetPath)).split(path.sep).join("/");
}

function priorityRank(value) {
  switch (value) {
    case "critical": return 4;
    case "high": return 3;
    case "medium": return 2;
    default: return 1;
  }
}

function normalizeStatus(value, fallback = "candidate") {
  const status = String(value || "").trim().toLowerCase();
  return status || fallback;
}

function statusRank(value) {
  switch (normalizeStatus(value)) {
    case "unsafe": return -1;
    case "deprecated": return 0;
    case "candidate": return 1;
    case "verified": return 2;
    case "canonical": return 3;
    default: return 1;
  }
}

function trustTierForStatus(status, currentTrustTier = "experimental") {
  const normalized = normalizeStatus(status);
  if (normalized === "canonical") return "canonical";
  if (normalized === "verified") return "verified";
  if (normalized === "candidate") {
    return ["reviewed", "verified", "canonical"].includes(String(currentTrustTier || "").toLowerCase())
      ? currentTrustTier
      : "reviewed";
  }
  return currentTrustTier || "experimental";
}

function planPromotion({ manifest, manifestPath, verification, releaseArtifact }) {
  const build = manifest.build || {};
  const publishing = manifest.publishing || {};
  const buildId = String(build.id || "").trim();
  const latestRelease = releaseArtifact?.latest_release || null;
  const currentStatus = normalizeStatus(build.status);
  const desiredStatus = determineDesiredStatus({ currentStatus, verification, latestRelease, publishing });
  const desiredTrustTier = trustTierForStatus(desiredStatus, build.trust_tier || "experimental");
  const readiness = Number(verification?.readiness_score || 0);
  const publishability = Number(verification?.publishability_score || 0);
  const updateability = Number(verification?.updateability_score || 0);
  const reasons = [];
  const actions = [];

  if (desiredStatus !== currentStatus) {
    actions.push({
      type: "promote_manifest_status",
      from: currentStatus,
      to: desiredStatus,
      automatic: statusRank(desiredStatus) > statusRank(currentStatus)
    });
  }

  if (desiredTrustTier !== (build.trust_tier || "experimental")) {
    actions.push({
      type: "promote_trust_tier",
      from: build.trust_tier || "experimental",
      to: desiredTrustTier,
      automatic: statusRank(desiredStatus) >= statusRank(currentStatus)
    });
  }

  if (verification?.verified_ready && latestRelease?.status === "draft") {
    actions.push({
      type: "review_release_for_publication",
      automatic: false,
      note: "Verifier says the build is structurally ready for verified promotion, but the release is still draft."
    });
  }

  if (verification?.publish_ready && publishing.publishable !== true) {
    actions.push({
      type: "enable_private_publishability_after_review",
      automatic: false,
      note: "The manifest still marks this build not publishable. Human review must decide whether to open the private publish lane."
    });
  }

  for (const blocker of toArray(verification?.top_blockers)) {
    reasons.push({
      dimension: inferDimension(blocker.code),
      severity: blocker.level === "fail" ? "blocker" : "warning",
      code: blocker.code,
      message: blocker.message
    });
  }

  if (!verification) {
    reasons.push({
      dimension: "verification",
      severity: "blocker",
      code: "missing_verification_report",
      message: "No build verification report exists yet."
    });
  }
  if (publishing.publishable !== true) {
    reasons.push({
      dimension: "publishability",
      severity: "blocker",
      code: "not_marked_publishable",
      message: "Manifest explicitly marks this build as not publishable."
    });
  }
  if (latestRelease?.status !== "published") {
    reasons.push({
      dimension: "release",
      severity: "blocker",
      code: "release_not_published",
      message: "Latest release is not published."
    });
  }

  const priority = determinePriority({ desiredStatus, currentStatus, verification, reasons });
  const applyManifestPromotion =
    statusRank(desiredStatus) > statusRank(currentStatus) &&
    verification?.verified_ready === true &&
    !reasons.some((reason) => reason.code === "missing_verification_report");

  return {
    build_id: buildId,
    name: build.name || buildId,
    source_project: manifest.source?.project || null,
    manifest_path: relativeFromRepo(manifestPath),
    current: {
      build_status: currentStatus,
      trust_tier: build.trust_tier || "experimental",
      visibility: build.visibility || "private",
      publishable: publishing.publishable === true,
      release_status: latestRelease?.status || null
    },
    desired: {
      build_status: desiredStatus,
      trust_tier: desiredTrustTier
    },
    verification_ready: verification?.verified_ready === true,
    publish_ready: verification?.publish_ready === true,
    suggested_build_status: verification?.suggested_build_status || currentStatus,
    readiness_score: readiness,
    publishability_score: publishability,
    updateability_score: updateability,
    priority,
    apply_manifest_promotion: applyManifestPromotion,
    actions,
    blockers: uniqueReasons(reasons)
  };
}

function uniqueReasons(reasons) {
  const seen = new Set();
  const out = [];
  for (const reason of reasons) {
    const key = `${reason.dimension}:${reason.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(reason);
  }
  return out;
}

function inferDimension(code) {
  if (String(code).startsWith("publishing.")) return "publishability";
  if (String(code).startsWith("release.")) return "release";
  if (String(code).startsWith("verification.")) return "verification";
  if (String(code).startsWith("clone.")) return "installability";
  if (String(code).startsWith("upgrade.")) return "updateability";
  return "general";
}

function determineDesiredStatus({ currentStatus, verification, latestRelease, publishing }) {
  if (["deprecated", "unsafe"].includes(currentStatus)) return currentStatus;
  const suggestedStatus = normalizeStatus(verification?.suggested_build_status, currentStatus);
  if (
    suggestedStatus === "canonical" &&
    verification?.publish_ready === true &&
    latestRelease?.status === "published" &&
    publishing.publishable === true
  ) {
    return "canonical";
  }
  if (suggestedStatus === "verified" || verification?.verified_ready === true) return "verified";
  if (
    verification?.publish_ready === true &&
    latestRelease?.status === "published" &&
    publishing.publishable === true
  ) {
    return "canonical";
  }
  if (verification?.verified_ready === true) return "verified";
  return "candidate";
}

function determinePriority({ desiredStatus, currentStatus, verification, reasons }) {
  const blockerCount = reasons.filter((reason) => reason.severity === "blocker").length;
  if (statusRank(desiredStatus) > statusRank(currentStatus) && blockerCount === 0) return "critical";
  if (verification?.verified_ready === true) return "high";
  if (Number(verification?.readiness_score || 0) >= 70) return "medium";
  return "low";
}

async function applyManifestPromotion(manifestPath, manifest, plan) {
  const nextStatus = plan.desired.build_status;
  const nextTrustTier = plan.desired.trust_tier;
  const currentStatus = normalizeStatus(manifest.build?.status);
  const currentTrustTier = String(manifest.build?.trust_tier || "experimental");

  if (statusRank(nextStatus) <= statusRank(currentStatus) && nextTrustTier === currentTrustTier) {
    return false;
  }

  const nextManifest = structuredClone(manifest);
  nextManifest.build = nextManifest.build || {};
  if (statusRank(nextStatus) > statusRank(currentStatus)) {
    nextManifest.build.status = nextStatus;
  }
  if (nextTrustTier !== currentTrustTier) {
    nextManifest.build.trust_tier = nextTrustTier;
  }

  await fs.writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
  return true;
}

function summarizePlans(plans, appliedCount) {
  const summary: Record<string, any> = {
    build_count: plans.length,
    applied_manifest_promotions: appliedCount,
    by_current_status: {},
    by_desired_status: {},
    verification_ready_count: 0,
    publish_ready_count: 0,
    auto_promotable_count: 0,
    priority_counts: {},
    top_blockers: []
  };

  const blockerCounts = new Map();
  for (const plan of plans) {
    summary.by_current_status[plan.current.build_status] = (summary.by_current_status[plan.current.build_status] || 0) + 1;
    summary.by_desired_status[plan.desired.build_status] = (summary.by_desired_status[plan.desired.build_status] || 0) + 1;
    summary.priority_counts[plan.priority] = (summary.priority_counts[plan.priority] || 0) + 1;
    if (plan.verification_ready) summary.verification_ready_count += 1;
    if (plan.publish_ready) summary.publish_ready_count += 1;
    if (plan.apply_manifest_promotion) summary.auto_promotable_count += 1;
    for (const blocker of plan.blockers) {
      const key = `${blocker.dimension}:${blocker.code}:${blocker.message}`;
      const current = blockerCounts.get(key) || { ...blocker, count: 0 };
      current.count += 1;
      blockerCounts.set(key, current);
    }
  }

  summary.top_blockers = [...blockerCounts.values()]
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code))
    .slice(0, 10);

  return summary;
}
