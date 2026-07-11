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
  getActiveExcludedRoots, parseArgs, pathExists, projectHealth,
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

type ProjectScannerReport = Awaited<ReturnType<typeof analyzeProjectScannerReport>>;
type CompactBrick = ReturnType<typeof compactBrick>;
type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonRecord | JsonValue[];
interface JsonRecord { [key: string]: JsonValue | undefined }
interface EnvNameSummary { name: string; brick_count: number; sample_bricks: Set<string> }

function compactScannerProjects(reports: ProjectScannerReport[]) {
  return reports.map(compactScannerProject).sort((left, right) => left.project.localeCompare(right.project));
}

function compactScannerProject(report: ProjectScannerReport) {
  return {
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
    manifest_drift: { count: report.manifest_drift.count },
    env_contract_report: {
      observed_reference_count: report.env_contract_report.observed_reference_count,
      undeclared_reference_count: report.env_contract_report.undeclared_reference_count,
      bricks_with_undeclared_refs: report.env_contract_report.bricks_with_undeclared_refs
    },
    compliance_report: {
      score: report.compliance_report.score || 0,
      grade: report.compliance_report.grade || "F",
      trackable_brick_count: report.compliance_report.trackable_brick_count || 0,
      weakest_dimensions: report.compliance_report.weakest_dimensions
    },
    code_quality_report: compactProjectQuality(report),
    build_report: {
      candidate_count: report.build_report.candidate_count || 0,
      detected_brick_count: report.build_report.detected_brick_count || 0,
      average_confidence_score: report.build_report.average_confidence_score || 0,
      recurrent_candidate_count: report.build_report.recurrent_candidate_count || 0
    },
    remediation_report: {
      counts: report.remediation_report.counts,
      top_actions: report.remediation_report.top_actions,
      quality_queue: report.remediation_report.quality_queue
    },
    token_economics: {
      raw_source_tokens: report.token_economics.raw_source_tokens,
      estimated_summary_tokens: report.token_economics.estimated_summary_tokens,
      compact_card_coverage_rate: report.token_economics.compact_card_coverage_rate,
      estimated_reduction_percent: report.token_economics.estimated_reduction_percent
    }
  };
}

function compactProjectQuality(report: ProjectScannerReport) {
  const quality = report.code_quality_report;
  return {
    score: quality.score || 0, grade: quality.grade || "F",
    analyzed_code_file_count: quality.analyzed_code_file_count || 0,
    hotspot_file_count: quality.hotspot_file_count || 0,
    brick_hotspot_count: quality.brick_hotspot_count || 0,
    duplicate_cluster_count: quality.duplicate_cluster_count || 0,
    total_smell_count: quality.total_smell_count || 0,
    weighted_smell_score: quality.weighted_smell_score || 0,
    by_type: quality.by_type
  };
}

function collectScannerHighlights(reports: ProjectScannerReport[]) {
  const topViolations = reports.flatMap((report) => report.boundary_report.top_violations).slice(0, 120);
  const highRiskBricks = reports.flatMap((report) => report.clone_preflight.highest_risk_bricks)
    .sort((a, b) => b.blocker_codes.length - a.blocker_codes.length || b.warning_codes.length - a.warning_codes.length || b.raw_source_tokens - a.raw_source_tokens)
    .slice(0, 120);
  const tokenHeavyBricks = reports.flatMap((report) => report.token_economics.top_token_heavy_bricks)
    .sort((a, b) => b.raw_source_tokens - a.raw_source_tokens || a.path.localeCompare(b.path)).slice(0, 80);
  return {
    topViolations,
    highRiskBricks,
    envGapBricks: reports.flatMap((report) => report.env_contract_report.highest_gap_bricks),
    driftEntries: reports.flatMap((report) => report.manifest_drift.entries).slice(0, 160),
    uniqueCodeQualityHotspots: dedupeQualityHotspots(reports.flatMap((report) => report.code_quality_report.top_hotspots)),
    codeQualityBricks: reports.flatMap((report) => report.code_quality_report.highest_risk_bricks),
    codeQualityDuplicateGroups: reports.flatMap((report) => report.code_quality_report.duplicate_groups),
    tokenHeavyBricks
  };
}

