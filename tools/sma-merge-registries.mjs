#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeRegistrySnapshot, writeJsonIfMeaningfulChanged } from "./lib/stable-generated.mjs";
import { buildCanonicalizationReport, emptyCanonicalizationReport } from "./sma-canonicalization.mjs";
import { SMA_ROOT, smaPath } from "./lib/sma-paths.mjs";

const defaults = {
  out: smaPath("registry/all-projects.generated.json"),
  registry: []
};

function parseArgs(argv) {
  const options = { ...defaults, registry: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--out" && next) {
      options.out = path.resolve(next);
      i += 1;
      continue;
    }

    if ((arg === "--registry" || arg === "--project") && next) {
      options.registry.push(parseRegistryRef(next));
      i += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      console.log(`SMA registry merger

Usage:
  node tools/sma-merge-registries.mjs \\
    --registry acme-studio=~/DEV/SMARCH/scans/acme-studio/latest.registry.json \\
    --registry acme-factory=~/DEV/SMARCH/scans/acme-factory/latest.registry.json \\
    --out ~/DEV/SMARCH/scans/all-projects/latest.registry.json
`);
      process.exit(0);
    }
  }

  if (options.registry.length === 0) {
    throw new Error("At least one --registry id=/path/to/latest.registry.json is required");
  }

  return options;
}

function parseRegistryRef(value) {
  const index = value.indexOf("=");

  if (index === -1) {
    const file = path.resolve(value);
    return {
      id: slugify(path.basename(path.dirname(file)) || "project"),
      file
    };
  }

  return {
    id: slugify(value.slice(0, index)),
    file: path.resolve(value.slice(index + 1))
  };
}

function slugify(value) {
  return String(value || "project")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function maybeSecurityGate(registryFile) {
  const file = path.join(path.dirname(registryFile), "security-gate.json");

  try {
    const report = await readJson(file);
    return {
      status: (report.high_or_critical || 0) > 0 ? "blocked" : "passed",
      findings: report.count || 0,
      high_or_critical: report.high_or_critical || 0,
      scanned_files: report.scanned_files || 0,
      truncated: Boolean(report.truncated)
    };
  } catch {
    return null;
  }
}

function normalizeCodeQualitySummary(summary = {}) {
  const score = Number(
    summary.score
    ?? summary.average_score
    ?? summary.readiness_score
    ?? 0
  );
  const grade = summary.grade || summary.average_grade || "F";

  return {
    score,
    grade,
    analyzed_code_file_count: Number(summary.analyzed_code_file_count || 0),
    hotspot_file_count: Number(summary.hotspot_file_count || 0),
    brick_hotspot_count: Number(summary.brick_hotspot_count || 0),
    duplicate_cluster_count: Number(summary.duplicate_cluster_count || 0),
    total_smell_count: Number(summary.total_smell_count || 0),
    weighted_smell_score: Number(summary.weighted_smell_score || 0),
    by_type: summary.by_type || {}
  };
}

function emptyStatusCounts() {
  return {
    experimental: 0,
    project_bound: 0,
    variant: 0,
    duplicate: 0,
    legacy: 0,
    candidate: 0,
    canonical: 0
  };
}

function emptyRefactorReport() {
  return {
    thresholds: null,
    analyzed_file_count: 0,
    oversized_file_count: 0,
    split_opportunity_count: 0,
    missing_source_path_count: 0,
    analysis_failure_count: 0,
    severity_counts: { medium: 0, high: 0, critical: 0 },
    projects: [],
    top_split_opportunities: [],
    refactor_queue: [],
    oversized_files: [],
    missing_source_paths: [],
    analysis_failures: []
  };
}

function emptyScannerReport() {
  return {
    readiness: {
      average_score: 0,
      average_grade: "F",
      projects: []
    },
    boundary_report: {
      import_scan_count: 0,
      same_group_internal_import_count: 0,
      private_cross_brick_import_count: 0,
      cross_brick_owned_import_count: 0,
      unresolved_local_import_count: 0,
      unowned_local_dependency_count: 0,
      top_violations: []
    },
    clone_preflight: {
      counts: {
        copy_ready: 0,
        guided: 0,
        manual_review: 0,
        blocked: 0
      },
      highest_risk_bricks: []
    },
    manifest_drift: {
      count: 0,
      by_type: {},
      entries: []
    },
    code_quality_report: {
      average_score: 0,
      average_grade: "F",
      analyzed_code_file_count: 0,
      hotspot_file_count: 0,
      brick_hotspot_count: 0,
      duplicate_cluster_count: 0,
      total_smell_count: 0,
      weighted_smell_score: 0,
      by_type: {},
      top_hotspots: [],
      highest_risk_bricks: [],
      duplicate_groups: [],
      projects: []
    },
    env_contract_report: {
      observed_reference_count: 0,
      observed_variable_count: 0,
      observed_variable_names: [],
      ignored_reference_count: 0,
      ignored_variable_count: 0,
      ignored_variable_names: [],
      declared_variable_count: 0,
      undeclared_reference_count: 0,
      bricks_with_undeclared_refs: 0,
      top_undeclared_refs: [],
      highest_gap_bricks: []
    },
    compliance_report: {
      average_score: 0,
      average_grade: "F",
      trackable_brick_count: 0,
      dimensions: {
        boundary_clean: { label: "Boundary clean", weight: 22, ready_count: 0, coverage_units: 0, total_count: 0, coverage_rate: 0 },
        env_contract: { label: "Env contract", weight: 18, ready_count: 0, coverage_units: 0, total_count: 0, coverage_rate: 0 },
        clone_steps: { label: "Clone steps", weight: 12, ready_count: 0, coverage_units: 0, total_count: 0, coverage_rate: 0 },
        test_commands: { label: "Test commands", weight: 12, ready_count: 0, coverage_units: 0, total_count: 0, coverage_rate: 0 },
        known_traps: { label: "Known traps", weight: 10, ready_count: 0, coverage_units: 0, total_count: 0, coverage_rate: 0 },
        public_api: { label: "Public API", weight: 8, ready_count: 0, coverage_units: 0, total_count: 0, coverage_rate: 0 },
        rls_contract: { label: "RLS contract", weight: 8, ready_count: 0, coverage_units: 0, total_count: 0, coverage_rate: 0 },
        source_attestation: { label: "Source attestation", weight: 5, ready_count: 0, coverage_units: 0, total_count: 0, coverage_rate: 0 },
        security_clean: { label: "Security clean", weight: 5, ready_count: 0, coverage_units: 0, total_count: 0, coverage_rate: 0 }
      },
      weakest_dimensions: [],
      highest_gap_bricks: []
    },
    build_report: {
      candidate_count: 0,
      detected_brick_count: 0,
      recurrent_candidate_count: 0,
      recurrent_family_count: 0,
      average_confidence_score: 0,
      signal_type_counts: {
        feature: 0,
        domain: 0,
        path: 0,
        group: 0
      },
      top_candidates: [],
      candidate_signatures: [],
      projects: []
    },
    remediation_report: {
      counts: {
        env_contract: 0,
        rls_contract: 0,
        boundary: 0,
        quality: 0
      },
      env_contract_queue: [],
      rls_contract_queue: [],
      boundary_queue: [],
      quality_queue: [],
      top_actions: [],
      project_action_plans: []
    },
    canonicalization_report: emptyCanonicalizationReport(),
    duplicate_clusters: [],
    token_economics: {
      raw_source_tokens: 0,
      estimated_summary_tokens: 0,
      compact_card_tokens: 0,
      top_token_heavy_bricks: []
    },
    missing_source_paths: [],
    analysis_failures: []
  };
}

function emptyBuildReport(project = null) {
  return {
    ...(project ? { project } : {}),
    candidate_count: 0,
    detected_brick_count: 0,
    recurrent_candidate_count: 0,
    recurrent_family_count: 0,
    average_confidence_score: 0,
    signal_type_counts: {
      feature: 0,
      domain: 0,
      path: 0,
      group: 0
    },
    top_candidates: [],
    candidate_signatures: [],
    projects: []
  };
}

function countBy(items, keyFn) {
  const counts = new Map();

  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));
}

