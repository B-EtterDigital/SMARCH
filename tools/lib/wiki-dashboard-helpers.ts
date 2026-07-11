import fs from "node:fs/promises";

import path from "node:path";

import { escapeHtml } from "./wiki-utils.ts";
import type { LooseRecord } from "./wiki-utils.ts";

export type RegistryProject = { id: string; root: string; security_gate?: { status?: string; high_or_critical?: number }; error_count?: number; warning_count?: number; health_counts?: Record<string, number>; brick_count?: number };
type ProjectMeta = { sma?: { security_gate?: { status?: string; high_or_critical?: number } } };
type ReadinessMetrics = { blocked_clone_count?: number; drift_count?: number; boundary_violation_count?: number; same_group_coupling_count?: number; env_gap_count?: number; compliance_score?: number; unmanifested_count?: number };
type ComplianceDimension = { label?: string; coverage_rate?: number; coverage_units?: number; ready_count?: number; total_count?: number };
type ComplianceReport = { score?: number; grade?: string; trackable_brick_count?: number; weakest_dimensions?: ComplianceDimension[]; dimensions?: Record<string, ComplianceDimension>; highest_gap_bricks?: GapEntry[] };
type ReadinessProject = { project?: string; readiness?: { score?: number; grade?: string; label?: string; reasons?: string[]; metrics?: ReadinessMetrics }; compliance_report?: ComplianceReport };
export type QueueEntry = { severity?: string; rank?: number; project?: string; path?: string; first_action?: string; strategy?: string; theme?: string; lines?: number; expected_slices?: number };
type BoundaryEntry = { kind?: string; project?: string; file?: string; path?: string; specifier?: string; target?: string };
type RiskEntry = { project?: string; name?: string; brick_id?: string; path?: string; effective_status?: string; blocker_codes?: string[]; warning_codes?: string[]; raw_source_tokens?: number };
type GapEntry = RiskEntry & { undeclared_env_refs?: string[]; missing_dimensions?: string[] };
type BuildCandidate = { project?: string; name?: string; candidate_key?: string; recurrence_key?: string; dominant_feature_cluster?: string; dominant_domain?: string; dominant_path_root?: string; dominant_group?: string; confidence_score?: number; confidence_label?: string; brick_count?: number; recurrent_project_count?: number; detection_sources?: string[]; why?: string; sample_paths?: string[] };
type Finding = { rule_id?: string; code?: string; summary?: string; message?: string };
type CuratedBuild = { source_project?: string; name?: string; artifact_id?: string; version?: string; required_brick_ref_count?: number; brick_ref_count?: number; promotion_desired_status?: string; suggested_build_status?: string; status?: string; update_ready?: boolean; release_count?: number; latest_channel?: string; latest_release_status?: string; verification_top_blockers?: Finding[]; private_publish_top_blockers?: Finding[]; promotion_blockers?: Finding[]; private_publish_status?: string; promotion_priority?: string; readiness_score?: number; publishability_score?: number; publish_ready?: boolean };
type ReleaseArtifact = { source_projects?: string[]; artifact_id?: string; latest_release?: { path?: string; version?: string; channel?: string; status?: string; trust_summary?: { trust_level?: string; verification_status?: string; check_counts?: { total?: number } } } };
type PublishBundle = { publish_safe?: boolean; decision?: { status?: string; counts?: { blocker?: number } }; top_blockers?: Finding[]; top_warnings?: Finding[]; artifact?: { type?: string; original_id?: string; community_id?: string }; bundle_path?: string; publishing_visibility?: string };
type InstallTarget = { target_root?: string; selected_build_count?: number; build_ids?: string[]; resolved_brick_count?: number; imports_count?: number; placement_count?: number; update_event_count?: number };
export type ActionEntry = { project?: string; category?: string; name?: string; brick_id?: string; brick_name?: string; path?: string; first_action?: string; why?: string; priority_score?: number; total_matches?: number; smell_score?: number; top_types?: Array<{ label?: string; key?: string; count?: number }> };
type QualityProject = { project?: string; code_quality_report?: { hotspot_file_count?: number; score?: number; grade?: string; total_smell_count?: number; duplicate_cluster_count?: number }; remediation_counts?: { quality?: number }; canonicalization?: { top_targets?: CanonicalTarget[]; bottleneck_stage?: string } };
type DuplicateCluster = { stem?: string; count: number; projects: string[]; bricks: Array<{ project: string; name?: string; id?: string }> };
type TokenEntry = { project?: string; name?: string; brick_id?: string; path?: string; raw_source_tokens?: number; summary_tokens?: number; estimated_summary_tokens?: number; estimated_savings_tokens?: number; file_count?: number };
type CanonicalTarget = { project?: string; target_type?: string; name?: string; target_id?: string; priority_score?: number; promotion_stage?: string; confidence_label?: string; blocker_reasons?: string[]; evidence_summary?: { brick_count?: number; duplicate_count?: number; why?: string }; blocker_summary?: Record<string, number> };
export type CanonicalizationView = { top_targets?: CanonicalTarget[]; reasons?: Array<{ code?: string; message?: string; current?: number; threshold?: number }>; counts?: { build_target_count?: number; brick_target_count?: number; ready_project_count?: number; project_work_bottleneck_count?: number; artifact_promotion_bottleneck_count?: number; project_count?: number }; project_canonicalization_ready?: boolean };
type QualityReportView = { average_score?: number; score?: number; average_grade?: string; grade?: string; hotspot_file_count?: number; total_smell_count?: number; duplicate_cluster_count?: number };
type PublishSummary = { bundle_count?: number; publish_safe_count?: number; blocked_count?: number; finding_count?: number };
export type StateSnapshot = { build_plane?: { curated_builds?: CuratedBuild[]; released_curated_build_count?: number; curated_manifest_count?: number; verification_ready_count?: number; publish_ready_count?: number; update_ready_build_count?: number; average_publishability_score?: number; promotion_ready_count?: number; installable_build_count?: number; rollback_supported_build_count?: number; candidate_or_better_verification_count?: number; private_publish_bundle_count?: number; private_publish_safe_count?: number }; release_plane?: { top_build_releases?: ReleaseArtifact[]; summary?: { build?: { artifact_count?: number; published_artifact_count?: number; channels?: Record<string, number>; stable_or_lts_artifact_count?: number }; release_count?: number } }; publish_plane?: { bundles?: PublishBundle[]; summary?: PublishSummary }; install_plane?: { targets?: InstallTarget[]; target_count?: number; update_event_count?: number; selected_build_count?: number; resolved_brick_count?: number; import_count?: number; placement_count?: number; latest_event_at?: string; scan_roots?: string[] }; projects?: QualityProject[]; trust?: { build_candidates?: BuildCandidate[]; canonicalization?: CanonicalizationView; quality_queue?: ActionEntry[]; code_quality_report?: QualityReportView; readiness?: { average_score?: number; average_grade?: string }; compliance?: { average_score?: number; average_grade?: string }; remediation_counts?: { env_contract?: number; rls_contract?: number; boundary?: number; quality?: number } }; totals?: PortfolioTotals; promotion_plane?: { summary?: { auto_promotable_count?: number; build_count?: number } } };
export type ScannerView = { readiness?: { projects?: ReadinessProject[]; average_score?: number; average_grade?: string }; boundary_report?: { top_violations?: BoundaryEntry[]; private_cross_brick_import_count?: number; cross_brick_owned_import_count?: number; same_group_internal_import_count?: number; unresolved_local_import_count?: number }; clone_preflight?: { highest_risk_bricks?: RiskEntry[]; counts?: Record<string, number> }; env_contract_report?: { highest_gap_bricks?: GapEntry[]; bricks_with_undeclared_refs?: number; undeclared_reference_count?: number; ignored_reference_count?: number }; compliance_report?: ComplianceReport & { average_score?: number; average_grade?: string }; build_report?: { top_candidates?: BuildCandidate[]; candidate_signatures?: BuildCandidate[]; average_confidence_score?: number; candidate_count?: number; recurrent_family_count?: number; recurrent_candidate_count?: number; detected_brick_count?: number }; remediation_report?: { top_actions?: ActionEntry[]; project_action_plans?: Array<{ project?: string; actions?: ActionEntry[] }>; quality_queue?: ActionEntry[]; counts?: { env_contract?: number; rls_contract?: number; boundary?: number; quality?: number } }; duplicate_clusters?: DuplicateCluster[]; token_economics?: { top_token_heavy_bricks?: TokenEntry[]; raw_source_tokens?: number; estimated_summary_tokens?: number }; canonicalization?: CanonicalizationView; code_quality_report?: QualityReportView; manifest_drift?: { count?: number } };
type CapabilityFamily = { key: string; label: string; feature: string; domain: string; projects: Set<string>; occurrence_count: number; total_brick_count: number; max_confidence_score: number; confidence_total: number; detection_sources: Set<string>; examples: Array<{ name: string; project: string; brick_count: number; confidence_score: number; why: string; path: string }> };
type PortfolioTotals = { project_count?: number; brick_count?: number; status_counts?: Record<string, number> };
type SurfaceMetric = { label: string; value: unknown; note?: string };



