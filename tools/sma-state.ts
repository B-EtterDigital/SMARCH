#!/usr/bin/env node
/**
 * WHAT: Builds the portfolio state snapshot consumed by dashboards and operators.
 * WHY: Registry facts, readiness signals, conflicts, and activity need one consistent view.
 * HOW: Reads registry, build-index, lease, conflict, graph, and project context artifacts.
 * OUTPUTS: Writes wiki/SMA_STATE.generated.json or the path supplied with --out.
 * CALLERS: Portfolio refresh, dashboard generation, and command-line status tools consume it.
 * USAGE: `node tools/sma-state.ts --help`
 * Glossary: [SMA](../docs/GLOSSARY.md).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCanonicalizationReport } from "./sma-canonicalization.ts";
import {
  discoverPortfolioProjects,
  portfolioProjectsRoot,
  priorityProjectIds,
  sortByPortfolioPriority,
} from "./lib/portfolio-projects.ts";
import { collectGlobalGen3 } from "./lib/gen3-state.ts";
import {
  normalizeSmaStateSnapshot,
  writeJsonIfMeaningfulChanged,
} from "./lib/stable-generated.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(repoRoot, "..");
const buildsRoot = path.resolve(repoRoot, "builds");
const buildIndexPath = path.resolve(buildsRoot, "build-index.generated.json");
const releasesRoot = path.resolve(repoRoot, "releases");
const releaseIndexPath = path.resolve(releasesRoot, "release-index.generated.json");
const buildVerificationPath = path.resolve(repoRoot, "security/build-verification.generated.json");
const buildPromotionPath = path.resolve(repoRoot, "security/build-promotion.generated.json");
const publishIndexPath = path.resolve(repoRoot, "publish/publish-index.generated.json");
const installScanRoots = [path.resolve(workspaceRoot, "Projects")];
const ignoredWalkDirs = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage"]);

interface StateOptions { registry: string; buildIndex: string; out: string }
interface StateRecord extends Record<string, unknown> {
  id?: string; project?: string; name?: string; status?: string; kind?: string; code?: string;
  message?: string; severity?: string; dimension?: string; artifact_id?: string; build_id?: string;
  version?: string; file?: string; root?: string | null; path?: string | null; channel?: string; label?: string;
  created_at?: string; published_at?: string; event_type?: string; bundle_path?: string;
  publishing_visibility?: string | null; original_id?: string; target_type?: string; target_id?: string;
  promotion_stage?: string; confidence_label?: string; candidate_key?: string; recurrence_key?: string;
  dominant_feature_cluster?: string; dominant_domain?: string; why?: string; bottleneck_stage?: string;
  source_project?: string | null; relative_root?: string; priority_tier?: string; generated_at?: string | null;
  score?: number; count?: number; release_count?: number; artifact_count?: number; skipped_count?: number;
  published_artifact_count?: number; stable_or_lts_artifact_count?: number; brick_count?: number;
  required_brick_count?: number; verification_health_score?: number; publishability_score?: number;
  installability_score?: number; updateability_score?: number; readiness_score?: number;
  published_release_count?: number; build_count?: number; ready_count?: number;
  verified_ready_count?: number; ready_for_adoption_count?: number; publish_ready_count?: number;
  publishable_count?: number; auto_promotable_count?: number; applied_manifest_promotions?: number;
  verification_ready_count?: number; bundle_count?: number; complete_bundle_count?: number;
  publish_safe_count?: number; blocker_bundle_count?: number; warning_bundle_count?: number;
  priority_score?: number; confidence_score?: number; recurrent_project_count?: number;
  unmanifested_count?: number; validation_error_count?: number; validation_warning_count?: number;
  priority_rank?: number;
  imports_count?: number; selected_build_count?: number; resolved_brick_count?: number;
  placement_count?: number; update_event_count?: number;
  publish_ready?: boolean; verified_ready?: boolean; install_ready?: boolean; update_ready?: boolean;
  rollback_supported?: boolean; installable?: boolean; ready?: boolean; release_backed?: boolean;
  verification_ready?: boolean; apply_manifest_promotion?: boolean; publish_safe?: boolean;
  declared_publishable?: boolean; required?: boolean; project_canonicalization_ready?: boolean;
  builds?: StateRecord[]; projects?: StateRecord[]; bricks?: StateRecord[]; top_blockers?: StateRecord[];
  top_warnings?: StateRecord[]; blockers?: StateRecord[]; actions?: StateRecord[]; bundles?: StateRecord[];
  promotion_queue?: StateRecord[]; curated_builds?: StateRecord[]; top_candidates?: StateRecord[];
  top_targets?: StateRecord[]; quality_queue?: StateRecord[]; top_actions?: StateRecord[];
  top_hotspots?: StateRecord[]; highest_risk_bricks?: StateRecord[]; duplicate_groups?: StateRecord[];
  imports?: StateRecord[]; selected_builds?: StateRecord[]; resolved_bricks?: StateRecord[];
  placements?: StateRecord[]; sample_build_ids?: string[]; source_projects?: string[];
  domains?: string[]; runtimes?: string[]; detection_sources?: string[]; sample_paths?: string[];
  blocker_reasons?: string[]; brick_refs?: StateRecord[];
  summary?: StateRecord; by_type?: StateRecord; build?: StateRecord; artifacts?: StateRecord;
  latest_release?: StateRecord; latest_published_release?: StateRecord; trust_summary?: StateRecord;
  build_truth?: StateRecord; release_summary?: StateRecord; verification_health?: StateRecord;
  publishability?: StateRecord; installability?: StateRecord; updateability?: StateRecord;
  check_counts?: StateRecord; verification?: StateRecord; release?: StateRecord; signals?: StateRecord;
  readiness?: StateRecord; booleans?: StateRecord; source?: StateRecord; composition?: StateRecord;
  current?: StateRecord; desired?: StateRecord; decision?: StateRecord; artifact?: StateRecord;
  counts?: StateRecord; lock?: StateRecord; map?: StateRecord; scanner_report?: StateRecord;
  code_quality_report?: StateRecord | null; compliance_report?: StateRecord; build_report?: StateRecord;
  canonicalization_report?: StateRecord; refactor_report?: StateRecord; clone_preflight?: StateRecord | null;
  env_contract_report?: StateRecord | null; boundary_report?: StateRecord | null; remediation_report?: StateRecord;
  manifest_drift?: StateRecord | null; scanner?: StateRecord; blocker_summary?: StateRecord; evidence_summary?: StateRecord;
}

const defaults: StateOptions = {
  registry: path.resolve(repoRoot, "scans/all-projects/latest.registry.json"),
  buildIndex: buildIndexPath,
  out: path.resolve(repoRoot, "wiki/SMA_STATE.generated.json")
};


function parseArgs(argv: string[]): StateOptions {
  const options: StateOptions = { ...defaults };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--registry" && next) {
      options.registry = path.resolve(next);
      i += 1;
    } else if (arg === "--build-index" && next) {
      options.buildIndex = path.resolve(next);
      i += 1;
    } else if (arg === "--out" && next) {
      options.out = path.resolve(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`SMA state snapshot generator

Usage:
  node tools/sma-state.ts
  node tools/sma-state.ts --registry scans/all-projects/latest.registry.json --build-index builds/build-index.generated.json --out wiki/SMA_STATE.generated.json
`);
      process.exit(0);
    }
  }

  return options;
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function maybeReadJson<T = StateRecord>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function maybeCountJsonl(filePath: string): Promise<number> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean).length;
  } catch {
    return 0;
  }
}

function registryStatusCounts(bricks: StateRecord[]): Record<string, number> {
  const counts: Record<string, number> = {
    canonical: 0,
    candidate: 0,
    project_bound: 0,
    variant: 0,
    duplicate: 0,
    legacy: 0,
    experimental: 0,
    unknown: 0
  };

  for (const brick of bricks) {
    const status = brick.status ?? "unknown";
    counts[status] += 1;
  }

  return counts;
}

function normalizeRelativePath(value: unknown): string {
  return legacyString(value ?? "").split(path.sep).join("/").replace(/^\.\//, "");
}

function relativeFromWorkspace(absolutePath: string): string {
  return normalizeRelativePath(path.relative(workspaceRoot, absolutePath));
}

function pick(obj: StateRecord, keys: string[]): StateRecord {
  const out: StateRecord = {};
  for (const key of keys) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

function toArray(value: unknown): StateRecord[] {
  return Array.isArray(value) ? value as StateRecord[] : [];
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function uniqStrings(values: unknown[]): string[] {
  return [...new Set<string>(values.flatMap((value) => {
  if (Array.isArray(value)) return value as unknown[];
    if (value == null) return [];
    return [legacyString(value)];
  }).map((value) => String(value).trim()).filter(Boolean))];
}

function semverOrFallback(value: unknown, fallback = "0.0.0"): string {
  const candidate = legacyString(value ?? "").trim();
  return /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(candidate)
    ? candidate
    : fallback;
}

function average(values: number[]): number {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length === 0) return 0;
  return Math.round(filtered.reduce((sum, value) => sum + value, 0) / filtered.length);
}

function numberOrFallback(primary: unknown, fallback: unknown): number {
  return primary !== undefined && primary !== null
    ? Number(primary)
    : Number(fallback);
}

/** @param {(absolutePath: string, entryName: string) => boolean} [predicate] */
async function collectJsonFiles(rootPath: string, predicate: (absolutePath: string, entryName: string) => boolean = () => true): Promise<string[]> {
  const stat = await fs.stat(rootPath).catch(() => null);
  if (!stat?.isDirectory()) return [];

  const files: string[] = [];
  async function walk(currentPath: string): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (ignoredWalkDirs.has(entry.name)) continue;
        await walk(path.join(currentPath, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".json")) continue;
      const absolutePath = path.join(currentPath, entry.name);
      if (predicate(absolutePath, entry.name)) files.push(absolutePath);
    }
  }
  await walk(rootPath);
  return files.sort((a, b) => a.localeCompare(b));
}

