const GENERIC_DUPLICATE_STEMS = new Set([
  "api",
  "common",
  "component",
  "components",
  "config",
  "data",
  "dialog",
  "hooks",
  "hook",
  "layout",
  "lib",
  "modal",
  "page",
  "pages",
  "provider",
  "providers",
  "service",
  "services",
  "shared",
  "state",
  "test",
  "tests",
  "types",
  "ui",
  "utils",
  "utility",
  "views"
]);

const DEFAULT_THRESHOLDS = {
  project_readiness_min: 60,
  compliance_min: 75,
  max_blocked_clone_ratio: 0.12,
  max_env_gap_ratio: 0.15,
  max_boundary_violations_per_brick: 4,
  min_recurrent_build_families: 8,
  min_ready_project_ratio: 0.4,
  max_project_work_bottleneck_ratio: 0.5,
  max_global_blocked_clone_ratio: 0.15
};

const STATUS_BONUS = {
  canonical: -100,
  candidate: 10,
  project_bound: 0,
  experimental: -12,
  duplicate: -10,
  variant: -8,
  legacy: -12
};

export function emptyCanonicalizationReport() {
  return {
    thresholds: { ...DEFAULT_THRESHOLDS },
    project_canonicalization_ready: false,
    bottleneck_mode: "project_work",
    reasons: [],
    counts: {
      project_count: 0,
      ready_project_count: 0,
      project_work_bottleneck_count: 0,
      artifact_promotion_bottleneck_count: 0,
      build_target_count: 0,
      brick_target_count: 0
    },
    top_targets: [],
    projects: []
  };
}