function gradeForScore(score) {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 55) return "D";
  return "F";
}

const complianceDimensionDefinitions = [
  { key: "boundary_clean", label: "Boundary clean", weight: 22 },
  { key: "env_contract", label: "Env contract", weight: 18 },
  { key: "clone_steps", label: "Clone steps", weight: 12 },
  { key: "test_commands", label: "Test commands", weight: 12 },
  { key: "known_traps", label: "Known traps", weight: 10 },
  { key: "public_api", label: "Public API", weight: 8 },
  { key: "rls_contract", label: "RLS contract", weight: 8 },
  { key: "source_attestation", label: "Source attestation", weight: 5 },
  { key: "security_clean", label: "Security clean", weight: 5 }
];

function boundaryViolationPriority(kind) {
  return {
    private_cross_brick_import: 4,
    unresolved_local_import: 3,
    unowned_local_dependency: 2,
    cross_brick_owned_import: 1
  }[kind] || 0;
}

function normalizeDuplicateStem(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|php|cs|sql)$/i, "")
    .replace(/^(use|get|set|create|build|render)-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^(acme-desktop|acme-studio|acme-factory|workspace-root|acme-desktop)-/, "")
    .replace(/^-+|-+$/g, "");
}

function duplicateStemForBrick(brick) {
  const firstSourcePath = String((brick.source_paths || [])[0] || "");
  const pathStem = normalizeDuplicateStem(path.basename(firstSourcePath));
  const nameStem = normalizeDuplicateStem(brick.name || brick.id);
  return pathStem || nameStem || "unknown";
}

function buildDuplicateClusters(bricks) {
  const byStem = new Map();

  for (const brick of bricks) {
    const stem = duplicateStemForBrick(brick);

    if (!stem || stem.length < 4) {
      continue;
    }

    const key = `${stem}:${String(brick.kind || "unknown").replace(/_(module|file)$/, "")}`;
    const current = byStem.get(key) || [];
    current.push(brick);
    byStem.set(key, current);
  }

  return [...byStem.entries()]
    .map(([key, group]) => ({
      key,
      projects: [...new Set(group.map((brick) => brick.project))].sort(),
      kind: group[0]?.kind || "unknown",
      stem: key.split(":")[0],
      count: group.length,
      bricks: group
        .sort((a, b) => (b.score || 0) - (a.score || 0) || a.id.localeCompare(b.id))
        .slice(0, 10)
        .map((brick) => ({
          id: brick.id,
          project: brick.project,
          name: brick.name,
          status: brick.status,
          score: brick.score,
          source_path: (brick.source_paths || [])[0] || ""
        }))
    }))
    .filter((cluster) => cluster.count >= 2 && (cluster.projects.length >= 2 || cluster.count >= 3))
    .sort((a, b) => b.projects.length - a.projects.length || b.count - a.count || a.stem.localeCompare(b.stem))
    .slice(0, 80);
}

function projectSummary(projectId, root, bricks, unmanifested, candidateGroups, securityGate, refactor, scanner) {
  const statusCounts = emptyStatusCounts();
  const healthCounts = { ok: 0, warn: 0, fail: 0 };
  const candidateTypeCounts = {};
  const candidateRoleCounts = {};
  let errorCount = 0;
  let warningCount = 0;
  let scoreTotal = 0;

  for (const brick of bricks) {
    statusCounts[brick.status] = (statusCounts[brick.status] || 0) + 1;
    healthCounts[brick.health?.status || "warn"] = (healthCounts[brick.health?.status || "warn"] || 0) + 1;
    errorCount += brick.health?.error_count || 0;
    warningCount += brick.health?.warning_count || 0;
    scoreTotal += brick.score || 0;
  }

  for (const candidate of unmanifested) {
    candidateTypeCounts[candidate.candidate_type] = (candidateTypeCounts[candidate.candidate_type] || 0) + 1;
    candidateRoleCounts[candidate.hierarchy_role] = (candidateRoleCounts[candidate.hierarchy_role] || 0) + 1;
  }

  return {
    id: projectId,
    root,
    brick_count: bricks.length,
    unmanifested_count: unmanifested.length,
    candidate_group_count: candidateGroups.length,
    status_counts: statusCounts,
    health_counts: healthCounts,
    candidate_type_counts: candidateTypeCounts,
    candidate_role_counts: candidateRoleCounts,
    error_count: errorCount,
    warning_count: warningCount,
    average_score: bricks.length ? Math.round(scoreTotal / bricks.length) : 0,
    security_gate: securityGate || undefined,
    refactor: refactor || undefined,
    scanner: scanner || undefined
  };
}

