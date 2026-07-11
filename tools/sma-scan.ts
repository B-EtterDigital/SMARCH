#!/usr/bin/env node
/**
 * What: Discovers and validates module manifests across a project root.
 * Why: Portfolio tools need one normalized registry instead of trusting scattered declarations.
 * How: Reads manifests and source metadata, then writes a generated registry or checks drift.
 * Callers: Portfolio scan, state generation, validation, and dashboards consume its output.
 * Example: `node tools/sma-scan.ts --help`
 */
import path from "node:path";
import { normalizeRegistrySnapshot, writeJsonIfMeaningfulChanged } from "./lib/stable-generated.ts";
import { validateManifest } from "./sma-validate.ts";
import {
  candidateGroups, compactBrick, discoverPotentialBricks, discoverProjectRoots,
  getActiveExcludedRoots, parseArgs, pathExists, projectHealth, projectId,
  readManifest, setActiveExcludedRoots, walk
} from "./lib/scan-discovery.ts";
import {
  analyzeProjectRefactorOpportunities, buildRefactorReport, compactCodeQualityCounts,
  countBy, dedupeQualityHotspots, emptyCodeQualityCounts, gradeForScore,
  mergeCodeQualityCounts
} from "./lib/scan-refactor.ts";
import {
  complianceDimensionDefinitions, emptyComplianceReport, finalizeComplianceReport,
  finalizeMergedBuildReport
} from "./lib/scan-build.ts";
import {
  analyzeProjectScannerReport, buildDuplicateClusters, loadCompactCardIndex,
  remediationActionProjectPlans
} from "./lib/scan-project-analysis.ts";