export function buildCanonicalizationReport(registry) {
  const report = emptyCanonicalizationReport();
  const scannerReport = registry?.scanner_report || {};
  const readinessProjects = Array.isArray(scannerReport.readiness?.projects)
    ? scannerReport.readiness.projects
    : [];

  if (readinessProjects.length === 0) {
    report.reasons.push({
      code: "missing_project_scanner_summaries",
      message: "No per-project scanner summaries were available to build a canonicalization queue."
    });
    return report;
  }

  const thresholds = { ...DEFAULT_THRESHOLDS };
  const bricks = Array.isArray(registry?.bricks) ? registry.bricks : [];
  const projectSummaries = Array.isArray(registry?.projects) ? registry.projects : [];
  const buildCandidates = Array.isArray(scannerReport.build_report?.top_candidates)
    ? scannerReport.build_report.top_candidates
    : [];
  const duplicateClusters = Array.isArray(scannerReport.duplicate_clusters)
    ? scannerReport.duplicate_clusters
    : [];
  const refactorProjects = new Map(
    (registry?.refactor_report?.projects || []).map((entry) => [entry.project, entry])
  );
  const projectSummaryMap = new Map(
    projectSummaries.map((entry) => [entry.id || entry.project, entry])
  );

  const bricksByProject = groupBy(bricks, (brick) => brick.project);
  const buildsByProject = groupBy(buildCandidates, (candidate) => candidate.project);
  const cloneRiskByBrick = toMap(scannerReport.clone_preflight?.highest_risk_bricks || [], "brick_id");
  const envGapByBrick = toMap(scannerReport.env_contract_report?.highest_gap_bricks || [], "brick_id");
  const complianceGapByBrick = toMap(scannerReport.compliance_report?.highest_gap_bricks || [], "brick_id");
  const boundaryCountsByBrick = countByKey(scannerReport.boundary_report?.top_violations || [], "brick_id");
  const duplicateTargetsByProject = buildDuplicateTargetsByProject(duplicateClusters, bricks, cloneRiskByBrick, envGapByBrick, complianceGapByBrick, boundaryCountsByBrick);

  const projectReports = readinessProjects
    .map((projectEntry) => {
      const project = projectEntry.project;
      const projectBricks = bricksByProject.get(project) || [];
      const projectBuildCandidates = buildsByProject.get(project) || [];
      const duplicateTargets = duplicateTargetsByProject.get(project) || [];
      const projectSummary = projectSummaryMap.get(project) || {};
      const refactor = refactorProjects.get(project) || {};
      const blockerSummary = summarizeProjectBlockers(projectEntry, projectSummary, refactor, projectBricks.length);
      const projectReasons = buildProjectReasons(projectEntry, blockerSummary, thresholds);
      const projectReady = isProjectCanonicalizationReady(projectEntry, blockerSummary, thresholds);
      const bottleneckStage = projectReady
        ? "target_promotion"
        : projectReasons.length > 0
          ? "project_work"
          : projectBuildCandidates.length + duplicateTargets.length > 0
            ? "artifact_promotion"
            : "artifact_discovery";

      const buildTargets = projectBuildCandidates.map((candidate) =>
        createBuildTarget(candidate, projectEntry, blockerSummary)
      );
      const brickTargets = duplicateTargets.map((target) => withProjectBlockers(target, blockerSummary));

      const topTargets = [...buildTargets, ...brickTargets]
        .sort(compareTargets)
        .slice(0, 6)
        .map((target, index) => ({
          ...target,
          rank: index + 1
        }));

      return {
        project,
        project_canonicalization_ready: projectReady,
        bottleneck_stage: bottleneckStage,
        readiness_score: Number(projectEntry.readiness?.score || 0),
        readiness_grade: projectEntry.readiness?.grade || "F",
        compliance_score: Number(projectEntry.compliance_report?.score || 0),
        compliance_grade: projectEntry.compliance_report?.grade || "F",
        counts: {
          brick_count: projectBricks.length,
          canonical_brick_count: projectBricks.filter((brick) => brick.status === "canonical").length,
          candidate_brick_count: projectBricks.filter((brick) => brick.status === "candidate").length,
          build_candidate_count: Number(projectEntry.build_report?.candidate_count || 0),
          recurrent_build_count: Number(projectEntry.build_report?.recurrent_candidate_count || 0),
          top_target_count: topTargets.length
        },
        blocker_summary: blockerSummary,
        reasons: projectReasons,
        top_targets: topTargets
      };
    })
    .sort((left, right) =>
      Number(right.project_canonicalization_ready) - Number(left.project_canonicalization_ready)
      || compareStrings(left.bottleneck_stage, right.bottleneck_stage)
      || Number(right.readiness_score || 0) - Number(left.readiness_score || 0)
      || compareStrings(left.project, right.project)
    );

  const topTargets = projectReports
    .flatMap((project) => project.top_targets.map((target) => ({
      ...target,
      project: target.project || project.project
    })))
    .sort(compareTargets)
    .slice(0, 30)
    .map((target, index) => ({
      ...target,
      rank: index + 1
    }));

  const readyProjectCount = projectReports.filter((project) => project.project_canonicalization_ready).length;
  const projectWorkBottleneckCount = projectReports.filter((project) => project.bottleneck_stage === "project_work").length;
  const artifactPromotionBottleneckCount = projectReports.filter((project) => project.bottleneck_stage === "artifact_promotion").length;
  const minReadyProjects = Math.max(1, Math.ceil(projectReports.length * thresholds.min_ready_project_ratio));
  const maxProjectWorkBottlenecks = Math.floor(projectReports.length * thresholds.max_project_work_bottleneck_ratio);
  const globalBlockedCloneRatio = ratio(
    Number(scannerReport.clone_preflight?.counts?.blocked || 0),
    bricks.length
  );

  const reasons = [];
  const avgReadiness = Number(scannerReport.readiness?.average_score || 0);
  const avgCompliance = Number(scannerReport.compliance_report?.average_score || 0);
  const recurrentFamilies = Number(scannerReport.build_report?.recurrent_family_count || 0);

  if (avgReadiness < thresholds.project_readiness_min) {
    reasons.push(thresholdReason(
      "average_readiness_below_threshold",
      avgReadiness,
      thresholds.project_readiness_min,
      "Average project readiness is still below the canonicalization threshold."
    ));
  }

  if (avgCompliance < thresholds.compliance_min) {
    reasons.push(thresholdReason(
      "average_compliance_below_threshold",
      avgCompliance,
      thresholds.compliance_min,
      "Average compliance is still below the canonicalization threshold."
    ));
  }

  if (readyProjectCount < minReadyProjects) {
    reasons.push(thresholdReason(
      "not_enough_ready_projects",
      readyProjectCount,
      minReadyProjects,
      "Too few projects are ready for canonicalization-first work."
    ));
  }

  if (projectWorkBottleneckCount > maxProjectWorkBottlenecks) {
    reasons.push(thresholdReason(
      "project_work_is_bottleneck",
      projectWorkBottleneckCount,
      maxProjectWorkBottlenecks,
      "Project-level cleanup is the dominant bottleneck across the portfolio."
    ));
  }

  if (recurrentFamilies < thresholds.min_recurrent_build_families) {
    reasons.push(thresholdReason(
      "not_enough_recurrent_build_families",
      recurrentFamilies,
      thresholds.min_recurrent_build_families,
      "There are not yet enough recurrent build families to prioritize build canonicalization at scale."
    ));
  }

  if (globalBlockedCloneRatio > thresholds.max_global_blocked_clone_ratio) {
    reasons.push(thresholdReason(
      "clone_blockers_above_threshold",
      roundNumber(globalBlockedCloneRatio),
      thresholds.max_global_blocked_clone_ratio,
      "Blocked clone preflight still dominates the global artifact set."
    ));
  }

  report.counts = {
    project_count: projectReports.length,
    ready_project_count: readyProjectCount,
    project_work_bottleneck_count: projectWorkBottleneckCount,
    artifact_promotion_bottleneck_count: artifactPromotionBottleneckCount,
    build_target_count: topTargets.filter((target) => target.target_type === "build").length,
    brick_target_count: topTargets.filter((target) => target.target_type === "brick").length
  };
  report.project_canonicalization_ready = reasons.length === 0;
  report.bottleneck_mode = projectWorkBottleneckCount > maxProjectWorkBottlenecks
    ? "project_work"
    : artifactPromotionBottleneckCount >= Math.ceil(projectReports.length / 2)
      ? "artifact_promotion"
      : "balanced";
  report.reasons = reasons;
  report.top_targets = topTargets;
  report.projects = projectReports;

  return report;
}