function mergedBuildReport(reports: ProjectScannerReport[]) {
  return finalizeMergedBuildReport({
    candidate_signatures: reports.flatMap((report) => report.build_report.candidate_signatures),
    top_candidates: reports.flatMap((report) => report.build_report.top_candidates),
    signal_type_counts: reports.reduce((counts, report) => ({
      feature: counts.feature + (report.build_report.signal_type_counts.feature || 0),
      domain: counts.domain + (report.build_report.signal_type_counts.domain || 0),
      path: counts.path + (report.build_report.signal_type_counts.path || 0),
      group: counts.group + (report.build_report.signal_type_counts.group || 0)
    }), { feature: 0, domain: 0, path: 0, group: 0 }),
    detected_brick_count: reports.reduce((sum, report) => sum + (report.build_report.detected_brick_count || 0), 0),
    projects: reports.map((report) => ({
      project: report.project,
      candidate_count: report.build_report.candidate_count || 0,
      detected_brick_count: report.build_report.detected_brick_count || 0,
      average_confidence_score: report.build_report.average_confidence_score || 0,
      signal_type_counts: report.build_report.signal_type_counts,
      candidate_signatures: report.build_report.candidate_signatures
    }))
  });
}

function mergeEnvState(reports: ProjectScannerReport[], bricks: CompactBrick[]) {
  const mergedEnvNames = new Map<string, EnvNameSummary>();
  const mergedDeclaredEnvNames = new Set<string>();
  const mergedObservedEnvNames = new Set<string>();
  const mergedIgnoredEnvNames = new Set<string>();
  for (const report of reports) {
    mergeUndeclaredEnvNames(mergedEnvNames, report);
    for (const name of report.env_contract_report.observed_variable_names) mergedObservedEnvNames.add(name);
    for (const name of report.env_contract_report.ignored_variable_names) mergedIgnoredEnvNames.add(name);
  }
  for (const brick of bricks) {
    for (const entry of brick.env_contract.variables) if (entry.name) mergedDeclaredEnvNames.add(entry.name);
  }
  return { mergedEnvNames, mergedDeclaredEnvNames, mergedObservedEnvNames, mergedIgnoredEnvNames };
}

function mergeUndeclaredEnvNames(names: Map<string, EnvNameSummary>, report: ProjectScannerReport): void {
  for (const entry of report.env_contract_report.top_undeclared_refs) {
    const current = names.get(entry.name) ?? { name: entry.name, brick_count: 0, sample_bricks: new Set<string>() };
    current.brick_count += entry.brick_count || 0;
    for (const brickId of entry.sample_bricks) current.sample_bricks.add(brickId);
    names.set(entry.name, current);
  }
}

function mergeReportState(reports: ProjectScannerReport[]) {
  const complianceReport = emptyComplianceReport();
  const remediationCounts = { env_contract: 0, rls_contract: 0, boundary: 0, quality: 0 };
  const mergedCodeQualityCounts = emptyCodeQualityCounts();
  for (const report of reports) {
    complianceReport.trackable_brick_count += report.compliance_report.trackable_brick_count || 0;
    complianceReport.highest_gap_bricks.push(...report.compliance_report.highest_gap_bricks);
    mergeComplianceDimensions(complianceReport, report);
    remediationCounts.env_contract += report.remediation_report.counts.env_contract || 0;
    remediationCounts.rls_contract += report.remediation_report.counts.rls_contract || 0;
    remediationCounts.boundary += report.remediation_report.counts.boundary || 0;
    remediationCounts.quality += report.remediation_report.counts.quality || 0;
    mergeCodeQualityCounts(mergedCodeQualityCounts, report.code_quality_report.by_type);
  }
  return { complianceReport, remediationCounts, mergedCodeQualityCounts };
}

function mergeComplianceDimensions(target: ReturnType<typeof emptyComplianceReport>, report: ProjectScannerReport): void {
  for (const definition of complianceDimensionDefinitions) {
    const current = report.compliance_report.dimensions[definition.key];
    const merged = target.dimensions[definition.key];
    merged.ready_count = (merged.ready_count ?? 0) + (current.ready_count || 0);
    merged.coverage_units = (merged.coverage_units ?? 0) + current.coverage_units;
    merged.total_count = (merged.total_count ?? 0) + (current.total_count || 0);
  }
}