// eslint-disable-next-line max-lines-per-function, complexity -- State builders are ordered compatibility serializers; centralized field precedence preserves stable snapshots.
function buildReleaseSummary(releaseIndex: StateRecord | null, curatedBuildLookup = new Map<string, StateRecord>()): StateRecord {
  const summary = releaseIndex?.summary ?? {};
  const buildSummary = summary.by_type?.build ?? {};
  const allBuildReleases = Object.values(releaseIndex?.artifacts?.build ?? {}) as StateRecord[];
  const linkedCuratedBuilds = allBuildReleases
    .map((artifact) => artifact.artifact_id ? curatedBuildLookup.get(artifact.artifact_id) : undefined)
    .filter((entry): entry is StateRecord => Boolean(entry));
  const topBuildReleases: (StateRecord & { latest_release: StateRecord })[] = allBuildReleases
    .flatMap((artifact) => artifact.latest_release ? [{
      artifact_id: artifact.artifact_id,
      source_projects: artifact.source_projects ?? [],
      release_count: artifact.release_count ?? 0,
      latest_release: artifact.latest_release,
      latest_published_release: artifact.latest_published_release ?? null,
      trust_summary: artifact.trust_summary ?? {},
      build_truth: artifact.artifact_id ? (curatedBuildLookup.get(artifact.artifact_id) ?? null) : null
    } as StateRecord & { latest_release: StateRecord }] : [])
    .sort((left, right) => {
      const leftTrust = legacyString(left.latest_release.trust_summary?.verification_status ?? "");
      const rightTrust = legacyString(right.latest_release.trust_summary?.verification_status ?? "");
      return rightTrust.localeCompare(leftTrust)
        || String(left.artifact_id).localeCompare(String(right.artifact_id));
    });

  return {
    index_path: releaseIndex ? relativeFromWorkspace(releaseIndexPath) : null,
    available: Boolean(releaseIndex),
    summary: {
      release_count: summary.release_count ?? 0,
      artifact_count: summary.artifact_count ?? 0,
      skipped_count: summary.skipped_count ?? 0,
      channels: summary.channels ?? {},
      statuses: summary.statuses ?? {},
      verification_statuses: summary.verification_statuses ?? {},
      trust_levels: summary.trust_levels ?? {},
      build: {
        artifact_count: buildSummary.artifact_count ?? 0,
        release_count: buildSummary.release_count ?? 0,
        published_artifact_count: buildSummary.published_artifact_count ?? 0,
        stable_or_lts_artifact_count: buildSummary.stable_or_lts_artifact_count ?? 0,
        channels: buildSummary.channels ?? {},
        statuses: buildSummary.statuses ?? {},
        verification_statuses: buildSummary.verification_statuses ?? {},
        trust_levels: buildSummary.trust_levels ?? {},
        product_truth: {
          linked_curated_build_count: linkedCuratedBuilds.length,
          average_verification_health_score: average(linkedCuratedBuilds.map((entry) => entry.verification_health_score ?? 0)),
          average_publishability_score: average(linkedCuratedBuilds.map((entry) => entry.publishability_score ?? 0)),
          average_installability_score: average(linkedCuratedBuilds.map((entry) => entry.installability_score ?? 0)),
          average_updateability_score: average(linkedCuratedBuilds.map((entry) => entry.updateability_score ?? 0))
        }
      }
    },
    top_build_releases: topBuildReleases.slice(0, 6).map((entry) => ({
      artifact_id: entry.artifact_id,
      source_projects: entry.source_projects,
      release_count: entry.release_count,
      latest_release: {
        release_id: entry.latest_release.release_id,
        version: entry.latest_release.version,
        channel: entry.latest_release.channel,
        status: entry.latest_release.status,
        created_at: entry.latest_release.created_at,
        published_at: entry.latest_release.published_at,
        path: entry.latest_release.path,
        content_summary: entry.latest_release.content_summary ?? {},
        contract_summary: entry.latest_release.contract_summary ?? {},
        trust_summary: entry.latest_release.trust_summary ?? {}
      },
      latest_published_release: entry.latest_published_release ? pick(entry.latest_published_release, ["release_id", "version", "channel", "status", "published_at", "path"]) : null,
      trust_summary: entry.trust_summary,
      build_truth: entry.build_truth ? pick(entry.build_truth, [
        "artifact_id",
        "publish_ready",
        "verified_ready",
        "install_ready",
        "update_ready",
        "verification_health_score",
        "verification_health_label",
        "publishability_score",
        "publishability_label",
        "installability_score",
        "installability_label",
        "updateability_score",
        "updateability_label",
        "top_blockers"
      ]) : null
    }))
  };
}