function buildDuplicateTargetsByProject(duplicateClusters, bricks, cloneRiskByBrick, envGapByBrick, complianceGapByBrick, boundaryCountsByBrick) {
  const bricksById = new Map(bricks.map((brick) => [brick.id, brick]));
  const byProject = new Map();

  for (const cluster of duplicateClusters || []) {
    const stem = String(cluster?.stem || "");
    if (!stem || GENERIC_DUPLICATE_STEMS.has(stem) || Number(cluster?.projects?.length || 0) < 3) {
      continue;
    }

    for (const member of cluster.bricks || []) {
      const brick = bricksById.get(member.id);
      if (!brick || brick.status === "canonical") {
        continue;
      }

      const cloneRisk = cloneRiskByBrick.get(brick.id);
      const envGap = envGapByBrick.get(brick.id);
      const complianceGap = complianceGapByBrick.get(brick.id);
      const boundaryCount = Number(boundaryCountsByBrick.get(brick.id) || 0);
      const blockerReasons = [];

      if (brick.status === "project_bound") {
        blockerReasons.push("still_project_bound");
      }
      if (cloneRisk?.effective_status === "blocked") {
        blockerReasons.push("clone_preflight_blocked");
      }
      if ((envGap?.undeclared_env_refs || []).length > 0) {
        blockerReasons.push("env_contract_gap");
      }
      if ((complianceGap?.missing_count || 0) > 0) {
        blockerReasons.push("compliance_dimensions_missing");
      }
      if (boundaryCount > 0) {
        blockerReasons.push("boundary_violations_present");
      }

      const blockerSummary = {
        duplicate_project_count: Number(cluster.projects?.length || 0),
        duplicate_count: Number(cluster.count || 0),
        clone_blocker_count: cloneRisk?.blocker_codes?.length || 0,
        undeclared_env_ref_count: envGap?.undeclared_env_refs?.length || 0,
        compliance_missing_count: Number(complianceGap?.missing_count || 0),
        boundary_violation_count: boundaryCount,
        raw_source_tokens: Number(brick.raw_source_tokens || 0)
      };

      const priorityScore = Math.round(
        (Number(cluster.projects?.length || 0) * 14)
        + (Math.min(Number(cluster.count || 0), 12) * 3)
        + Number(brick.score || 0)
        + (STATUS_BONUS[brick.status] || 0)
        - (blockerSummary.clone_blocker_count * 5)
        - Math.min(blockerSummary.undeclared_env_ref_count, 10)
        - (blockerSummary.compliance_missing_count * 6)
        - (blockerSummary.boundary_violation_count * 2)
      );

      const target = {
        target_type: "brick",
        project: brick.project,
        target_id: brick.id,
        name: brick.name || brick.id,
        priority_score: priorityScore,
        promotion_stage: chooseBrickPromotionStage(cluster, blockerReasons),
        confidence_label: Number(cluster.projects?.length || 0) >= 4 ? "high" : "medium",
        evidence_summary: {
          duplicate_stem: stem,
          duplicate_project_count: Number(cluster.projects?.length || 0),
          duplicate_count: Number(cluster.count || 0),
          kind: brick.kind,
          status: brick.status,
          score: Number(brick.score || 0),
          source_path: (brick.source_paths || [])[0] || member.source_path || ""
        },
        blocker_summary: blockerSummary,
        blocker_reasons: blockerReasons
      };

      const existing = byProject.get(brick.project) || [];
      existing.push(target);
      byProject.set(brick.project, existing);
    }
  }

  for (const [project, targets] of byProject.entries()) {
    byProject.set(project, targets.sort(compareTargets).slice(0, 8));
  }

  return byProject;
}

