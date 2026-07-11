#!/usr/bin/env node
/**
 * What: Generates per-project queues for canonicalization work.
 * Why: Portfolio findings need actionable project-side tasks rather than one undifferentiated list.
 * How: Reads curated-build context and project metadata, then writes or prints queue handoffs.
 * Callers: Controllers and project agents use the queues to choose the next bounded task.
 * Example: `node tools/sma-repo-queues.mjs --help`
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildHandoffPaths,
  loadCuratedBuildContext,
  parseArgs,
  toArray,
  uniqueStrings,
} from "./lib/curated-build-utils.ts";
import {
  discoverPortfolioProjects,
  projectPriorityRank,
} from "./lib/portfolio-projects.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const DEFAULT_OUT = "handoffs/repo-queues.generated.json";

const HELP_TEXT = `Usage: node tools/sma-repo-queues.mjs [options]

Generate machine-readable repo queues for project-side canonicalization work.

Options:
  --project <id>   Limit output to one project id. Repeatable.
  --out <file>     Output JSON path. Default: ${DEFAULT_OUT}
  --stdout         Print the generated JSON.
  --dry-run        Print only, do not write a file.
  --help           Show this help text.
`;

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const outPath = path.resolve(args.out || DEFAULT_OUT);
  const selectedProjects = new Set([].concat(args.project || []).flatMap((value) => Array.isArray(value) ? value : [value]).map((value) => String(value || "").trim()).filter(Boolean));
  const context = await loadCuratedBuildContext(args);
  const portfolioProjects = await discoverPortfolioProjects();
  const projects = buildProjectQueues(context, portfolioProjects)
    .filter((entry) => selectedProjects.size === 0 || selectedProjects.has(entry.project))
    .sort((left, right) => compareProjectQueues(left, right, portfolioProjects));

  const document = {
    generated_at: new Date().toISOString(),
    summary: {
      project_count: projects.length,
      curated_build_count: projects.reduce((sum, entry) => sum + entry.curated_builds.length, 0),
      execution_order: projects.map((entry) => entry.project),
      top_repo: projects[0]?.project || null,
    },
    portfolio: {
      total_project_count: portfolioProjects.length,
      priority_projects: portfolioProjects
        .filter((entry) => entry.priority_tier === "priority")
        .map((entry) => entry.id),
    },
    projects,
  };

  if (args.stdout || args["dry-run"]) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  }

  if (!args["dry-run"]) {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await writeQueueDocs(document);
  }
}

function buildProjectQueues(context, portfolioProjects = []) {
  const projectStates = new Map(toArray(context.state.projects).map((entry) => [entry.project, entry]));
  const registryProjects = new Map(toArray(context.registry.projects).map((entry) => [entry.id || entry.project, entry]));
  const remediationPlans = new Map(
    toArray(context.registry.scanner_report?.remediation_report?.project_action_plans)
      .map((entry) => [entry.project, entry])
  );
  const topActions = toArray(context.registry.scanner_report?.remediation_report?.top_actions);
  const qualityQueue = toArray(context.registry.scanner_report?.remediation_report?.quality_queue);
  const portfolioById = new Map(portfolioProjects.map((entry) => [entry.id, entry]));
  const curatedByProject = new Map();
  for (const build of context.curatedBuilds) {
    if (!curatedByProject.has(build.source_project)) curatedByProject.set(build.source_project, []);
    curatedByProject.get(build.source_project).push(build);
  }

  const projectIds = uniqueStrings(portfolioProjects.map((entry) => entry.id));

  return projectIds.map((projectId) => {
    const portfolioProject = portfolioById.get(projectId) || null;
    const stateProject = projectStates.get(projectId) || {};
    const registryProject = registryProjects.get(projectId) || {};
    const scanner = registryProject.scanner || {};
    const clone = scanner.clone_preflight || {};
    const env = scanner.env_contract_report || {};
    const boundary = scanner.boundary_report || {};
    const drift = scanner.manifest_drift || {};
    const quality = scanner.code_quality_report || stateProject.code_quality_report || {};
    const curatedBuilds = toArray(curatedByProject.get(projectId)).sort((left, right) =>
      String(left.name || "").localeCompare(String(right.name || ""))
    );
    const topTargets = toArray(stateProject.canonicalization?.top_targets || []).slice(0, 6);
    const remediationActions = toArray(remediationPlans.get(projectId)?.actions || []).slice(0, 6);
    const topProjectActions = topActions.filter((entry) => entry.project === projectId).slice(0, 6);
    const topQualityActions = qualityQueue.filter((entry) => entry.project === projectId).slice(0, 6);

    return {
      project: projectId,
      display_name: portfolioProject?.name || projectId,
      relative_root: portfolioProject?.relative_root || null,
      priority_order: projectPriorityRank(projectId, portfolioProjects),
      priority_tier: portfolioProject?.priority_tier || "standard",
      scan_available: Boolean(projectStates.has(projectId) || registryProjects.has(projectId)),
      handoff_refs: {
        queue_doc: `handoffs/repo-queues/${projectId}.md`,
      },
      current: {
        readiness_score: scanner.readiness?.score ?? stateProject.readiness?.score ?? null,
        readiness_grade: scanner.readiness?.grade ?? stateProject.readiness?.grade ?? null,
        compliance_score: scanner.compliance_report?.score ?? stateProject.compliance?.score ?? null,
        compliance_grade: scanner.compliance_report?.grade ?? stateProject.compliance?.grade ?? null,
        clone_preflight: {
          copy_ready: Number(clone.copy_ready || 0),
          guided: Number(clone.guided || 0),
          manual_review: Number(clone.manual_review || 0),
          blocked: Number(clone.blocked || 0),
        },
        env_backlog: {
          brick_count: Number(env.bricks_with_undeclared_refs || 0),
          undeclared_reference_count: Number(env.undeclared_reference_count || 0),
        },
        boundary_backlog: {
          unresolved_local_import_count: Number(boundary.unresolved_local_import_count || 0),
          unowned_local_dependency_count: Number(boundary.unowned_local_dependency_count || 0),
          cross_brick_owned_import_count: Number(boundary.cross_brick_owned_import_count || 0),
          private_cross_brick_import_count: Number(boundary.private_cross_brick_import_count || 0),
        },
        manifest_drift_count: Number(drift.count || 0),
        code_quality: {
          score: Number(quality.score || 0),
          grade: quality.grade || "A",
          analyzed_code_file_count: Number(quality.analyzed_code_file_count || 0),
          hotspot_file_count: Number(quality.hotspot_file_count || 0),
          brick_hotspot_count: Number(quality.brick_hotspot_count || 0),
          duplicate_cluster_count: Number(quality.duplicate_cluster_count || 0),
          total_smell_count: Number(quality.total_smell_count || 0),
          top_smells: Object.entries(quality.by_type || {})
            .sort((left, right) => Number(right[1]) - Number(left[1]) || String(left[0]).localeCompare(String(right[0])))
            .slice(0, 4)
            .map(([key, count]) => ({ key, count: Number(count || 0) })),
        },
        remediation_counts: scanner.remediation_report?.counts || stateProject.remediation_counts || {},
      },
      curated_builds: curatedBuilds.map((build) => ({
        build_id: build.build_id,
        name: build.name,
        manifest_path: build.manifest_path,
        current_status: build.status,
        verification_ready: build.verified_ready === true,
        publish_ready: build.publish_ready === true,
        private_publish_status: build.private_publish_status || null,
        blocker_codes: uniqueStrings([
          ...toArray(build.promotion?.blockers).map((entry) => entry.code),
          ...toArray(build.verificationEntry?.top_blockers).map((entry) => entry.code),
          ...toArray(build.publishBundle?.top_blockers).map((entry) => entry.rule_id),
        ]),
        handoff_refs: buildHandoffPaths(build),
        first_actions: toArray(build.first_actions),
      })),
      candidate_targets: topTargets.map((target) => ({
        target_id: target.target_id,
        target_type: target.target_type,
        name: target.name,
        priority_score: target.priority_score,
        blocker_reasons: toArray(target.blocker_reasons),
        evidence_summary: target.evidence_summary || null,
      })),
      remediation_actions: remediationActions.map((action) => ({
        name: action.name,
        first_action: action.first_action,
        priority_score: action.priority_score,
        reason_codes: toArray(action.reason_codes),
      })),
      top_actions: topProjectActions.map((action) => ({
        category: action.category || "action",
        name: action.name || action.brick_name || action.brick_id || action.path || "action",
        path: action.path || null,
        priority_score: Number(action.priority_score || 0),
        why: action.why || null,
        first_action: action.first_action || null,
      })),
      quality_actions: topQualityActions.map((action) => ({
        category: action.category || "quality_hotspot",
        name: action.brick_name || action.path || action.brick_id || "quality hotspot",
        path: action.path || null,
        priority_score: Number(action.priority_score || 0),
        why: action.why || null,
        first_action: action.first_action || null,
        top_types: toArray(action.top_types).slice(0, 3),
      })),
      first_actions: deriveProjectFirstActions({ projectId, curatedBuilds, scanner, remediationActions, topQualityActions }),
    };
  });
}

function deriveProjectFirstActions({ projectId, curatedBuilds, scanner, remediationActions, topQualityActions }) {
  const actions = [];
  const push = (value) => {
    const text = String(value || "").trim();
    if (text) actions.push(text);
  };

  for (const build of curatedBuilds.slice(0, 2)) {
    push(`Repair curated build ${build.build_id} before touching lower-priority scanner candidates.`);
  }

  if (Number(scanner.env_contract_report?.undeclared_reference_count || 0) > 0) {
    push("Declare env references in the same feature lanes you are repairing so verification evidence stops drifting.");
  }
  if (Number(scanner.boundary_report?.unowned_local_dependency_count || 0) > 0) {
    push("Reduce unowned local dependencies in the same paths before promoting more bricks or builds.");
  }
  if (Number(scanner.clone_preflight?.blocked || 0) > 0) {
    push("Re-run the central lane after each repo batch until blocked clone pressure drops materially.");
  }
  for (const action of remediationActions.slice(0, 2)) push(action.first_action);
  for (const action of topQualityActions.slice(0, 2)) push(action.first_action);
  if (projectId === "acme-factory") {
    push("Start in analytics and web-ui utility lanes before promoting any public-facing build candidate.");
  }
  return uniqueStrings(actions).slice(0, 8);
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function renderList(items, renderItem) {
  if (!items.length) return "- None recorded";
  return items.map(renderItem).join("\n");
}

function renderProjectQueueMarkdown(entry) {
  const quality = entry.current.code_quality || {};
  const topSmells = quality.top_smells || [];
  return `# ${entry.project}

## Snapshot

- Priority: \`${entry.priority_order}\` (${entry.priority_tier})
- Readiness: \`${entry.current.readiness_score} / ${entry.current.readiness_grade}\`
- Compliance: \`${entry.current.compliance_score} / ${entry.current.compliance_grade}\`
- Clone preflight: \`${entry.current.clone_preflight.blocked}\` blocked, \`${entry.current.clone_preflight.manual_review}\` manual, \`${entry.current.clone_preflight.copy_ready}\` copy-ready
- Env backlog: \`${entry.current.env_backlog.undeclared_reference_count}\` undeclared refs across \`${entry.current.env_backlog.brick_count}\` bricks
- Boundary backlog: \`${entry.current.boundary_backlog.unresolved_local_import_count}\` unresolved imports, \`${entry.current.boundary_backlog.unowned_local_dependency_count}\` unowned local deps
- Manifest drift: \`${entry.current.manifest_drift_count}\`

## Code Quality

- Score: \`${quality.score || 0} / ${quality.grade || "A"}\`
- Hotspots: \`${quality.hotspot_file_count || 0}\` files across \`${quality.brick_hotspot_count || 0}\` bricks
- Duplicate clusters: \`${quality.duplicate_cluster_count || 0}\`
- Total smell hits: \`${quality.total_smell_count || 0}\`
- Top smell families: ${topSmells.length ? topSmells.map((item) => `\`${item.key}\` x${formatNumber(item.count)}`).join(", ") : "none recorded"}

## Curated Builds

${renderList(entry.curated_builds, (build) => `- \`${build.build_id}\` is \`${build.current_status}\`; verification-ready: \`${build.verification_ready}\`, publish-ready: \`${build.publish_ready}\`, private publish: \`${build.private_publish_status || "none"}\`\n  blockers: ${build.blocker_codes.length ? build.blocker_codes.join(", ") : "none recorded"}`)}

## Canonical Targets

${renderList(entry.candidate_targets, (target, index) => `${index + 1}. ${target.target_type} \`${target.name}\` (${target.priority_score})\n   blockers: ${target.blocker_reasons.length ? target.blocker_reasons.join(", ") : "none recorded"}\n   evidence: ${target.evidence_summary?.source_path || target.evidence_summary?.why || "none recorded"}`)}

## Structural Actions

${renderList(entry.top_actions, (action) => `- [${action.category}] ${action.name}${action.path ? ` · \`${action.path}\`` : ""}\n  ${action.first_action || action.why || "Review this action."}`)}

## Quality Actions

${renderList(entry.quality_actions, (action) => `- [${action.category}] ${action.name}${action.path ? ` · \`${action.path}\`` : ""}\n  ${action.first_action || action.why || "Review this hotspot."}${action.top_types.length ? ` Dominant issues: ${action.top_types.map((item) => `${item.label || item.key} x${formatNumber(item.count)}`).join(", ")}.` : ""}`)}

## First Actions

${renderList(entry.first_actions, (action, index) => `${index + 1}. ${action}`)}

## Handoff Refs

- Queue JSON: \`handoffs/repo-queues.generated.json\`
- Queue doc: \`${entry.handoff_refs.queue_doc}\`
`;
}

function renderQueueReadme(document) {
  const topProjects = document.projects.slice(0, 5);
  return `# Repo Queues

Generated from current central truth.

- Generated at: \`${document.generated_at}\`
- Projects covered: \`${document.summary.project_count}\`
- Curated builds represented: \`${document.summary.curated_build_count}\`
- Priority projects: ${document.portfolio.priority_projects.map((entry) => `\`${entry}\``).join(", ")}

Use these queue docs in this order first:

${topProjects.map((entry, index) => `${index + 1}. \`${entry.project}.md\`\n   Reason: readiness \`${entry.current.readiness_score}/${entry.current.readiness_grade}\`, compliance \`${entry.current.compliance_score}/${entry.current.compliance_grade}\`, quality \`${entry.current.code_quality.score}/${entry.current.code_quality.grade}\`.`).join("\n")}

Each queue doc includes:

- current scanner snapshot
- curated-build pressure
- canonical targets
- structural actions
- quality actions
- first moves worth landing in-repo
`;
}

async function writeQueueDocs(document) {
  const docsRoot = path.join(repoRoot, "handoffs/repo-queues");
  await fs.mkdir(docsRoot, { recursive: true });
  const keepFiles = new Set(["README.md", ...document.projects.map((entry) => `${entry.project}.md`)]);
  for (const entry of await fs.readdir(docsRoot, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    if (keepFiles.has(entry.name)) continue;
    await fs.unlink(path.join(docsRoot, entry.name));
  }
  await Promise.all(document.projects.map((entry) =>
    fs.writeFile(path.join(docsRoot, `${entry.project}.md`), `${renderProjectQueueMarkdown(entry)}\n`, "utf8")
  ));
  await fs.writeFile(path.join(docsRoot, "README.md"), `${renderQueueReadme(document)}\n`, "utf8");
}

function compareProjectQueues(left, right, portfolioProjects = []) {
  return projectPriorityRank(left.project, portfolioProjects) - projectPriorityRank(right.project, portfolioProjects)
    || String(left.project).localeCompare(String(right.project));
}