function sortCuratedBuilds(curatedBuilds: StateRecord[]): StateRecord[] {
  // eslint-disable-next-line complexity -- State builders are ordered compatibility serializers; centralized field precedence preserves stable snapshots.
  return [...curatedBuilds].sort((left, right) => {
    const leftPublishReady = Number(Boolean(left.publish_ready));
    const rightPublishReady = Number(Boolean(right.publish_ready));
    const leftVerifiedReady = Number(Boolean(left.verified_ready));
    const rightVerifiedReady = Number(Boolean(right.verified_ready));
    const leftInstallReady = Number(Boolean(left.install_ready));
    const rightInstallReady = Number(Boolean(right.install_ready));
    const leftHasRelease = (left.release_count ?? 0);
    const rightHasRelease = (right.release_count ?? 0);
    return rightPublishReady - leftPublishReady
      || rightVerifiedReady - leftVerifiedReady
      || rightInstallReady - leftInstallReady
      || ((right.installability_score ?? right.readiness_score) ?? 0) - ((left.installability_score ?? left.readiness_score) ?? 0)
      || (right.updateability_score ?? 0) - (left.updateability_score ?? 0)
      || rightHasRelease - leftHasRelease
      || legacyString(right.latest_verification_status ?? "").localeCompare(legacyString(left.latest_verification_status ?? ""))
      || (left.artifact_id ?? "").localeCompare((right.artifact_id ?? ""));
  });
}

// eslint-disable-next-line complexity -- State builders are ordered compatibility serializers; centralized field precedence preserves stable snapshots.
function summarizeTopBuildBlockers(builds: StateRecord[], fallbackRows: StateRecord[] = [], limit = 8): StateRecord[] {
  const counts = new Map<string, StateRecord & { count: number; sample_build_ids: string[] }>();

  for (const build of builds) {
    for (const blocker of toArray(build.top_blockers).slice(0, 4)) {
      if (!blocker.code) continue;
      const key = `${blocker.dimension ?? "build"}:${blocker.code}`;
      if (!counts.has(key)) {
        counts.set(key, {
          dimension: blocker.dimension ?? "build",
          code: blocker.code,
          severity: blocker.severity ?? "warning",
          message: blocker.message ?? "Build blocker recorded.",
          count: 0,
          sample_build_ids: []
        });
      }
      const row = counts.get(key);
      if (!row) continue;
      row.count += 1;
      if (row.sample_build_ids.length < 4) {
        if (build.artifact_id) row.sample_build_ids.push(build.artifact_id);
      }
    }
  }

  for (const blocker of toArray(fallbackRows)) {
    if (!blocker.code) continue;
    const key = `${blocker.dimension ?? "verification"}:${blocker.code}`;
    if (!counts.has(key)) {
      counts.set(key, {
        dimension: blocker.dimension ?? "verification",
        code: blocker.code,
        severity: blocker.severity ?? "warning",
        message: blocker.message ?? "Verification blocker recorded.",
        count: (blocker.count ?? 0),
        sample_build_ids: (blocker.sample_build_ids ?? []).slice(0, 4)
      });
    }
  }

  return [...counts.values()]
    .sort((left, right) => (right.count || 0) - (left.count || 0) || (left.code ?? "").localeCompare((right.code ?? "")))
    .slice(0, limit);
}

// eslint-disable-next-line complexity -- State builders are ordered compatibility serializers; centralized field precedence preserves stable snapshots.
function normalizeCuratedBuildFromIndex(entry: StateRecord): StateRecord {
  const releaseSummary = entry.release_summary ?? {};
  const verificationHealth = entry.verification_health ?? {};
  const publishability = entry.publishability ?? {};
  const installability = entry.installability ?? {};
  const updateability = entry.updateability ?? {};

  return {
    artifact_id: entry.build_id,
    name: entry.name ?? entry.build_id,
    version: semverOrFallback(entry.version, "0.1.0"),
    status: entry.status ?? "candidate",
    kind: entry.kind ?? "build",
    source_project: entry.project ?? null,
    manifest_path: entry.file ?? null,
    domains: uniqStrings(entry.domains ?? []),
    runtimes: uniqStrings(entry.runtimes ?? []),
    brick_ref_count: (entry.brick_count ?? 0),
    required_brick_ref_count: (entry.required_brick_count ?? 0),
    release_count: (releaseSummary.release_count ?? 0),
    installable: (installability.release_backed ?? (releaseSummary.release_count ?? 0) > 0),
    install_ready: Boolean(installability.ready),
    update_ready: Boolean(updateability.ready),
    latest_channel: releaseSummary.latest_channel ?? null,
    latest_release_status: releaseSummary.latest_status ?? null,
    latest_release_version: releaseSummary.latest_version ?? null,
    latest_verification_status: (verificationHealth.primary_status ?? releaseSummary.latest_verification_status) ?? null,
    latest_trust_level: (verificationHealth.trust_level ?? releaseSummary.latest_trust_level) ?? null,
    latest_release_path: null,
    latest_release_created_at: null,
    latest_release_published_at: null,
    latest_release_check_counts: (releaseSummary.latest_check_counts ?? verificationHealth.check_counts) ?? {},
    rollback_supported: (updateability.rollback_supported ?? Number(releaseSummary.rollback_supported_release_count ?? 0) > 0),
    published_release_count: (releaseSummary.published_release_count ?? 0),
    suggested_build_status: null,
    verification_health_score: (verificationHealth.score ?? 0),
    verification_health_label: verificationHealth.label ?? null,
    verification_score: (verificationHealth.score ?? 0),
    installability_score: (installability.score ?? 0),
    installability_label: installability.label ?? null,
    publishability_score: (publishability.score ?? 0),
    publishability_label: publishability.label ?? null,
    updateability_score: (updateability.score ?? 0),
    updateability_label: updateability.label ?? null,
    readiness_score: (installability.score ?? 0),
    verification_check_counts: verificationHealth.check_counts ?? { passed: 0, failed: 0, skipped: 0, total: 0 },
    verified_ready: Boolean(verificationHealth.ready),
    publish_ready: Boolean(publishability.ready),
    verification_top_blockers: toArray(entry.top_blockers).slice(0, 4),
    top_blockers: toArray(entry.top_blockers).slice(0, 6)
  };
}