function createBuildTarget(candidate, projectEntry, blockerSummary) {
  const projectBoundMembers = Number(candidate?.status_counts?.project_bound || 0);
  const candidateMembers = Number(candidate?.status_counts?.candidate || 0);
  const canonicalMembers = Number(candidate?.status_counts?.canonical || 0);
  const blockerReasons = [];

  if (projectBoundMembers > 0) {
    blockerReasons.push("contains_project_bound_members");
  }
  if (blockerSummary.blocked_clone_count > 0) {
    blockerReasons.push("project_clone_backlog");
  }
  if (blockerSummary.env_gap_brick_count > 0) {
    blockerReasons.push("project_env_contract_backlog");
  }
  if (blockerSummary.boundary_violation_count > 0) {
    blockerReasons.push("project_boundary_backlog");
  }
  if (Number(candidate?.recurrent_project_count || 0) < 2) {
    blockerReasons.push("not_yet_recurrent_across_projects");
  }

  const priorityScore = Math.round(
    Number(candidate?.confidence_score || 0)
    + (Number(candidate?.recurrent_project_count || 0) * 16)
    + (Math.min(Number(candidate?.brick_count || 0), 12) * 2)
    + (Number(candidate?.average_brick_score || 0) * 0.5)
    + (candidateMembers * 2)
    + (canonicalMembers * 3)
    - (projectBoundMembers * 4)
    - Math.min(blockerSummary.blocked_clone_count, 200) * 0.03
    - Math.min(blockerSummary.env_gap_brick_count, 120) * 0.08
  );

  return {
    target_type: "build",
    project: candidate.project,
    target_id: candidate.candidate_key,
    name: candidate.name,
    priority_score: priorityScore,
    promotion_stage: chooseBuildPromotionStage(candidate, projectBoundMembers),
    confidence_label: candidate.confidence_label || "medium",
    evidence_summary: {
      recurrent_project_count: Number(candidate?.recurrent_project_count || 0),
      confidence_score: Number(candidate?.confidence_score || 0),
      brick_count: Number(candidate?.brick_count || 0),
      dominant_feature_cluster: candidate?.dominant_feature_cluster || null,
      dominant_domain: candidate?.dominant_domain || null,
      dominant_group: candidate?.dominant_group || null,
      why: candidate?.why || null
    },
    blocker_summary: {
      project_bound_member_count: projectBoundMembers,
      candidate_member_count: candidateMembers,
      canonical_member_count: canonicalMembers,
      blocked_clone_count: blockerSummary.blocked_clone_count,
      env_gap_brick_count: blockerSummary.env_gap_brick_count,
      manifest_drift_count: blockerSummary.manifest_drift_count,
      oversized_file_count: blockerSummary.oversized_file_count
    },
    blocker_reasons: blockerReasons
  };
}

