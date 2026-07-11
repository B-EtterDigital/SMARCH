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

function fail(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

async function loadOptionalJson(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function summarizeCuratedBuildPressure(state, buildVerification) {
  if (buildVerification?.summary?.build_count) {
    const topBlocker = (buildVerification.summary.top_blockers || [])[0] || null;
    return {
      source: "build_verification.generated.json",
      build_count: Number(buildVerification.summary.build_count || 0),
      verified_ready_count: Number(buildVerification.summary.verified_ready_count || 0),
      publish_ready_count: Number(buildVerification.summary.publish_ready_count || 0),
      average_readiness_score: Number(buildVerification.summary.average_readiness_score || 0),
      top_blocker_code: topBlocker?.code || null,
      top_blocker_message: topBlocker?.message || null,
      top_blocker_count: Number(topBlocker?.count || 0)
    };
  }

  const curatedBuilds = state.build_plane?.curated_builds || [];
  if (!curatedBuilds.length) return null;

  const blockerCounts = new Map();
  for (const build of curatedBuilds) {
    for (const blocker of build.top_blockers || build.verification_top_blockers || []) {
      const key = `${blocker.code || "unknown"}::${blocker.message || ""}`;
      blockerCounts.set(key, {
        code: blocker.code || null,
        message: blocker.message || null,
        count: Number((blockerCounts.get(key)?.count || 0) + 1)
      });
    }
  }

  const topBlocker = [...blockerCounts.values()].sort((left, right) => right.count - left.count)[0] || null;
  const totalReadiness = curatedBuilds.reduce((sum, build) => sum + Number(build.readiness_score || 0), 0);

  return {
    source: "SMA_STATE.generated.json",
    build_count: curatedBuilds.length,
    verified_ready_count: curatedBuilds.filter((build) => build.verified_ready).length,
    publish_ready_count: curatedBuilds.filter((build) => build.publish_ready).length,
    average_readiness_score: curatedBuilds.length ? Math.round(totalReadiness / curatedBuilds.length) : 0,
    top_blocker_code: topBlocker?.code || null,
    top_blocker_message: topBlocker?.message || null,
    top_blocker_count: Number(topBlocker?.count || 0)
  };
}

function toIsoOrNull(value) {
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function minutesBetween(a, b) {
  if (!a || !b) return null;
  const diff = Math.round((Date.parse(a) - Date.parse(b)) / 60000);
  return Number.isFinite(diff) ? diff : null;
}

function summarizeCloneCounts(state) {
  const aggregate = { copy_ready: 0, guided: 0, manual_review: 0, blocked: 0 };
  for (const project of state.projects || []) {
    const counts = project.clone_preflight || {};
    for (const key of Object.keys(aggregate)) {
      aggregate[key] += Number(counts[key] || 0);
    }
  }
  return aggregate;
}

function globalDiagnosis(state, registry, buildVerification, topN) {
  const remediationCounts = registry.scanner_report?.remediation_report?.counts || {};
  const topActions = topList(
    registry.scanner_report?.remediation_report?.top_actions || [],
    topN,
    compareBy("priority_score", "desc")
  );
  const topQualityActions = topList(
    registry.scanner_report?.remediation_report?.quality_queue || [],
    topN,
    compareBy("priority_score", "desc")
  );
  const topTargets = topList(
    state.trust?.canonicalization?.top_targets || [],
    topN,
    compareBy("priority_score", "desc")
  );
  const snapshots: Record<string, any> = {
    state_generated_at: toIsoOrNull(state.generated_at),
    registry_generated_at: toIsoOrNull(registry.generated_at)
  };
  snapshots.state_vs_registry_minutes = minutesBetween(snapshots.state_generated_at, snapshots.registry_generated_at);

  return {
    scope: "global",
    snapshots,
    totals: state.totals || {},
    trust: state.trust || {},
    build_plane: state.build_plane || {},
    promotion_plane: state.promotion_plane || {},
    publish_plane: state.publish_plane || {},
    release_plane: state.release_plane || {},
    install_plane: state.install_plane || {},
    retrieval: state.retrieval || {},
    clone_preflight: summarizeCloneCounts(state),
    curated_build_pressure: summarizeCuratedBuildPressure(state, buildVerification),
    remediation_counts: remediationCounts,
    top_actions: topActions,
    top_quality_actions: topQualityActions,
    top_targets: topTargets,
    gen3: state.gen3 || null
  };
}

function projectDiagnosis(stateProject, registryProject, registry, topN) {
  const projectId = registryProject?.id || stateProject?.project;
  if (!projectId) fail("could not resolve requested project");

  const projectPlan = (registry.scanner_report?.remediation_report?.project_action_plans || [])
    .find((entry) => entry.project === projectId);
  const qualityQueue = (registry.scanner_report?.remediation_report?.quality_queue || [])
    .filter((entry) => entry.project === projectId);
  const topActions = (registry.scanner_report?.remediation_report?.top_actions || [])
    .filter((entry) => entry.project === projectId);

  const projectAbsoluteRoot = registryProject?.absolute_root
    || registryProject?.root
    || (registryProject?.relative_root ? path.resolve(PROJECTS_ROOT, registryProject.relative_root) : null);
  const gen3 = projectAbsoluteRoot
    ? collectProjectGen3({ projectId, projectRoot: projectAbsoluteRoot })
    : null;

  return {
    scope: "project",
    project: projectId,
    state_project: stateProject || null,
    registry_project: registryProject || null,
    top_actions: topList(projectPlan?.actions || [], topN, compareBy("priority_score", "desc")),
    top_targets: topList(stateProject?.canonicalization?.top_targets || [], topN, compareBy("priority_score", "desc")),
    top_quality_actions: topList(stateProject?.quality_queue?.length ? stateProject.quality_queue : qualityQueue, topN, compareBy("priority_score", "desc")),
    top_structural_actions: topList(stateProject?.top_actions?.length ? stateProject.top_actions : topActions, topN, compareBy("priority_score", "desc")),
    gen3
  };
}

function renderGlobalText(report, cwd, statePath, registryPath) {
  const lines = [];
  lines.push("SMA Doctor");
  lines.push(`State: ${relativeFromCwd(cwd, statePath)} (${report.snapshots.state_generated_at || "unknown"})`);
  lines.push(`Registry: ${relativeFromCwd(cwd, registryPath)} (${report.snapshots.registry_generated_at || "unknown"})`);
  if (report.snapshots.state_vs_registry_minutes !== null) {
    const sign = report.snapshots.state_vs_registry_minutes >= 0 ? "+" : "";
    lines.push(`Snapshot skew: ${sign}${report.snapshots.state_vs_registry_minutes} min (state minus registry)`);
  }
  lines.push("");
  lines.push(`Portfolio: ${formatNumber(report.totals.brick_count)} bricks across ${formatNumber(report.totals.project_count)} projects`);
  lines.push(`Trust: readiness ${report.trust.readiness?.average_score || 0}/${report.trust.readiness?.average_grade || "?"}, compliance ${report.trust.compliance?.average_score || 0}/${report.trust.compliance?.average_grade || "?"}`);
  lines.push(`Quality control: ${report.trust.code_quality_report?.average_score || 0}/${report.trust.code_quality_report?.average_grade || "?"}, ${formatNumber(report.trust.code_quality_report?.hotspot_file_count || 0)} hotspot files, ${formatNumber(report.trust.code_quality_report?.brick_hotspot_count || 0)} risky bricks, ${formatNumber(report.trust.code_quality_report?.duplicate_cluster_count || 0)} duplicate clusters`);
  lines.push(`Build layer: ${formatNumber(report.trust.build_report?.candidate_count)} inferred candidates, ${formatNumber(report.build_plane.curated_manifest_count)} curated manifests, ${formatNumber(report.build_plane.installable_build_count)} installable builds`);
  lines.push(`Build trust: ${formatNumber(report.build_plane.verification_ready_count || 0)} verification-ready, ${formatNumber(report.build_plane.publish_ready_count || 0)} publish-ready, avg readiness ${formatNumber(report.build_plane.average_readiness_score || 0)}/100`);
  if (report.curated_build_pressure?.build_count) {
    const blockerSummary = report.curated_build_pressure.top_blocker_message
      ? `${report.curated_build_pressure.top_blocker_message} x${formatNumber(report.curated_build_pressure.top_blocker_count)}`
      : "no dominant blocker recorded";
    lines.push(`Curated-build pressure: ${formatNumber(report.curated_build_pressure.verified_ready_count)}/${formatNumber(report.curated_build_pressure.build_count)} verified-ready, ${formatNumber(report.curated_build_pressure.publish_ready_count)}/${formatNumber(report.curated_build_pressure.build_count)} publish-ready; top blocker ${blockerSummary}`);
  }
  lines.push(`Promotion lane: ${formatNumber(report.promotion_plane.summary?.auto_promotable_count || 0)} auto-promotable, ${formatNumber(report.promotion_plane.summary?.verification_ready_count || 0)} verifier-ready, ${formatNumber(report.promotion_plane.summary?.publish_ready_count || 0)} publish-ready`);
  lines.push(`Private publish: ${formatNumber(report.publish_plane.summary?.bundle_count || 0)} bundles, ${formatNumber(report.publish_plane.summary?.publish_safe_count || 0)} safe, ${formatNumber(report.publish_plane.summary?.blocker_bundle_count || 0)} blocked`);
  lines.push(`Release layer: ${report.release_plane.summary?.release_count || 0} releases, ${report.release_plane.summary?.statuses?.published || 0} published, ${report.release_plane.summary?.verification_statuses?.candidate || 0} candidate-verified`);
  lines.push(`Retrieval: ${formatNumber(report.retrieval.compact_card_count)} compact cards`);
  lines.push(`Clone plane: copy-ready ${formatNumber(report.clone_preflight.copy_ready)}, guided ${formatNumber(report.clone_preflight.guided)}, manual ${formatNumber(report.clone_preflight.manual_review)}, blocked ${formatNumber(report.clone_preflight.blocked)}`);
  if ((report.promotion_plane.top_blockers || []).length > 0 || (report.publish_plane.top_rules || []).length > 0) {
    lines.push("");
    lines.push("Promotion Pressure:");
    const promotionBlocker = report.promotion_plane.top_blockers?.[0];
    const publishRule = report.publish_plane.top_rules?.[0];
    if (promotionBlocker) lines.push(`- build promotion blocker: ${promotionBlocker.code} (${formatNumber(promotionBlocker.count || 0)})`);
    if (publishRule) lines.push(`- publish gate rule: ${publishRule.rule_id} (${formatNumber(publishRule.count || 0)})`);
  }
  lines.push("");
  lines.push("Main Backlogs:");
  const backlogEntries = Object.entries(report.remediation_counts || {}).sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const [key, value] of backlogEntries.slice(0, 5)) {
    lines.push(`- ${key}: ${formatNumber(value)}`);
  }
  lines.push("");
  lines.push("Top Actions:");
  for (const action of report.top_actions || []) {
    lines.push(`- ${action.project} :: ${action.name} -> ${action.first_action}`);
  }
  if ((report.top_quality_actions || []).length > 0) {
    lines.push("");
    lines.push("Top Quality Actions:");
    for (const action of report.top_quality_actions || []) {
      lines.push(`- ${action.project} :: ${action.path || action.brick_name || action.name || "quality hotspot"} -> ${action.first_action || action.why || "Review hotspot"}`);
    }
  }
  lines.push("");
  lines.push("Top Promotion Targets:");
  for (const target of report.top_targets || []) {
    lines.push(`- ${target.project} ${target.target_type} ${target.name} (${target.priority_score})`);
    lines.push(`  blockers: ${(target.blocker_reasons || []).join(", ") || "none recorded"}`);
  }
  if (report.gen3) {
    lines.push("");
    lines.push("Gen-3 Multi-Agent:");
    const leases = report.gen3.leases || {};
    const ctx = report.gen3.context_coverage || {};
    const mp = report.gen3.merge_proposals || {};
    lines.push(`- active leases: ${formatNumber(leases.active_count || 0)} (${formatLeaseKinds(leases.by_resource_kind)})`);
    lines.push(`- context coverage: ${formatNumber(ctx.total_bricks_with_context || 0)} bricks across ${formatNumber(ctx.projects_with_logs || 0)} projects, ${formatNumber(ctx.total_context_events || 0)} events`);
    lines.push(`- merge proposals: ${formatNumber(mp.open_count || 0)} open, ${formatNumber(mp.resolved_count || 0)} resolved`);
    if (leases.active_count) {
      lines.push("  current leases:");
      for (const lease of (leases.sample || []).slice(0, 5)) {
        lines.push(`  · ${lease.resource_kind}:${lease.resource_id} → ${lease.agent_id} (${lease.ttl_remaining_seconds}s left)`);
      }
    }
  }
  lines.push("");
  lines.push("Suggested Commands:");
  lines.push("- npm run why:blocked -- --project acme-studio");
  lines.push('- npm run recommend:builds -- --vision "build AI image generation with auth and billing"');
  lines.push("- npm run repair:kit");
  lines.push("- npm run publish:leaks");
  lines.push("- npm run lease:list");
  lines.push("- npm run context:check -- check --project <id>");
  return lines.join("\n");
}

function formatLeaseKinds(byKind) {
  if (!byKind || !Object.keys(byKind).length) return "none";
  return Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(", ");
}

function renderProjectText(report, cwd, statePath, registryPath) {
  const stateProject = report.state_project || {};
  const registryProject = report.registry_project || {};
  const readiness = registryProject.scanner?.readiness || {};
  const boundary = registryProject.scanner?.boundary_report || {};
  const env = registryProject.scanner?.env_contract_report || {};
  const clone = registryProject.scanner?.clone_preflight || {};
  const manifestDrift = registryProject.scanner?.manifest_drift || {};
  const compliance = registryProject.scanner?.compliance_report || {};
  const quality = registryProject.scanner?.code_quality_report || stateProject.code_quality_report || {};
  const refactor = registryProject.refactor || {};

  const lines = [];
  lines.push(`SMA Doctor: ${report.project}`);
  lines.push(`State: ${relativeFromCwd(cwd, statePath)}`);
  lines.push(`Registry: ${relativeFromCwd(cwd, registryPath)}`);
  lines.push("");
  lines.push(`Readiness: ${readiness.score || stateProject.readiness?.score || 0}/${readiness.grade || stateProject.readiness?.grade || "?"} ${readiness.label ? `(${readiness.label})` : ""}`.trim());
  lines.push(`Compliance: ${compliance.score || stateProject.compliance?.score || 0}/${compliance.grade || stateProject.compliance?.grade || "?"}`);
  lines.push(`Builds: ${formatNumber(stateProject.build_report?.candidate_count)} candidates, ${formatNumber(stateProject.build_report?.detected_brick_count)} participating bricks`);
  lines.push(`Clone preflight: copy-ready ${formatNumber(clone.copy_ready)}, guided ${formatNumber(clone.guided)}, manual ${formatNumber(clone.manual_review)}, blocked ${formatNumber(clone.blocked)}`);
  lines.push(`Boundary backlog: unresolved ${formatNumber(boundary.unresolved_local_import_count)}, unowned ${formatNumber(boundary.unowned_local_dependency_count)}, owned-cross ${formatNumber(boundary.cross_brick_owned_import_count)}, private-cross ${formatNumber(boundary.private_cross_brick_import_count)}`);
  lines.push(`Env backlog: ${formatNumber(env.bricks_with_undeclared_refs)} bricks, ${formatNumber(env.undeclared_reference_count)} undeclared refs`);
  lines.push(`Manifest drift: ${formatNumber(manifestDrift.count)} entries`);
  lines.push(`Code quality: ${formatNumber(quality.score || 0)}/${quality.grade || "?"}, ${formatNumber(quality.hotspot_file_count || 0)} hotspot files, ${formatNumber(quality.total_smell_count || 0)} smell hits, ${formatNumber(quality.duplicate_cluster_count || 0)} duplicate clusters`);
  lines.push(`Refactor pressure: ${formatNumber(refactor.oversized_file_count)} oversized files, ${formatNumber(refactor.split_opportunity_count)} split opportunities`);
  lines.push("");
  lines.push("Why This Project Is Blocked:");
  for (const reason of readiness.reasons || []) {
    lines.push(`- ${reason}`);
  }
  lines.push("");
  lines.push("Weakest Dimensions:");
  for (const dimension of (compliance.weakest_dimensions || []).slice(0, 4)) {
    lines.push(`- ${dimension.label}: ${dimension.coverage_rate}% coverage (${formatNumber(dimension.ready_count)}/${formatNumber(dimension.total_count)})`);
  }
  lines.push("");
  lines.push("Next Actions:");
  for (const action of report.top_actions || []) {
    lines.push(`- ${action.name}: ${action.first_action}`);
  }
  if ((report.top_structural_actions || []).length > 0) {
    lines.push("");
    lines.push("Structural Hotspots:");
    for (const action of report.top_structural_actions || []) {
      lines.push(`- ${action.path || action.name || "action"}: ${action.first_action || action.why || "Review hotspot."}`);
    }
  }
  if ((report.top_quality_actions || []).length > 0) {
    lines.push("");
    lines.push("Quality Hotspots:");
    for (const action of report.top_quality_actions || []) {
      lines.push(`- ${action.path || action.brick_name || action.name || "quality hotspot"}: ${action.first_action || action.why || "Review hotspot."}`);
    }
  }
  lines.push("");
  lines.push("Top Targets:");
  for (const target of report.top_targets || []) {
    lines.push(`- ${target.target_type} ${target.name} (${target.priority_score})`);
    lines.push(`  blockers: ${(target.blocker_reasons || []).join(", ") || "none recorded"}`);
  }
  if (report.gen3) {
    const ctx = report.gen3.context_coverage || {};
    const mp = report.gen3.merge_proposals || {};
    const leases = report.gen3.leases || {};
    lines.push("");
    lines.push("Gen-3 Multi-Agent:");
    lines.push(`- active leases for project resources: ${formatNumber(leases.active_count || 0)}`);
    lines.push(`- bricks with context: ${formatNumber(ctx.bricks_with_context || 0)} / ${formatNumber(ctx.total_events || 0)} events`);
    lines.push(`- last context event: ${ctx.last_event_at || "(none)"}`);
    lines.push(`- merge proposals: ${formatNumber(mp.open_count || 0)} open, ${formatNumber(mp.resolved_count || 0)} resolved`);
    if (mp.open_count) {
      lines.push("  open proposals:");
      for (const p of (mp.proposals || []).filter((x) => !x.resolved_at).slice(0, 5)) {
        lines.push(`  · ${p.proposal_id} (${p.brick_id}) → recommends ${p.recommendation}`);
      }
    }
    if (ctx.bricks?.length) {
      lines.push("  bricks with most recent activity:");
      for (const b of ctx.bricks.slice(0, 5)) {
        lines.push(`  · ${b.brick_id} — ${b.event_count} events, last: ${b.last_intent || b.last_kind || "(no intent)"}`);
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

  const cwd = process.cwd();
  const topN = Math.max(1, Number(args.top || 5));
  const buildVerification = await loadOptionalJson(path.resolve(cwd, DEFAULT_BUILD_VERIFICATION_PATH));
  const { state, registry, statePath, registryPath } = await loadStateAndRegistry({
    cwd,
    statePath: args.state || DEFAULT_STATE_PATH,
    registryPath: args.registry || DEFAULT_REGISTRY_PATH
  });

  let report;
  if (args.project) {
    const { stateProject, registryProject } = findProjectEntries(state, registry, args.project);
    report = projectDiagnosis(stateProject, registryProject, registry, topN);
  } else {
    report = globalDiagnosis(state, registry, buildVerification, topN);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const text = args.project
    ? renderProjectText(report, cwd, statePath, registryPath)
    : renderGlobalText(report, cwd, statePath, registryPath);
  console.log(text);
}

main().catch((error) => fail(error?.stack || error?.message || String(error)));