// eslint-disable-next-line complexity -- State builders are ordered compatibility serializers; centralized field precedence preserves stable snapshots.
function normalizeVerifierBuildOverlay(entry: StateRecord): StateRecord | null {
  if (!entry.build_id) return null;
  const suggestedStatus = legacyString(entry.verification?.suggested_status ?? "").trim().toLowerCase();
  return {
    artifact_id: entry.build_id,
    latest_release_status: entry.release?.latest_status ?? entry.release_summary?.latest_status ?? null,
    latest_verification_status: entry.release?.latest_verification_status ?? entry.release_summary?.latest_verification_status ?? null,
    latest_trust_level: entry.release?.latest_trust_level ?? entry.release_summary?.latest_trust_level ?? null,
    latest_channel: entry.release?.latest_channel ?? entry.release_summary?.latest_channel ?? null,
    published_release_count: (entry.release?.published_release_count ?? entry.release_summary?.published_release_count ?? 0),
    suggested_build_status: suggestedStatus === "unverified" ? "candidate" : (suggestedStatus || null),
    verification_score: (entry.signals?.readiness?.score ?? 0),
    verification_health_score: (entry.signals?.readiness?.score ?? 0),
    installability_score: (entry.signals?.installability?.score ?? 0),
    publishability_score: (entry.signals?.publishability?.score ?? 0),
    updateability_score: (entry.signals?.updateability?.score ?? 0),
    readiness_score: (entry.signals?.readiness?.score ?? 0),
    verified_ready: entry.booleans?.ready_for_adoption === true || ["verified", "canonical"].includes(suggestedStatus),
    publish_ready: entry.booleans?.publishable === true,
    install_ready: entry.booleans?.installable === true,
    update_ready: entry.booleans?.updateable === true,
    verification_top_blockers: toArray(entry.top_blockers).slice(0, 4),
    top_blockers: toArray(entry.top_blockers).slice(0, 6)
  };
}