export async function projectMetadata(projects: RegistryProject[]): Promise<Map<string, ProjectMeta>> {
  const byId = new Map<string, ProjectMeta>();

  for (const project of projects) {
    if (!project.root) {
      continue;
    }

    const metaPath = path.join(project.root, ".sweetspot", "project.json");

    try {
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
      byId.set(project.id, meta);
    } catch {
      // Project metadata is optional for external registries.
    }
  }

  return byId;
}

export function projectStatus(project: RegistryProject, meta?: ProjectMeta): string {
  const securityGate = meta?.sma?.security_gate || project.security_gate;

  if (securityGate?.status === "blocked") {
    return "security_blocked";
  }

  if ((project.error_count || 0) > 0 || (project.health_counts?.fail || 0) > 0) {
    return "validation_blocked";
  }

  if ((project.warning_count || 0) > 0 || (project.health_counts?.warn || 0) > 0) {
    return "indexed_with_warnings";
  }

  if ((project.brick_count || 0) > 0) {
    return "indexed_clean";
  }

  return "not_indexed";
}

export function projectTone(status: string): string {
  if (status.includes("blocked")) return "danger";
  if (status.includes("warnings")) return "review";
  if (status === "indexed_clean") return "ready";
  return "steady";
}

export function scoreTone(score: number): string {
  if (score >= 85) return "ready";
  if (score >= 70) return "review";
  return "danger";
}

export function formatNumber(value: unknown): string {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

export function toArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

export function formatCoverageUnits(value: unknown): string {
  const numeric = Number(value || 0);

  if (Number.isInteger(numeric)) {
    return formatNumber(numeric);
  }

  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1
  }).format(numeric);
}