function collectRemediationQueues(reports: ProjectScannerReport[]) {
  return {
    remediationActions: sortRemediation(reports.flatMap((report) => report.remediation_report.top_actions), 120),
    remediationEnvQueue: sortRemediation(reports.flatMap((report) => report.remediation_report.env_contract_queue), 80),
    remediationRlsQueue: sortRemediation(reports.flatMap((report) => report.remediation_report.rls_contract_queue), 80),
    remediationBoundaryQueue: sortRemediation(reports.flatMap((report) => report.remediation_report.boundary_queue), 80),
    remediationQualityQueue: sortRemediation(reports.flatMap((report) => report.remediation_report.quality_queue), 80)
  };
}

function sortRemediation<T extends { priority_score?: number; path: string }>(items: T[], limit: number): T[] {
  return items.sort((left, right) => (right.priority_score ?? 0) - (left.priority_score ?? 0) || left.path.localeCompare(right.path)).slice(0, limit);
}

function weightedQualityScore(reports: ProjectScannerReport[], projects: ReturnType<typeof compactScannerProjects>): number {
  const weight = reports.reduce((sum, report) => sum + (report.code_quality_report.analyzed_code_file_count || 0), 0);
  if (weight > 0) {
    const total = reports.reduce((sum, report) => sum + ((report.code_quality_report.score || 0) * (report.code_quality_report.analyzed_code_file_count || 0)), 0);
    return Math.round(total / weight);
  }
  return projects.length ? Math.round(projects.reduce((sum, project) => sum + (project.code_quality_report.score || 0), 0) / projects.length) : 0;
}

function sumReports(reports: ProjectScannerReport[], value: (report: ProjectScannerReport) => number): number {
  return reports.reduce((sum, report) => sum + value(report), 0);
}

function boundarySummary(reports: ProjectScannerReport[], violations: ReturnType<typeof collectScannerHighlights>["topViolations"]) {
  return {
    import_scan_count: sumReports(reports, (report) => report.boundary_report.import_scan_count || 0),
    same_group_internal_import_count: sumReports(reports, (report) => report.boundary_report.same_group_internal_import_count || 0),
    private_cross_brick_import_count: sumReports(reports, (report) => report.boundary_report.private_cross_brick_import_count || 0),
    cross_brick_owned_import_count: sumReports(reports, (report) => report.boundary_report.cross_brick_owned_import_count || 0),
    unresolved_local_import_count: sumReports(reports, (report) => report.boundary_report.unresolved_local_import_count || 0),
    unowned_local_dependency_count: sumReports(reports, (report) => report.boundary_report.unowned_local_dependency_count || 0),
    top_violations: violations
  };
}

function clonePreflightSummary(reports: ProjectScannerReport[], highRiskBricks: ReturnType<typeof collectScannerHighlights>["highRiskBricks"]) {
  return {
    counts: reports.reduce((counts, report) => ({
      copy_ready: counts.copy_ready + (report.clone_preflight.counts.copy_ready || 0),
      guided: counts.guided + (report.clone_preflight.counts.guided || 0),
      manual_review: counts.manual_review + (report.clone_preflight.counts.manual_review || 0),
      blocked: counts.blocked + (report.clone_preflight.counts.blocked || 0)
    }), { copy_ready: 0, guided: 0, manual_review: 0, blocked: 0 }),
    highest_risk_bricks: highRiskBricks
  };
}

function driftSummary(reports: ProjectScannerReport[], entries: ReturnType<typeof collectScannerHighlights>["driftEntries"]) {
  return {
    count: sumReports(reports, (report) => report.manifest_drift.count || 0),
    by_type: Object.fromEntries(countBy(entries, (entry) => entry.kind)),
    entries
  };
}

