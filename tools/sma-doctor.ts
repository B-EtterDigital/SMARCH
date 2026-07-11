#!/usr/bin/env node
/**
 * WHAT: Diagnoses portfolio or project health from generated registry and state snapshots.
 * WHY: Operators need actionable causes and next commands instead of isolated health metrics.
 * HOW: Joins registry, state, lease, build, and adoption summaries for the requested scope.
 * INPUTS: Optional project, snapshot-path, result-limit, and structured-output options.
 * OUTPUTS: A concise diagnosis with prioritized repair actions or structured data.
 * CALLERS: Human operators and troubleshooting workflows investigating blocked progress.
 * Usage: `node tools/sma-doctor.ts --help`
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { PROJECTS_ROOT } from "./lib/sma-paths.ts";

import {
  compareBy,
  DEFAULT_REGISTRY_PATH,
  DEFAULT_STATE_PATH,
  findProjectEntries,
  formatNumber,
  loadStateAndRegistry,
  parseArgs,
  relativeFromCwd,
  topList
} from "./lib/adoption-utils.ts";
import { collectProjectGen3 } from "./lib/gen3-state.ts";

const HELP_TEXT = `Usage: node tools/sma-doctor.ts [options]

Summarize current SMA/SMARCH repo health from the generated registry and state.

Options:
  --project <id>        Focus on one scanned project id.
  --state <path>        Override state snapshot path.
                        Default: ${DEFAULT_STATE_PATH}
  --registry <path>     Override merged registry path.
                        Default: ${DEFAULT_REGISTRY_PATH}
  --top <n>             Number of actions/targets to show. Default: 5
  --json                Print machine-readable JSON.
  --help                Show this help.
`;

const DEFAULT_BUILD_VERIFICATION_PATH = "security/build-verification.generated.json";

type Scalar = string | number | boolean | bigint | null | undefined;
type CloneCategory = "copy_ready" | "guided" | "manual_review" | "blocked";
type CloneCounts = Record<CloneCategory, number>;
interface Metric { score?: number; grade?: string; average_score?: number; average_grade?: string; label?: string; reasons?: string[]; weakest_dimensions?: Dimension[] }
interface Dimension { label?: string; coverage_rate?: number; ready_count?: number; total_count?: number }
interface Blocker { code?: string | null; message?: string | null; count?: number }
interface Action {
  project?: string; name?: string; path?: string; brick_name?: string; first_action?: string;
  why?: string; priority_score?: number; target_id?: string; target_type?: string;
  blocker_reasons?: string[];
  [key: string]: unknown;
}
interface BuildReport { candidate_count?: number; detected_brick_count?: number }
interface CuratedBuild {
  top_blockers?: Blocker[]; verification_top_blockers?: Blocker[]; readiness_score?: number;
  verified_ready?: boolean; publish_ready?: boolean;
}
interface QualityReport { score?: number; grade?: string; average_score?: number; average_grade?: string; hotspot_file_count?: number; brick_hotspot_count?: number; total_smell_count?: number; duplicate_cluster_count?: number }
interface StateProject {
  project?: string; clone_preflight?: Partial<CloneCounts>; canonicalization?: { top_targets?: Action[] };
  quality_queue?: Action[]; top_actions?: Action[]; code_quality_report?: QualityReport;
  readiness?: Metric; compliance?: Metric; build_report?: BuildReport;
  [key: string]: unknown;
}
interface PlaneSummary { auto_promotable_count?: number; verification_ready_count?: number; publish_ready_count?: number; bundle_count?: number; publish_safe_count?: number; blocker_bundle_count?: number; release_count?: number; statuses?: { published?: number }; verification_statuses?: { candidate?: number } }
interface BuildPlane { curated_builds?: CuratedBuild[]; curated_manifest_count?: number; installable_build_count?: number; verification_ready_count?: number; publish_ready_count?: number; average_readiness_score?: number }
interface Gen3Global {
  leases?: { active_count?: number; by_resource_kind?: Record<string, Scalar>; sample?: { resource_kind?: string; resource_id?: string; agent_id?: string; ttl_remaining_seconds?: number }[] };
  context_coverage?: { total_bricks_with_context?: number; projects_with_logs?: number; total_context_events?: number };
  merge_proposals?: { open_count?: number; resolved_count?: number };
}
interface PortfolioState {
  generated_at?: Scalar; projects?: StateProject[]; totals?: { brick_count?: number; project_count?: number };
  trust?: { readiness?: Metric; compliance?: Metric; code_quality_report?: QualityReport; build_report?: BuildReport; canonicalization?: { top_targets?: Action[] } };
  build_plane?: BuildPlane; promotion_plane?: { summary?: PlaneSummary; top_blockers?: Blocker[] };
  publish_plane?: { summary?: PlaneSummary; top_rules?: { rule_id?: string; count?: number }[] };
  release_plane?: { summary?: PlaneSummary }; install_plane?: Record<string, unknown>;
  retrieval?: { compact_card_count?: number }; gen3?: Gen3Global;
}
interface RegistryProject extends StateProject {
  id?: string; absolute_root?: string; root?: string; relative_root?: string;
  scanner?: {
    readiness?: Metric; boundary_report?: Record<string, number>; env_contract_report?: Record<string, number>;
    clone_preflight?: Partial<CloneCounts>; manifest_drift?: { count?: number }; compliance_report?: Metric;
    code_quality_report?: QualityReport;
  };
  refactor?: { oversized_file_count?: number; split_opportunity_count?: number };
}
interface PortfolioRegistry {
  generated_at?: Scalar; projects?: RegistryProject[];
  scanner_report?: { remediation_report?: { counts?: Record<string, Scalar>; top_actions?: Action[]; quality_queue?: Action[]; project_action_plans?: { project?: string; actions?: Action[] }[] } };
}
interface BuildVerification { summary?: { build_count?: number; verified_ready_count?: number; publish_ready_count?: number; average_readiness_score?: number; top_blockers?: Blocker[] } }
interface CuratedBuildPressure { source: string; build_count: number; verified_ready_count: number; publish_ready_count: number; average_readiness_score: number; top_blocker_code: string | null; top_blocker_message: string | null; top_blocker_count: number }

function firstBlocker(blockers: Blocker[] | undefined): Blocker | undefined {
  return blockers?.length ? blockers[0] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asPortfolioState(value: unknown): PortfolioState {
  if (!isObject(value)) throw new Error("state snapshot must be a JSON object");
  return value;
}

function asPortfolioRegistry(value: unknown): PortfolioRegistry {
  if (!isObject(value)) throw new Error("registry snapshot must be a JSON object");
  return value;
}

function fail(message: string, code = 1): never {
  console.error(`Error: ${message}`);
  process.exit(code);
}

async function loadOptionalJson(filePath: string): Promise<BuildVerification | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function summarizeGeneratedBuildPressure(summary: NonNullable<BuildVerification["summary"]>): CuratedBuildPressure {
  const topBlocker = firstBlocker(summary.top_blockers);
  return {
    source: "build_verification.generated.json",
    build_count: summary.build_count ?? 0,
    verified_ready_count: summary.verified_ready_count ?? 0,
    publish_ready_count: summary.publish_ready_count ?? 0,
    average_readiness_score: summary.average_readiness_score ?? 0,
    top_blocker_code: topBlocker?.code ?? null,
    top_blocker_message: topBlocker?.message ?? null,
    top_blocker_count: topBlocker?.count ?? 0
  };
}

function summarizeStateBuildPressure(curatedBuilds: CuratedBuild[]): CuratedBuildPressure | null {
  if (!curatedBuilds.length) return null;
  const topBlocker = summarizeBuildBlockers(curatedBuilds);
  const totalReadiness = curatedBuilds.reduce((sum: number, build) => sum + (build.readiness_score ?? 0), 0);
  return {
    source: "SMA_STATE.generated.json",
    build_count: curatedBuilds.length,
    verified_ready_count: curatedBuilds.filter((build) => build.verified_ready).length,
    publish_ready_count: curatedBuilds.filter((build) => build.publish_ready).length,
    average_readiness_score: Math.round(totalReadiness / curatedBuilds.length),
    top_blocker_code: topBlocker?.code ?? null,
    top_blocker_message: topBlocker?.message ?? null,
    top_blocker_count: topBlocker?.count ?? 0
  };
}

function summarizeBuildBlockers(curatedBuilds: CuratedBuild[]): (Blocker & { count: number }) | undefined {
  const blockerCounts = new Map<string, Blocker & { count: number }>();
  for (const build of curatedBuilds) {
    for (const blocker of (build.top_blockers ?? build.verification_top_blockers) ?? []) {
      const key = `${blocker.code ?? "unknown"}::${blocker.message ?? ""}`;
      blockerCounts.set(key, {
        code: blocker.code ?? null,
        message: blocker.message ?? null,
        count: ((blockerCounts.get(key)?.count ?? 0) + 1)
      });
    }
  }

  const sorted = [...blockerCounts.values()].sort((left, right) => right.count - left.count);
  return sorted.length ? sorted[0] : undefined;
}

function summarizeCuratedBuildPressure(state: PortfolioState, buildVerification: BuildVerification | null): CuratedBuildPressure | null {
  const generatedSummary = buildVerification?.summary;
  if (generatedSummary?.build_count) return summarizeGeneratedBuildPressure(generatedSummary);
  return summarizeStateBuildPressure(state.build_plane?.curated_builds ?? []);
}

function toIsoOrNull(value: Scalar) {
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function minutesBetween(a: string | null, b: string | null) {
  if (!a || !b) return null;
  const diff = Math.round((Date.parse(a) - Date.parse(b)) / 60000);
  return Number.isFinite(diff) ? diff : null;
}

function summarizeCloneCounts(state: PortfolioState): CloneCounts {
  const aggregate: CloneCounts = { copy_ready: 0, guided: 0, manual_review: 0, blocked: 0 };
  for (const project of state.projects ?? []) {
    const counts = project.clone_preflight ?? {};
    for (const key of Object.keys(aggregate) as CloneCategory[]) {
      aggregate[key] += (counts[key] ?? 0);
    }
  }
  return aggregate;
}

function prioritizedActions(actions: Action[] | undefined, topN: number | undefined) {
  return topList(actions ?? [], topN, compareBy<Action>("priority_score", "desc"));
}

function globalStateViews(state: PortfolioState) {
  return {
    totals: state.totals ?? {}, trust: state.trust ?? {}, build_plane: state.build_plane ?? {},
    promotion_plane: state.promotion_plane ?? {}, publish_plane: state.publish_plane ?? {},
    release_plane: state.release_plane ?? {}, install_plane: state.install_plane ?? {},
    retrieval: state.retrieval ?? {}, gen3: state.gen3 ?? null,
  };
}

function globalDiagnosis(state: PortfolioState, registry: PortfolioRegistry, buildVerification: BuildVerification | null, topN: number | undefined) {
  const remediation = registry.scanner_report?.remediation_report;
  const views = globalStateViews(state);
  const snapshots: { state_generated_at: string | null; registry_generated_at: string | null; state_vs_registry_minutes: number | null } = {
    state_generated_at: toIsoOrNull(state.generated_at),
    registry_generated_at: toIsoOrNull(registry.generated_at),
    state_vs_registry_minutes: null
  };
  snapshots.state_vs_registry_minutes = minutesBetween(snapshots.state_generated_at, snapshots.registry_generated_at);

  return {
    scope: "global",
    snapshots,
    ...views,
    clone_preflight: summarizeCloneCounts(state),
    curated_build_pressure: summarizeCuratedBuildPressure(state, buildVerification),
    remediation_counts: remediation?.counts ?? {},
    top_actions: prioritizedActions(remediation?.top_actions, topN),
    top_quality_actions: prioritizedActions(remediation?.quality_queue, topN),
    top_targets: prioritizedActions(state.trust?.canonicalization?.top_targets, topN),
  };
}

function projectRoot(registryProject: RegistryProject | null) {
  if (registryProject?.absolute_root) return registryProject.absolute_root;
  if (registryProject?.root) return registryProject.root;
  return registryProject?.relative_root ? path.resolve(PROJECTS_ROOT, registryProject.relative_root) : null;
}

function projectRemediation(registry: PortfolioRegistry, projectId: string) {
  const remediation = registry.scanner_report?.remediation_report;
  return {
    projectPlan: remediation?.project_action_plans?.find((entry) => entry.project === projectId),
    qualityQueue: remediation?.quality_queue?.filter((entry) => entry.project === projectId) ?? [],
    topActions: remediation?.top_actions?.filter((entry) => entry.project === projectId) ?? [],
  };
}

function preferredActions(primary: Action[] | undefined, fallback: Action[]) {
  return primary?.length ? primary : fallback;
}

function projectDiagnosis(stateProject: StateProject | null, registryProject: RegistryProject | null, registry: PortfolioRegistry, topN: number | undefined) {
  const projectId = registryProject?.id ?? stateProject?.project;
  if (!projectId) fail("could not resolve requested project");
  const { projectPlan, qualityQueue, topActions } = projectRemediation(registry, projectId);
  const absoluteRoot = projectRoot(registryProject);
  const gen3 = absoluteRoot ? collectProjectGen3({ projectId, projectRoot: absoluteRoot }) : null;

  return {
    scope: "project",
    project: projectId,
    state_project: stateProject ?? null,
    registry_project: registryProject ?? null,
    top_actions: prioritizedActions(projectPlan?.actions, topN),
    top_targets: prioritizedActions(stateProject?.canonicalization?.top_targets, topN),
    top_quality_actions: prioritizedActions(preferredActions(stateProject?.quality_queue, qualityQueue), topN),
    top_structural_actions: prioritizedActions(preferredActions(stateProject?.top_actions, topActions), topN),
    gen3
  };
}

function globalHeaderLines(report: ReturnType<typeof globalDiagnosis>, cwd: string, statePath: string, registryPath: string) {
  const lines = [
    "SMA Doctor",
    `State: ${relativeFromCwd(cwd, statePath)} (${report.snapshots.state_generated_at ?? "unknown"})`,
    `Registry: ${relativeFromCwd(cwd, registryPath)} (${report.snapshots.registry_generated_at ?? "unknown"})`,
  ];
  if (report.snapshots.state_vs_registry_minutes !== null) {
    const sign = report.snapshots.state_vs_registry_minutes >= 0 ? "+" : "";
    lines.push(`Snapshot skew: ${sign}${String(report.snapshots.state_vs_registry_minutes)} min (state minus registry)`);
  }
  return lines;
}

function globalTrustLines(report: ReturnType<typeof globalDiagnosis>) {
  const readiness = report.trust.readiness ?? {};
  const compliance = report.trust.compliance ?? {};
  const quality = report.trust.code_quality_report ?? {};
  const buildReport = report.trust.build_report ?? {};
  return [
    `Portfolio: ${formatNumber(report.totals.brick_count)} bricks across ${formatNumber(report.totals.project_count)} projects`,
    `Trust: readiness ${String(readiness.average_score ?? 0)}/${readiness.average_grade ?? "?"}, compliance ${String(compliance.average_score ?? 0)}/${compliance.average_grade ?? "?"}`,
    `Quality control: ${String(quality.average_score ?? 0)}/${quality.average_grade ?? "?"}, ${formatNumber(quality.hotspot_file_count ?? 0)} hotspot files, ${formatNumber(quality.brick_hotspot_count ?? 0)} risky bricks, ${formatNumber(quality.duplicate_cluster_count ?? 0)} duplicate clusters`,
    `Build layer: ${formatNumber(buildReport.candidate_count)} inferred candidates, ${formatNumber(report.build_plane.curated_manifest_count)} curated manifests, ${formatNumber(report.build_plane.installable_build_count)} installable builds`,
  ];
}

function globalPlaneLines(report: ReturnType<typeof globalDiagnosis>) {
  const promotion = report.promotion_plane.summary ?? {};
  return [
    `Build trust: ${formatNumber(report.build_plane.verification_ready_count ?? 0)} verification-ready, ${formatNumber(report.build_plane.publish_ready_count ?? 0)} publish-ready, avg readiness ${formatNumber(report.build_plane.average_readiness_score ?? 0)}/100`,
    `Promotion lane: ${formatNumber(promotion.auto_promotable_count ?? 0)} auto-promotable, ${formatNumber(promotion.verification_ready_count ?? 0)} verifier-ready, ${formatNumber(promotion.publish_ready_count ?? 0)} publish-ready`,
    ...globalDistributionLines(report),
  ];
}

function globalDistributionLines(report: ReturnType<typeof globalDiagnosis>) {
  const publishing = report.publish_plane.summary ?? {};
  const release = report.release_plane.summary ?? {};
  return [
    `Private publish: ${formatNumber(publishing.bundle_count ?? 0)} bundles, ${formatNumber(publishing.publish_safe_count ?? 0)} safe, ${formatNumber(publishing.blocker_bundle_count ?? 0)} blocked`,
    `Release layer: ${String(release.release_count ?? 0)} releases, ${String(release.statuses?.published ?? 0)} published, ${String(release.verification_statuses?.candidate ?? 0)} candidate-verified`,
    `Retrieval: ${formatNumber(report.retrieval.compact_card_count)} compact cards`,
    `Clone plane: copy-ready ${formatNumber(report.clone_preflight.copy_ready)}, guided ${formatNumber(report.clone_preflight.guided)}, manual ${formatNumber(report.clone_preflight.manual_review)}, blocked ${formatNumber(report.clone_preflight.blocked)}`,
  ];
}

function globalBuildPressureLines(report: ReturnType<typeof globalDiagnosis>) {
  const pressure = report.curated_build_pressure;
  if (!pressure?.build_count) return [];
  const blockerSummary = pressure.top_blocker_message
    ? `${pressure.top_blocker_message} x${formatNumber(pressure.top_blocker_count)}`
    : "no dominant blocker recorded";
  return [`Curated-build pressure: ${formatNumber(pressure.verified_ready_count)}/${formatNumber(pressure.build_count)} verified-ready, ${formatNumber(pressure.publish_ready_count)}/${formatNumber(pressure.build_count)} publish-ready; top blocker ${blockerSummary}`];
}

function globalPromotionPressureLines(report: ReturnType<typeof globalDiagnosis>) {
  const promotionBlocker = report.promotion_plane.top_blockers?.[0];
  const publishRule = report.publish_plane.top_rules?.[0];
  if (!promotionBlocker && !publishRule) return [];
  const lines = ["", "Promotion Pressure:"];
  if (promotionBlocker) lines.push(`- build promotion blocker: ${String(promotionBlocker.code)} (${formatNumber(promotionBlocker.count ?? 0)})`);
  if (publishRule) lines.push(`- publish gate rule: ${String(publishRule.rule_id)} (${formatNumber(publishRule.count ?? 0)})`);
  return lines;
}

function globalBacklogLines(report: ReturnType<typeof globalDiagnosis>) {
  const lines = ["", "Main Backlogs:"];
  const backlogEntries = Object.entries(report.remediation_counts).sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const [key, value] of backlogEntries.slice(0, 5)) lines.push(`- ${key}: ${formatNumber(value)}`);
  return lines;
}

function globalActionLines(report: ReturnType<typeof globalDiagnosis>) {
  const lines = ["", "Top Actions:"];
  for (const action of report.top_actions) lines.push(`- ${String(action.project)} :: ${String(action.name)} -> ${String(action.first_action)}`);
  if (report.top_quality_actions.length > 0) {
    lines.push("", "Top Quality Actions:");
    for (const action of report.top_quality_actions) {
      lines.push(`- ${String(action.project)} :: ${action.path ?? action.brick_name ?? action.name ?? "quality hotspot"} -> ${action.first_action ?? action.why ?? "Review hotspot"}`);
    }
  }
  lines.push("", "Top Promotion Targets:");
  for (const target of report.top_targets) {
    lines.push(`- ${String(target.project)} ${String(target.target_type)} ${String(target.name)} (${String(target.priority_score)})`);
    lines.push(`  blockers: ${(target.blocker_reasons ?? []).join(", ") || "none recorded"}`);
  }
  return lines;
}

function globalGen3Lines(report: ReturnType<typeof globalDiagnosis>) {
  if (!report.gen3) return [];
  const leases = report.gen3.leases ?? {};
  const context = report.gen3.context_coverage ?? {};
  const proposals = report.gen3.merge_proposals ?? {};
  const lines = [
    "", "Gen-3 Multi-Agent:",
    `- active leases: ${formatNumber(leases.active_count ?? 0)} (${formatLeaseKinds(leases.by_resource_kind)})`,
    `- context coverage: ${formatNumber(context.total_bricks_with_context ?? 0)} bricks across ${formatNumber(context.projects_with_logs ?? 0)} projects, ${formatNumber(context.total_context_events ?? 0)} events`,
    `- merge proposals: ${formatNumber(proposals.open_count ?? 0)} open, ${formatNumber(proposals.resolved_count ?? 0)} resolved`,
  ];
  if (leases.active_count) {
    lines.push("  current leases:");
    for (const lease of (leases.sample ?? []).slice(0, 5)) {
      lines.push(`  · ${String(lease.resource_kind)}:${String(lease.resource_id)} → ${String(lease.agent_id)} (${String(lease.ttl_remaining_seconds)}s left)`);
    }
  }
  return lines;
}

function renderGlobalText(report: ReturnType<typeof globalDiagnosis>, cwd: string, statePath: string, registryPath: string) {
  const lines = [
    ...globalHeaderLines(report, cwd, statePath, registryPath), "",
    ...globalTrustLines(report),
    ...globalBuildPressureLines(report),
    ...globalPlaneLines(report),
    ...globalPromotionPressureLines(report),
    ...globalBacklogLines(report),
    ...globalActionLines(report),
    ...globalGen3Lines(report),
    "", "Suggested Commands:",
    "- npm run why:blocked -- --project acme-studio",
    '- npm run recommend:builds -- --vision "build AI image generation with auth and billing"',
    "- npm run repair:kit", "- npm run publish:leaks", "- npm run lease:list",
    "- npm run context:check -- check --project <id>",
  ];
  return lines.join("\n");
}

function formatLeaseKinds(byKind: Record<string, unknown> | ArrayLike<unknown> | undefined) {
  if (!byKind || !Object.keys(byKind).length) return "none";
  return Object.entries(byKind).map(([k, v]) => `${k}=${String(v)}`).join(", ");
}

function projectReadinessLines(report: ReturnType<typeof projectDiagnosis>) {
  const stateProject = report.state_project ?? {};
  const registryProject = report.registry_project ?? {};
  const readiness = registryProject.scanner?.readiness ?? {};
  const stateReadiness = stateProject.readiness ?? {};
  return [
    `Readiness: ${String(readiness.score ?? stateReadiness.score ?? 0)}/${readiness.grade ?? stateReadiness.grade ?? "?"} ${readiness.label ? `(${readiness.label})` : ""}`.trim(),
    projectComplianceLine(report),
  ];
}

function projectComplianceLine(report: ReturnType<typeof projectDiagnosis>) {
  const stateProject = report.state_project ?? {};
  const registryProject = report.registry_project ?? {};
  const compliance = registryProject.scanner?.compliance_report ?? {};
  const stateCompliance = stateProject.compliance ?? {};
  return `Compliance: ${String(compliance.score ?? stateCompliance.score ?? 0)}/${compliance.grade ?? stateCompliance.grade ?? "?"}`;
}

function projectTrustLines(report: ReturnType<typeof projectDiagnosis>) {
  const stateProject = report.state_project ?? {};
  const registryProject = report.registry_project ?? {};
  const quality = registryProject.scanner?.code_quality_report ?? stateProject.code_quality_report ?? {};
  const buildReport = stateProject.build_report ?? {};
  return [
    ...projectReadinessLines(report),
    `Builds: ${formatNumber(buildReport.candidate_count)} candidates, ${formatNumber(buildReport.detected_brick_count)} participating bricks`,
    `Code quality: ${formatNumber(quality.score ?? 0)}/${quality.grade ?? "?"}, ${formatNumber(quality.hotspot_file_count ?? 0)} hotspot files, ${formatNumber(quality.total_smell_count ?? 0)} smell hits, ${formatNumber(quality.duplicate_cluster_count ?? 0)} duplicate clusters`,
  ];
}

function projectBacklogLines(report: ReturnType<typeof projectDiagnosis>) {
  const registryProject = report.registry_project ?? {};
  const boundary = registryProject.scanner?.boundary_report ?? {};
  const environment = registryProject.scanner?.env_contract_report ?? {};
  const clone = registryProject.scanner?.clone_preflight ?? {};
  const manifestDrift = registryProject.scanner?.manifest_drift ?? {};
  const refactor = registryProject.refactor ?? {};
  return [
    `Clone preflight: copy-ready ${formatNumber(clone.copy_ready)}, guided ${formatNumber(clone.guided)}, manual ${formatNumber(clone.manual_review)}, blocked ${formatNumber(clone.blocked)}`,
    `Boundary backlog: unresolved ${formatNumber(boundary.unresolved_local_import_count)}, unowned ${formatNumber(boundary.unowned_local_dependency_count)}, owned-cross ${formatNumber(boundary.cross_brick_owned_import_count)}, private-cross ${formatNumber(boundary.private_cross_brick_import_count)}`,
    `Env backlog: ${formatNumber(environment.bricks_with_undeclared_refs)} bricks, ${formatNumber(environment.undeclared_reference_count)} undeclared refs`,
    `Manifest drift: ${formatNumber(manifestDrift.count)} entries`,
    `Refactor pressure: ${formatNumber(refactor.oversized_file_count)} oversized files, ${formatNumber(refactor.split_opportunity_count)} split opportunities`,
  ];
}

function projectBlockerLines(report: ReturnType<typeof projectDiagnosis>) {
  const registryProject = report.registry_project ?? {};
  const readiness = registryProject.scanner?.readiness ?? {};
  const compliance = registryProject.scanner?.compliance_report ?? {};
  const lines = ["", "Why This Project Is Blocked:"];
  for (const reason of readiness.reasons ?? []) lines.push(`- ${reason}`);
  lines.push("", "Weakest Dimensions:");
  const weakestDimensions = compliance.weakest_dimensions ?? [];
  for (const dimension of weakestDimensions.slice(0, 4)) {
    lines.push(`- ${String(dimension.label)}: ${String(dimension.coverage_rate)}% coverage (${formatNumber(dimension.ready_count)}/${formatNumber(dimension.total_count)})`);
  }
  return lines;
}

function namedActionLines(title: string, actions: Action[], includeBrickName: boolean) {
  if (!actions.length) return [];
  const lines = ["", title];
  for (const action of actions) {
    const name = includeBrickName ? action.path ?? action.brick_name ?? action.name : action.path ?? action.name;
    lines.push(`- ${name ?? (includeBrickName ? "quality hotspot" : "action")}: ${action.first_action ?? action.why ?? "Review hotspot."}`);
  }
  return lines;
}

function projectTargetLines(report: ReturnType<typeof projectDiagnosis>) {
  const lines = ["", "Top Targets:"];
  for (const target of report.top_targets) {
    lines.push(`- ${String(target.target_type)} ${String(target.name)} (${String(target.priority_score)})`);
    lines.push(`  blockers: ${(target.blocker_reasons ?? []).join(", ") || "none recorded"}`);
  }
  return lines;
}

function projectActionLines(report: ReturnType<typeof projectDiagnosis>) {
  const lines = ["", "Next Actions:"];
  for (const action of report.top_actions) lines.push(`- ${String(action.name)}: ${String(action.first_action)}`);
  return [
    ...lines,
    ...namedActionLines("Structural Hotspots:", report.top_structural_actions, false),
    ...namedActionLines("Quality Hotspots:", report.top_quality_actions, true),
    ...projectTargetLines(report),
  ];
}

function projectGen3Lines(report: ReturnType<typeof projectDiagnosis>) {
  if (!report.gen3) return [];
  const { context_coverage: context, merge_proposals: proposals, leases } = report.gen3;
  const lines = [
    "", "Gen-3 Multi-Agent:",
    `- active leases for project resources: ${formatNumber(leases.active_count)}`,
    `- bricks with context: ${formatNumber(context.bricks_with_context)} / ${formatNumber(context.total_events)} events`,
    `- last context event: ${context.last_event_at ?? "(none)"}`,
    `- merge proposals: ${formatNumber(proposals.open_count)} open, ${formatNumber(proposals.resolved_count)} resolved`,
  ];
  if (proposals.open_count) {
    lines.push("  open proposals:");
    for (const proposal of proposals.proposals.filter((entry) => !entry.resolved_at).slice(0, 5)) {
      lines.push(`  · ${String(proposal.proposal_id)} (${String(proposal.brick_id)}) → recommends ${String(proposal.recommendation)}`);
    }
  }
  if (context.bricks.length) {
    lines.push("  bricks with most recent activity:");
    for (const brick of context.bricks.slice(0, 5)) {
      lines.push(`  · ${brick.brick_id} — ${String(brick.event_count)} events, last: ${brick.last_intent ?? brick.last_kind ?? "(no intent)"}`);
    }
  }
  return lines;
}

function renderProjectText(report: ReturnType<typeof projectDiagnosis>, cwd: string, statePath: string, registryPath: string) {
  const lines = [
    `SMA Doctor: ${report.project}`,
    `State: ${relativeFromCwd(cwd, statePath)}`,
    `Registry: ${relativeFromCwd(cwd, registryPath)}`,
    "",
    ...projectTrustLines(report),
    ...projectBacklogLines(report),
    ...projectBlockerLines(report),
    ...projectActionLines(report),
    ...projectGen3Lines(report),
  ];
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleanFlags: ["json", "help"] });
  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  const cwd = process.cwd();
  const topN = Math.max(1, Number(args.top || 5));
  const buildVerification = await loadOptionalJson(path.resolve(cwd, DEFAULT_BUILD_VERIFICATION_PATH));
  const stateArg = typeof args.state === "string" ? args.state : DEFAULT_STATE_PATH;
  const registryArg = typeof args.registry === "string" ? args.registry : DEFAULT_REGISTRY_PATH;
  const loaded = await loadStateAndRegistry({
    cwd,
    statePath: stateArg,
    registryPath: registryArg
  });
  const state = asPortfolioState(loaded.state);
  const registry = asPortfolioRegistry(loaded.registry);
  const { statePath, registryPath } = loaded;

  const projectArg = typeof args.project === "string" ? args.project : "";
  if (projectArg) {
    const { stateProject: rawStateProject, registryProject: rawRegistryProject } = findProjectEntries(state, registry, projectArg);
    const stateProject = rawStateProject;
    const registryProject = rawRegistryProject;
    const report = projectDiagnosis(stateProject, registryProject, registry, topN);
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(renderProjectText(report, cwd, statePath, registryPath));
    return;
  }

  const report = globalDiagnosis(state, registry, buildVerification, topN);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(renderGlobalText(report, cwd, statePath, registryPath));
}

main().catch((error: unknown) => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
