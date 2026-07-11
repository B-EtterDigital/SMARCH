#!/usr/bin/env node
/**
 * WHAT: Explains why a project, brick, or curated build is not ready.
 * WHY: Raw blocker codes do not tell operators which dependency or gate to fix next.
 * HOW: Reads state, registry, and handoff artifacts, then ranks matching blockers and actions.
 * OUTPUTS: Prints a human explanation or a structured report for one query.
 * CALLERS: Operators and command-line workflows use it for readiness triage.
 * USAGE: `node tools/sma-why-blocked.ts --project sma --json`
 * Glossary: [SMA](../docs/GLOSSARY.md).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_REGISTRY_PATH,
  DEFAULT_STATE_PATH,
  findProjectEntries,
  formatNumber,
  fuzzyMatchScore,
  loadStateAndRegistry,
  parseArgs,
  topList,
  uniqueBy
} from "./lib/adoption-utils.ts";
import { buildHandoffPaths } from "./lib/curated-build-utils.ts";

const HELP_TEXT = `Usage: node tools/sma-why-blocked.ts [options] <query>

Explain why a project, brick, or build is blocked or still not ready.

Options:
  --project <id>        Explain a project id.
  --brick <query>       Explain a brick id, name, or path fragment.
  --build <query>       Explain a curated build id/name or inferred build candidate.
  --state <path>        Override state snapshot path.
                        Default: ${DEFAULT_STATE_PATH}
  --registry <path>     Override merged registry path.
                        Default: ${DEFAULT_REGISTRY_PATH}
  --json                Print machine-readable JSON.
  --help                Show this help.
`;

const DEFAULT_BUILD_VERIFICATION_PATH = "security/build-verification.generated.json";

const REASON_LABELS = {
  project_clone_backlog: "clone preflight is still mostly blocked/manual",
  project_env_contract_backlog: "env contracts are still incomplete across the project",
  project_boundary_backlog: "boundary violations still dominate the project",
  contains_project_bound_members: "the build candidate still contains project-bound members",
  clone_blocker_count: "clone blockers still exist",
  env_reference_undeclared: "source code references env vars that the manifest does not declare",
  env_contract_incomplete: "the env contract is incomplete",
  rls_contract_incomplete: "the RLS contract is incomplete",
  cross_brick_owned_import: "the brick reaches into paths owned by other bricks",
  private_cross_brick_import: "the brick imports private sibling internals",
  unresolved_local_import: "the brick has unresolved local imports",
  unowned_local_dependency: "the brick depends on local code outside its owned/public surface",
  cross_group_dependency: "the brick leaks across its intended group boundary",
  file_over_600: "source files are oversized",
  code_budget_bloated: "the code budget is bloated for clean reuse",
  validation_warning: "manifest validation warnings still exist",
  unpublished_release: "no published release exists yet",
  draft_release: "the latest release is still draft",
  unverified_release: "the latest release is still unverified",
  candidate_release: "the latest release is only candidate-verified",
  "publishing.publishable": "the build is not marked publishable yet",
  "publishing.visibility": "the build is still private/internal only",
  "verification.evidence": "runtime verification evidence is still missing",
  "clone.readiness": "clone/install still requires manual review",
  "release.status": "the latest release is not published yet",
  not_marked_publishable: "the manifest explicitly marks this build as not publishable",
  private_license: "license metadata is private or missing",
  private_visibility: "build visibility is private, so community export is blocked",
  private_publish_blocked: "the local private publish bundle is blocked by leak-review findings",
  adapter_ports_required: "target-side adapter/port work is still required",
  project_quality_backlog: "code-quality hotspots are still concentrated in this project",
  quality_hotspot: "the file still carries concentrated code-quality smells",
  duplicate_code_cluster: "the file appears to be duplicated and should be deduplicated before promotion"
};

function fail(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function labelReason(code) {
  return REASON_LABELS[code] || String(code || "unknown").replace(/[._]/g, " ");
}

function mapBlockerCodeToAction(code) {
  switch (code) {
    case "project_clone_backlog":
      return "Reduce blocked/manual clone outcomes before promotion work.";
    case "project_env_contract_backlog":
    case "env_reference_undeclared":
    case "env_contract_incomplete":
      return "Declare observed env references and tighten the env contract.";
    case "project_boundary_backlog":
    case "cross_brick_owned_import":
    case "private_cross_brick_import":
    case "unresolved_local_import":
    case "unowned_local_dependency":
    case "cross_group_dependency":
      return "Fix boundary ownership and local import resolution first.";
    case "contains_project_bound_members":
      return "Extract or promote project-bound members before treating this as a reusable build.";
    case "rls_contract_incomplete":
      return "Add explicit RLS matrix coverage and negative tests.";
    case "file_over_600":
    case "code_budget_bloated":
      return "Split oversized files and reduce the code surface before reuse promotion.";
    case "unpublished_release":
    case "draft_release":
    case "unverified_release":
    case "candidate_release":
    case "release.status":
      return "Promote the release through verification/publishing before treating it as community-trustworthy.";
    case "publishing.publishable":
    case "not_marked_publishable":
    case "private_license":
    case "private_visibility":
      return "Mark the build publishable, set community-safe license/visibility metadata, and rerun verification.";
    case "private_publish_blocked":
      return "Review the local publish bundle blockers and remove leaked private paths, URLs, prompts, or customer-specific language.";
    case "verification.evidence":
      return "Add runtime verification evidence or smoke-test proof before promotion.";
    case "clone.readiness":
    case "adapter_ports_required":
      return "Reduce manual install/adaptation work so the build is actually operator-ready.";
    case "project_quality_backlog":
    case "quality_hotspot":
      return "Fix the dominant smell family at the public seam first, then shrink the hotspot before promotion.";
    case "duplicate_code_cluster":
      return "Delete the fork or extract a shared seam so you stop maintaining duplicate code.";
    default:
      return "Inspect the relevant scanner backlog and resolve the recorded blocker directly.";
  }
}

async function loadOptionalJson(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeBuildBlocker(blocker) {
  if (!blocker?.code) return null;
  return {
    code: blocker.code,
    message: blocker.message || null,
    level: blocker.level || blocker.severity || null,
    dimension: blocker.dimension || null
  };
}

function uniqueBlockers(blockers) {
  return uniqueBy(
    (blockers || []).map(normalizeBuildBlocker).filter(Boolean),
    (entry) => `${entry.code}::${entry.message || ""}`
  );
}

function findVerificationEntryForBuild(query, curatedEntry, verificationReport) {
  const verificationBuilds = verificationReport?.builds || [];
  if (!verificationBuilds.length) return null;

  if (curatedEntry?.artifact_id) {
    const direct = verificationBuilds.find((entry) => entry.build_id === curatedEntry.artifact_id);
    if (direct) return direct;
  }
  if (curatedEntry?.manifest_path) {
    const byPath = verificationBuilds.find((entry) => entry.manifest_path === curatedEntry.manifest_path);
    if (byPath) return byPath;
  }

  return verificationBuilds
    .map((entry) => ({
      score: fuzzyMatchScore(query, entry.build_id, entry.name, entry.manifest_path || "", entry.source_project || ""),
      entry
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.entry || null;
}

function fallbackReleaseReasons(entry) {
  const reasons = [];
  if ((entry?.published_release_count || 0) === 0) reasons.push("unpublished_release");
  if (entry?.latest_release_status && entry.latest_release_status !== "published") reasons.push("draft_release");
  if (entry?.latest_verification_status === "unverified") reasons.push("unverified_release");
  if (entry?.latest_verification_status === "candidate") reasons.push("candidate_release");
  return reasons;
}

function collectCuratedBuildBlockers(entry, verificationEntry) {
  const blockers = uniqueBlockers(
    (verificationEntry?.top_blockers && verificationEntry.top_blockers.length > 0)
      ? verificationEntry.top_blockers
      : [
          ...(entry?.top_blockers || []),
          ...(entry?.verification_top_blockers || [])
        ]
  );

  if (blockers.length > 0) return blockers;

  return fallbackReleaseReasons(entry).map((code) => ({
    code,
    message: null,
    level: "warn",
    dimension: code.includes("release") ? "release" : null
  }));
}

function mergeCuratedBuildEntries(state, verificationReport) {
  const verificationBuilds = verificationReport?.builds || [];
  const usedVerificationIds = new Set();

  const curatedFromState = (state.build_plane?.curated_builds || []).map((entry) => {
    const verificationEntry = findVerificationEntryForBuild(entry.artifact_id || entry.name || "", entry, verificationReport);
    if (verificationEntry?.build_id) usedVerificationIds.add(verificationEntry.build_id);
    return { ...entry, verificationEntry };
  });

  const verificationOnly = verificationBuilds
    .filter((entry) => !usedVerificationIds.has(entry.build_id))
    .map((entry) => ({
      artifact_id: entry.build_id,
      name: entry.name,
      source_project: entry.source_project,
      manifest_path: entry.manifest_path,
      status: entry.build_status,
      installable: entry.installability_score >= 70,
      install_ready: entry.installability_score >= 70,
      update_ready: entry.updateability_score >= 70,
      rollback_supported: false,
      latest_release_status: entry.release_summary?.latest_status || null,
      latest_verification_status: entry.release_summary?.latest_verification_status || null,
      published_release_count: entry.release_summary?.published_release_count || 0,
      suggested_build_status: entry.suggested_build_status || null,
      verification_score: entry.verification_score ?? null,
      installability_score: entry.installability_score ?? null,
      publishability_score: entry.publishability_score ?? null,
      updateability_score: entry.updateability_score ?? null,
      readiness_score: entry.readiness_score ?? null,
      verified_ready: entry.verified_ready ?? null,
      publish_ready: entry.publish_ready ?? null,
      top_blockers: entry.top_blockers || [],
      verificationEntry: entry
    }));

  return [...curatedFromState, ...verificationOnly];
}

function buildExplanation(query, state, verificationReport) {
  const curated = mergeCuratedBuildEntries(state, verificationReport).map((entry) => ({
    type: "curated_build",
    key: entry.artifact_id,
    name: entry.name,
    project: entry.source_project,
    score: fuzzyMatchScore(query, entry.artifact_id, entry.name, entry.manifest_path || "", (entry.domains || []).join(" "), (entry.runtimes || []).join(" ")),
    entry
  }));

  const topTargets = uniqueBy(
    (state.projects || [])
      .flatMap((project) => project.canonicalization?.top_targets || [])
      .filter((target) => target.target_type === "build"),
    (target) => target.target_id
  ).map((target) => ({
    type: "candidate_build",
    key: target.target_id,
    name: target.name,
    project: target.project,
    score: fuzzyMatchScore(query, target.target_id, target.name, target.project, target.evidence_summary?.why || "", target.evidence_summary?.dominant_feature_cluster || "", target.evidence_summary?.dominant_domain || ""),
    entry: target
  }));

  const inferred = (state.trust?.build_candidates || []).map((entry) => ({
    type: "inferred_build",
    key: entry.candidate_key,
    name: entry.name,
    project: entry.project,
    score: fuzzyMatchScore(query, entry.candidate_key, entry.name, entry.project, entry.why || "", entry.dominant_feature_cluster || "", entry.dominant_domain || "", (entry.sample_paths || []).join(" ")),
    entry
  }));

  const best = [...curated, ...topTargets, ...inferred]
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || String(left.name).localeCompare(String(right.name)))[0];

  if (!best) return null;

  if (best.type === "curated_build") {
    const release = (state.release_plane?.top_build_releases || []).find((entry) => entry.artifact_id === best.entry.artifact_id);
    const verificationEntry = best.entry.verificationEntry || findVerificationEntryForBuild(query, best.entry, verificationReport);
    const blockers = collectCuratedBuildBlockers(best.entry, verificationEntry);
    const reasons = uniqueBy([
      ...blockers.map((entry) => entry.code).filter(Boolean),
      ...(best.entry.private_publish_status === "blocked" ? ["private_publish_blocked"] : [])
    ], (item) => item);
    const verifiedReady = verificationEntry?.verified_ready ?? best.entry.verified_ready ?? (best.entry.latest_verification_status === "verified");
    const publishReady = verificationEntry?.publish_ready ?? best.entry.publish_ready ?? Boolean((best.entry.published_release_count || 0) > 0 && best.entry.latest_release_status === "published");
    const installReady = best.entry.install_ready ?? best.entry.installable ?? null;
    const updateReady = best.entry.update_ready ?? null;
    const blocked = reasons.length > 0 || verifiedReady === false || publishReady === false || installReady === false;

    return {
      target_type: "build",
      target_kind: "curated_build",
      query,
      matched: best.entry.artifact_id,
      name: best.entry.name,
      project: best.entry.source_project,
      ready: !blocked && Boolean(best.entry.installable ?? installReady),
      blocked,
      reasons,
      explanation: {
        manifest_path: best.entry.manifest_path || verificationEntry?.manifest_path || null,
        installable: best.entry.installable,
        install_ready: installReady,
        update_ready: updateReady,
        rollback_supported: best.entry.rollback_supported,
        latest_release_status: best.entry.latest_release_status,
        latest_verification_status: best.entry.latest_verification_status,
        published_release_count: best.entry.published_release_count,
        domains: best.entry.domains || [],
        runtimes: best.entry.runtimes || [],
        verification_score: verificationEntry?.verification_score ?? best.entry.verification_score ?? null,
        installability_score: verificationEntry?.installability_score ?? best.entry.installability_score ?? null,
        publishability_score: verificationEntry?.publishability_score ?? best.entry.publishability_score ?? null,
        updateability_score: verificationEntry?.updateability_score ?? best.entry.updateability_score ?? null,
        readiness_score: verificationEntry?.readiness_score ?? best.entry.readiness_score ?? null,
        verified_ready: verifiedReady,
        publish_ready: publishReady,
        suggested_build_status: verificationEntry?.suggested_build_status ?? best.entry.suggested_build_status ?? null,
        promotion_priority: best.entry.promotion_priority || null,
        promotion_desired_status: best.entry.promotion_desired_status || null,
        promotion_apply_manifest: best.entry.promotion_apply_manifest === true,
        promotion_blockers: best.entry.promotion_blockers || [],
        private_publish_status: best.entry.private_publish_status || null,
        private_publish_safe: best.entry.private_publish_safe === true,
        private_publish_bundle_path: best.entry.private_publish_bundle_path || null,
        private_publish_blocker_count: best.entry.private_publish_blocker_count || 0,
        private_publish_warning_count: best.entry.private_publish_warning_count || 0,
        private_publish_top_blockers: best.entry.private_publish_top_blockers || [],
        verification_source: verificationEntry ? "build_verification.generated.json" : "SMA_STATE.generated.json",
        handoff_refs: buildHandoffPaths({
          build_id: best.entry.artifact_id,
          source_project: best.entry.source_project,
        }),
        blockers,
        release_summary: verificationEntry?.release_summary || release?.latest_release || null
      }
    };
  }

  if (best.type === "candidate_build") {
    return {
      target_type: "build",
      target_kind: "candidate_build",
      query,
      matched: best.entry.target_id,
      name: best.entry.name,
      project: best.entry.project,
      ready: false,
      blocked: true,
      reasons: best.entry.blocker_reasons || [],
      explanation: {
        priority_score: best.entry.priority_score,
        promotion_stage: best.entry.promotion_stage,
        confidence_label: best.entry.confidence_label,
        blocker_summary: best.entry.blocker_summary || {},
        evidence_summary: best.entry.evidence_summary || {}
      }
    };
  }

  return {
    target_type: "build",
    target_kind: "inferred_build",
    query,
    matched: best.entry.candidate_key,
    name: best.entry.name,
    project: best.entry.project,
    ready: false,
    blocked: false,
    reasons: [],
    explanation: {
      confidence_score: best.entry.confidence_score,
      confidence_label: best.entry.confidence_label,
      brick_count: best.entry.brick_count,
      recurrent_project_count: best.entry.recurrent_project_count,
      why: best.entry.why,
      sample_paths: best.entry.sample_paths || []
    }
  };
}

function brickExplanation(query, registry) {
  const qualityQueue = registry.scanner_report?.remediation_report?.quality_queue || [];
  const duplicateGroups = registry.scanner_report?.code_quality_report?.duplicate_groups || [];
  const cloneRisk = registry.scanner_report?.clone_preflight?.highest_risk_bricks || [];
  const riskMatch = cloneRisk
    .map((entry) => ({
      score: fuzzyMatchScore(query, entry.brick_id, entry.name, entry.path, entry.project),
      entry
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)[0];

  const brickMatch = (registry.bricks || [])
    .map((entry) => ({
      score: fuzzyMatchScore(query, entry.id, entry.name, (entry.source_paths || []).join(" "), entry.manifest_path || "", entry.project || ""),
      entry
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)[0];

  if (!riskMatch && !brickMatch) return null;

  const brick = brickMatch?.entry || (registry.bricks || []).find((entry) => entry.id === riskMatch.entry.brick_id);
  const risk = riskMatch?.entry || null;
  const qualityMatch = qualityQueue
    .map((entry) => ({
      score: fuzzyMatchScore(query, entry.brick_id, entry.brick_name, entry.path, entry.project),
      entry
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.entry || null;
  const duplicateMatch = duplicateGroups
    .map((entry) => ({
      score: fuzzyMatchScore(query, ...(entry.sample_paths || []), entry.path, ...(entry.related_bricks || []), entry.project),
      entry
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.entry || null;
  const reasons = [];

  if (risk) reasons.push(...(risk.blocker_codes || []), ...(risk.warning_codes || []));
  if (!risk && brick?.clone_readiness === "manual_only") reasons.push("project_clone_backlog");
  if (!risk && brick?.env_contract?.status && !["passing", "not_applicable"].includes(brick.env_contract.status)) reasons.push("env_contract_incomplete");
  if (!risk && brick?.rls_contract?.required && brick?.rls_contract?.status !== "passing") reasons.push("rls_contract_incomplete");
  if (!risk && brick?.health?.warnings?.length) reasons.push(...brick.health.warnings);
  if (qualityMatch) reasons.push("quality_hotspot");
  if (duplicateMatch) reasons.push("duplicate_code_cluster");

  return {
    target_type: "brick",
    query,
    matched: brick?.id || risk?.brick_id,
    name: brick?.name || risk?.name,
    project: brick?.project || risk?.project,
    ready: !risk,
    blocked: Boolean(risk),
    reasons: uniqueBy(reasons, (item) => item),
    explanation: {
      path: risk?.path || brick?.source_paths?.[0] || null,
      status: brick?.status || null,
      clone_readiness: brick?.clone_readiness || risk?.declared_readiness || null,
      health_warnings: brick?.health?.warnings || [],
      undeclared_env_refs: risk?.undeclared_env_refs || [],
      blocker_codes: risk?.blocker_codes || [],
      warning_codes: risk?.warning_codes || [],
      cross_brick_owned_import_count: risk?.cross_brick_owned_import_count || 0,
      private_cross_import_count: risk?.private_cross_import_count || 0,
      unresolved_local_import_count: risk?.unresolved_local_import_count || 0,
      unowned_local_dependency_count: risk?.unowned_local_dependency_count || 0,
      raw_source_tokens: risk?.raw_source_tokens || 0,
      file_count: risk?.file_count || 0,
      clone_known_traps: brick?.clone_known_traps || [],
      clone_adaptation_points: brick?.clone_adaptation_points || [],
      quality_hotspot: qualityMatch ? {
        path: qualityMatch.path,
        smell_score: qualityMatch.smell_score,
        total_matches: qualityMatch.total_matches,
        top_types: qualityMatch.top_types || [],
        first_action: qualityMatch.first_action || null,
        why: qualityMatch.why || null
      } : null,
      duplicate_cluster: duplicateMatch ? {
        path: duplicateMatch.path,
        sample_paths: duplicateMatch.sample_paths || [],
        file_count: duplicateMatch.file_count || 0,
        first_action: duplicateMatch.first_action || null,
        why: duplicateMatch.why || null
      } : null
    }
  };
}

function projectExplanation(query, state, registry) {
  const { stateProject, registryProject } = findProjectEntries(state, registry, query);
  if (!stateProject && !registryProject) return null;

  const projectId = registryProject?.id || stateProject?.project;
  const projectPlan = (registry.scanner_report?.remediation_report?.project_action_plans || [])
    .find((entry) => entry.project === projectId);
  const qualityQueue = (stateProject?.quality_queue || registry.scanner_report?.remediation_report?.quality_queue || [])
    .filter((entry) => entry.project === projectId)
    .slice(0, 6);
  const reasons = [
    ...(registryProject?.scanner?.readiness?.reasons || []),
    ...(qualityQueue.length > 0 ? ["project_quality_backlog"] : []),
  ];

  return {
    target_type: "project",
    query,
    matched: projectId,
    name: projectId,
    project: projectId,
    ready: Boolean(stateProject?.canonicalization?.project_canonicalization_ready),
    blocked: !Boolean(stateProject?.canonicalization?.project_canonicalization_ready),
    reasons,
    explanation: {
      readiness: registryProject?.scanner?.readiness || stateProject?.readiness || null,
      compliance: registryProject?.scanner?.compliance_report || stateProject?.compliance || null,
      code_quality_report: registryProject?.scanner?.code_quality_report || stateProject?.code_quality_report || null,
      clone_preflight: registryProject?.scanner?.clone_preflight || stateProject?.clone_preflight || null,
      env_contract_report: registryProject?.scanner?.env_contract_report || stateProject?.env_contract_report || null,
      boundary_report: registryProject?.scanner?.boundary_report || stateProject?.boundary_report || null,
      manifest_drift: registryProject?.scanner?.manifest_drift || stateProject?.manifest_drift || null,
      top_targets: stateProject?.canonicalization?.top_targets || [],
      next_actions: projectPlan?.actions || [],
      quality_queue: qualityQueue
    }
  };
}

function renderText(report) {
  const lines = [];
  lines.push(`Why Blocked: ${report.name}`);
  lines.push(`Type: ${report.target_type}${report.target_kind ? ` (${report.target_kind})` : ""}`);
  lines.push(`Project: ${report.project}`);
  lines.push(`Matched: ${report.matched}`);
  lines.push(`Status: ${report.blocked ? "blocked" : report.ready ? "not blocked" : "unknown"}`);
  lines.push("");
  lines.push("Reasons:");
  if ((report.reasons || []).length === 0) {
    lines.push("- No explicit blocker reasons were recorded for this target.");
  } else {
    for (const reason of report.reasons) {
      lines.push(`- ${labelReason(reason)}`);
    }
  }
  lines.push("");
  lines.push("Recommended Next Moves:");
  const nextMoves = uniqueBy((report.reasons || []).map(mapBlockerCodeToAction), (item) => item).slice(0, 5);
  if (nextMoves.length === 0) lines.push("- Inspect the latest scanner output for this target and decide whether it needs promotion, verification, or cleanup.");
  else nextMoves.forEach((move) => lines.push(`- ${move}`));
  lines.push("");

  if (report.target_type === "project") {
    const readiness = report.explanation.readiness || {};
    const clone = report.explanation.clone_preflight || {};
    const env = report.explanation.env_contract_report || {};
    const boundary = report.explanation.boundary_report || {};
    const quality = report.explanation.code_quality_report || {};
    lines.push(`Readiness: ${readiness.score || 0}/${readiness.grade || "?"} ${readiness.label ? `(${readiness.label})` : ""}`.trim());
    lines.push(`Clone backlog: blocked ${formatNumber(clone.blocked)}, manual ${formatNumber(clone.manual_review)}, guided ${formatNumber(clone.guided)}, copy-ready ${formatNumber(clone.copy_ready)}`);
    lines.push(`Env backlog: ${formatNumber(env.bricks_with_undeclared_refs)} bricks, ${formatNumber(env.undeclared_reference_count)} undeclared refs`);
    lines.push(`Boundary backlog: unresolved ${formatNumber(boundary.unresolved_local_import_count)}, unowned ${formatNumber(boundary.unowned_local_dependency_count)}, owned-cross ${formatNumber(boundary.cross_brick_owned_import_count)}, private-cross ${formatNumber(boundary.private_cross_brick_import_count)}`);
    lines.push(`Code quality: ${formatNumber(quality.score || 0)}/${quality.grade || "?"}, ${formatNumber(quality.hotspot_file_count || 0)} hotspot files, ${formatNumber(quality.total_smell_count || 0)} smell hits, ${formatNumber(quality.duplicate_cluster_count || 0)} duplicate clusters`);
    lines.push("");
    lines.push("Top Targets:");
    for (const target of topList(report.explanation.top_targets || [], 3)) {
      lines.push(`- ${target.target_type} ${target.name} (${target.priority_score})`);
      lines.push(`  blockers: ${(target.blocker_reasons || []).join(", ") || "none recorded"}`);
    }
    if ((report.explanation.quality_queue || []).length > 0) {
      lines.push("");
      lines.push("Code Quality Hotspots:");
      for (const action of topList(report.explanation.quality_queue || [], 3)) {
        lines.push(`- ${action.path || action.brick_name || action.brick_id || "quality hotspot"}: ${action.first_action || action.why || "Review hotspot."}`);
      }
    }
  } else if (report.target_type === "brick") {
    lines.push(`Path: ${report.explanation.path || "unknown"}`);
    lines.push(`Clone readiness: ${report.explanation.clone_readiness || "unknown"}`);
    lines.push(`Local import pressure: unresolved ${formatNumber(report.explanation.unresolved_local_import_count)}, unowned ${formatNumber(report.explanation.unowned_local_dependency_count)}, owned-cross ${formatNumber(report.explanation.cross_brick_owned_import_count)}, private-cross ${formatNumber(report.explanation.private_cross_import_count)}`);
    if ((report.explanation.undeclared_env_refs || []).length) {
      lines.push(`Undeclared env refs: ${(report.explanation.undeclared_env_refs || []).slice(0, 8).join(", ")}`);
    }
    if ((report.explanation.health_warnings || []).length) {
      lines.push(`Health warnings: ${(report.explanation.health_warnings || []).join(", ")}`);
    }
    if (report.explanation.quality_hotspot) {
      lines.push(`Quality hotspot: ${formatNumber(report.explanation.quality_hotspot.total_matches || 0)} smell hits, score ${formatNumber(report.explanation.quality_hotspot.smell_score || 0)}`);
      if ((report.explanation.quality_hotspot.top_types || []).length) {
        lines.push(`Dominant issues: ${(report.explanation.quality_hotspot.top_types || []).map((entry) => `${entry.label || entry.key} x${formatNumber(entry.count || 0)}`).join(", ")}`);
      }
      if (report.explanation.quality_hotspot.first_action) {
        lines.push(`First fix: ${report.explanation.quality_hotspot.first_action}`);
      }
    }
    if (report.explanation.duplicate_cluster) {
      lines.push(`Duplicate cluster: ${formatNumber(report.explanation.duplicate_cluster.file_count || 0)} files`);
      lines.push(`Duplicate paths: ${(report.explanation.duplicate_cluster.sample_paths || []).slice(0, 4).join(", ")}`);
      if (report.explanation.duplicate_cluster.first_action) {
        lines.push(`Dedup move: ${report.explanation.duplicate_cluster.first_action}`);
      }
    }
  } else if (report.target_type === "build") {
    if (report.target_kind === "curated_build") {
      lines.push(`Manifest: ${report.explanation.manifest_path || "unknown"}`);
      lines.push(`Installable: ${report.explanation.installable ? "yes" : "no"}`);
      lines.push(`Install-ready: ${report.explanation.install_ready ? "yes" : "no"}`);
      lines.push(`Update-ready: ${report.explanation.update_ready ? "yes" : "no"}`);
      lines.push(`Rollback supported: ${report.explanation.rollback_supported ? "yes" : "no"}`);
      lines.push(`Latest release: ${report.explanation.latest_release_status || "unknown"} / ${report.explanation.latest_verification_status || "unknown"}`);
      lines.push(`Published releases: ${formatNumber(report.explanation.published_release_count)}`);
      lines.push(`Verification source: ${report.explanation.verification_source}`);
      lines.push(`Scores: verification ${formatNumber(report.explanation.verification_score)}/100, installability ${formatNumber(report.explanation.installability_score)}/100, publishability ${formatNumber(report.explanation.publishability_score)}/100, updateability ${formatNumber(report.explanation.updateability_score)}/100, readiness ${formatNumber(report.explanation.readiness_score)}/100`);
      lines.push(`Ready flags: verified ${report.explanation.verified_ready ? "yes" : "no"}, publishable ${report.explanation.publish_ready ? "yes" : "no"}`);
      if (report.explanation.promotion_priority || report.explanation.promotion_desired_status) {
        lines.push(`Promotion lane: ${report.explanation.promotion_priority || "unknown"} priority, desired status ${report.explanation.promotion_desired_status || "unchanged"}, auto-apply ${report.explanation.promotion_apply_manifest ? "yes" : "no"}`);
      }
      if (report.explanation.private_publish_status || report.explanation.private_publish_bundle_path) {
        lines.push(`Private publish bundle: ${report.explanation.private_publish_status || "not generated"} (${report.explanation.private_publish_safe ? "safe" : "not safe"})`);
        if (report.explanation.private_publish_bundle_path) lines.push(`Bundle path: ${report.explanation.private_publish_bundle_path}`);
        lines.push(`Publish findings: blockers ${formatNumber(report.explanation.private_publish_blocker_count)}, warnings ${formatNumber(report.explanation.private_publish_warning_count)}`);
      }
      if (report.explanation.suggested_build_status) {
        lines.push(`Suggested status: ${report.explanation.suggested_build_status}`);
      }
      lines.push(`Domains: ${(report.explanation.domains || []).join(", ") || "none recorded"}`);
      if ((report.explanation.blockers || []).length) {
        lines.push("Top blockers:");
        for (const blocker of (report.explanation.blockers || []).slice(0, 4)) {
          const prefix = blocker.level ? `[${blocker.level}] ` : "";
          const detail = blocker.message ? `: ${blocker.message}` : "";
          lines.push(`- ${prefix}${blocker.code}${detail}`);
        }
      }
      if ((report.explanation.private_publish_top_blockers || []).length) {
        lines.push("Top publish blockers:");
        for (const blocker of (report.explanation.private_publish_top_blockers || []).slice(0, 4)) {
          lines.push(`- ${blocker.rule_id || blocker.code || "publish-rule"}: ${blocker.summary || blocker.message || "Finding recorded."}`);
        }
      }
      if (report.explanation.handoff_refs) {
        lines.push("Repair kit:");
        lines.push(`- repo prompt: ${report.explanation.handoff_refs.repo_prompt}`);
        lines.push(`- repo queue: ${report.explanation.handoff_refs.queue_doc}`);
        lines.push(`- build packets: ${report.explanation.handoff_refs.build_packets}`);
        lines.push(`- publish leaks: ${report.explanation.handoff_refs.publish_leaks}`);
        lines.push(`- manifest scaffolds: ${report.explanation.handoff_refs.manifest_scaffolds}`);
        lines.push(`- release drafts: ${report.explanation.handoff_refs.release_drafts}`);
      }
    } else if (report.target_kind === "candidate_build") {
      lines.push(`Priority score: ${formatNumber(report.explanation.priority_score)}`);
      lines.push(`Promotion stage: ${report.explanation.promotion_stage || "unknown"}`);
      lines.push(`Confidence: ${report.explanation.confidence_label || "unknown"}`);
      lines.push(`Evidence: ${report.explanation.evidence_summary?.why || "none recorded"}`);
    } else {
      lines.push(`Confidence: ${report.explanation.confidence_score || 0} (${report.explanation.confidence_label || "unknown"})`);
      lines.push(`Why: ${report.explanation.why || "No explanation recorded."}`);
      if ((report.explanation.sample_paths || []).length) {
        lines.push(`Sample paths: ${(report.explanation.sample_paths || []).slice(0, 4).join(", ")}`);
      }
    }
  }

  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: ["json", "help"] });
  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  const query = args.project || args.brick || args.build || args._[0];
  if (!query) fail("pass --project, --brick, --build, or a positional query");

  const cwd = process.cwd();
  const { state, registry } = await loadStateAndRegistry({
    cwd,
    statePath: args.state || DEFAULT_STATE_PATH,
    registryPath: args.registry || DEFAULT_REGISTRY_PATH
  });
  const verificationReport = await loadOptionalJson(path.resolve(cwd, DEFAULT_BUILD_VERIFICATION_PATH));

  let report = null;
  if (args.project) report = projectExplanation(query, state, registry);
  else if (args.brick) report = brickExplanation(query, registry);
  else if (args.build) report = buildExplanation(query, state, verificationReport);
  else {
    report = projectExplanation(query, state, registry)
      || buildExplanation(query, state, verificationReport)
      || brickExplanation(query, registry);
  }

  if (!report) fail(`no project, brick, or build matched "${query}"`);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(renderText(report));
}

main().catch((error) => fail(error?.stack || error?.message || String(error)));