export function scannerReadinessCards(scanner: ScannerView | null | undefined): string {
  const projects = scanner?.readiness?.projects || [];

  return projects.map((entry) => {
    const readiness = entry.readiness || {};
    const compliance = entry.compliance_report || {};
    const metrics = readiness.metrics || {};
    const tone = scoreTone(readiness.score || 0);
    const reasons = (readiness.reasons || []).slice(0, 3).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");

    return `      <article class="scanner-brick scanner-brick--${tone}">
        <div class="scanner-studs"><span></span><span></span><span></span><span></span></div>
        <div class="scanner-brick-head">
          <p>${escapeHtml(entry.project)}</p>
          <strong>${readiness.score || 0}<small>/${escapeHtml(readiness.grade || "F")}</small></strong>
        </div>
        <h3>${escapeHtml(readiness.label || "unknown")}</h3>
        <dl>
          <div><dt>Blocked clone</dt><dd>${metrics.blocked_clone_count || 0}</dd></div>
          <div><dt>Drift</dt><dd>${metrics.drift_count || 0}</dd></div>
          <div><dt>Boundary hits</dt><dd>${metrics.boundary_violation_count || 0}</dd></div>
          <div><dt>Coupling</dt><dd>${metrics.same_group_coupling_count || 0}</dd></div>
          <div><dt>Env gaps</dt><dd>${metrics.env_gap_count || 0}</dd></div>
          <div><dt>Compliance</dt><dd>${compliance.score || metrics.compliance_score || 0}/${escapeHtml(compliance.grade || "F")}</dd></div>
          <div><dt>Unmanifested</dt><dd>${metrics.unmanifested_count || 0}</dd></div>
        </dl>
        <ul>${reasons || "<li>No major penalties recorded.</li>"}</ul>
      </article>`;
  }).join("\n");
}

export function scannerQueueCards(queue: QueueEntry[] | null | undefined): string {
  return (queue || []).slice(0, 12).map((entry) => `      <article class="queue-card queue-card--${escapeHtml(entry.severity || "medium")}">
        <div class="queue-rank">#${entry.rank}</div>
        <p class="queue-project">${escapeHtml(entry.project)}</p>
        <h3>${escapeHtml(entry.path)}</h3>
        <p class="queue-copy">${escapeHtml(entry.first_action || entry.strategy || "Review this file and split by the listed seams.")}</p>
        <dl>
          <div><dt>Theme</dt><dd>${escapeHtml(entry.theme || "unknown")}</dd></div>
          <div><dt>Lines</dt><dd>${formatNumber(entry.lines)}</dd></div>
          <div><dt>Slices</dt><dd>${entry.expected_slices || 0}</dd></div>
          <div><dt>Severity</dt><dd>${escapeHtml(entry.severity || "unknown")}</dd></div>
        </dl>
      </article>`).join("\n");
}

export function boundaryRows(scanner: ScannerView | null | undefined): string {
  const rows = scanner?.boundary_report?.top_violations || [];

  return rows.slice(0, 18).map((entry) => `        <li>
          <strong>${escapeHtml(entry.kind || "violation")}</strong>
          <span>${escapeHtml(entry.project || "")}</span>
          <code>${escapeHtml(entry.file || entry.path || "")}</code>
          <em>${escapeHtml(entry.specifier || entry.target || "")}</em>
        </li>`).join("\n");
}

export function cloneRiskCards(scanner: ScannerView | null | undefined): string {
  const rows = scanner?.clone_preflight?.highest_risk_bricks || [];

  return rows.slice(0, 10).map((entry) => `      <article class="risk-card risk-card--${escapeHtml(entry.effective_status || "manual_review")}">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>${escapeHtml(entry.name || entry.brick_id || "brick")}</h3>
        <code>${escapeHtml(entry.path || "")}</code>
        <dl>
          <div><dt>Status</dt><dd>${escapeHtml(entry.effective_status || "unknown")}</dd></div>
          <div><dt>Blockers</dt><dd>${(entry.blocker_codes || []).length}</dd></div>
          <div><dt>Warnings</dt><dd>${(entry.warning_codes || []).length}</dd></div>
          <div><dt>Tokens</dt><dd>${formatNumber(entry.raw_source_tokens)}</dd></div>
        </dl>
      </article>`).join("\n");
}

export function envContractCards(scanner: ScannerView | null | undefined): string {
  const rows = scanner?.env_contract_report?.highest_gap_bricks || [];

  return rows.slice(0, 8).map((entry) => `      <article class="env-card env-card--${escapeHtml(entry.effective_status || "manual_review")}">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>${escapeHtml(entry.name || entry.brick_id || "brick")}</h3>
        <code>${escapeHtml(entry.path || "")}</code>
        <ul>${(entry.undeclared_env_refs || []).slice(0, 4).map((name) => `<li>${escapeHtml(name)}</li>`).join("")}</ul>
      </article>`).join("\n");
}

export function complianceProjectCards(scanner: ScannerView | null | undefined): string {
  const rows = scanner?.readiness?.projects || [];

  return rows.slice(0, 8).map((entry) => {
    const compliance = entry.compliance_report || {};
    const tone = scoreTone(compliance.score || 0);
    const weakest = (compliance.weakest_dimensions || []).slice(0, 2).map((dimension) => `${dimension.label} ${dimension.coverage_rate}%`).join(" · ");

    return `      <article class="gap-card gap-card--${tone}">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>${compliance.score || 0}<small>/${escapeHtml(compliance.grade || "F")}</small></h3>
        <code>${formatNumber(compliance.trackable_brick_count || 0)} trackable bricks</code>
        <p>${escapeHtml(weakest || "No active compliance gaps.")}</p>
      </article>`;
  }).join("\n");
}

export function complianceDimensionRows(scanner: ScannerView | null | undefined): string {
  const dimensions = (Object.entries(scanner?.compliance_report?.dimensions || {}) as Array<[string, LooseRecord]>)
    .filter(([, dimension]) => Number(dimension?.total_count || 0) > 0)
    .sort((a, b) => Number(a[1]?.coverage_rate || 0) - Number(b[1]?.coverage_rate || 0) || String(a[0]).localeCompare(String(b[0])));

  return dimensions.slice(0, 9).map(([, dimension]) => `        <li>
          <strong>${escapeHtml(dimension.label || "dimension")}</strong>
          <span>${formatCoverageUnits(dimension.coverage_units ?? dimension.ready_count)}/${formatNumber(dimension.total_count || 0)}</span>
          <div class="compliance-bar"><b style="width:${Math.max(6, Number(dimension.coverage_rate || 0))}%"></b></div>
          <em>${dimension.coverage_rate || 0}%</em>
        </li>`).join("\n");
}