function summarizeProjectBlockers(projectEntry, projectSummary, refactor, brickCount) {
  const readiness = projectEntry?.readiness || {};
  const metrics = readiness.metrics || {};
  const boundaryReport = projectEntry?.boundary_report || {};
  const clonePreflight = projectEntry?.clone_preflight || {};
  const envReport = projectEntry?.env_contract_report || {};
  const manifestDrift = projectEntry?.manifest_drift || {};

  return {
    brick_count: brickCount || Number(metrics.brick_count || 0),
    blocked_clone_count: Number(clonePreflight.blocked || metrics.blocked_clone_count || 0),
    manual_review_count: Number(clonePreflight.manual_review || metrics.manual_review_count || 0),
    guided_count: Number(clonePreflight.guided || metrics.guided_count || 0),
    copy_ready_count: Number(clonePreflight.copy_ready || metrics.copy_ready_count || 0),
    env_gap_brick_count: Number(envReport.bricks_with_undeclared_refs || metrics.env_gap_count || 0),
    undeclared_reference_count: Number(envReport.undeclared_reference_count || 0),
    boundary_violation_count: Number(metrics.boundary_violation_count || 0),
    unresolved_local_import_count: Number(boundaryReport.unresolved_local_import_count || 0),
    unowned_local_dependency_count: Number(boundaryReport.unowned_local_dependency_count || 0),
    cross_brick_owned_import_count: Number(boundaryReport.cross_brick_owned_import_count || 0),
    private_cross_brick_import_count: Number(boundaryReport.private_cross_brick_import_count || 0),
    manifest_drift_count: Number(manifestDrift.count || metrics.drift_count || 0),
    unmanifested_count: Number(projectSummary.unmanifested_count || metrics.unmanifested_count || 0),
    oversized_file_count: Number(refactor.oversized_file_count || 0),
    split_opportunity_count: Number(refactor.split_opportunity_count || 0)
  };
}

function buildProjectReasons(projectEntry, blockerSummary, thresholds) {
  const reasons = [];
  const readiness = Number(projectEntry?.readiness?.score || 0);
  const compliance = Number(projectEntry?.compliance_report?.score || 0);
  const brickCount = Math.max(Number(blockerSummary.brick_count || 0), 1);
  const blockedCloneRatio = ratio(blockerSummary.blocked_clone_count, brickCount);
  const envGapRatio = ratio(blockerSummary.env_gap_brick_count, brickCount);
  const boundaryPerBrick = ratio(blockerSummary.boundary_violation_count, brickCount);

  if (readiness < thresholds.project_readiness_min) {
    reasons.push(thresholdReason(
      "project_readiness_below_threshold",
      readiness,
      thresholds.project_readiness_min,
      "Project readiness is below the canonicalization threshold."
    ));
  }
  if (compliance < thresholds.compliance_min) {
    reasons.push(thresholdReason(
      "project_compliance_below_threshold",
      compliance,
      thresholds.compliance_min,
      "Project compliance is below the canonicalization threshold."
    ));
  }
  if (blockedCloneRatio > thresholds.max_blocked_clone_ratio) {
    reasons.push(thresholdReason(
      "blocked_clone_ratio_above_threshold",
      roundNumber(blockedCloneRatio),
      thresholds.max_blocked_clone_ratio,
      "Blocked clone preflight is still too high for clean canonical promotion."
    ));
  }
  if (envGapRatio > thresholds.max_env_gap_ratio) {
    reasons.push(thresholdReason(
      "env_gap_ratio_above_threshold",
      roundNumber(envGapRatio),
      thresholds.max_env_gap_ratio,
      "Env contract drift is still too high for clean canonical promotion."
    ));
  }
  if (boundaryPerBrick > thresholds.max_boundary_violations_per_brick) {
    reasons.push(thresholdReason(
      "boundary_violation_density_above_threshold",
      roundNumber(boundaryPerBrick),
      thresholds.max_boundary_violations_per_brick,
      "Boundary issues are still dense enough that project work dominates."
    ));
  }

  return reasons;
}