function normalizeBrick(projectId, brick, seenIds) {
  const originalId = brick.id || "missing-id";
  let id = `${projectId}.${originalId}`;
  let index = 2;

  while (seenIds.has(id)) {
    id = `${projectId}.${originalId}.${index}`;
    index += 1;
  }

  seenIds.add(id);

  return {
    ...brick,
    id,
    project: projectId
  };
}

function normalizeCandidate(projectId, candidate) {
  return {
    ...candidate,
    project: projectId,
    brick_group: candidate.brick_group ? `${projectId}:${candidate.brick_group}` : candidate.brick_group
  };
}

function normalizeGroup(projectId, group) {
  return {
    ...group,
    project: projectId,
    id: `${projectId}:${group.id}`
  };
}

function normalizeRelatedBrickIds(projectId, value) {
  return Array.isArray(value) ? value.map((id) => `${projectId}.${id}`) : value;
}

function normalizeRefactorEntry(projectId, entry) {
  return {
    ...entry,
    project: projectId,
    related_bricks: normalizeRelatedBrickIds(projectId, entry.related_bricks)
  };
}

function normalizeScannerEntry(projectId, entry) {
  return {
    ...entry,
    project: projectId,
    brick_id: entry.brick_id ? `${projectId}.${entry.brick_id}` : entry.brick_id,
    target_brick_id: entry.target_brick_id ? `${projectId}.${entry.target_brick_id}` : entry.target_brick_id,
    related_bricks: normalizeRelatedBrickIds(projectId, entry.related_bricks)
  };
}

function normalizeBuildCandidate(projectId, entry) {
  return {
    ...entry,
    project: projectId,
    candidate_key: entry.candidate_key ? `${projectId}.${entry.candidate_key}` : `${projectId}.build-candidate`,
    brick_ids: normalizeRelatedBrickIds(projectId, entry.brick_ids || []),
    sample_bricks: Array.isArray(entry.sample_bricks)
      ? entry.sample_bricks.map((brick) => ({
        ...brick,
        project: projectId,
        id: brick.id ? `${projectId}.${brick.id}` : brick.id
      }))
      : [],
    recurrent_projects: Array.isArray(entry.recurrent_projects) ? entry.recurrent_projects : []
  };
}

function normalizeBuildSignature(projectId, entry) {
  return {
    ...entry,
    project: projectId,
    candidate_key: entry.candidate_key ? `${projectId}.${entry.candidate_key}` : `${projectId}.build-candidate`
  };
}

function finalizeMergedBuildReport(report) {
  const finalized = {
    ...emptyBuildReport(),
    ...report,
    signal_type_counts: {
      feature: report.signal_type_counts?.feature || 0,
      domain: report.signal_type_counts?.domain || 0,
      path: report.signal_type_counts?.path || 0,
      group: report.signal_type_counts?.group || 0
    }
  };
  const recurrence = new Map();

  for (const signature of finalized.candidate_signatures || []) {
    const key = signature.recurrence_key || "capability";
    const current = recurrence.get(key) || {
      projects: new Set(),
      candidate_count: 0,
      max_confidence_score: 0
    };

    current.projects.add(signature.project);
    current.candidate_count += 1;
    current.max_confidence_score = Math.max(current.max_confidence_score, Number(signature.confidence_score || 0));
    recurrence.set(key, current);
  }

  finalized.candidate_count = (finalized.candidate_signatures || []).length;
  finalized.recurrent_family_count = [...recurrence.values()].filter((entry) => entry.projects.size >= 2).length;
  finalized.recurrent_candidate_count = [...(finalized.candidate_signatures || [])]
    .filter((signature) => (recurrence.get(signature.recurrence_key || "capability")?.projects.size || 0) >= 2)
    .length;
  finalized.average_confidence_score = finalized.candidate_signatures?.length
    ? Math.round(finalized.candidate_signatures.reduce((sum, signature) => sum + Number(signature.confidence_score || 0), 0) / finalized.candidate_signatures.length)
    : 0;
  finalized.top_candidates = [...(finalized.top_candidates || [])]
    .map((candidate) => {
      const recurrenceEntry = recurrence.get(candidate.recurrence_key || "capability");
      return {
        ...candidate,
        recurrent_project_count: recurrenceEntry?.projects.size || 0,
        recurrent_projects: recurrenceEntry ? [...recurrenceEntry.projects].sort() : []
      };
    })
    .sort((a, b) => (b.recurrent_project_count || 0) - (a.recurrent_project_count || 0) || Number(b.confidence_score || 0) - Number(a.confidence_score || 0) || Number(b.brick_count || 0) - Number(a.brick_count || 0) || String(a.name).localeCompare(String(b.name)))
    .slice(0, 40);
  finalized.projects = [...(finalized.projects || [])]
    .map((project) => ({
      ...project,
      recurrent_candidate_count: (project.candidate_signatures || [])
        .filter((signature) => (recurrence.get(signature.recurrence_key || "capability")?.projects.size || 0) >= 2)
        .length
    }))
    .map(({ candidate_signatures, ...project }) => project)
    .sort((a, b) => Number(b.candidate_count || 0) - Number(a.candidate_count || 0) || Number(b.average_confidence_score || 0) - Number(a.average_confidence_score || 0) || String(a.project).localeCompare(String(b.project)));
  finalized.candidate_signatures = [...(finalized.candidate_signatures || [])]
    .sort((a, b) => Number(b.confidence_score || 0) - Number(a.confidence_score || 0) || Number(b.brick_count || 0) - Number(a.brick_count || 0) || String(a.project).localeCompare(String(b.project)))
    .slice(0, 160);
  return finalized;
}