export function complianceGapCards(scanner: ScannerView | null | undefined): string {
  const rows = scanner?.compliance_report?.highest_gap_bricks || [];

  return rows.slice(0, 10).map((entry) => `      <article class="gap-card gap-card--${escapeHtml(entry.effective_status || "manual_review")}">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>${escapeHtml(entry.name || entry.brick_id || "brick")}</h3>
        <code>${escapeHtml(entry.path || "")}</code>
        <ul>${(entry.missing_dimensions || []).slice(0, 4).map((dimension) => `<li>${escapeHtml(String(dimension).replaceAll("_", " "))}</li>`).join("")}</ul>
      </article>`).join("\n");
}

export function buildCandidateCards(scanner: ScannerView | null | undefined, limit = 8): string {
  const rows = scanner?.build_report?.top_candidates || [];

  return rows.slice(0, limit).map((entry) => {
    const tone = Number(entry.confidence_score || 0) >= 90 ? "ready" : Number(entry.confidence_score || 0) >= 75 ? "review" : "danger";
    const sources = (entry.detection_sources || []).slice(0, 4).join(" · ");
    const recurrence = Number(entry.recurrent_project_count || 0);

    return `      <article class="build-card build-card--${tone}">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>${escapeHtml(entry.name || entry.candidate_key || "build candidate")}</h3>
        <code>${escapeHtml(entry.dominant_feature_cluster || entry.dominant_domain || entry.recurrence_key || "mixed")}</code>
        <dl>
          <div><dt>Confidence</dt><dd>${entry.confidence_score || 0}/${escapeHtml(entry.confidence_label || "unknown")}</dd></div>
          <div><dt>Bricks</dt><dd>${formatNumber(entry.brick_count || 0)}</dd></div>
          <div><dt>Reuse</dt><dd>${formatNumber(recurrence)}</dd></div>
          <div><dt>Signals</dt><dd>${formatNumber((entry.detection_sources || []).length)}</dd></div>
        </dl>
        <p>${escapeHtml(entry.why || sources || "Grouped by repeated architectural signals.")}</p>
      </article>`;
  }).join("\n");
}

export function buildFamilyRows(scanner: ScannerView | null | undefined, limit = 10): string {
  const rows = scanner?.build_report?.candidate_signatures || [];

  return rows.slice(0, limit).map((entry) => `        <li>
          <strong>${escapeHtml(entry.recurrence_key || entry.dominant_feature_cluster || "build family")}</strong>
          <span>${escapeHtml(entry.project || "")}</span>
          <code>${escapeHtml(entry.dominant_domain || entry.dominant_path_root || entry.dominant_group || "mixed")}</code>
          <em>${formatNumber(entry.brick_count || 0)} bricks · ${escapeHtml((entry.detection_sources || []).join(" / ") || "signals")}</em>
        </li>`).join("\n");
}

export function releaseTone(trustLevel: unknown, verificationStatus: unknown): string {
  if (["high", "strong"].includes(String(trustLevel || "").toLowerCase()) || ["verified", "canonical"].includes(String(verificationStatus || "").toLowerCase())) return "ready";
  if (["medium"].includes(String(trustLevel || "").toLowerCase()) || ["candidate"].includes(String(verificationStatus || "").toLowerCase())) return "review";
  return "danger";
}

export function buildVerificationTone(entry: CuratedBuild | null | undefined): string {
  const suggested = String(entry?.suggested_build_status || "").toLowerCase();
  if (suggested === "canonical" || entry?.publish_ready) return "ready";
  if (suggested === "verified" || Number(entry?.readiness_score || 0) >= 75) return "review";
  return "danger";
}

export function curatedBuildCards(stateSnapshot: StateSnapshot | null | undefined, limit = 8): string {
  const rows = stateSnapshot?.build_plane?.curated_builds || [];

  return rows.slice(0, limit).map((entry) => {
    const tone = buildVerificationTone(entry);
    const releaseState = entry.release_count
      ? `${entry.latest_channel || "channel?"} · ${entry.latest_release_status || "status?"}`
      : "manifest only";
    const blocker = entry.verification_top_blockers?.[0] || entry.private_publish_top_blockers?.[0] || entry.promotion_blockers?.[0];
    const laneState = entry.private_publish_status
      ? `publish ${entry.private_publish_status}`
      : entry.promotion_priority
        ? `promotion ${entry.promotion_priority}`
        : "lane pending";
    const qualityLine = entry.readiness_score
      ? `readiness ${formatNumber(entry.readiness_score || 0)} · publish ${formatNumber(entry.publishability_score || 0)} · ${laneState}`
      : releaseState;

    return `      <article class="build-card build-card--${tone}">
        <p>${escapeHtml(entry.source_project || "unknown project")}</p>
        <h3>${escapeHtml(entry.name || entry.artifact_id || "curated build")}</h3>
        <code>${escapeHtml(entry.artifact_id || "")}</code>
        <dl>
          <div><dt>Version</dt><dd>${escapeHtml(entry.version || "0.0.0")}</dd></div>
          <div><dt>Bricks</dt><dd>${formatNumber(entry.required_brick_ref_count || entry.brick_ref_count || 0)}</dd></div>
          <div><dt>Status</dt><dd>${escapeHtml(entry.promotion_desired_status || entry.suggested_build_status || entry.status || "candidate")}</dd></div>
          <div><dt>Update</dt><dd>${entry.update_ready ? "ready" : "pending"}</dd></div>
        </dl>
        <p>${escapeHtml(`${qualityLine} · ${releaseState}`)}</p>
        ${blocker ? `<p>${escapeHtml(`${blocker.rule_id || blocker.code}: ${blocker.summary || blocker.message || "Finding recorded."}`)}</p>` : ""}
      </article>`;
  }).join("\n");
}