// eslint-disable-next-line max-lines-per-function, complexity -- State builders are ordered compatibility serializers; centralized field precedence preserves stable snapshots.
async function collectCuratedBuilds(releaseIndex: StateRecord | null, buildIndexDocument: StateRecord | null, buildIndexFilePath: string): Promise<StateRecord> {
  const verificationReport = await maybeReadJson(buildVerificationPath);
  const verificationLookup = new Map<string, StateRecord>(
    toArray(verificationReport?.builds)
      .map((entry) => normalizeVerifierBuildOverlay(entry))
      .filter((entry): entry is StateRecord & { artifact_id: string } => Boolean(entry?.artifact_id))
      .map((entry) => [entry.artifact_id, entry])
  );

  if (Array.isArray(buildIndexDocument?.builds) && buildIndexDocument.builds.length > 0) {
    const sortedBuilds = sortCuratedBuilds(buildIndexDocument.builds.map((entry) => ({
      ...normalizeCuratedBuildFromIndex(entry),
      ...(entry.build_id ? (verificationLookup.get(entry.build_id) ?? {}) : {})
    })));
    const verifierSummary = verificationReport?.summary ?? {};
    const verificationSummary = buildIndexDocument.summary?.verification ?? {};
    const publishabilitySummary = buildIndexDocument.summary?.publishability ?? {};
    const installabilitySummary = buildIndexDocument.summary?.installability ?? {};
    const updateabilitySummary = buildIndexDocument.summary?.updateability ?? {};
    const topBlockers = summarizeTopBuildBlockers(sortedBuilds, verifierSummary.top_blockers ?? buildIndexDocument.summary?.top_blockers);

    return {
      manifest_root: normalizeRelativePath(buildIndexDocument.root ?? relativeFromWorkspace(buildsRoot)),
      build_index_path: relativeFromWorkspace(buildIndexFilePath),
      verification_report_path: verificationReport ? relativeFromWorkspace(buildVerificationPath) : null,
      curated_manifest_count: sortedBuilds.length,
      released_curated_build_count: sortedBuilds.filter((entry) => (entry.release_count ?? 0) > 0).length,
      unreleased_curated_build_count: sortedBuilds.filter((entry) => (entry.release_count ?? 0) === 0).length,
      installable_build_count: sortedBuilds.filter((entry) => entry.installable).length,
      install_ready_count: numberOrFallback(verifierSummary.installable_count, sortedBuilds.filter((entry) => entry.install_ready).length),
      update_ready_build_count: numberOrFallback(verifierSummary.updateable_count, sortedBuilds.filter((entry) => entry.update_ready).length),
      rollback_supported_build_count: sortedBuilds.filter((entry) => entry.rollback_supported).length,
      candidate_or_better_verification_count: sortedBuilds.filter((entry) => ["candidate", "verified", "canonical", "passing"].includes(legacyString(entry.latest_verification_status ?? ""))).length,
      verification_available_count: numberOrFallback(verifierSummary.build_count, sortedBuilds.filter((entry) => (entry.verification_health_score ?? 0) > 0).length),
      verification_ready_count: verifierSummary.verified_ready_count ?? (verifierSummary.ready_for_adoption_count ?? numberOrFallback(verificationSummary.ready_count, sortedBuilds.filter((entry) => entry.verified_ready).length)),
      publish_ready_count: verifierSummary.publish_ready_count ?? (verifierSummary.publishable_count ?? numberOrFallback(publishabilitySummary.ready_count, sortedBuilds.filter((entry) => entry.publish_ready).length)),
      suggested_build_status_counts: verifierSummary.by_suggested_status ?? (verifierSummary.verification_status_suggestions ?? verificationReport?.summary?.by_suggested_status) ?? {},
      average_verification_health_score: Number(verificationSummary.average_score ?? average(sortedBuilds.map((entry) => entry.verification_health_score ?? 0))),
      average_readiness_score: Number(installabilitySummary.average_score ?? average(sortedBuilds.map((entry) => entry.readiness_score ?? 0))),
      average_publishability_score: Number(publishabilitySummary.average_score ?? average(sortedBuilds.map((entry) => entry.publishability_score ?? 0))),
      average_installability_score: Number(installabilitySummary.average_score ?? average(sortedBuilds.map((entry) => entry.installability_score ?? 0))),
      average_updateability_score: Number(updateabilitySummary.average_score ?? average(sortedBuilds.map((entry) => entry.updateability_score ?? 0))),
      verification_summary: verificationSummary,
      publishability_summary: publishabilitySummary,
      installability_summary: installabilitySummary,
      updateability_summary: updateabilitySummary,
      top_verification_blockers: toArray(verifierSummary.top_blockers ?? verificationReport?.summary?.top_blockers).slice(0, 8),
      top_blockers: topBlockers,
      curated_builds: sortedBuilds.slice(0, 12)
    };
  }

  const files = await collectJsonFiles(buildsRoot, (absolutePath) => absolutePath.endsWith(".build.sweetspot.json"));
  const builds: StateRecord[] = [];

  for (const filePath of files) {
    const manifest = await maybeReadJson(filePath);
    if (!manifest?.build?.id) continue;
    const artifactId = manifest.build.id;
    const releaseArtifact = (releaseIndex?.artifacts?.build?.[artifactId] as StateRecord | undefined) ?? null;
    const latestRelease = releaseArtifact?.latest_release ?? null;
    const trustSummary = (latestRelease?.trust_summary ?? releaseArtifact?.trust_summary) ?? {};
    const verification = verificationLookup.get(artifactId) ?? null;
    const version = semverOrFallback(manifest.build.version, "0.1.0");
    const installable = Boolean(latestRelease);
    const updateReady = Boolean(latestRelease?.trust_summary?.rollback_supported);
    builds.push({
      artifact_id: artifactId,
      name: manifest.build.name ?? artifactId,
      version,
      status: manifest.build.status ?? "candidate",
      kind: manifest.build.kind ?? "build",
      source_project: manifest.source?.project ?? null,
      manifest_path: relativeFromWorkspace(filePath),
      domains: uniqStrings(toStringArray(manifest.build.domain)),
      runtimes: uniqStrings(toStringArray(manifest.build.runtimes)),
      brick_ref_count: toArray(manifest.composition?.brick_refs).length,
      required_brick_ref_count: toArray(manifest.composition?.brick_refs).filter((entry) => entry.required !== false).length,
      release_count: releaseArtifact?.release_count ?? 0,
      installable,
      update_ready: updateReady,
      latest_channel: latestRelease?.channel ?? null,
      latest_release_status: latestRelease?.status ?? null,
      latest_release_version: latestRelease?.version ?? null,
      latest_verification_status: (trustSummary.verification_status ?? releaseArtifact?.trust_summary?.latest_verification_status) ?? null,
      latest_trust_level: (trustSummary.trust_level ?? releaseArtifact?.trust_summary?.latest_trust_level) ?? null,
      latest_release_path: latestRelease?.path ?? null,
      latest_release_created_at: latestRelease?.created_at ?? null,
      latest_release_published_at: latestRelease?.published_at ?? null,
      latest_release_check_counts: latestRelease?.trust_summary?.check_counts ?? {},
      rollback_supported: Boolean(latestRelease?.trust_summary?.rollback_supported),
      published_release_count: releaseArtifact?.trust_summary?.published_release_count ?? 0,
      suggested_build_status: verification?.suggested_build_status ?? null,
      verification_score: Number(verification?.verification_score ?? 0),
      installability_score: (verification?.installability_score ?? 0),
      publishability_score: (verification?.publishability_score ?? 0),
      updateability_score: (verification?.updateability_score ?? 0),
      readiness_score: (verification?.readiness_score ?? 0),
      verification_check_counts: verification?.summary ?? { pass: 0, warn: 0, fail: 0 },
      verified_ready: verification?.verified_ready === true,
      publish_ready: verification?.publish_ready === true,
      verification_top_blockers: toArray(verification?.top_blockers).slice(0, 4),
      top_blockers: toArray(verification?.top_blockers).slice(0, 6)
    });
  }

  const sortedBuilds = sortCuratedBuilds(builds);
  return {
    manifest_root: relativeFromWorkspace(buildsRoot),
    build_index_path: null,
    verification_report_path: verificationReport ? relativeFromWorkspace(buildVerificationPath) : null,
    curated_manifest_count: sortedBuilds.length,
    released_curated_build_count: sortedBuilds.filter((entry) => (entry.release_count ?? 0) > 0).length,
    unreleased_curated_build_count: sortedBuilds.filter((entry) => (entry.release_count ?? 0) === 0).length,
    installable_build_count: sortedBuilds.filter((entry) => entry.installable).length,
    install_ready_count: 0,
    update_ready_build_count: sortedBuilds.filter((entry) => entry.update_ready).length,
    rollback_supported_build_count: sortedBuilds.filter((entry) => entry.rollback_supported).length,
    candidate_or_better_verification_count: sortedBuilds.filter((entry) => ["candidate", "verified", "canonical"].includes(legacyString(entry.latest_verification_status ?? ""))).length,
    verification_available_count: (verificationReport?.summary?.build_count ?? 0),
    verification_ready_count: (verificationReport?.summary?.verified_ready_count ?? 0),
    publish_ready_count: (verificationReport?.summary?.publish_ready_count ?? 0),
    suggested_build_status_counts: verificationReport?.summary?.by_suggested_status ?? {},
    average_verification_health_score: 0,
    average_readiness_score: Number(verificationReport?.summary?.average_readiness_score ?? 0),
    average_publishability_score: Number(verificationReport?.summary?.average_publishability_score ?? 0),
    average_installability_score: 0,
    average_updateability_score: Number(verificationReport?.summary?.average_updateability_score ?? 0),
    verification_summary: {},
    publishability_summary: {},
    installability_summary: {},
    updateability_summary: {},
    top_verification_blockers: toArray(verificationReport?.summary?.top_blockers).slice(0, 8),
    top_blockers: summarizeTopBuildBlockers(sortedBuilds, verificationReport?.summary?.top_blockers),
    curated_builds: sortedBuilds.slice(0, 12)
  };
}

function summarizePromotionPlane(promotionDocument: StateRecord | null): StateRecord {
  const summary = promotionDocument?.summary ?? {};
  const queue = toArray(promotionDocument?.promotion_queue);
  return {
    available: Boolean(promotionDocument),
    path: promotionDocument ? relativeFromWorkspace(buildPromotionPath) : null,
    summary: {
      build_count: (summary.build_count ?? queue.length),
      applied_manifest_promotions: (summary.applied_manifest_promotions ?? 0),
      verification_ready_count: (summary.verification_ready_count ?? 0),
      publish_ready_count: (summary.publish_ready_count ?? 0),
      auto_promotable_count: (summary.auto_promotable_count ?? 0),
      by_current_status: summary.by_current_status ?? {},
      by_desired_status: summary.by_desired_status ?? {},
      priority_counts: summary.priority_counts ?? {}
    },
    top_blockers: toArray(summary.top_blockers).slice(0, 8),
    top_queue: queue.slice(0, 8).map((entry) => ({
      build_id: entry.build_id,
      name: entry.name,
      source_project: entry.source_project,
      current: entry.current ?? {},
      desired: entry.desired ?? {},
      priority: entry.priority ?? "low",
      verification_ready: entry.verification_ready === true,
      publish_ready: entry.publish_ready === true,
      readiness_score: (entry.readiness_score ?? 0),
      publishability_score: (entry.publishability_score ?? 0),
      updateability_score: (entry.updateability_score ?? 0),
      apply_manifest_promotion: entry.apply_manifest_promotion === true,
      blockers: toArray(entry.blockers).slice(0, 6),
      actions: toArray(entry.actions).slice(0, 4)
    }))
  };
}