function isProjectCanonicalizationReady(projectEntry, blockerSummary, thresholds) {
  const readiness = Number(projectEntry?.readiness?.score || 0);
  const compliance = Number(projectEntry?.compliance_report?.score || 0);
  const brickCount = Math.max(Number(blockerSummary.brick_count || 0), 1);

  return readiness >= thresholds.project_readiness_min
    && compliance >= thresholds.compliance_min
    && ratio(blockerSummary.blocked_clone_count, brickCount) <= thresholds.max_blocked_clone_ratio
    && ratio(blockerSummary.env_gap_brick_count, brickCount) <= thresholds.max_env_gap_ratio
    && ratio(blockerSummary.boundary_violation_count, brickCount) <= thresholds.max_boundary_violations_per_brick;
}

function chooseBuildPromotionStage(candidate, projectBoundMembers) {
  const recurrence = Number(candidate?.recurrent_project_count || 0);
  const confidence = Number(candidate?.confidence_score || 0);
  if (recurrence >= 3 && confidence >= 85 && projectBoundMembers <= 1) {
    return "promote_now";
  }
  if (recurrence >= 2 && confidence >= 75) {
    return "stabilize_then_promote";
  }
  return "refine_before_promote";
}

function chooseBrickPromotionStage(cluster, blockerReasons) {
  const duplicateProjects = Number(cluster?.projects?.length || 0);
  if (duplicateProjects >= 4 && blockerReasons.length === 0) {
    return "promote_now";
  }
  if (duplicateProjects >= 3) {
    return "stabilize_then_promote";
  }
  return "research_before_promote";
}

function thresholdReason(code, current, threshold, message) {
  return {
    code,
    current,
    threshold,
    message
  };
}

function compareTargets(left, right) {
  return Number(right.priority_score || 0) - Number(left.priority_score || 0)
    || compareStrings(left.target_type, right.target_type)
    || compareStrings(left.project, right.project)
    || compareStrings(left.name, right.name);
}

function withProjectBlockers(target, blockerSummary) {
  const blockerReasons = new Set(target.blocker_reasons || []);
  const summary = {
    ...target.blocker_summary,
    project_blocked_clone_count: Number(blockerSummary.blocked_clone_count || 0),
    project_env_gap_brick_count: Number(blockerSummary.env_gap_brick_count || 0),
    project_boundary_violation_count: Number(blockerSummary.boundary_violation_count || 0),
    project_manifest_drift_count: Number(blockerSummary.manifest_drift_count || 0)
  };

  if (blockerSummary.blocked_clone_count > 0) {
    blockerReasons.add("project_clone_backlog");
  }
  if (blockerSummary.env_gap_brick_count > 0) {
    blockerReasons.add("project_env_contract_backlog");
  }
  if (blockerSummary.boundary_violation_count > 0) {
    blockerReasons.add("project_boundary_backlog");
  }

  return {
    ...target,
    blocker_summary: summary,
    blocker_reasons: [...blockerReasons]
  };
}

function toMap(entries, key) {
  const map = new Map();
  for (const entry of entries || []) {
    if (entry?.[key]) {
      map.set(entry[key], entry);
    }
  }
  return map;
}

function countByKey(entries, key) {
  const counts = new Map();
  for (const entry of entries || []) {
    const value = entry?.[key];
    if (!value) {
      continue;
    }
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items || []) {
    const key = keyFn(item);
    const current = groups.get(key) || [];
    current.push(item);
    groups.set(key, current);
  }
  return groups;
}

function ratio(numerator, denominator) {
  if (!denominator) {
    return 0;
  }
  return Number(numerator || 0) / Number(denominator || 1);
}

function roundNumber(value) {
  return Number(value.toFixed(2));
}

function compareStrings(left, right) {
  return String(left || "").localeCompare(String(right || ""));
}