function queuePriorityScore(entry) {
  return Number(entry.priority_score || 0);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = {
    schema_version: "1.0.0",
    generated_at: new Date().toISOString(),
    scan_root: SMA_ROOT,
    scan_project_id: "all-projects",
    scanned_project_roots: [],
    projects: [],
    count: 0,
    failure_count: 0,
    validation_error_count: 0,
    validation_warning_count: 0,
    unmanifested_count: 0,
    candidate_group_count: 0,
    refactor_report: emptyRefactorReport(),
    scanner_report: emptyScannerReport(),
    bricks: [],
    candidate_groups: [],
    unmanifested_bricks: [],
    failures: []
  };
  const seenIds = new Set();

  for (const ref of options.registry) {
    const registry = await readJson(ref.file);
    const projectRoot = registry.scanned_project_roots?.[0]?.root || registry.projects?.[0]?.root || path.dirname(ref.file);
    const securityGate = await maybeSecurityGate(ref.file);
    const bricks = (registry.bricks || []).map((brick) => normalizeBrick(ref.id, brick, seenIds));
    const candidates = (registry.unmanifested_bricks || []).map((candidate) => normalizeCandidate(ref.id, candidate));
    const groups = (registry.candidate_groups || []).map((group) => normalizeGroup(ref.id, group));
    const refactorSummary = registry.projects?.[0]?.refactor
      || registry.refactor_report?.projects?.find((project) => project.project === ref.id)
      || null;
    const refactorReport = registry.refactor_report || null;
    const buildSummary = registry.scanner_report?.build_report?.projects?.find((project) => project.project === ref.id)
      || registry.projects?.[0]?.scanner?.build_report
      || emptyBuildReport(ref.id);
    const scannerSummaryBase = registry.projects?.[0]?.scanner
      || registry.scanner_report?.readiness?.projects?.find((project) => project.project === ref.id)
      || null;
    const scannerSummary = scannerSummaryBase
      ? {
        ...scannerSummaryBase,
        build_report: scannerSummaryBase.build_report || buildSummary
      }
      : null;
    const scannerReport = registry.scanner_report || null;

    output.scanned_project_roots.push({ id: ref.id, root: projectRoot });
    output.projects.push(projectSummary(ref.id, projectRoot, bricks, candidates, groups, securityGate, refactorSummary, scannerSummary));
    output.bricks.push(...bricks);
    output.unmanifested_bricks.push(...candidates);
    output.candidate_groups.push(...groups);
    output.failures.push(...(registry.failures || []));
    output.scanner_report.build_report.projects.push({
      project: ref.id,
      candidate_count: buildSummary.candidate_count || 0,
      detected_brick_count: buildSummary.detected_brick_count || 0,
      average_confidence_score: buildSummary.average_confidence_score || 0,
      signal_type_counts: buildSummary.signal_type_counts || { feature: 0, domain: 0, path: 0, group: 0 },
      candidate_signatures: (registry.scanner_report?.build_report?.candidate_signatures || []).map((entry) => normalizeBuildSignature(ref.id, entry))
    });

    if (refactorReport) {
      output.refactor_report.thresholds = output.refactor_report.thresholds || refactorReport.thresholds || null;
      output.refactor_report.analyzed_file_count += refactorReport.analyzed_file_count || 0;
      output.refactor_report.oversized_file_count += refactorReport.oversized_file_count || 0;
      output.refactor_report.split_opportunity_count += refactorReport.split_opportunity_count || 0;
      output.refactor_report.missing_source_path_count += refactorReport.missing_source_path_count || 0;
      output.refactor_report.analysis_failure_count += refactorReport.analysis_failure_count || 0;
      output.refactor_report.severity_counts.medium += refactorReport.severity_counts?.medium || 0;
      output.refactor_report.severity_counts.high += refactorReport.severity_counts?.high || 0;
      output.refactor_report.severity_counts.critical += refactorReport.severity_counts?.critical || 0;

      if (refactorSummary) {
        output.refactor_report.projects.push({
          project: ref.id,
          analyzed_file_count: refactorSummary.analyzed_file_count || 0,
          oversized_file_count: refactorSummary.oversized_file_count || 0,
          split_opportunity_count: refactorSummary.split_opportunity_count || 0,
          missing_source_path_count: refactorSummary.missing_source_path_count || 0,
          analysis_failure_count: refactorSummary.analysis_failure_count || 0,
          severity_counts: refactorSummary.severity_counts || { medium: 0, high: 0, critical: 0 }
        });
      }

      output.refactor_report.oversized_files.push(...(refactorReport.oversized_files || []).map((entry) => normalizeRefactorEntry(ref.id, entry)));
      output.refactor_report.refactor_queue.push(...(refactorReport.refactor_queue || []).map((entry) => normalizeRefactorEntry(ref.id, entry)));
      output.refactor_report.missing_source_paths.push(...(refactorReport.missing_source_paths || []).map((entry) => normalizeRefactorEntry(ref.id, entry)));
      output.refactor_report.analysis_failures.push(...(refactorReport.analysis_failures || []).map((entry) => normalizeRefactorEntry(ref.id, entry)));
    }

    if (scannerReport) {
      if (scannerSummary) {
        output.scanner_report.readiness.projects.push({
          project: ref.id,
          readiness: scannerSummary.readiness || scannerSummary,
          boundary_report: scannerSummary.boundary_report || {},
          clone_preflight: scannerSummary.clone_preflight || {},
          manifest_drift: scannerSummary.manifest_drift || {},
          code_quality_report: scannerSummary.code_quality_report || {},
          env_contract_report: scannerSummary.env_contract_report || {},
          compliance_report: scannerSummary.compliance_report || {},
          build_report: scannerSummary.build_report || emptyBuildReport(ref.id),
          remediation_report: scannerSummary.remediation_report || {},
          token_economics: scannerSummary.token_economics || {}
        });
      }

      output.scanner_report.boundary_report.import_scan_count += scannerReport.boundary_report?.import_scan_count || 0;
      output.scanner_report.boundary_report.same_group_internal_import_count += scannerReport.boundary_report?.same_group_internal_import_count || 0;
      output.scanner_report.boundary_report.private_cross_brick_import_count += scannerReport.boundary_report?.private_cross_brick_import_count || 0;
      output.scanner_report.boundary_report.cross_brick_owned_import_count += scannerReport.boundary_report?.cross_brick_owned_import_count || 0;
      output.scanner_report.boundary_report.unresolved_local_import_count += scannerReport.boundary_report?.unresolved_local_import_count || 0;
      output.scanner_report.boundary_report.unowned_local_dependency_count += scannerReport.boundary_report?.unowned_local_dependency_count || 0;
      output.scanner_report.boundary_report.top_violations.push(...(scannerReport.boundary_report?.top_violations || []).map((entry) => normalizeScannerEntry(ref.id, entry)));

      output.scanner_report.clone_preflight.counts.copy_ready += scannerReport.clone_preflight?.counts?.copy_ready || 0;
      output.scanner_report.clone_preflight.counts.guided += scannerReport.clone_preflight?.counts?.guided || 0;
      output.scanner_report.clone_preflight.counts.manual_review += scannerReport.clone_preflight?.counts?.manual_review || 0;
      output.scanner_report.clone_preflight.counts.blocked += scannerReport.clone_preflight?.counts?.blocked || 0;
      output.scanner_report.clone_preflight.highest_risk_bricks.push(...(scannerReport.clone_preflight?.highest_risk_bricks || []).map((entry) => normalizeScannerEntry(ref.id, entry)));

      output.scanner_report.manifest_drift.count += scannerReport.manifest_drift?.count || 0;
      output.scanner_report.manifest_drift.entries.push(...(scannerReport.manifest_drift?.entries || []).map((entry) => normalizeScannerEntry(ref.id, entry)));

      output.scanner_report.code_quality_report.analyzed_code_file_count += scannerReport.code_quality_report?.analyzed_code_file_count || 0;
      output.scanner_report.code_quality_report.hotspot_file_count += scannerReport.code_quality_report?.hotspot_file_count || 0;
      output.scanner_report.code_quality_report.brick_hotspot_count += scannerReport.code_quality_report?.brick_hotspot_count || 0;
      output.scanner_report.code_quality_report.duplicate_cluster_count += scannerReport.code_quality_report?.duplicate_cluster_count || 0;
      output.scanner_report.code_quality_report.total_smell_count += scannerReport.code_quality_report?.total_smell_count || 0;
      output.scanner_report.code_quality_report.weighted_smell_score += scannerReport.code_quality_report?.weighted_smell_score || 0;
      output.scanner_report.code_quality_report.projects.push({
        project: ref.id,
        ...normalizeCodeQualitySummary(
          scannerSummary?.code_quality_report
          || scannerReport.code_quality_report
          || {}
        )
      });
      output.scanner_report.code_quality_report.top_hotspots.push(...(scannerReport.code_quality_report?.top_hotspots || []).map((entry) => normalizeScannerEntry(ref.id, entry)));
      output.scanner_report.code_quality_report.highest_risk_bricks.push(...(scannerReport.code_quality_report?.highest_risk_bricks || []).map((entry) => normalizeScannerEntry(ref.id, entry)));
      output.scanner_report.code_quality_report.duplicate_groups.push(...(scannerReport.code_quality_report?.duplicate_groups || []).map((entry) => normalizeScannerEntry(ref.id, entry)));

      output.scanner_report.env_contract_report.observed_reference_count += scannerReport.env_contract_report?.observed_reference_count || 0;
      output.scanner_report.env_contract_report.ignored_reference_count += scannerReport.env_contract_report?.ignored_reference_count || 0;
      output.scanner_report.env_contract_report.undeclared_reference_count += scannerReport.env_contract_report?.undeclared_reference_count || 0;
      output.scanner_report.env_contract_report.bricks_with_undeclared_refs += scannerReport.env_contract_report?.bricks_with_undeclared_refs || 0;
      output.scanner_report.env_contract_report.observed_variable_names.push(...(scannerReport.env_contract_report?.observed_variable_names || []));
      output.scanner_report.env_contract_report.ignored_variable_names.push(...(scannerReport.env_contract_report?.ignored_variable_names || []));
      output.scanner_report.env_contract_report.top_undeclared_refs.push(...(scannerReport.env_contract_report?.top_undeclared_refs || []));
      output.scanner_report.env_contract_report.highest_gap_bricks.push(...(scannerReport.env_contract_report?.highest_gap_bricks || []).map((entry) => normalizeScannerEntry(ref.id, entry)));

      output.scanner_report.compliance_report.trackable_brick_count += scannerReport.compliance_report?.trackable_brick_count || 0;
      output.scanner_report.compliance_report.highest_gap_bricks.push(...(scannerReport.compliance_report?.highest_gap_bricks || []).map((entry) => normalizeScannerEntry(ref.id, entry)));

      for (const definition of complianceDimensionDefinitions) {
        const current = scannerReport.compliance_report?.dimensions?.[definition.key];

        if (!current) {
          continue;
        }

        output.scanner_report.compliance_report.dimensions[definition.key].ready_count += current.ready_count || 0;
        output.scanner_report.compliance_report.dimensions[definition.key].coverage_units += current.coverage_units ?? current.ready_count ?? 0;
        output.scanner_report.compliance_report.dimensions[definition.key].total_count += current.total_count || 0;
      }

      output.scanner_report.build_report.detected_brick_count += scannerReport.build_report?.detected_brick_count || 0;
      output.scanner_report.build_report.signal_type_counts.feature += scannerReport.build_report?.signal_type_counts?.feature || 0;
      output.scanner_report.build_report.signal_type_counts.domain += scannerReport.build_report?.signal_type_counts?.domain || 0;
      output.scanner_report.build_report.signal_type_counts.path += scannerReport.build_report?.signal_type_counts?.path || 0;
      output.scanner_report.build_report.signal_type_counts.group += scannerReport.build_report?.signal_type_counts?.group || 0;
      output.scanner_report.build_report.top_candidates.push(...(scannerReport.build_report?.top_candidates || []).map((entry) => normalizeBuildCandidate(ref.id, entry)));
      output.scanner_report.build_report.candidate_signatures.push(...(scannerReport.build_report?.candidate_signatures || []).map((entry) => normalizeBuildSignature(ref.id, entry)));

      output.scanner_report.remediation_report.counts.env_contract += scannerReport.remediation_report?.counts?.env_contract || 0;
      output.scanner_report.remediation_report.counts.rls_contract += scannerReport.remediation_report?.counts?.rls_contract || 0;
      output.scanner_report.remediation_report.counts.boundary += scannerReport.remediation_report?.counts?.boundary || 0;
      output.scanner_report.remediation_report.counts.quality += scannerReport.remediation_report?.counts?.quality || 0;
      output.scanner_report.remediation_report.env_contract_queue.push(...(scannerReport.remediation_report?.env_contract_queue || []).map((entry) => normalizeScannerEntry(ref.id, entry)));
      output.scanner_report.remediation_report.rls_contract_queue.push(...(scannerReport.remediation_report?.rls_contract_queue || []).map((entry) => normalizeScannerEntry(ref.id, entry)));
      output.scanner_report.remediation_report.boundary_queue.push(...(scannerReport.remediation_report?.boundary_queue || []).map((entry) => normalizeScannerEntry(ref.id, entry)));
      output.scanner_report.remediation_report.quality_queue.push(...(scannerReport.remediation_report?.quality_queue || []).map((entry) => normalizeScannerEntry(ref.id, entry)));
      output.scanner_report.remediation_report.top_actions.push(...(scannerReport.remediation_report?.top_actions || []).map((entry) => normalizeScannerEntry(ref.id, entry)));

      output.scanner_report.token_economics.raw_source_tokens += scannerReport.token_economics?.raw_source_tokens || 0;
      output.scanner_report.token_economics.estimated_summary_tokens += scannerReport.token_economics?.estimated_summary_tokens || 0;
      output.scanner_report.token_economics.compact_card_tokens += scannerReport.token_economics?.compact_card_tokens || 0;
      output.scanner_report.token_economics.top_token_heavy_bricks.push(...(scannerReport.token_economics?.top_token_heavy_bricks || []).map((entry) => normalizeScannerEntry(ref.id, entry)));

      output.scanner_report.missing_source_paths.push(...(scannerReport.missing_source_paths || []).map((entry) => normalizeScannerEntry(ref.id, entry)));
      output.scanner_report.analysis_failures.push(...(scannerReport.analysis_failures || []).map((entry) => normalizeScannerEntry(ref.id, entry)));
    }
  }

  output.bricks.sort((a, b) => a.project.localeCompare(b.project) || a.id.localeCompare(b.id));
  output.unmanifested_bricks.sort((a, b) => a.project.localeCompare(b.project) || String(a.path).localeCompare(String(b.path)));
  output.candidate_groups.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
  output.projects.sort((a, b) => a.id.localeCompare(b.id));
  output.refactor_report.projects.sort((a, b) => a.project.localeCompare(b.project));
  output.refactor_report.oversized_files.sort((a, b) => {
    const severityOrder = (b.severity === "critical" ? 3 : b.severity === "high" ? 2 : b.severity === "medium" ? 1 : 0)
      - (a.severity === "critical" ? 3 : a.severity === "high" ? 2 : a.severity === "medium" ? 1 : 0);
    return severityOrder || (b.lines || 0) - (a.lines || 0) || String(a.path).localeCompare(String(b.path));
  });
  output.refactor_report.refactor_queue.sort((a, b) => queuePriorityScore(b) - queuePriorityScore(a) || (b.lines || 0) - (a.lines || 0) || String(a.path).localeCompare(String(b.path)));
  output.refactor_report.refactor_queue = output.refactor_report.refactor_queue
    .slice(0, 100)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
  output.refactor_report.missing_source_paths.sort((a, b) => a.project.localeCompare(b.project) || String(a.path).localeCompare(String(b.path)));
  output.refactor_report.analysis_failures.sort((a, b) => a.project.localeCompare(b.project) || String(a.path).localeCompare(String(b.path)));
  output.refactor_report.top_split_opportunities = output.refactor_report.oversized_files
    .filter((file) => Array.isArray(file.split_points) && file.split_points.length > 0)
    .slice(0, 50);
  output.scanner_report.readiness.projects.sort((a, b) => a.project.localeCompare(b.project));
  output.scanner_report.readiness.average_score = output.scanner_report.readiness.projects.length
    ? Math.round(output.scanner_report.readiness.projects.reduce((sum, project) => sum + (project.readiness?.score || 0), 0) / output.scanner_report.readiness.projects.length)
    : 0;
  output.scanner_report.readiness.average_grade = gradeForScore(output.scanner_report.readiness.average_score);
  output.scanner_report.boundary_report.top_violations = output.scanner_report.boundary_report.top_violations
    .sort((a, b) => boundaryViolationPriority(b.kind) - boundaryViolationPriority(a.kind) || String(a.file).localeCompare(String(b.file)))
    .slice(0, 120);
  output.scanner_report.clone_preflight.highest_risk_bricks = output.scanner_report.clone_preflight.highest_risk_bricks
    .sort((a, b) => (b.blocker_codes?.length || 0) - (a.blocker_codes?.length || 0) || (b.warning_codes?.length || 0) - (a.warning_codes?.length || 0) || (b.raw_source_tokens || 0) - (a.raw_source_tokens || 0))
    .slice(0, 120);
  output.scanner_report.manifest_drift.by_type = countBy(output.scanner_report.manifest_drift.entries, (entry) => entry.kind);
  output.scanner_report.manifest_drift.entries = output.scanner_report.manifest_drift.entries
    .sort((a, b) => String(a.path).localeCompare(String(b.path)))
    .slice(0, 160);
  output.scanner_report.code_quality_report.projects = output.scanner_report.code_quality_report.projects
    .sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.project).localeCompare(String(b.project)));
  {
    const codeQualityWeight = output.scanner_report.code_quality_report.projects.reduce(
      (sum, project) => sum + Number(project.analyzed_code_file_count || 0),
      0
    );
    output.scanner_report.code_quality_report.average_score = codeQualityWeight > 0
      ? Math.round(
        output.scanner_report.code_quality_report.projects.reduce(
          (sum, project) => sum + (Number(project.score || 0) * Number(project.analyzed_code_file_count || 0)),
          0
        ) / codeQualityWeight
      )
      : (output.scanner_report.code_quality_report.projects.length
        ? Math.round(
          output.scanner_report.code_quality_report.projects.reduce((sum, project) => sum + (project.score || 0), 0)
          / output.scanner_report.code_quality_report.projects.length
        )
        : 0);
  }
  output.scanner_report.code_quality_report.average_grade = gradeForScore(output.scanner_report.code_quality_report.average_score);
  {
    const aggregatedTypeCounts = {};

    for (const project of output.scanner_report.code_quality_report.projects) {
      for (const [key, count] of Object.entries(project.by_type || {})) {
        aggregatedTypeCounts[key] = (aggregatedTypeCounts[key] || 0) + Number(count || 0);
      }
    }

    output.scanner_report.code_quality_report.by_type = Object.fromEntries(
      Object.entries(aggregatedTypeCounts)
        .filter(([, count]) => count > 0)
        .sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0])))
    );
  }
  output.scanner_report.code_quality_report.top_hotspots = output.scanner_report.code_quality_report.top_hotspots
    .sort((a, b) => (b.smell_score || 0) - (a.smell_score || 0) || (b.total_matches || 0) - (a.total_matches || 0) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 120);
  output.scanner_report.code_quality_report.highest_risk_bricks = output.scanner_report.code_quality_report.highest_risk_bricks
    .sort((a, b) => (b.smell_score || 0) - (a.smell_score || 0) || (b.total_matches || 0) - (a.total_matches || 0) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 80);
  output.scanner_report.code_quality_report.duplicate_groups = output.scanner_report.code_quality_report.duplicate_groups
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || Number(b.file_count || 0) - Number(a.file_count || 0) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 80);
  {
    const observedEnvNames = new Set();
    const ignoredEnvNames = new Set();
    const declaredEnvNames = new Set();
    const undeclaredEnvNames = new Map();

    for (const name of output.scanner_report.env_contract_report.observed_variable_names || []) {
      observedEnvNames.add(name);
    }

    for (const name of output.scanner_report.env_contract_report.ignored_variable_names || []) {
      ignoredEnvNames.add(name);
    }

    for (const brick of output.bricks) {
      for (const entry of brick.env_contract?.variables || []) {
        if (entry?.name) {
          declaredEnvNames.add(entry.name);
        }
      }
    }

    for (const entry of output.scanner_report.env_contract_report.top_undeclared_refs || []) {
      const current = undeclaredEnvNames.get(entry.name) || {
        name: entry.name,
        brick_count: 0,
        sample_bricks: new Set()
      };

      current.brick_count += entry.brick_count || 0;

      for (const brickId of entry.sample_bricks || []) {
        current.sample_bricks.add(brickId);
      }

      undeclaredEnvNames.set(entry.name, current);
    }

    for (const entry of output.scanner_report.env_contract_report.highest_gap_bricks || []) {
      for (const name of entry.undeclared_env_refs || []) {
        const current = undeclaredEnvNames.get(name) || {
          name,
          brick_count: 0,
          sample_bricks: new Set()
        };

        if (!undeclaredEnvNames.has(name)) {
          current.brick_count += 1;
        }

        current.sample_bricks.add(entry.brick_id);
        undeclaredEnvNames.set(name, current);
      }
    }

    output.scanner_report.env_contract_report.observed_variable_names = [...observedEnvNames].sort();
    output.scanner_report.env_contract_report.observed_variable_count = observedEnvNames.size;
    output.scanner_report.env_contract_report.ignored_variable_names = [...ignoredEnvNames].sort();
    output.scanner_report.env_contract_report.ignored_variable_count = ignoredEnvNames.size;
    output.scanner_report.env_contract_report.declared_variable_count = declaredEnvNames.size;
    output.scanner_report.env_contract_report.top_undeclared_refs = [...undeclaredEnvNames.values()]
      .sort((a, b) => b.brick_count - a.brick_count || a.name.localeCompare(b.name))
      .slice(0, 24)
      .map((entry) => ({
        name: entry.name,
        brick_count: entry.brick_count,
        sample_bricks: [...entry.sample_bricks].sort().slice(0, 6)
      }));
    output.scanner_report.env_contract_report.highest_gap_bricks = output.scanner_report.env_contract_report.highest_gap_bricks
      .sort((a, b) => (b.undeclared_env_refs?.length || 0) - (a.undeclared_env_refs?.length || 0) || String(a.path).localeCompare(String(b.path)))
      .slice(0, 80);
  }
  {
    const activeDimensions = [];

    for (const definition of complianceDimensionDefinitions) {
      const current = output.scanner_report.compliance_report.dimensions[definition.key];
      const totalCount = Number(current.total_count || 0);
      const readyCount = Number(current.ready_count || 0);
      const coverageUnits = Number((current.coverage_units ?? readyCount) || 0);
      const coverageRate = totalCount > 0 ? Math.round((coverageUnits / totalCount) * 100) : 100;

      output.scanner_report.compliance_report.dimensions[definition.key] = {
        label: current.label || definition.label,
        weight: Number(current.weight || definition.weight),
        ready_count: readyCount,
        coverage_units: Number(coverageUnits.toFixed(2)),
        total_count: totalCount,
        coverage_rate: coverageRate
      };

      if (totalCount > 0) {
        activeDimensions.push([definition.key, output.scanner_report.compliance_report.dimensions[definition.key]]);
      }
    }

    const weightTotal = activeDimensions.reduce((sum, [, dimension]) => sum + dimension.weight, 0);
    output.scanner_report.compliance_report.average_score = weightTotal > 0
      ? Math.round(activeDimensions.reduce((sum, [, dimension]) => sum + (dimension.coverage_rate * dimension.weight), 0) / weightTotal)
      : 100;
    output.scanner_report.compliance_report.average_grade = gradeForScore(output.scanner_report.compliance_report.average_score);
    output.scanner_report.compliance_report.weakest_dimensions = activeDimensions
      .sort((a, b) => a[1].coverage_rate - b[1].coverage_rate || b[1].total_count - a[1].total_count || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([key, dimension]) => ({
        key,
        label: dimension.label,
        coverage_rate: dimension.coverage_rate,
        ready_count: dimension.ready_count,
        total_count: dimension.total_count
      }));
    output.scanner_report.compliance_report.highest_gap_bricks = output.scanner_report.compliance_report.highest_gap_bricks
      .sort((a, b) => (b.missing_count || 0) - (a.missing_count || 0) || (b.raw_source_tokens || 0) - (a.raw_source_tokens || 0) || String(a.path).localeCompare(String(b.path)))
      .slice(0, 80);
  }
  output.scanner_report.build_report = finalizeMergedBuildReport(output.scanner_report.build_report);
  {
    const sortActions = (items, limit) => items
      .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || String(a.path).localeCompare(String(b.path)))
      .slice(0, limit);
    const byProject = new Map();

    output.scanner_report.remediation_report.env_contract_queue = sortActions(output.scanner_report.remediation_report.env_contract_queue, 80);
    output.scanner_report.remediation_report.rls_contract_queue = sortActions(output.scanner_report.remediation_report.rls_contract_queue, 80);
    output.scanner_report.remediation_report.boundary_queue = sortActions(output.scanner_report.remediation_report.boundary_queue, 80);
    output.scanner_report.remediation_report.quality_queue = sortActions(output.scanner_report.remediation_report.quality_queue, 80);
    output.scanner_report.remediation_report.top_actions = sortActions(output.scanner_report.remediation_report.top_actions, 120);

    for (const action of output.scanner_report.remediation_report.top_actions) {
      const current = byProject.get(action.project) || [];
      current.push(action);
      byProject.set(action.project, current);
    }

    output.scanner_report.remediation_report.project_action_plans = [...byProject.entries()]
      .map(([project, actions]) => ({
        project,
        actions: sortActions(actions, 3)
      }))
      .sort((a, b) => (b.actions[0]?.priority_score || 0) - (a.actions[0]?.priority_score || 0) || a.project.localeCompare(b.project));
  }
  output.scanner_report.duplicate_clusters = buildDuplicateClusters(output.bricks);
  output.scanner_report.canonicalization_report = buildCanonicalizationReport(output);
  output.scanner_report.token_economics.top_token_heavy_bricks = output.scanner_report.token_economics.top_token_heavy_bricks
    .sort((a, b) => (b.raw_source_tokens || 0) - (a.raw_source_tokens || 0) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 80);
  output.scanner_report.missing_source_paths = output.scanner_report.missing_source_paths
    .sort((a, b) => String(a.path).localeCompare(String(b.path)));
  output.scanner_report.analysis_failures = output.scanner_report.analysis_failures
    .sort((a, b) => String(a.path).localeCompare(String(b.path)));
  output.count = output.bricks.length;
  output.failure_count = output.failures.length;
  output.validation_error_count = output.projects.reduce((sum, project) => sum + (project.error_count || 0), 0);
  output.validation_warning_count = output.projects.reduce((sum, project) => sum + (project.warning_count || 0), 0);
  output.unmanifested_count = output.unmanifested_bricks.length;
  output.candidate_group_count = output.candidate_groups.length;

  await writeJsonIfMeaningfulChanged(options.out, output, {
    normalize: normalizeRegistrySnapshot,
  });

  console.log(JSON.stringify({
    out: options.out,
    projects: output.projects.length,
    count: output.count,
    unmanifested_count: output.unmanifested_count,
    validation_error_count: output.validation_error_count,
    validation_warning_count: output.validation_warning_count,
    refactor_report: {
      analyzed_file_count: output.refactor_report.analyzed_file_count,
      oversized_file_count: output.refactor_report.oversized_file_count,
      split_opportunity_count: output.refactor_report.split_opportunity_count,
      refactor_queue_count: output.refactor_report.refactor_queue.length,
      missing_source_path_count: output.refactor_report.missing_source_path_count,
      analysis_failure_count: output.refactor_report.analysis_failure_count,
      severity_counts: output.refactor_report.severity_counts
    },
    scanner_report: {
      readiness: {
        average_score: output.scanner_report.readiness.average_score,
        average_grade: output.scanner_report.readiness.average_grade
      },
      boundary_report: {
        same_group_internal_import_count: output.scanner_report.boundary_report.same_group_internal_import_count,
        private_cross_brick_import_count: output.scanner_report.boundary_report.private_cross_brick_import_count,
        cross_brick_owned_import_count: output.scanner_report.boundary_report.cross_brick_owned_import_count,
        unresolved_local_import_count: output.scanner_report.boundary_report.unresolved_local_import_count,
        unowned_local_dependency_count: output.scanner_report.boundary_report.unowned_local_dependency_count
      },
      clone_preflight: output.scanner_report.clone_preflight.counts,
      manifest_drift: {
        count: output.scanner_report.manifest_drift.count
      },
      code_quality_report: {
        average_score: output.scanner_report.code_quality_report.average_score,
        average_grade: output.scanner_report.code_quality_report.average_grade,
        hotspot_file_count: output.scanner_report.code_quality_report.hotspot_file_count,
        duplicate_cluster_count: output.scanner_report.code_quality_report.duplicate_cluster_count,
        total_smell_count: output.scanner_report.code_quality_report.total_smell_count
      },
      env_contract_report: {
        undeclared_reference_count: output.scanner_report.env_contract_report.undeclared_reference_count,
        bricks_with_undeclared_refs: output.scanner_report.env_contract_report.bricks_with_undeclared_refs
      },
      compliance_report: {
        average_score: output.scanner_report.compliance_report.average_score,
        average_grade: output.scanner_report.compliance_report.average_grade,
        trackable_brick_count: output.scanner_report.compliance_report.trackable_brick_count
      },
      build_report: {
        candidate_count: output.scanner_report.build_report.candidate_count,
        detected_brick_count: output.scanner_report.build_report.detected_brick_count,
        recurrent_candidate_count: output.scanner_report.build_report.recurrent_candidate_count,
        recurrent_family_count: output.scanner_report.build_report.recurrent_family_count
      },
      canonicalization_report: {
        project_canonicalization_ready: output.scanner_report.canonicalization_report.project_canonicalization_ready,
        bottleneck_mode: output.scanner_report.canonicalization_report.bottleneck_mode,
        ready_project_count: output.scanner_report.canonicalization_report.counts.ready_project_count,
        project_work_bottleneck_count: output.scanner_report.canonicalization_report.counts.project_work_bottleneck_count,
        top_target_count: output.scanner_report.canonicalization_report.top_targets.length
      },
      remediation_report: output.scanner_report.remediation_report.counts,
      duplicate_cluster_count: output.scanner_report.duplicate_clusters.length,
      token_economics: {
        raw_source_tokens: output.scanner_report.token_economics.raw_source_tokens,
        estimated_summary_tokens: output.scanner_report.token_economics.estimated_summary_tokens,
        compact_card_tokens: output.scanner_report.token_economics.compact_card_tokens
      }
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