// eslint-disable-next-line complexity -- State builders are ordered compatibility serializers; centralized field precedence preserves stable snapshots.
function summarizePublishPlane(publishIndexDocument: StateRecord | null): StateRecord {
  const summary = publishIndexDocument?.summary ?? {};
  const bundles = toArray(publishIndexDocument?.bundles);
  return {
    available: Boolean(publishIndexDocument),
    path: publishIndexDocument ? relativeFromWorkspace(publishIndexPath) : null,
    root: publishIndexDocument?.root ?? null,
    summary: {
      bundle_count: (summary.bundle_count ?? bundles.length),
      complete_bundle_count: (summary.complete_bundle_count ?? 0),
      publish_safe_count: (summary.publish_safe_count ?? 0),
      blocker_bundle_count: (summary.blocker_bundle_count ?? 0),
      warning_bundle_count: (summary.warning_bundle_count ?? 0),
      by_decision_status: summary.by_decision_status ?? {},
      by_artifact_type: summary.by_artifact_type ?? {},
      by_original_artifact_type: summary.by_original_artifact_type ?? {},
      by_publishing_visibility: summary.by_publishing_visibility ?? {}
    },
    top_rules: toArray(summary.top_rules).slice(0, 10),
    bundles: bundles.slice(0, 8).map((entry) => ({
      bundle_path: entry.bundle_path,
      generated_at: entry.generated_at ?? null,
      artifact: entry.artifact ?? {},
      decision: entry.decision ?? {},
      publish_safe: entry.publish_safe === true,
      declared_publishable: entry.declared_publishable === true,
      publishing_visibility: entry.publishing_visibility ?? null,
      top_blockers: toArray(entry.top_blockers).slice(0, 4),
      top_warnings: toArray(entry.top_warnings).slice(0, 3)
    }))
  };
}

// eslint-disable-next-line complexity -- State builders are ordered compatibility serializers; centralized field precedence preserves stable snapshots.
function attachCuratedBuildAuxTruth(curatedBuildsDocument: StateRecord, promotionDocument: StateRecord | null, publishIndexDocument: StateRecord | null): StateRecord {
  const promotionLookup = new Map<string, StateRecord>(
    toArray(promotionDocument?.promotion_queue)
      .filter((entry): entry is StateRecord & { build_id: string } => Boolean(entry.build_id))
      .map((entry) => [entry.build_id, entry])
  );
  const publishLookup = new Map<string, StateRecord>();

  for (const bundle of toArray(publishIndexDocument?.bundles)) {
    const originalId = bundle.artifact?.original_id;
    if (!originalId) continue;
    const current = publishLookup.get(originalId);
    if (!current || (bundle.generated_at ?? "") > (current.generated_at ?? "")) {
      publishLookup.set(originalId, bundle);
    }
  }

  const enrichedBuilds = sortCuratedBuilds(
    // eslint-disable-next-line complexity -- State builders are ordered compatibility serializers; centralized field precedence preserves stable snapshots.
    toArray(curatedBuildsDocument.curated_builds).map((entry) => {
      const promotion = entry.artifact_id ? (promotionLookup.get(entry.artifact_id) ?? null) : null;
      const publishBundle = entry.artifact_id ? (publishLookup.get(entry.artifact_id) ?? null) : null;
      return {
        ...entry,
        promotion_priority: promotion?.priority ?? null,
        promotion_current_status: promotion?.current?.build_status ?? null,
        promotion_desired_status: promotion?.desired?.build_status ?? null,
        promotion_apply_manifest: promotion?.apply_manifest_promotion === true,
        promotion_actions: toArray(promotion?.actions).slice(0, 4),
        promotion_blockers: toArray(promotion?.blockers).slice(0, 6),
        private_publish_bundle_path: publishBundle?.bundle_path ?? null,
        private_publish_generated_at: publishBundle?.generated_at ?? null,
        private_publish_status: publishBundle?.decision?.status ?? null,
        private_publish_safe: publishBundle?.publish_safe === true,
        private_publish_declared_publishable: publishBundle?.declared_publishable === true,
        private_publish_visibility: publishBundle?.publishing_visibility ?? null,
        private_publish_blocker_count: Number(publishBundle?.decision?.counts?.blocker ?? 0),
        private_publish_warning_count: Number(publishBundle?.decision?.counts?.warning ?? 0),
        private_publish_top_blockers: toArray(publishBundle?.top_blockers).slice(0, 4),
        private_publish_top_warnings: toArray(publishBundle?.top_warnings).slice(0, 3)
      };
    })
  );

  return {
    ...curatedBuildsDocument,
    promotion_path: promotionDocument ? relativeFromWorkspace(buildPromotionPath) : null,
    publish_index_path: publishIndexDocument ? relativeFromWorkspace(publishIndexPath) : null,
    auto_promotable_count: (promotionDocument?.summary?.auto_promotable_count ?? 0),
    promotion_ready_count: enrichedBuilds.filter((entry) => entry.promotion_apply_manifest).length,
    private_publish_bundle_count: enrichedBuilds.filter((entry) => entry.private_publish_status).length,
    private_publish_safe_count: enrichedBuilds.filter((entry) => entry.private_publish_safe).length,
    top_promotion_blockers: toArray(promotionDocument?.summary?.top_blockers).slice(0, 8),
    top_publish_rules: toArray(publishIndexDocument?.summary?.top_rules).slice(0, 8),
    curated_builds: enrichedBuilds.slice(0, 12)
  };
}

async function readJsonLines(filePath: string): Promise<StateRecord[]> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as StateRecord;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is StateRecord => Boolean(entry));
  } catch {
    return [];
  }
}

async function findSmarchRoots(rootPath: string, maxDepth = 4): Promise<string[]> {
  const found: string[] = [];
  const rootStat = await fs.stat(rootPath).catch(() => null);
  if (!rootStat?.isDirectory()) return found;

  async function walk(currentPath: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (ignoredWalkDirs.has(entry.name)) continue;
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.name === ".smarch") {
        found.push(absolutePath);
        continue;
      }
      await walk(absolutePath, depth + 1);
    }
  }

  await walk(rootPath, 0);
  return found.sort((a, b) => a.localeCompare(b));
}