function buildScannerReport(projectReports, bricks) {
  const projects = projectReports.map((report) => ({
    project: report.project,
    readiness: report.readiness,
    boundary_report: {
      import_scan_count: report.boundary_report.import_scan_count,
      same_group_internal_import_count: report.boundary_report.same_group_internal_import_count,
      private_cross_brick_import_count: report.boundary_report.private_cross_brick_import_count,
      cross_brick_owned_import_count: report.boundary_report.cross_brick_owned_import_count,
      unresolved_local_import_count: report.boundary_report.unresolved_local_import_count,
      unowned_local_dependency_count: report.boundary_report.unowned_local_dependency_count
    },
    clone_preflight: report.clone_preflight.counts,
    manifest_drift: {
      count: report.manifest_drift.count
    },
    env_contract_report: {
      observed_reference_count: report.env_contract_report.observed_reference_count,
      undeclared_reference_count: report.env_contract_report.undeclared_reference_count,
      bricks_with_undeclared_refs: report.env_contract_report.bricks_with_undeclared_refs
    },
    compliance_report: {
      score: report.compliance_report?.score || 0,
      grade: report.compliance_report?.grade || "F",
      trackable_brick_count: report.compliance_report?.trackable_brick_count || 0,
      weakest_dimensions: report.compliance_report?.weakest_dimensions || []
    },
    code_quality_report: {
      score: report.code_quality_report?.score || 0,
      grade: report.code_quality_report?.grade || "F",
      analyzed_code_file_count: report.code_quality_report?.analyzed_code_file_count || 0,
      hotspot_file_count: report.code_quality_report?.hotspot_file_count || 0,
      brick_hotspot_count: report.code_quality_report?.brick_hotspot_count || 0,
      duplicate_cluster_count: report.code_quality_report?.duplicate_cluster_count || 0,
      total_smell_count: report.code_quality_report?.total_smell_count || 0,
      weighted_smell_score: report.code_quality_report?.weighted_smell_score || 0,
      by_type: report.code_quality_report?.by_type || {}
    },
    build_report: {
      candidate_count: report.build_report?.candidate_count || 0,
      detected_brick_count: report.build_report?.detected_brick_count || 0,
      average_confidence_score: report.build_report?.average_confidence_score || 0,
      recurrent_candidate_count: report.build_report?.recurrent_candidate_count || 0
    },
    remediation_report: {
      counts: report.remediation_report?.counts || {},
      top_actions: report.remediation_report?.top_actions || [],
      quality_queue: report.remediation_report?.quality_queue || []
    },
    token_economics: {
      raw_source_tokens: report.token_economics.raw_source_tokens,
      estimated_summary_tokens: report.token_economics.estimated_summary_tokens,
      compact_card_coverage_rate: report.token_economics.compact_card_coverage_rate,
      estimated_reduction_percent: report.token_economics.estimated_reduction_percent
    }
  })).sort((a, b) => a.project.localeCompare(b.project));

  const topViolations = projectReports
    .flatMap((report) => report.boundary_report.top_violations)
    .slice(0, 120);
  const highRiskBricks = projectReports
    .flatMap((report) => report.clone_preflight.highest_risk_bricks)
    .sort((a, b) => b.blocker_codes.length - a.blocker_codes.length || b.warning_codes.length - a.warning_codes.length || b.raw_source_tokens - a.raw_source_tokens)
    .slice(0, 120);
  const envGapBricks = projectReports
    .flatMap((report) => report.env_contract_report?.highest_gap_bricks || []);
  const driftEntries = projectReports
    .flatMap((report) => report.manifest_drift.entries)
    .slice(0, 160);
  const codeQualityHotspots = projectReports
    .flatMap((report) => report.code_quality_report?.top_hotspots || []);
  const uniqueCodeQualityHotspots = dedupeQualityHotspots(codeQualityHotspots);
  const codeQualityBricks = projectReports
    .flatMap((report) => report.code_quality_report?.highest_risk_bricks || []);
  const codeQualityDuplicateGroups = projectReports
    .flatMap((report) => report.code_quality_report?.duplicate_groups || []);
  const tokenHeavyBricks = projectReports
    .flatMap((report) => report.token_economics.top_token_heavy_bricks)
    .sort((a, b) => b.raw_source_tokens - a.raw_source_tokens || a.path.localeCompare(b.path))
    .slice(0, 80);
  const duplicateClusters = buildDuplicateClusters(bricks);
  const buildReport = finalizeMergedBuildReport({
    candidate_signatures: projectReports.flatMap((report) => report.build_report?.candidate_signatures || []),
    top_candidates: projectReports.flatMap((report) => report.build_report?.top_candidates || []),
    signal_type_counts: projectReports.reduce((counts, report) => ({
      feature: counts.feature + (report.build_report?.signal_type_counts?.feature || 0),
      domain: counts.domain + (report.build_report?.signal_type_counts?.domain || 0),
      path: counts.path + (report.build_report?.signal_type_counts?.path || 0),
      group: counts.group + (report.build_report?.signal_type_counts?.group || 0)
    }), { feature: 0, domain: 0, path: 0, group: 0 }),
    detected_brick_count: projectReports.reduce((sum, report) => sum + (report.build_report?.detected_brick_count || 0), 0),
    projects: projectReports.map((report) => ({
      project: report.project,
      candidate_count: report.build_report?.candidate_count || 0,
      detected_brick_count: report.build_report?.detected_brick_count || 0,
      average_confidence_score: report.build_report?.average_confidence_score || 0,
      signal_type_counts: report.build_report?.signal_type_counts || { feature: 0, domain: 0, path: 0, group: 0 },
      candidate_signatures: report.build_report?.candidate_signatures || []
    }))
  });
  const mergedEnvNames = new Map();
  const mergedDeclaredEnvNames = new Set();
  const mergedObservedEnvNames = new Set();
  const mergedIgnoredEnvNames = new Set();
  const complianceReport = emptyComplianceReport();
  const remediationCounts = {
    env_contract: 0,
    rls_contract: 0,
    boundary: 0,
    quality: 0
  };
  const mergedCodeQualityCounts = emptyCodeQualityCounts();

  for (const report of projectReports) {
    for (const entry of report.env_contract_report?.top_undeclared_refs || []) {
      const current = mergedEnvNames.get(entry.name) || {
        name: entry.name,
        brick_count: 0,
        sample_bricks: new Set()
      };

      current.brick_count += entry.brick_count || 0;

      for (const brickId of entry.sample_bricks || []) {
        current.sample_bricks.add(brickId);
      }

      mergedEnvNames.set(entry.name, current);
    }
  }

  for (const report of projectReports) {
    for (const name of report.env_contract_report?.observed_variable_names || []) {
      mergedObservedEnvNames.add(name);
    }

    for (const name of report.env_contract_report?.ignored_variable_names || []) {
      mergedIgnoredEnvNames.add(name);
    }
  }

  for (const brick of bricks) {
    for (const entry of brick.env_contract?.variables || []) {
      if (entry?.name) {
        mergedDeclaredEnvNames.add(entry.name);
      }
    }
  }

  for (const report of projectReports) {
    complianceReport.trackable_brick_count += report.compliance_report?.trackable_brick_count || 0;
    complianceReport.highest_gap_bricks.push(...(report.compliance_report?.highest_gap_bricks || []));

    for (const definition of complianceDimensionDefinitions) {
      const current = report.compliance_report?.dimensions?.[definition.key];

      if (!current) {
        continue;
      }

      complianceReport.dimensions[definition.key].ready_count += current.ready_count || 0;
      complianceReport.dimensions[definition.key].coverage_units += current.coverage_units ?? current.ready_count ?? 0;
      complianceReport.dimensions[definition.key].total_count += current.total_count || 0;
    }

    remediationCounts.env_contract += report.remediation_report?.counts?.env_contract || 0;
    remediationCounts.rls_contract += report.remediation_report?.counts?.rls_contract || 0;
    remediationCounts.boundary += report.remediation_report?.counts?.boundary || 0;
    remediationCounts.quality += report.remediation_report?.counts?.quality || 0;
    mergeCodeQualityCounts(mergedCodeQualityCounts, report.code_quality_report?.by_type || {});
  }

  const averageReadiness = projects.length
    ? Math.round(projects.reduce((sum, project) => sum + (project.readiness?.score || 0), 0) / projects.length)
    : 0;
  const finalizedComplianceReport = finalizeComplianceReport(complianceReport);
  const remediationActions = projectReports
    .flatMap((report) => report.remediation_report?.top_actions || [])
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 120);
  const remediationEnvQueue = projectReports
    .flatMap((report) => report.remediation_report?.env_contract_queue || [])
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 80);
  const remediationRlsQueue = projectReports
    .flatMap((report) => report.remediation_report?.rls_contract_queue || [])
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 80);
  const remediationBoundaryQueue = projectReports
    .flatMap((report) => report.remediation_report?.boundary_queue || [])
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 80);
  const remediationQualityQueue = projectReports
    .flatMap((report) => report.remediation_report?.quality_queue || [])
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 80);
  const codeQualityWeight = projectReports.reduce(
    (sum, report) => sum + Number(report.code_quality_report?.analyzed_code_file_count || 0),
    0
  );
  const weightedCodeQualityScore = codeQualityWeight > 0
    ? Math.round(
      projectReports.reduce(
        (sum, report) => sum + (Number(report.code_quality_report?.score || 0) * Number(report.code_quality_report?.analyzed_code_file_count || 0)),
        0
      ) / codeQualityWeight
    )
    : (projects.length
      ? Math.round(projects.reduce((sum, project) => sum + (project.code_quality_report?.score || 0), 0) / projects.length)
      : 0);

  return {
    readiness: {
      average_score: averageReadiness,
      average_grade: gradeForScore(averageReadiness),
      projects
    },
    boundary_report: {
      import_scan_count: projectReports.reduce((sum, report) => sum + (report.boundary_report.import_scan_count || 0), 0),
      same_group_internal_import_count: projectReports.reduce((sum, report) => sum + (report.boundary_report.same_group_internal_import_count || 0), 0),
      private_cross_brick_import_count: projectReports.reduce((sum, report) => sum + (report.boundary_report.private_cross_brick_import_count || 0), 0),
      cross_brick_owned_import_count: projectReports.reduce((sum, report) => sum + (report.boundary_report.cross_brick_owned_import_count || 0), 0),
      unresolved_local_import_count: projectReports.reduce((sum, report) => sum + (report.boundary_report.unresolved_local_import_count || 0), 0),
      unowned_local_dependency_count: projectReports.reduce((sum, report) => sum + (report.boundary_report.unowned_local_dependency_count || 0), 0),
      top_violations: topViolations
    },
    clone_preflight: {
      counts: projectReports.reduce((counts, report) => ({
        copy_ready: counts.copy_ready + (report.clone_preflight.counts.copy_ready || 0),
        guided: counts.guided + (report.clone_preflight.counts.guided || 0),
        manual_review: counts.manual_review + (report.clone_preflight.counts.manual_review || 0),
        blocked: counts.blocked + (report.clone_preflight.counts.blocked || 0)
      }), { copy_ready: 0, guided: 0, manual_review: 0, blocked: 0 }),
      highest_risk_bricks: highRiskBricks
    },
    manifest_drift: {
      count: projectReports.reduce((sum, report) => sum + (report.manifest_drift.count || 0), 0),
      by_type: Object.fromEntries(countBy(driftEntries, (entry) => entry.kind)),
      entries: driftEntries
    },
    code_quality_report: {
      average_score: weightedCodeQualityScore,
      average_grade: gradeForScore(weightedCodeQualityScore),
      analyzed_code_file_count: projectReports.reduce((sum, report) => sum + (report.code_quality_report?.analyzed_code_file_count || 0), 0),
      hotspot_file_count: projectReports.reduce((sum, report) => sum + (report.code_quality_report?.hotspot_file_count || 0), 0),
      brick_hotspot_count: projectReports.reduce((sum, report) => sum + (report.code_quality_report?.brick_hotspot_count || 0), 0),
      duplicate_cluster_count: projectReports.reduce((sum, report) => sum + (report.code_quality_report?.duplicate_cluster_count || 0), 0),
      total_smell_count: projectReports.reduce((sum, report) => sum + (report.code_quality_report?.total_smell_count || 0), 0),
      weighted_smell_score: projectReports.reduce((sum, report) => sum + (report.code_quality_report?.weighted_smell_score || 0), 0),
      by_type: compactCodeQualityCounts(mergedCodeQualityCounts),
      top_hotspots: uniqueCodeQualityHotspots
        .sort((a, b) => (b.smell_score || 0) - (a.smell_score || 0) || (b.total_matches || 0) - (a.total_matches || 0) || String(a.path).localeCompare(String(b.path)))
        .slice(0, 120),
      highest_risk_bricks: codeQualityBricks
        .sort((a, b) => (b.smell_score || 0) - (a.smell_score || 0) || (b.total_matches || 0) - (a.total_matches || 0) || String(a.path).localeCompare(String(b.path)))
        .slice(0, 80),
      duplicate_groups: codeQualityDuplicateGroups
        .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || Number(b.file_count || 0) - Number(a.file_count || 0) || String(a.path).localeCompare(String(b.path)))
        .slice(0, 80)
    },
    env_contract_report: {
      observed_reference_count: projectReports.reduce((sum, report) => sum + (report.env_contract_report?.observed_reference_count || 0), 0),
      observed_variable_count: mergedObservedEnvNames.size,
      observed_variable_names: [...mergedObservedEnvNames].sort(),
      ignored_reference_count: projectReports.reduce((sum, report) => sum + (report.env_contract_report?.ignored_reference_count || 0), 0),
      ignored_variable_count: mergedIgnoredEnvNames.size,
      ignored_variable_names: [...mergedIgnoredEnvNames].sort(),
      declared_variable_count: mergedDeclaredEnvNames.size,
      undeclared_reference_count: projectReports.reduce((sum, report) => sum + (report.env_contract_report?.undeclared_reference_count || 0), 0),
      bricks_with_undeclared_refs: projectReports.reduce((sum, report) => sum + (report.env_contract_report?.bricks_with_undeclared_refs || 0), 0),
      top_undeclared_refs: [...mergedEnvNames.values()]
        .sort((a, b) => b.brick_count - a.brick_count || a.name.localeCompare(b.name))
        .slice(0, 24)
        .map((entry) => ({
          name: entry.name,
          brick_count: entry.brick_count,
          sample_bricks: [...entry.sample_bricks].sort().slice(0, 6)
        })),
      highest_gap_bricks: envGapBricks
        .sort((a, b) => (b.undeclared_env_refs?.length || 0) - (a.undeclared_env_refs?.length || 0) || String(a.path).localeCompare(String(b.path)))
        .slice(0, 80)
    },
    compliance_report: {
      average_score: finalizedComplianceReport.score,
      average_grade: finalizedComplianceReport.grade,
      trackable_brick_count: finalizedComplianceReport.trackable_brick_count,
      dimensions: finalizedComplianceReport.dimensions,
      weakest_dimensions: finalizedComplianceReport.weakest_dimensions,
      highest_gap_bricks: finalizedComplianceReport.highest_gap_bricks
    },
    build_report: buildReport,
    remediation_report: {
      counts: remediationCounts,
      env_contract_queue: remediationEnvQueue,
      rls_contract_queue: remediationRlsQueue,
      boundary_queue: remediationBoundaryQueue,
      quality_queue: remediationQualityQueue,
      top_actions: remediationActions,
      project_action_plans: remediationActionProjectPlans(remediationActions)
    },
    duplicate_clusters: duplicateClusters,
    token_economics: {
      raw_source_tokens: projectReports.reduce((sum, report) => sum + (report.token_economics.raw_source_tokens || 0), 0),
      estimated_summary_tokens: projectReports.reduce((sum, report) => sum + (report.token_economics.estimated_summary_tokens || 0), 0),
      compact_card_tokens: projectReports.reduce((sum, report) => sum + (report.token_economics.compact_card_tokens || 0), 0),
      compact_card_coverage_count: projectReports.reduce((sum, report) => sum + (report.token_economics.compact_card_coverage_count || 0), 0),
      top_token_heavy_bricks: tokenHeavyBricks
    }
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  setActiveExcludedRoots([...new Set<string>((options.excludeRoots || []).map((root: string) => path.resolve(root)).filter((root: string) => root !== path.resolve(options.root)))]);

  if (!(await pathExists(options.root))) {
    throw new Error(`Scan root does not exist: ${options.root}`);
  }

  const bricks = [];
  const failures = [];
  const validationFailures = [];
  const unmanifested = [];
  const projects = [];
  const projectRefactorReports = [];
  const projectScannerReports = [];
  const compactCardIndex = await loadCompactCardIndex();
  const projectRoots = await discoverProjectRoots(options.root, options.projectId);

  for (const projectRoot of projectRoots) {
    const manifestPaths = await walk(projectRoot.root);
    const projectUnmanifested = await discoverPotentialBricks(projectRoot.root, projectRoot.root, [], projectRoot.id);
    const projectBricks = [];

    unmanifested.push(...projectUnmanifested);

    for (const manifestPath of manifestPaths) {
      try {
        const manifest = await readManifest(manifestPath);
        const validation = validateManifest(manifestPath, manifest);
        if (validation.errors.length > 0) validationFailures.push({ manifest_path: manifestPath, brick_id: validation.brick_id, errors: validation.errors });
        const brick = compactBrick(projectRoot.root, manifestPath, manifest, validation, projectRoot.id);
        bricks.push(brick);
        projectBricks.push(brick);
      } catch (error) {
        failures.push({
          manifest_path: manifestPath,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const [projectSummary] = projectHealth(projectRoot.root, projectBricks, projectUnmanifested, projectRoot.id);
    const projectRefactorReport = await analyzeProjectRefactorOpportunities(projectRoot.root, projectRoot.id, projectBricks);
    const projectScannerReport = await analyzeProjectScannerReport(projectRoot.root, projectRoot.id, projectBricks, projectUnmanifested.length, compactCardIndex);

    projectRefactorReports.push(projectRefactorReport);
    projectScannerReports.push(projectScannerReport);
    projects.push({
      ...projectSummary,
      refactor: {
        analyzed_file_count: projectRefactorReport.analyzed_file_count,
        oversized_file_count: projectRefactorReport.oversized_file_count,
        split_opportunity_count: projectRefactorReport.split_opportunity_count,
        missing_source_path_count: projectRefactorReport.missing_source_path_count,
        analysis_failure_count: projectRefactorReport.analysis_failure_count,
        severity_counts: projectRefactorReport.severity_counts
      },
      scanner: {
        readiness: projectScannerReport.readiness,
        boundary_report: {
          same_group_internal_import_count: projectScannerReport.boundary_report.same_group_internal_import_count,
          private_cross_brick_import_count: projectScannerReport.boundary_report.private_cross_brick_import_count,
          cross_brick_owned_import_count: projectScannerReport.boundary_report.cross_brick_owned_import_count,
          unresolved_local_import_count: projectScannerReport.boundary_report.unresolved_local_import_count,
          unowned_local_dependency_count: projectScannerReport.boundary_report.unowned_local_dependency_count
        },
        clone_preflight: projectScannerReport.clone_preflight.counts,
        manifest_drift: {
          count: projectScannerReport.manifest_drift.count
        },
        code_quality_report: {
          score: projectScannerReport.code_quality_report.score,
          grade: projectScannerReport.code_quality_report.grade,
          analyzed_code_file_count: projectScannerReport.code_quality_report.analyzed_code_file_count,
          hotspot_file_count: projectScannerReport.code_quality_report.hotspot_file_count,
          brick_hotspot_count: projectScannerReport.code_quality_report.brick_hotspot_count,
          duplicate_cluster_count: projectScannerReport.code_quality_report.duplicate_cluster_count,
          total_smell_count: projectScannerReport.code_quality_report.total_smell_count,
          weighted_smell_score: projectScannerReport.code_quality_report.weighted_smell_score,
          by_type: projectScannerReport.code_quality_report.by_type
        },
        env_contract_report: {
          observed_reference_count: projectScannerReport.env_contract_report.observed_reference_count,
          undeclared_reference_count: projectScannerReport.env_contract_report.undeclared_reference_count,
          bricks_with_undeclared_refs: projectScannerReport.env_contract_report.bricks_with_undeclared_refs
        },
        compliance_report: {
          score: projectScannerReport.compliance_report.score,
          grade: projectScannerReport.compliance_report.grade,
          trackable_brick_count: projectScannerReport.compliance_report.trackable_brick_count,
          weakest_dimensions: projectScannerReport.compliance_report.weakest_dimensions
        },
        build_report: {
          candidate_count: projectScannerReport.build_report.candidate_count,
          detected_brick_count: projectScannerReport.build_report.detected_brick_count,
          average_confidence_score: projectScannerReport.build_report.average_confidence_score,
          recurrent_candidate_count: projectScannerReport.build_report.recurrent_candidate_count,
          signal_type_counts: projectScannerReport.build_report.signal_type_counts
        },
        remediation_report: {
          counts: projectScannerReport.remediation_report.counts
        },
        token_economics: {
          raw_source_tokens: projectScannerReport.token_economics.raw_source_tokens,
          estimated_summary_tokens: projectScannerReport.token_economics.estimated_summary_tokens,
          compact_card_coverage_rate: projectScannerReport.token_economics.compact_card_coverage_rate,
          estimated_reduction_percent: projectScannerReport.token_economics.estimated_reduction_percent
        }
      }
    });
  }

  const errorCount = bricks.reduce((sum, brick) => sum + brick.health.error_count, 0);
  const warningCount = bricks.reduce((sum, brick) => sum + brick.health.warning_count, 0);
  const groupedCandidates = candidateGroups(unmanifested);
  const refactorReport = buildRefactorReport(projectRefactorReports);
  const scannerReport = buildScannerReport(projectScannerReports, bricks);

  const output = {
    schema_version: "1.0.0",
    generated_at: new Date().toISOString(),
    scan_root: options.root,
    scan_project_id: options.projectId || null,
    excluded_roots: getActiveExcludedRoots(),
    scanned_project_roots: projectRoots,
    projects,
    count: bricks.length,
    failure_count: failures.length,
    validation_error_count: errorCount,
    validation_warning_count: warningCount,
    unmanifested_count: unmanifested.length,
    candidate_group_count: groupedCandidates.length,
    refactor_report: refactorReport,
    scanner_report: scannerReport,
    bricks: bricks.sort((a, b) => a.id.localeCompare(b.id)),
    candidate_groups: groupedCandidates,
    unmanifested_bricks: unmanifested.sort((a, b) => a.path.localeCompare(b.path)),
    failures
  };

  if (failures.length > 0 || errorCount > 0) {
    const rejectedOut = `${options.out}.rejected.json`;
    await writeJsonIfMeaningfulChanged(rejectedOut, { schema_version: "1.0.0", generated_at: output.generated_at, registry_out: options.out,
      forced: options.force, failure_count: failures.length, validation_error_count: errorCount, failures, validation_failures: validationFailures },
    { normalize: normalizeRegistrySnapshot });
    console.error(`[sma-scan] ${options.force ? "WARN --force replaced registry despite manifest errors" : "ERROR manifest errors rejected registry replacement"}; report=${rejectedOut}`);
    if (!options.force) process.exit(options.check ? 1 : 2);
  }
  await writeJsonIfMeaningfulChanged(options.out, output, {
    normalize: normalizeRegistrySnapshot,
  });
  if (options.json) {
    console.log(JSON.stringify({
      count: bricks.length,
      failure_count: failures.length,
      validation_error_count: errorCount,
      validation_warning_count: warningCount,
      unmanifested_count: unmanifested.length,
      candidate_group_count: groupedCandidates.length,
      refactor_report: {
        analyzed_file_count: refactorReport.analyzed_file_count,
        oversized_file_count: refactorReport.oversized_file_count,
        split_opportunity_count: refactorReport.split_opportunity_count,
        refactor_queue_count: refactorReport.refactor_queue.length,
        missing_source_path_count: refactorReport.missing_source_path_count,
        analysis_failure_count: refactorReport.analysis_failure_count,
        severity_counts: refactorReport.severity_counts
      },
      scanner_report: {
        readiness: {
          average_score: scannerReport.readiness.average_score,
          average_grade: scannerReport.readiness.average_grade
        },
        boundary_report: {
          same_group_internal_import_count: scannerReport.boundary_report.same_group_internal_import_count,
          private_cross_brick_import_count: scannerReport.boundary_report.private_cross_brick_import_count,
          cross_brick_owned_import_count: scannerReport.boundary_report.cross_brick_owned_import_count,
          unresolved_local_import_count: scannerReport.boundary_report.unresolved_local_import_count,
          unowned_local_dependency_count: scannerReport.boundary_report.unowned_local_dependency_count
        },
        clone_preflight: scannerReport.clone_preflight.counts,
        manifest_drift: {
          count: scannerReport.manifest_drift.count
        },
        code_quality_report: {
          average_score: scannerReport.code_quality_report.average_score,
          average_grade: scannerReport.code_quality_report.average_grade,
          hotspot_file_count: scannerReport.code_quality_report.hotspot_file_count,
          duplicate_cluster_count: scannerReport.code_quality_report.duplicate_cluster_count,
          total_smell_count: scannerReport.code_quality_report.total_smell_count
        },
        env_contract_report: {
          undeclared_reference_count: scannerReport.env_contract_report.undeclared_reference_count,
          bricks_with_undeclared_refs: scannerReport.env_contract_report.bricks_with_undeclared_refs
        },
        compliance_report: {
          average_score: scannerReport.compliance_report.average_score,
          average_grade: scannerReport.compliance_report.average_grade,
          trackable_brick_count: scannerReport.compliance_report.trackable_brick_count
        },
        build_report: {
          candidate_count: scannerReport.build_report.candidate_count,
          detected_brick_count: scannerReport.build_report.detected_brick_count,
          recurrent_candidate_count: scannerReport.build_report.recurrent_candidate_count,
          recurrent_family_count: scannerReport.build_report.recurrent_family_count
        },
        remediation_report: scannerReport.remediation_report.counts,
        duplicate_cluster_count: scannerReport.duplicate_clusters.length,
        token_economics: {
          raw_source_tokens: scannerReport.token_economics.raw_source_tokens,
          estimated_summary_tokens: scannerReport.token_economics.estimated_summary_tokens,
          compact_card_tokens: scannerReport.token_economics.compact_card_tokens
        }
      },
      out: options.out
    }, null, 2));
  } else {
    console.log(`SMA scan complete: ${bricks.length} manifest brick(s), ${unmanifested.length} unmanifested candidate(s), ${groupedCandidates.length} candidate group(s), ${failures.length} failure(s), ${errorCount} validation error(s), ${warningCount} warning(s), ${refactorReport.oversized_file_count} oversized file(s), ${refactorReport.split_opportunity_count} split opportunity file(s), ${refactorReport.analysis_failure_count} refactor analysis failure(s), readiness ${scannerReport.readiness.average_score}/${scannerReport.readiness.average_grade}, compliance ${scannerReport.compliance_report.average_score}/${scannerReport.compliance_report.average_grade}, code quality ${scannerReport.code_quality_report.average_score}/${scannerReport.code_quality_report.average_grade}, ${scannerReport.code_quality_report.hotspot_file_count} quality hotspot file(s), ${scannerReport.build_report.candidate_count} build candidate(s), ${scannerReport.clone_preflight.counts.blocked} blocked clone candidate(s), ${scannerReport.env_contract_report.bricks_with_undeclared_refs} env-gap brick(s)`);
    console.log(`Wrote ${options.out}`);
  }

  if (options.check && options.strict && warningCount > 0 && !options.force) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