export function releaseArtifactCards(stateSnapshot: StateSnapshot | null | undefined, limit = 6): string {
  const rows = stateSnapshot?.release_plane?.top_build_releases || [];

  return rows.slice(0, limit).map((entry) => {
    const latest = entry.latest_release || {};
    const trust = latest.trust_summary || {};
    const tone = releaseTone(trust.trust_level, trust.verification_status);

    return `      <article class="build-card build-card--${tone}">
        <p>${escapeHtml((entry.source_projects || []).join(" · ") || "unknown project")}</p>
        <h3>${escapeHtml(entry.artifact_id || "release artifact")}</h3>
        <code>${escapeHtml(latest.path || "")}</code>
        <dl>
          <div><dt>Version</dt><dd>${escapeHtml(latest.version || "0.0.0")}</dd></div>
          <div><dt>Channel</dt><dd>${escapeHtml(latest.channel || "unknown")}</dd></div>
          <div><dt>Trust</dt><dd>${escapeHtml(trust.trust_level || "unknown")}</dd></div>
          <div><dt>Checks</dt><dd>${formatNumber(trust.check_counts?.total || 0)}</dd></div>
        </dl>
        <p>${escapeHtml(`${trust.verification_status || "unverified"} · ${latest.status || "draft"}`)}</p>
      </article>`;
  }).join("\n");
}

export function privatePublishCards(stateSnapshot: StateSnapshot | null | undefined, limit = 6): string {
  const rows = stateSnapshot?.publish_plane?.bundles || [];

  return rows.slice(0, limit).map((entry) => {
    const tone = entry.publish_safe ? "ready" : entry.decision?.status === "blocked" ? "danger" : "review";
    const blocker = entry.top_blockers?.[0] || entry.top_warnings?.[0];
    return `      <article class="build-card build-card--${tone}">
        <p>${escapeHtml(entry.artifact?.type || "artifact")}</p>
        <h3>${escapeHtml(entry.artifact?.original_id || entry.artifact?.community_id || "publish bundle")}</h3>
        <code>${escapeHtml(entry.bundle_path || "")}</code>
        <dl>
          <div><dt>Status</dt><dd>${escapeHtml(entry.decision?.status || "unknown")}</dd></div>
          <div><dt>Visibility</dt><dd>${escapeHtml(entry.publishing_visibility || "unknown")}</dd></div>
          <div><dt>Safe</dt><dd>${entry.publish_safe ? "yes" : "no"}</dd></div>
          <div><dt>Findings</dt><dd>${formatNumber(entry.decision?.counts?.blocker || 0)} blocker</dd></div>
        </dl>
        ${blocker ? `<p>${escapeHtml(`${blocker.rule_id || blocker.code}: ${blocker.summary || blocker.message || "Finding recorded."}`)}</p>` : ""}
      </article>`;
  }).join("\n");
}

export function installEvidenceCards(stateSnapshot: StateSnapshot | null | undefined): string {
  const rows = stateSnapshot?.install_plane?.targets || [];

  return rows.slice(0, 8).map((entry) => `      <article class="plan-card">
        <p>${escapeHtml(entry.target_root || "target")}</p>
        <h3>${formatNumber(entry.selected_build_count || 0)} build${entry.selected_build_count === 1 ? "" : "s"} installed</h3>
        <code>${escapeHtml((entry.build_ids || []).join(" · ") || "no selected builds recorded")}</code>
        <ul>
          <li>${formatNumber(entry.resolved_brick_count || 0)} resolved bricks</li>
          <li>${formatNumber(entry.imports_count || 0)} total imports</li>
          <li>${formatNumber(entry.placement_count || 0)} placements</li>
          <li>${formatNumber(entry.update_event_count || 0)} journal events</li>
        </ul>
      </article>`).join("\n");
}

export function remediationActionCards(scanner: ScannerView | null | undefined): string {
  const rows = scanner?.remediation_report?.top_actions || [];

  return rows.slice(0, 12).map((entry) => `      <article class="action-card action-card--${escapeHtml(entry.category || "boundary")}">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>${escapeHtml(entry.name || entry.brick_id || entry.path || "action")}</h3>
        <code>${escapeHtml(entry.path || "")}</code>
        <span class="action-tag">${escapeHtml(String(entry.category || "action").replaceAll("_", " "))}</span>
        <p>${escapeHtml(entry.first_action || entry.why || "Review this action.")}</p>
      </article>`).join("\n");
}

export function remediationProjectPlans(scanner: ScannerView | null | undefined): string {
  const rows = scanner?.remediation_report?.project_action_plans || [];

  return rows.slice(0, 6).map((entry) => `      <article class="plan-card">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>Top Moves</h3>
        <ul>${(entry.actions || []).map((action) => `<li>${escapeHtml(action.first_action || action.path || action.name || action.category || "action")}</li>`).join("")}</ul>
      </article>`).join("\n");
}

export function qualityQueueCards(rows: ActionEntry[] | null | undefined, limit = 8): string {
  return toArray(rows).slice(0, limit).map((entry) => `      <article class="plan-card">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>${escapeHtml(entry.path || entry.brick_name || entry.brick_id || "quality hotspot")}</h3>
        <code>${escapeHtml(entry.first_action || entry.why || "Review hotspot")}</code>
        <ul>
          <li>priority: ${formatNumber(entry.priority_score || 0)}</li>
          <li>smell hits: ${formatNumber(entry.total_matches || 0)}</li>
          <li>score: ${formatNumber(entry.smell_score || 0)}</li>
          <li>dominant: ${escapeHtml(toArray(entry.top_types).slice(0, 2).map((item) => `${item.label || item.key} x${formatNumber(item.count || 0)}`).join(" · ") || "none recorded")}</li>
        </ul>
      </article>`).join("\n");
}