function qualitySummary(
  reports: ProjectScannerReport[], score: number, counts: ReturnType<typeof emptyCodeQualityCounts>,
  hotspots: ReturnType<typeof collectScannerHighlights>["uniqueCodeQualityHotspots"],
  bricks: ReturnType<typeof collectScannerHighlights>["codeQualityBricks"],
  groups: ReturnType<typeof collectScannerHighlights>["codeQualityDuplicateGroups"],
) {
  const qualityOrder = (left: { smell_score?: number; total_matches?: number; path: string }, right: { smell_score?: number; total_matches?: number; path: string }): number =>
    (right.smell_score ?? 0) - (left.smell_score ?? 0) || (right.total_matches ?? 0) - (left.total_matches ?? 0) || left.path.localeCompare(right.path);
  return {
    average_score: score, average_grade: gradeForScore(score),
    analyzed_code_file_count: sumReports(reports, (report) => report.code_quality_report.analyzed_code_file_count || 0),
    hotspot_file_count: sumReports(reports, (report) => report.code_quality_report.hotspot_file_count || 0),
    brick_hotspot_count: sumReports(reports, (report) => report.code_quality_report.brick_hotspot_count || 0),
    duplicate_cluster_count: sumReports(reports, (report) => report.code_quality_report.duplicate_cluster_count || 0),
    total_smell_count: sumReports(reports, (report) => report.code_quality_report.total_smell_count || 0),
    weighted_smell_score: sumReports(reports, (report) => report.code_quality_report.weighted_smell_score || 0),
    by_type: compactCodeQualityCounts(counts),
    top_hotspots: hotspots.sort(qualityOrder).slice(0, 120),
    highest_risk_bricks: bricks.sort(qualityOrder).slice(0, 80),
    duplicate_groups: groups.sort((left, right) => (right.priority_score || 0) - (left.priority_score || 0)
      || Number(right.file_count ?? 0) - Number(left.file_count ?? 0) || left.path.localeCompare(right.path)).slice(0, 80)
  };
}

function envContractSummary(
  reports: ProjectScannerReport[], state: ReturnType<typeof mergeEnvState>,
  gapBricks: ReturnType<typeof collectScannerHighlights>["envGapBricks"],
) {
  return {
    observed_reference_count: sumReports(reports, (report) => report.env_contract_report.observed_reference_count || 0),
    observed_variable_count: state.mergedObservedEnvNames.size,
    observed_variable_names: [...state.mergedObservedEnvNames].sort(),
    ignored_reference_count: sumReports(reports, (report) => report.env_contract_report.ignored_reference_count || 0),
    ignored_variable_count: state.mergedIgnoredEnvNames.size,
    ignored_variable_names: [...state.mergedIgnoredEnvNames].sort(),
    declared_variable_count: state.mergedDeclaredEnvNames.size,
    undeclared_reference_count: sumReports(reports, (report) => report.env_contract_report.undeclared_reference_count || 0),
    bricks_with_undeclared_refs: sumReports(reports, (report) => report.env_contract_report.bricks_with_undeclared_refs || 0),
    top_undeclared_refs: [...state.mergedEnvNames.values()].sort((left, right) => right.brick_count - left.brick_count || left.name.localeCompare(right.name))
      .slice(0, 24).map((entry) => ({ name: entry.name, brick_count: entry.brick_count, sample_bricks: [...entry.sample_bricks].sort().slice(0, 6) })),
    highest_gap_bricks: gapBricks.sort((left, right) => (right.undeclared_env_refs.length || 0) - (left.undeclared_env_refs.length || 0)
      || left.path.localeCompare(right.path)).slice(0, 80)
  };
}

function tokenEconomicsSummary(reports: ProjectScannerReport[], heavyBricks: ReturnType<typeof collectScannerHighlights>["tokenHeavyBricks"]) {
  return {
    raw_source_tokens: sumReports(reports, (report) => report.token_economics.raw_source_tokens || 0),
    estimated_summary_tokens: sumReports(reports, (report) => report.token_economics.estimated_summary_tokens || 0),
    compact_card_tokens: sumReports(reports, (report) => report.token_economics.compact_card_tokens || 0),
    compact_card_coverage_count: sumReports(reports, (report) => report.token_economics.compact_card_coverage_count || 0),
    top_token_heavy_bricks: heavyBricks
  };
}