// eslint-disable-next-line complexity -- State builders are ordered compatibility serializers; centralized field precedence preserves stable snapshots.
async function collectInstallEvidence(): Promise<StateRecord> {
  const targets: StateRecord[] = [];

  for (const rootPath of installScanRoots) {
    for (const smarchRoot of await findSmarchRoots(rootPath)) {
      const importsDoc = await maybeReadJson(path.join(smarchRoot, "imports.json"));
      const buildLockDoc = await maybeReadJson(path.join(smarchRoot, "build-lock.json"));
      const placementsDoc = await maybeReadJson(path.join(smarchRoot, "placements.json"));
      const journalRecords = await readJsonLines(path.join(smarchRoot, "update-journal.jsonl"));
      const imports = toArray(importsDoc?.imports);
      const selectedBuilds = toArray(buildLockDoc?.selected_builds);
      const resolvedBricks = toArray(buildLockDoc?.resolved_bricks);
      const placements = toArray(placementsDoc?.placements);
      const targetRoot = path.dirname(smarchRoot);
      const latestEvent = [...journalRecords]
        .sort((left, right) => (right.created_at ?? "").localeCompare((left.created_at ?? "")))
        .at(0) ?? null;

      targets.push({
        target_root: relativeFromWorkspace(targetRoot),
        imports_count: imports.length,
        selected_build_count: selectedBuilds.length,
        resolved_brick_count: resolvedBricks.length,
        placement_count: placements.length,
        update_event_count: journalRecords.length,
        latest_event_at: latestEvent?.created_at ?? null,
        latest_event_type: latestEvent?.event_type ?? null,
        build_ids: uniqStrings(selectedBuilds.map((entry) => entry.artifact_id)).slice(0, 8),
        import_statuses: uniqStrings(imports.map((entry) => entry.status)).sort(),
        registry_snapshot_sha: (buildLockDoc?.lock?.registry_snapshot_sha ?? placementsDoc?.map?.registry_snapshot_sha) ?? null
      });
    }
  }

  const totalTargets = targets.length;
  return {
    scan_roots: installScanRoots.map((rootPath) => relativeFromWorkspace(rootPath)),
    target_count: totalTargets,
    import_count: targets.reduce((sum, entry) => sum + (entry.imports_count ?? 0), 0),
    selected_build_count: targets.reduce((sum, entry) => sum + (entry.selected_build_count ?? 0), 0),
    resolved_brick_count: targets.reduce((sum, entry) => sum + (entry.resolved_brick_count ?? 0), 0),
    placement_count: targets.reduce((sum, entry) => sum + (entry.placement_count ?? 0), 0),
    update_event_count: targets.reduce((sum, entry) => sum + (entry.update_event_count ?? 0), 0),
    latest_event_at: targets.map((entry) => entry.latest_event_at).filter(Boolean).sort().slice(-1)[0] ?? null,
    targets: targets.slice(0, 12)
  };
}

function summarizeCanonicalizationTargets(targets: StateRecord[], limit = 6): StateRecord[] {
  return (targets).slice(0, limit).map((target) => ({
    rank: target.rank,
    target_type: target.target_type,
    project: target.project,
    target_id: target.target_id,
    name: target.name,
    priority_score: target.priority_score,
    promotion_stage: target.promotion_stage,
    confidence_label: target.confidence_label,
    blocker_reasons: target.blocker_reasons ?? [],
    blocker_summary: target.blocker_summary ?? {},
    evidence_summary: target.evidence_summary ?? {}
  }));
}

function projectRemediationRows(remediationReport: StateRecord, projectId: string | undefined, key: string, limit = 6): StateRecord[] {
  return toArray(remediationReport[key])
    .filter((entry) => (entry.project ?? "") === (projectId ?? ""))
    .slice(0, limit);
}

function summarizeProjects(
  projects: StateRecord[],
  canonicalizationProjects = new Map<string, StateRecord>(),
  portfolioProjects: Awaited<ReturnType<typeof discoverPortfolioProjects>> = [],
  remediationReport: StateRecord = {},
  registryProjects = new Map<string, StateRecord>(),
): StateRecord[] {
  const portfolioIds = new Set(portfolioProjects.map((entry) => entry.id));
  return sortByPortfolioPriority(
    (projects).filter((entry) => portfolioIds.has((entry.project ?? ""))),
    portfolioProjects,
    (entry) => entry.project ?? "",
  // eslint-disable-next-line complexity -- State builders are ordered compatibility serializers; centralized field precedence preserves stable snapshots.
  ).map((entry) => {
    const projectId = entry.project ?? "";
    const scanner = registryProjects.get(projectId)?.scanner ?? {};
    const canonicalProject = canonicalizationProjects.get(projectId);
    return {
      project: projectId,
      readiness: pick(entry.readiness ?? {}, ["score", "grade", "label"]),
      compliance: pick(entry.compliance_report ?? {}, ["score", "grade", "trackable_brick_count"]),
      code_quality_report: entry.code_quality_report ?? null,
      build_report: pick(entry.build_report ?? {}, ["candidate_count", "detected_brick_count", "average_confidence_score", "recurrent_candidate_count"]),
      canonicalization: canonicalProject
        ? {
          project_canonicalization_ready: canonicalProject.project_canonicalization_ready,
          bottleneck_stage: canonicalProject.bottleneck_stage,
          top_targets: summarizeCanonicalizationTargets(canonicalProject.top_targets ?? [], 3)
        }
        : null,
      clone_preflight: entry.clone_preflight ?? null,
      env_contract_report: entry.env_contract_report ?? null,
      boundary_report: entry.boundary_report ?? null,
      manifest_drift: entry.manifest_drift ?? null,
      remediation_counts: scanner.remediation_report?.counts ?? {},
      top_actions: projectRemediationRows(remediationReport, projectId, "top_actions"),
      quality_queue: projectRemediationRows(remediationReport, projectId, "quality_queue"),
    };
  });
}

function summarizeBuildCandidates(buildReport: StateRecord, limit = 6): StateRecord[] {
  const rows = Array.isArray(buildReport.top_candidates) ? buildReport.top_candidates : [];

  return rows.slice(0, limit).map((entry) => ({
    candidate_key: entry.candidate_key,
    recurrence_key: entry.recurrence_key,
    project: entry.project,
    name: entry.name,
    confidence_score: entry.confidence_score,
    confidence_label: entry.confidence_label,
    brick_count: entry.brick_count,
    recurrent_project_count: entry.recurrent_project_count,
    dominant_feature_cluster: entry.dominant_feature_cluster,
    dominant_domain: entry.dominant_domain,
    detection_sources: entry.detection_sources ?? [],
    sample_paths: (entry.sample_paths ?? []).slice(0, 4),
    why: entry.why
  }));
}