export function qualityProjectCards(stateSnapshot: StateSnapshot | null | undefined, limit = 8): string {
  return toArray(stateSnapshot?.projects)
    .filter((entry) => Number(entry?.code_quality_report?.hotspot_file_count || 0) > 0)
    .sort((left, right) =>
      Number(left?.code_quality_report?.score || 100) - Number(right?.code_quality_report?.score || 100)
      || Number(right?.code_quality_report?.hotspot_file_count || 0) - Number(left?.code_quality_report?.hotspot_file_count || 0)
      || String(left?.project || "").localeCompare(String(right?.project || ""))
    )
    .slice(0, limit)
    .map((entry) => `      <article class="plan-card">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>${formatNumber(entry.code_quality_report?.score || 0)}/${escapeHtml(entry.code_quality_report?.grade || "A")} quality</h3>
        <ul>
          <li>hotspot files: ${formatNumber(entry.code_quality_report?.hotspot_file_count || 0)}</li>
          <li>smell hits: ${formatNumber(entry.code_quality_report?.total_smell_count || 0)}</li>
          <li>duplicate clusters: ${formatNumber(entry.code_quality_report?.duplicate_cluster_count || 0)}</li>
          <li>quality backlog: ${formatNumber(entry.remediation_counts?.quality || 0)}</li>
        </ul>
      </article>`).join("\n");
}

export function duplicateCards(scanner: ScannerView | null | undefined): string {
  const clusters = scanner?.duplicate_clusters || [];

  return clusters.slice(0, 10).map((cluster) => `      <article class="duplicate-card">
        <p>${escapeHtml(cluster.stem || "cluster")}</p>
        <h3>${cluster.count} overlap${cluster.count === 1 ? "" : "s"}</h3>
        <span>${cluster.projects.length} project${cluster.projects.length === 1 ? "" : "s"}</span>
        <ul>${cluster.bricks.slice(0, 4).map((brick) => `<li>${escapeHtml(brick.project)} · ${escapeHtml(brick.name || brick.id)}</li>`).join("")}</ul>
      </article>`).join("\n");
}

export function tokenCards(scanner: ScannerView | null | undefined): string {
  const rows = scanner?.token_economics?.top_token_heavy_bricks || [];

  return rows.slice(0, 8).map((entry) => {
    const raw = Number(entry.raw_source_tokens || 0);
    const summary = Number(entry.summary_tokens || entry.estimated_summary_tokens || 0);
    const ratio = raw ? Math.max(6, Math.round((summary / raw) * 100)) : 0;

    return `      <article class="token-card">
        <p>${escapeHtml(entry.project || "")}</p>
        <h3>${escapeHtml(entry.name || entry.brick_id || "brick")}</h3>
        <code>${escapeHtml(entry.path || "")}</code>
        <div class="token-bar"><b style="width:${ratio}%"></b></div>
        <dl>
          <div><dt>Raw</dt><dd>${formatNumber(raw)}</dd></div>
          <div><dt>Summary</dt><dd>${formatNumber(summary)}</dd></div>
          <div><dt>Savings</dt><dd>${formatNumber(entry.estimated_savings_tokens || Math.max(0, raw - summary))}</dd></div>
          <div><dt>Files</dt><dd>${entry.file_count || 0}</dd></div>
        </dl>
      </article>`;
  }).join("\n");
}

export function titleLabel(value: unknown): string {
  const text = String(value || "unknown")
    .replace(/::/g, " / ")
    .replace(/[._/]+/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "Unknown";

  return text.replace(/\b[a-z]/g, (match) => match.toUpperCase());
}

export function buildCandidateSource(stateSnapshot: StateSnapshot | null | undefined, scanner: ScannerView | null | undefined): BuildCandidate[] {
  const scannerRows = scanner?.build_report?.top_candidates || [];
  if (scannerRows.length > 0) {
    return scannerRows;
  }
  return stateSnapshot?.trust?.build_candidates || [];
}

export function canonicalizationState(stateSnapshot: StateSnapshot | null | undefined, scanner: ScannerView | null | undefined): CanonicalizationView {
  return stateSnapshot?.trust?.canonicalization || scanner?.canonicalization || {};
}

export function capabilityFamilies(stateSnapshot: StateSnapshot | null | undefined, scanner: ScannerView | null | undefined) {
  const families = new Map<string, CapabilityFamily>();

  for (const entry of buildCandidateSource(stateSnapshot, scanner)) {
    const key = entry.recurrence_key || [entry.dominant_feature_cluster, entry.dominant_domain].filter(Boolean).join("::") || entry.candidate_key || entry.name || "mixed";
    const current = families.get(key) || {
      key,
      label: titleLabel(key),
      feature: entry.dominant_feature_cluster || "mixed",
      domain: entry.dominant_domain || "mixed",
      projects: new Set(),
      occurrence_count: 0,
      total_brick_count: 0,
      max_confidence_score: 0,
      confidence_total: 0,
      detection_sources: new Set(),
      examples: []
    };

    current.projects.add(entry.project || "unknown");
    current.occurrence_count += 1;
    current.total_brick_count += Number(entry.brick_count || 0);
    current.max_confidence_score = Math.max(current.max_confidence_score, Number(entry.confidence_score || 0));
    current.confidence_total += Number(entry.confidence_score || 0);
    for (const source of entry.detection_sources || []) {
      current.detection_sources.add(source);
    }
    if (current.examples.length < 4) {
      current.examples.push({
        name: entry.name || entry.candidate_key || "build candidate",
        project: entry.project || "unknown",
        brick_count: Number(entry.brick_count || 0),
        confidence_score: Number(entry.confidence_score || 0),
        why: entry.why || "",
        path: (entry.sample_paths || [])[0] || ""
      });
    }

    families.set(key, current);
  }

  return [...families.values()]
    .map((entry) => ({
      ...entry,
      project_count: entry.projects.size,
      average_confidence_score: entry.occurrence_count ? Math.round(entry.confidence_total / entry.occurrence_count) : 0,
      projects: [...entry.projects].sort(),
      detection_sources: [...entry.detection_sources]
    }))
    .sort((a, b) => b.project_count - a.project_count || b.occurrence_count - a.occurrence_count || b.max_confidence_score - a.max_confidence_score || a.label.localeCompare(b.label));
}

export function topSummaryItems(summary: Record<string, number> | null | undefined, limit = 3): Array<[string, number]> {
  return Object.entries(summary || {})
    .filter(([, value]) => Number(value || 0) > 0)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0) || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit);
}