function buildScannerReport(projectReports: ProjectScannerReport[], bricks: CompactBrick[]) {
  const projects = compactScannerProjects(projectReports);

  const {
    topViolations, highRiskBricks, envGapBricks, driftEntries, uniqueCodeQualityHotspots,
    codeQualityBricks, codeQualityDuplicateGroups, tokenHeavyBricks
  } = collectScannerHighlights(projectReports);
  const duplicateClusters = buildDuplicateClusters(bricks);
  const buildReport = mergedBuildReport(projectReports);
  const { mergedEnvNames, mergedDeclaredEnvNames, mergedObservedEnvNames, mergedIgnoredEnvNames } = mergeEnvState(projectReports, bricks);
  const { complianceReport, remediationCounts, mergedCodeQualityCounts } = mergeReportState(projectReports);

  const averageReadiness = projects.length
    ? Math.round(projects.reduce((sum, project) => sum + (project.readiness.score || 0), 0) / projects.length)
    : 0;
  const finalizedComplianceReport = finalizeComplianceReport(complianceReport);
  const { remediationActions, remediationEnvQueue, remediationRlsQueue,
    remediationBoundaryQueue, remediationQualityQueue } = collectRemediationQueues(projectReports);
  const weightedCodeQualityScore = weightedQualityScore(projectReports, projects);

  return {
    readiness: {
      average_score: averageReadiness,
      average_grade: gradeForScore(averageReadiness),
      projects
    },
    boundary_report: boundarySummary(projectReports, topViolations),
    clone_preflight: clonePreflightSummary(projectReports, highRiskBricks),
    manifest_drift: driftSummary(projectReports, driftEntries),
    code_quality_report: qualitySummary(projectReports, weightedCodeQualityScore, mergedCodeQualityCounts,
      uniqueCodeQualityHotspots, codeQualityBricks, codeQualityDuplicateGroups),
    env_contract_report: envContractSummary(projectReports, {
      mergedEnvNames, mergedDeclaredEnvNames, mergedObservedEnvNames, mergedIgnoredEnvNames
    }, envGapBricks),
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
      counts: remediationCounts, env_contract_queue: remediationEnvQueue, rls_contract_queue: remediationRlsQueue,
      boundary_queue: remediationBoundaryQueue, quality_queue: remediationQualityQueue, top_actions: remediationActions,
      project_action_plans: remediationActionProjectPlans(remediationActions)
    },
    duplicate_clusters: duplicateClusters,
    token_economics: tokenEconomicsSummary(projectReports, tokenHeavyBricks)
  };
}

async function scanProjects(
  projectRoots: Awaited<ReturnType<typeof discoverProjectRoots>>,
  compactCardIndex: Awaited<ReturnType<typeof loadCompactCardIndex>>,
) {
  const bricks: CompactBrick[] = [];
  const failures: { manifest_path: string; error: string }[] = [];
  const validationFailures: { manifest_path: string; brick_id: string; errors: ReturnType<typeof validateManifest>['errors'] }[] = [];
  const unmanifested: Awaited<ReturnType<typeof discoverPotentialBricks>> = [];
  const projects: ReturnType<typeof scannerProjectSummary>[] = [];
  const projectRefactorReports: Awaited<ReturnType<typeof analyzeProjectRefactorOpportunities>>[] = [];
  const projectScannerReports: ProjectScannerReport[] = [];
  for (const projectRoot of projectRoots) {
    const manifestPaths = await walk(projectRoot.root);
    const projectUnmanifested = await discoverPotentialBricks(projectRoot.root, projectRoot.root, [], projectRoot.id);
    const projectBricks: CompactBrick[] = [];
    unmanifested.push(...projectUnmanifested);
    for (const manifestPath of manifestPaths) {
      await collectManifestBrick(projectRoot, manifestPath, bricks, projectBricks, failures, validationFailures);
    }
    const [projectSummary] = projectHealth(projectRoot.root, projectBricks, projectUnmanifested, projectRoot.id);
    const refactor = await analyzeProjectRefactorOpportunities(projectRoot.root, projectRoot.id, projectBricks);
    const scanner = await analyzeProjectScannerReport(projectRoot.root, projectRoot.id, projectBricks, projectUnmanifested.length, compactCardIndex);
    projectRefactorReports.push(refactor);
    projectScannerReports.push(scanner);
    projects.push(scannerProjectSummary(projectSummary, refactor, scanner));
  }
  return { bricks, failures, validationFailures, unmanifested, projects, projectRefactorReports, projectScannerReports };
}

async function collectManifestBrick(
  projectRoot: Awaited<ReturnType<typeof discoverProjectRoots>>[number],
  manifestPath: string,
  bricks: CompactBrick[],
  projectBricks: CompactBrick[],
  failures: { manifest_path: string; error: string }[],
  validationFailures: { manifest_path: string; brick_id: string; errors: ReturnType<typeof validateManifest>['errors'] }[],
): Promise<void> {
  try {
    const manifest = await readManifest(manifestPath);
    const validation = validateManifest(manifestPath, manifest);
    if (validation.errors.length > 0) validationFailures.push({ manifest_path: manifestPath, brick_id: validation.brick_id, errors: validation.errors });
    const brick = compactBrick(projectRoot.root, manifestPath, manifest, validation, projectRoot.id);
    bricks.push(brick);
    projectBricks.push(brick);
  } catch (error: unknown) {
    failures.push({ manifest_path: manifestPath, error: error instanceof Error ? error.message : String(error) });
  }
}