// eslint-disable-next-line max-lines-per-function, complexity -- State builders are ordered compatibility serializers; centralized field precedence preserves stable snapshots.
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const registry = await readJson<StateRecord>(options.registry);
  const portfolioProjects = await discoverPortfolioProjects();
  const gen3Projects = [
    ...portfolioProjects.map((entry) => ({ id: entry.id, absoluteRoot: entry.absolute_root })),
    { id: "sma", absoluteRoot: repoRoot },
  ];
  const scannedProjectIds = new Set((registry.projects ?? []).map((entry) => ((entry.id ?? entry.project) ?? "")));
  const scannerReport = registry.scanner_report ?? {};
  const readiness = scannerReport.readiness ?? {};
  const compliance = scannerReport.compliance_report ?? {};
  const buildReport = scannerReport.build_report ?? {};
  const remediation = scannerReport.remediation_report ?? {};
  const canonicalization: StateRecord = scannerReport.canonicalization_report?.projects?.length
    ? scannerReport.canonicalization_report
    : buildCanonicalizationReport(registry as unknown as Parameters<typeof buildCanonicalizationReport>[0]) as unknown as StateRecord;
  const refactor = registry.refactor_report ?? {};
  const compactCardCount = await maybeCountJsonl(path.resolve(repoRoot, "security/brick_cards.jsonl"));
  const releaseIndex = await maybeReadJson(releaseIndexPath);
  const buildIndex = await maybeReadJson(options.buildIndex);
  const buildPromotion = await maybeReadJson(buildPromotionPath);
  const publishIndex = await maybeReadJson(publishIndexPath);
  let curatedBuilds = await collectCuratedBuilds(releaseIndex, buildIndex, options.buildIndex);
  curatedBuilds = attachCuratedBuildAuxTruth(curatedBuilds, buildPromotion, publishIndex);
  const curatedBuildLookup = new Map<string, StateRecord>(
    (curatedBuilds.curated_builds ?? [])
      .filter((entry): entry is StateRecord & { artifact_id: string } => Boolean(entry.artifact_id))
      .map((entry) => [entry.artifact_id, entry]),
  );
  const releasePlane = buildReleaseSummary(releaseIndex, curatedBuildLookup);
  const promotionPlane = summarizePromotionPlane(buildPromotion);
  const publishPlane = summarizePublishPlane(publishIndex);
  const installPlane = await collectInstallEvidence();
  const canonicalizationProjects = new Map<string, StateRecord>(
    (canonicalization.projects ?? [])
      .filter((entry): entry is StateRecord & { project: string } => Boolean(entry.project))
      .map((entry) => [entry.project, entry]),
  );
  const registryProjects = new Map<string, StateRecord>((registry.projects ?? []).map((entry) => [((entry.id ?? entry.project) ?? ""), entry]));

  const snapshot = {
    generated_at: new Date().toISOString(),
    registry_path: relativeFromWorkspace(options.registry),
    totals: {
      brick_count: registry.count ?? (registry.bricks ?? []).length,
      project_count: Array.isArray(registry.projects) ? registry.projects.length : 0,
      unmanifested_count: registry.unmanifested_count ?? 0,
      validation_error_count: registry.validation_error_count ?? 0,
      validation_warning_count: registry.validation_warning_count ?? 0,
      status_counts: registryStatusCounts(registry.bricks ?? [])
    },
    portfolio: {
      root: relativeFromWorkspace(portfolioProjectsRoot),
      total_project_count: portfolioProjects.length,
      scanned_project_count: portfolioProjects.filter((entry) => scannedProjectIds.has(entry.id)).length,
      unscanned_project_count: portfolioProjects.filter((entry) => !scannedProjectIds.has(entry.id)).length,
      priority_project_ids: priorityProjectIds,
      projects: portfolioProjects.map((entry) => ({
        id: entry.id,
        name: entry.name,
        relative_root: entry.relative_root,
        priority_rank: entry.priority_rank,
        priority_tier: entry.priority_tier,
        scanned: scannedProjectIds.has(entry.id),
      })),
    },
    trust: {
      readiness: pick(readiness, ["average_score", "average_grade"]),
      compliance: pick(compliance, ["average_score", "average_grade", "trackable_brick_count"]),
      build_report: pick(buildReport, [
        "candidate_count",
        "detected_brick_count",
        "average_confidence_score",
        "recurrent_candidate_count",
        "recurrent_family_count",
        "signal_type_counts"
      ]),
      code_quality_report: {
        ...pick(scannerReport.code_quality_report ?? {}, [
          "average_score",
          "average_grade",
          "analyzed_code_file_count",
          "hotspot_file_count",
          "brick_hotspot_count",
          "duplicate_cluster_count",
          "total_smell_count",
          "weighted_smell_score",
          "by_type"
        ]),
        top_hotspots: toArray(scannerReport.code_quality_report?.top_hotspots).slice(0, 12),
        highest_risk_bricks: toArray(scannerReport.code_quality_report?.highest_risk_bricks).slice(0, 12),
        duplicate_groups: toArray(scannerReport.code_quality_report?.duplicate_groups).slice(0, 12)
      },
      build_candidates: summarizeBuildCandidates(buildReport),
      canonicalization: {
        project_canonicalization_ready: canonicalization.project_canonicalization_ready,
        bottleneck_mode: canonicalization.bottleneck_mode,
        reasons: canonicalization.reasons ?? [],
        counts: canonicalization.counts ?? {},
        top_targets: summarizeCanonicalizationTargets(canonicalization.top_targets ?? [], 8)
      },
      remediation_counts: remediation.counts ?? {},
      quality_queue: toArray(remediation.quality_queue).slice(0, 12),
      boundary_report: scannerReport.boundary_report ?? {},
      env_contract_report: scannerReport.env_contract_report ?? {},
      clone_preflight: scannerReport.clone_preflight ?? {}
    },
    refactor: pick(refactor, [
      "analyzed_file_count",
      "oversized_file_count",
      "split_opportunity_count",
      "missing_source_path_count",
      "analysis_failure_count",
      "severity_counts",
      "refactor_queue_count"
    ]),
    retrieval: {
      compact_card_count: compactCardCount
    },
    build_plane: curatedBuilds,
    promotion_plane: promotionPlane,
    publish_plane: publishPlane,
    release_plane: releasePlane,
    install_plane: installPlane,
    gen3: collectGlobalGen3({
      projects: gen3Projects
    }),
    projects: summarizeProjects(readiness.projects ?? [], canonicalizationProjects, portfolioProjects, remediation, registryProjects)
  };

  const writeResult = await writeJsonIfMeaningfulChanged(options.out, snapshot as unknown as Parameters<typeof normalizeSmaStateSnapshot>[0], {
    normalize: normalizeSmaStateSnapshot,
  });
  console.log(JSON.stringify({ ok: true, out: options.out, written: writeResult.written }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

function legacyString(value: unknown): string {
  return String(value);
}