export function canonicalTargetTone(entry: CanonicalTarget | null | undefined): string {
  if (entry?.promotion_stage === "promote_now" && !(entry?.blocker_reasons || []).includes("contains_project_bound_members")) {
    return "ready";
  }
  if (entry?.promotion_stage === "stabilize_then_promote" || Number(entry?.priority_score || 0) >= 150) {
    return "review";
  }
  return "danger";
}

export function capabilityFamilyCards(stateSnapshot: StateSnapshot | null | undefined, scanner: ScannerView | null | undefined, limit = 12): string {
  return capabilityFamilies(stateSnapshot, scanner).slice(0, limit).map((entry) => {
    const tone = entry.max_confidence_score >= 90 ? "ready" : entry.max_confidence_score >= 75 ? "review" : "danger";
    const examples = entry.examples.slice(0, 3).map((example) => `<li>${escapeHtml(example.project)} · ${escapeHtml(example.name)} · ${formatNumber(example.brick_count)} bricks</li>`).join("");

    return `      <article class="build-card build-card--${tone}">
        <p>${escapeHtml(entry.feature || "mixed")} / ${escapeHtml(entry.domain || "mixed")}</p>
        <h3>${escapeHtml(entry.label)}</h3>
        <code>${escapeHtml(entry.key)}</code>
        <dl>
          <div><dt>Projects</dt><dd>${formatNumber(entry.project_count)}</dd></div>
          <div><dt>Occurrences</dt><dd>${formatNumber(entry.occurrence_count)}</dd></div>
          <div><dt>Bricks</dt><dd>${formatNumber(entry.total_brick_count)}</dd></div>
          <div><dt>Confidence</dt><dd>${entry.average_confidence_score}/100</dd></div>
        </dl>
        <ul>${examples || "<li>No concrete build examples recorded.</li>"}</ul>
      </article>`;
  }).join("\n");
}

export function canonicalTargetCards(stateSnapshot: StateSnapshot | null | undefined, scanner: ScannerView | null | undefined, limit = 12): string {
  const rows = canonicalizationState(stateSnapshot, scanner).top_targets || [];

  return rows.slice(0, limit).map((entry) => {
    const tone = canonicalTargetTone(entry);
    const blockers = (entry.blocker_reasons || []).slice(0, 4).map((reason) => `<li>${escapeHtml(titleLabel(reason))}</li>`).join("");
    const evidence = entry.evidence_summary || {};
    const blockerSummary = topSummaryItems(entry.blocker_summary, 3).map(([key, value]) => `${titleLabel(key)}: ${formatNumber(value)}`).join(" · ");

    return `      <article class="build-card build-card--${tone}">
        <p>${escapeHtml(entry.project || "unknown")} · ${escapeHtml(entry.target_type || "target")}</p>
        <h3>${escapeHtml(entry.name || entry.target_id || "canonicalization target")}</h3>
        <code>${escapeHtml(entry.target_id || "")}</code>
        <dl>
          <div><dt>Priority</dt><dd>${formatNumber(entry.priority_score || 0)}</dd></div>
          <div><dt>Stage</dt><dd>${escapeHtml(entry.promotion_stage || "unknown")}</dd></div>
          <div><dt>Confidence</dt><dd>${escapeHtml(entry.confidence_label || "unknown")}</dd></div>
          <div><dt>Evidence</dt><dd>${formatNumber(evidence.brick_count || evidence.duplicate_count || 0)}</dd></div>
        </dl>
        <p>${escapeHtml(evidence.why || blockerSummary || "Target generated from overlap, build recurrence, and promotion pressure.")}</p>
        <ul>${blockers || "<li>No explicit blocker reasons recorded.</li>"}</ul>
      </article>`;
  }).join("\n");
}

export function projectCanonicalizationCards(stateSnapshot: StateSnapshot | null | undefined, limit = 6): string {
  const rows = stateSnapshot?.projects || [];

  return rows
    .filter((entry) => (entry.canonicalization?.top_targets || []).length > 0)
    .slice(0, limit)
    .map((entry) => {
      const targets = (entry.canonicalization?.top_targets || []).slice(0, 3).map((target) => `<li>${escapeHtml(target.name || target.target_id || "target")} · ${escapeHtml(target.promotion_stage || "unknown")}</li>`).join("");

      return `      <article class="plan-card">
        <p>${escapeHtml(entry.project || "unknown")}</p>
        <h3>${escapeHtml(entry.canonicalization?.bottleneck_stage || "canonicalization backlog")}</h3>
        <code>${formatNumber((entry.canonicalization?.top_targets || []).length)} target${(entry.canonicalization?.top_targets || []).length === 1 ? "" : "s"} in focus</code>
        <ul>${targets || "<li>No project-level targets queued.</li>"}</ul>
      </article>`;
    }).join("\n");
}