function scannerProjectSummary(
  projectSummary: ReturnType<typeof projectHealth>[number],
  refactor: Awaited<ReturnType<typeof analyzeProjectRefactorOpportunities>>,
  scanner: ProjectScannerReport,
) {
  return {
    ...projectSummary,
    refactor: {
      analyzed_file_count: refactor.analyzed_file_count, oversized_file_count: refactor.oversized_file_count,
      split_opportunity_count: refactor.split_opportunity_count, missing_source_path_count: refactor.missing_source_path_count,
      analysis_failure_count: refactor.analysis_failure_count, severity_counts: refactor.severity_counts,
    },
    scanner: {
      readiness: scanner.readiness,
      boundary_report: scanner.boundary_report,
      clone_preflight: scanner.clone_preflight.counts,
      manifest_drift: { count: scanner.manifest_drift.count },
      code_quality_report: scanner.code_quality_report,
      env_contract_report: scanner.env_contract_report,
      compliance_report: scanner.compliance_report,
      build_report: scanner.build_report,
      remediation_report: { counts: scanner.remediation_report.counts },
      token_economics: scanner.token_economics,
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  setActiveExcludedRoots([...new Set<string>(options.excludeRoots.map((root: string) => path.resolve(root)).filter((root: string) => root !== path.resolve(options.root)))]);

  if (!(await pathExists(options.root))) {
    throw new Error(`Scan root does not exist: ${options.root}`);
  }

  const compactCardIndex = await loadCompactCardIndex();
  const projectRoots = await discoverProjectRoots(options.root, options.projectId);
  const { bricks, failures, validationFailures, unmanifested, projects, projectRefactorReports, projectScannerReports } =
    await scanProjects(projectRoots, compactCardIndex);

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

  await writeRejectionReport(options, output.generated_at, failures, validationFailures, errorCount);
  await writeJsonIfMeaningfulChanged(options.out, jsonSafe(output), {
    normalize: normalizeRegistrySnapshot,
  });
  printScanSummary(options, { bricks, failures, unmanifested, groupedCandidates, errorCount, warningCount, refactorReport, scannerReport });

  if (options.check && options.strict && warningCount > 0 && !options.force) {
    process.exit(1);
  }
}

async function writeRejectionReport(
  options: ReturnType<typeof parseArgs>,
  generatedAt: string,
  failures: { manifest_path: string; error: string }[],
  validationFailures: unknown[],
  errorCount: number,
): Promise<void> {
  if (failures.length === 0 && errorCount === 0) return;
  const rejectedOut = `${options.out}.rejected.json`;
  await writeJsonIfMeaningfulChanged(rejectedOut, jsonSafe({
    schema_version: "1.0.0", generated_at: generatedAt, registry_out: options.out,
    forced: options.force, failure_count: failures.length, validation_error_count: errorCount,
    failures, validation_failures: validationFailures,
  }), { normalize: normalizeRegistrySnapshot });
  const verdict = options.force ? "WARN --force replaced registry despite manifest errors" : "ERROR manifest errors rejected registry replacement";
  console.error(`[sma-scan] ${verdict}; report=${rejectedOut}`);
  if (!options.force) process.exit(options.check ? 1 : 2);
}

function printScanSummary(options: ReturnType<typeof parseArgs>, data: {
  bricks: CompactBrick[];
  failures: { manifest_path: string; error: string }[];
  unmanifested: Awaited<ReturnType<typeof discoverPotentialBricks>>;
  groupedCandidates: ReturnType<typeof candidateGroups>;
  errorCount: number;
  warningCount: number;
  refactorReport: ReturnType<typeof buildRefactorReport>;
  scannerReport: ReturnType<typeof buildScannerReport>;
}): void {
  if (options.json) {
    console.log(JSON.stringify(compactScanSummary(options.out, data), null, 2));
    return;
  }
  const { bricks, failures, unmanifested, groupedCandidates, errorCount, warningCount, refactorReport, scannerReport } = data;
  console.log(`SMA scan complete: ${String(bricks.length)} manifest brick(s), ${String(unmanifested.length)} unmanifested candidate(s), ${String(groupedCandidates.length)} candidate group(s), ${String(failures.length)} failure(s), ${String(errorCount)} validation error(s), ${String(warningCount)} warning(s), ${String(refactorReport.oversized_file_count)} oversized file(s), ${String(refactorReport.split_opportunity_count)} split opportunity file(s), ${String(refactorReport.analysis_failure_count)} refactor analysis failure(s), readiness ${String(scannerReport.readiness.average_score)}/${scannerReport.readiness.average_grade}, compliance ${String(scannerReport.compliance_report.average_score)}/${scannerReport.compliance_report.average_grade}, code quality ${String(scannerReport.code_quality_report.average_score)}/${scannerReport.code_quality_report.average_grade}, ${String(scannerReport.code_quality_report.hotspot_file_count)} quality hotspot file(s), ${String(scannerReport.build_report.candidate_count)} build candidate(s), ${String(scannerReport.clone_preflight.counts.blocked)} blocked clone candidate(s), ${String(scannerReport.env_contract_report.bricks_with_undeclared_refs)} env-gap brick(s)`);
  console.log(`Wrote ${options.out}`);
}

function compactScanSummary(out: string, data: Parameters<typeof printScanSummary>[1]) {
  const { bricks, failures, unmanifested, groupedCandidates, errorCount, warningCount, refactorReport, scannerReport } = data;
  return {
    count: bricks.length, failure_count: failures.length, validation_error_count: errorCount,
    validation_warning_count: warningCount, unmanifested_count: unmanifested.length,
    candidate_group_count: groupedCandidates.length,
    refactor_report: {
      analyzed_file_count: refactorReport.analyzed_file_count, oversized_file_count: refactorReport.oversized_file_count,
      split_opportunity_count: refactorReport.split_opportunity_count, refactor_queue_count: refactorReport.refactor_queue.length,
      missing_source_path_count: refactorReport.missing_source_path_count, analysis_failure_count: refactorReport.analysis_failure_count,
      severity_counts: refactorReport.severity_counts,
    },
    scanner_report: compactScannerReport(scannerReport),
    out,
  };
}

function compactScannerReport(report: ReturnType<typeof buildScannerReport>) {
  return {
    readiness: { average_score: report.readiness.average_score, average_grade: report.readiness.average_grade },
    boundary_report: {
      same_group_internal_import_count: report.boundary_report.same_group_internal_import_count,
      private_cross_brick_import_count: report.boundary_report.private_cross_brick_import_count,
      cross_brick_owned_import_count: report.boundary_report.cross_brick_owned_import_count,
      unresolved_local_import_count: report.boundary_report.unresolved_local_import_count,
      unowned_local_dependency_count: report.boundary_report.unowned_local_dependency_count,
    },
    clone_preflight: report.clone_preflight.counts,
    manifest_drift: { count: report.manifest_drift.count },
    code_quality_report: {
      average_score: report.code_quality_report.average_score, average_grade: report.code_quality_report.average_grade,
      hotspot_file_count: report.code_quality_report.hotspot_file_count,
      duplicate_cluster_count: report.code_quality_report.duplicate_cluster_count,
      total_smell_count: report.code_quality_report.total_smell_count,
    },
    env_contract_report: {
      undeclared_reference_count: report.env_contract_report.undeclared_reference_count,
      bricks_with_undeclared_refs: report.env_contract_report.bricks_with_undeclared_refs,
    },
    compliance_report: {
      average_score: report.compliance_report.average_score, average_grade: report.compliance_report.average_grade,
      trackable_brick_count: report.compliance_report.trackable_brick_count,
    },
    build_report: {
      candidate_count: report.build_report.candidate_count, detected_brick_count: report.build_report.detected_brick_count,
      recurrent_candidate_count: report.build_report.recurrent_candidate_count,
      recurrent_family_count: report.build_report.recurrent_family_count,
    },
    remediation_report: report.remediation_report.counts,
    duplicate_cluster_count: report.duplicate_clusters.length,
    token_economics: {
      raw_source_tokens: report.token_economics.raw_source_tokens,
      estimated_summary_tokens: report.token_economics.estimated_summary_tokens,
      compact_card_tokens: report.token_economics.compact_card_tokens,
    },
  };
}

function jsonSafe(value: unknown): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
