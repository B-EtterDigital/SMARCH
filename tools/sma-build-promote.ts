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

type FalsyValue = false | 0 | 0n | '' | null | undefined;
function orElse<T, U>(value: T, fallback: () => U): Exclude<T, FalsyValue> | U {
  if (!value) return fallback();
  return value as Exclude<T, FalsyValue>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const defaults = {
  root: path.resolve(repoRoot, "builds"),
  verification: path.resolve(repoRoot, "security/build-verification.generated.json"),
  releases: path.resolve(repoRoot, "releases/release-index.generated.json"),
  out: path.resolve(repoRoot, "security/build-promotion.generated.json")
};

interface PromoteArgs { root: string; verification: string; releases: string; out: string; builds: string[]; write: boolean; stdout: boolean; dryRun: boolean; help: boolean }
interface Blocker { code?: string; level?: string | null; severity?: string; message?: string | null; summary?: string }
interface Verification { build_id: string; verified_ready: boolean; publish_ready: boolean; readiness_score: number; publishability_score: number; updateability_score: number; suggested_build_status: string; top_blockers: Blocker[]; release_summary: { latest_status?: string | null; published_release_count: number } }
interface BuildManifest { build?: { id?: string; name?: string; status?: string; trust_tier?: string; visibility?: string }; publishing?: { publishable?: boolean }; source?: { project?: string } }
interface ReleaseArtifact { latest_release?: { status?: string } | null }
interface JsonDocument extends BuildManifest { builds?: unknown[]; artifacts?: { build?: Record<string, ReleaseArtifact> } }
interface Reason { dimension: string; severity: string; code?: string; message?: string | null }
interface PromotionPlan { build_id: string; priority: string; readiness_score: number; verification_ready: boolean; publish_ready: boolean; apply_manifest_promotion: boolean; current: { build_status: string; [key: string]: unknown }; desired: { build_status: string; trust_tier: string }; blockers: Reason[]; [key: string]: unknown }

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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

// eslint-disable-next-line complexity -- Promotion planning is an ordered release policy and serializer; branch order is part of the release contract.
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const manifests = await collectBuildManifests(options.root);
  const verificationReport = await maybeReadJson(options.verification);
  const releaseIndex = await maybeReadJson(options.releases);
  const verificationLookup = new Map<string, Verification>(
    toArray(verificationReport?.builds)
      .map((entry) => normalizeVerificationEntry(entry))
      .filter((entry): entry is Verification => Boolean(entry))
      .map((entry) => [entry.build_id, entry])
  );
  const releaseLookup = new Map(Object.entries(orElse(releaseIndex?.artifacts?.build, () => ({}))));

  const filteredBuildIds = new Set(options.builds);
  const plans: PromotionPlan[] = [];
  let appliedCount = 0;

  for (const manifestPath of manifests) {
    const manifest = await maybeReadJson(manifestPath);
    if (!manifest?.build?.id) continue;
    const buildId = manifest.build.id;
    if (filteredBuildIds.size && !filteredBuildIds.has(buildId)) continue;
    const verification = orElse(verificationLookup.get(buildId), () => null);
    const releaseArtifact = orElse(releaseLookup.get(buildId), () => null);
    const plan = planPromotion({ manifest, manifestPath, verification, releaseArtifact });
    plans.push(plan);

    if (options.write && plan.apply_manifest_promotion) {
      const changed = await applyManifestPromotion(manifestPath, manifest, plan);
      if (changed) appliedCount += 1;
    }
  }

  plans.sort((left, right) =>
    priorityRank(right.priority) - priorityRank(left.priority)
    || (right.readiness_score || 0) - (left.readiness_score || 0)
    || (left.build_id || "").localeCompare((right.build_id || ""))
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

function parseArgs(argv: string[]): PromoteArgs {
  const options: PromoteArgs = {
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

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
  return value;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function maybeReadJson(filePath: string): Promise<JsonDocument | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as JsonDocument;
  } catch {
    return null;
  }
}

// eslint-disable-next-line complexity -- Promotion planning is an ordered release policy and serializer; branch order is part of the release contract.
function normalizeVerificationEntry(entry: unknown): Verification | null {
  if (!entry || typeof entry !== 'object' || typeof Reflect.get(entry, 'build_id') !== 'string') return null;
  const value = entry as Record<string, unknown>;
  const verification = value.verification && typeof value.verification === 'object' ? value.verification as Record<string, unknown> : {};
  const booleans = value.booleans && typeof value.booleans === 'object' ? value.booleans as Record<string, unknown> : {};
  const signals = value.signals && typeof value.signals === 'object' ? value.signals as Record<string, unknown> : {};
  const readiness = signals.readiness && typeof signals.readiness === 'object' ? signals.readiness as Record<string, unknown> : {};
  const publishability = signals.publishability && typeof signals.publishability === 'object' ? signals.publishability as Record<string, unknown> : {};
  const updateability = signals.updateability && typeof signals.updateability === 'object' ? signals.updateability as Record<string, unknown> : {};
  const release = value.release && typeof value.release === 'object' ? value.release as Record<string, unknown> : {};
  const releaseSummary = value.release_summary && typeof value.release_summary === 'object' ? value.release_summary as Record<string, unknown> : {};
  const suggestedStatus = String(
    orElse(orElse(verification.suggested_status, () => (value.suggested_build_status)), () => "")
  ).trim().toLowerCase();

  return {
    build_id: String(value.build_id),
    verified_ready: booleans.ready_for_adoption === true || ["verified", "canonical"].includes(suggestedStatus),
    publish_ready: booleans.publishable === true,
    readiness_score: Number(orElse(orElse(readiness.score, () => (value.readiness_score)), () => 0)),
    publishability_score: Number(orElse(orElse(publishability.score, () => (value.publishability_score)), () => 0)),
    updateability_score: Number(orElse(orElse(updateability.score, () => (value.updateability_score)), () => 0)),
    suggested_build_status: suggestedStatus === "unverified" ? "candidate" : (suggestedStatus || "candidate"),
    top_blockers: toArray(value.top_blockers).map((item) => {
      const blocker = item && typeof item === 'object' ? item as Record<string, unknown> : {};
      return {
      code: typeof blocker.code === 'string' ? blocker.code : undefined,
      level: typeof (orElse(blocker.level, () => blocker.severity)) === 'string' ? String(orElse(blocker.level, () => blocker.severity)) : null,
      message: typeof (orElse(blocker.message, () => blocker.summary)) === 'string' ? String(orElse(blocker.message, () => blocker.summary)) : null
    }; }),
    release_summary: {
      latest_status: typeof (orElse(release.latest_status, () => releaseSummary.latest_status)) === 'string' ? String(orElse(release.latest_status, () => releaseSummary.latest_status)) : null,
      published_release_count: Number(orElse(orElse(release.published_release_count, () => (releaseSummary.published_release_count)), () => 0))
    }
  };
}

async function collectBuildManifests(root: string): Promise<string[]> {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) return [];
  const files: string[] = [];
  async function walk(currentPath: string): Promise<void> {
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

function relativeFromRepo(targetPath: string): string {
  return path.relative(repoRoot, targetPath).split(path.sep).join("/");
}

function priorityRank(value: string): number {
  switch (value) {
    case "critical": return 4;
    case "high": return 3;
    case "medium": return 2;
    default: return 1;
  }
}

function normalizeStatus(value: unknown, fallback = "candidate"): string {
  const status = String(orElse(value, () => "")).trim().toLowerCase();
  return status || fallback;
}

function statusRank(value: unknown): number {
  switch (normalizeStatus(value)) {
    case "unsafe": return -1;
    case "deprecated": return 0;
    case "candidate": return 1;
    case "verified": return 2;
    case "canonical": return 3;
    default: return 1;
  }
}

function trustTierForStatus(status: string, currentTrustTier = "experimental"): string {
  const normalized = normalizeStatus(status);
  if (normalized === "canonical") return "canonical";
  if (normalized === "verified") return "verified";
  if (normalized === "candidate") {
    return ["reviewed", "verified", "canonical"].includes((currentTrustTier || "").toLowerCase())
      ? currentTrustTier
      : "reviewed";
  }
  return currentTrustTier || "experimental";
}

// eslint-disable-next-line max-lines-per-function, complexity -- Promotion planning is an ordered release policy and serializer; branch order is part of the release contract.
function planPromotion({ manifest, manifestPath, verification, releaseArtifact }: { manifest: BuildManifest; manifestPath: string; verification: Verification | null; releaseArtifact: ReleaseArtifact | null }): PromotionPlan {
  const build = manifest.build ?? {};
  const publishing = manifest.publishing ?? {};
  const buildId = (orElse(build.id, () => "")).trim();
  const latestRelease = orElse(releaseArtifact?.latest_release, () => null);
  const currentStatus = normalizeStatus(build.status);
  const desiredStatus = determineDesiredStatus({ currentStatus, verification, latestRelease, publishing });
  const desiredTrustTier = trustTierForStatus(desiredStatus, orElse(build.trust_tier, () => "experimental"));
  const readiness = (orElse(verification?.readiness_score, () => 0));
  const publishability = (orElse(verification?.publishability_score, () => 0));
  const updateability = (orElse(verification?.updateability_score, () => 0));
  const reasons: Reason[] = [];
  const actions: Record<string, string | boolean>[] = [];

  if (desiredStatus !== currentStatus) {
    actions.push({
      type: "promote_manifest_status",
      from: currentStatus,
      to: desiredStatus,
      automatic: statusRank(desiredStatus) > statusRank(currentStatus)
    });
  }

  if (desiredTrustTier !== (orElse(build.trust_tier, () => "experimental"))) {
    actions.push({
      type: "promote_trust_tier",
      from: orElse(build.trust_tier, () => "experimental"),
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

  for (const blocker of verification?.top_blockers ?? []) {
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
    name: orElse(build.name, () => buildId),
    source_project: orElse(manifest.source?.project, () => null),
    manifest_path: relativeFromRepo(manifestPath),
    current: {
      build_status: currentStatus,
      trust_tier: orElse(build.trust_tier, () => "experimental"),
      visibility: orElse(build.visibility, () => "private"),
      publishable: publishing.publishable === true,
      release_status: orElse(latestRelease?.status, () => null)
    },
    desired: {
      build_status: desiredStatus,
      trust_tier: desiredTrustTier
    },
    verification_ready: verification?.verified_ready === true,
    publish_ready: verification?.publish_ready === true,
    suggested_build_status: orElse(verification?.suggested_build_status, () => currentStatus),
    readiness_score: readiness,
    publishability_score: publishability,
    updateability_score: updateability,
    priority,
    apply_manifest_promotion: applyManifestPromotion,
    actions,
    blockers: uniqueReasons(reasons)
  };
}

function uniqueReasons(reasons: Reason[]): Reason[] {
  const seen = new Set();
  const out = [];
  for (const reason of reasons) {
    const key = `${reason.dimension}:${String(reason.code)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(reason);
  }
  return out;
}

function inferDimension(code: unknown): string {
  if (String(code).startsWith("publishing.")) return "publishability";
  if (String(code).startsWith("release.")) return "release";
  if (String(code).startsWith("verification.")) return "verification";
  if (String(code).startsWith("clone.")) return "installability";
  if (String(code).startsWith("upgrade.")) return "updateability";
  return "general";
}

// eslint-disable-next-line complexity -- Promotion planning is an ordered release policy and serializer; branch order is part of the release contract.
function determineDesiredStatus({ currentStatus, verification, latestRelease, publishing }: { currentStatus: string; verification: Verification | null; latestRelease: ReleaseArtifact['latest_release']; publishing: NonNullable<BuildManifest['publishing']> }): string {
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
  return "candidate";
}

function determinePriority({ desiredStatus, currentStatus, verification, reasons }: { desiredStatus: string; currentStatus: string; verification: Verification | null; reasons: Reason[] }): string {
  const blockerCount = reasons.filter((reason) => reason.severity === "blocker").length;
  if (statusRank(desiredStatus) > statusRank(currentStatus) && blockerCount === 0) return "critical";
  if (verification?.verified_ready === true) return "high";
  if ((orElse(verification?.readiness_score, () => 0)) >= 70) return "medium";
  return "low";
}

async function applyManifestPromotion(manifestPath: string, manifest: BuildManifest, plan: PromotionPlan): Promise<boolean> {
  const nextStatus = plan.desired.build_status;
  const nextTrustTier = plan.desired.trust_tier;
  const currentStatus = normalizeStatus(manifest.build?.status);
  const currentTrustTier = (orElse(manifest.build?.trust_tier, () => "experimental"));

  if (statusRank(nextStatus) <= statusRank(currentStatus) && nextTrustTier === currentTrustTier) {
    return false;
  }

  const nextManifest = structuredClone(manifest);
  nextManifest.build ??= {};
  if (statusRank(nextStatus) > statusRank(currentStatus)) {
    nextManifest.build.status = nextStatus;
  }
  if (nextTrustTier !== currentTrustTier) {
    nextManifest.build.trust_tier = nextTrustTier;
  }

  await fs.writeFile(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
  return true;
}

function summarizePlans(plans: PromotionPlan[], appliedCount: number) {
  const summary: { build_count: number; applied_manifest_promotions: number; by_current_status: Record<string, number>; by_desired_status: Record<string, number>; verification_ready_count: number; publish_ready_count: number; auto_promotable_count: number; priority_counts: Record<string, number>; top_blockers: (Reason & { count: number })[] } = {
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

  const blockerCounts = new Map<string, Reason & { count: number }>();
  for (const plan of plans) {
    summary.by_current_status[plan.current.build_status] = (summary.by_current_status[plan.current.build_status] || 0) + 1;
    summary.by_desired_status[plan.desired.build_status] = (summary.by_desired_status[plan.desired.build_status] || 0) + 1;
    summary.priority_counts[plan.priority] = (summary.priority_counts[plan.priority] || 0) + 1;
    if (plan.verification_ready) summary.verification_ready_count += 1;
    if (plan.publish_ready) summary.publish_ready_count += 1;
    if (plan.apply_manifest_promotion) summary.auto_promotable_count += 1;
    for (const blocker of plan.blockers) {
      const key = `${blocker.dimension}:${String(blocker.code)}:${String(blocker.message)}`;
      const current = orElse(blockerCounts.get(key), () => ({ ...blocker, count: 0 }));
      current.count += 1;
      blockerCounts.set(key, current);
    }
  }

  summary.top_blockers = [...blockerCounts.values()]
    .sort((left, right) => right.count - left.count || (orElse(left.code, () => '')).localeCompare((orElse(right.code, () => ''))))
    .slice(0, 10);

  return summary;
}