export function canonicalizationReasonList(stateSnapshot: StateSnapshot | null | undefined, scanner: ScannerView | null | undefined): string {
  const reasons = canonicalizationState(stateSnapshot, scanner).reasons || [];

  return reasons.slice(0, 8).map((reason) => `        <li>
          <strong>${escapeHtml(titleLabel(reason.code || "reason"))}</strong>
          <span>${escapeHtml(reason.message || "No explanation recorded.")}</span>
          <em>${formatNumber(reason.current || 0)} now · ${formatNumber(reason.threshold || 0)} threshold</em>
        </li>`).join("\n");
}

export function proofSurfaceCards(stateSnapshot: StateSnapshot | null | undefined, scanner: ScannerView | null | undefined, totals: PortfolioTotals, projectCount: number): string {
  const buildPlane = stateSnapshot?.build_plane || {};
  const releasePlane = stateSnapshot?.release_plane || {};
  const releaseSummary = releasePlane.summary || {};
  const buildSummary = releaseSummary.build || {};
  const installPlane = stateSnapshot?.install_plane || {};
  const canonicalization = canonicalizationState(stateSnapshot, scanner);
  const tokenEconomics = scanner?.token_economics || {};
  const tokenReduction = tokenEconomics.raw_source_tokens
    ? Math.round(((tokenEconomics.raw_source_tokens - (tokenEconomics.estimated_summary_tokens || 0)) / tokenEconomics.raw_source_tokens) * 100)
    : 0;

  const cards = [
    {
      tone: "ready",
      label: "Portfolio Proof",
      title: `${formatNumber(totals.brick_count || 0)} indexed bricks across ${formatNumber(projectCount)} projects`,
      copy: `${formatNumber(totals.status_counts?.candidate || 0)} candidate bricks and ${formatNumber(totals.status_counts?.canonical || 0)} canonical bricks already exist in the registry.`,
      link: "PROOF.generated.html",
      action: "Open proof surface"
    },
    {
      tone: Number(scanner?.build_report?.average_confidence_score || 0) >= 80 ? "ready" : "review",
      label: "Build Registry",
      title: `${formatNumber(scanner?.build_report?.candidate_count || 0)} build candidates with ${formatNumber(scanner?.build_report?.recurrent_family_count || 0)} recurrent families`,
      copy: `${formatNumber(scanner?.build_report?.detected_brick_count || 0)} bricks already participate in mined multi-brick capabilities.`,
      link: "BUILD_REGISTRY.generated.html",
      action: "Open build registry"
    },
    {
      tone: Number(buildPlane.released_curated_build_count || 0) > 0 ? "review" : "danger",
      label: "Delivery Plane",
      title: `${formatNumber(buildPlane.curated_manifest_count || 0)} curated builds, ${formatNumber(buildSummary.artifact_count || 0)} build release artifacts`,
      copy: `${formatNumber(buildPlane.verification_ready_count || 0)} builds are verification-ready and ${formatNumber(buildPlane.publish_ready_count || 0)} are publish-ready.`,
      link: "CAPABILITIES.generated.html",
      action: "Open capability map"
    },
    {
      tone: Number(canonicalization.counts?.build_target_count || 0) > 0 || Number(canonicalization.counts?.brick_target_count || 0) > 0 ? "review" : "steady",
      label: "Canonicalization",
      title: `${formatNumber(canonicalization.counts?.build_target_count || 0)} build targets and ${formatNumber(canonicalization.counts?.brick_target_count || 0)} brick targets queued`,
      copy: `${formatNumber(installPlane.target_count || 0)} install target${installPlane.target_count === 1 ? "" : "s"} and ${formatNumber(tokenReduction)}% estimated token reduction show the next leverage layer.`,
      link: "CANONICALIZATION.generated.html",
      action: "Open target board"
    }
  ];

  return cards.map((card) => `      <article class="build-card build-card--${card.tone}">
        <p>${escapeHtml(card.label)}</p>
        <h3>${escapeHtml(card.title)}</h3>
        <p>${escapeHtml(card.copy)}</p>
        <a class="project-link" href="${card.link}">${escapeHtml(card.action)}</a>
      </article>`).join("\n");
}

export function surfaceNav(activeHref: string): string {
  const links = [
    { href: "DASHBOARD.generated.html", label: "Dashboard" },
    { href: "PROOF.generated.html", label: "Proof" },
    { href: "BUILD_REGISTRY.generated.html", label: "Build Registry" },
    { href: "CAPABILITIES.generated.html", label: "Capabilities" },
    { href: "CANONICALIZATION.generated.html", label: "Canonicalization" },
    { href: "BRICK_WALL.generated.html", label: "Brick Wall" },
    { href: "FEATURE_CLUSTERS.generated.html", label: "Feature Clusters" },
    { href: "BRICK_CATALOG.generated.md", label: "Catalog" },
    { href: "PROJECT_HEALTH.generated.md", label: "Project Health" },
    { href: "SMA_STATE.generated.json", label: "State JSON" }
  ];

  return `<nav class="nav" aria-label="Wiki navigation">
${links.map((link) => `      <a${link.href === activeHref ? ' class="active"' : ""} href="${link.href}">${escapeHtml(link.label)}</a>`).join("\n")}
    </nav>`;
}

export function surfaceMetricGrid(metrics: SurfaceMetric[]): string {
  return `<div class="metrics">
${metrics.map((metric) => `      <div class="metric">
        <span>${escapeHtml(metric.label)}</span>
        <strong>${escapeHtml(metric.value)}</strong>
        ${metric.note ? `<small>${escapeHtml(metric.note)}</small>` : ""}
      </div>`).join("\n")}
    </div>`;
}
