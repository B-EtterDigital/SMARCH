#!/usr/bin/env node
/* Defensive external-input guards and JavaScript coercion semantics are intentional in this behavior-preserving strict-type pass. */
/* eslint @typescript-eslint/no-unnecessary-boolean-literal-compare: "off", @typescript-eslint/no-unnecessary-condition: "off", @typescript-eslint/no-useless-default-assignment: "off", @typescript-eslint/prefer-nullish-coalescing: "off", @typescript-eslint/array-type: "off", max-lines-per-function: "off", complexity: "off", @typescript-eslint/prefer-optional-chain: "off", @typescript-eslint/no-base-to-string: "off", @typescript-eslint/no-unnecessary-type-conversion: "off", @typescript-eslint/restrict-template-expressions: "off", @typescript-eslint/use-unknown-in-catch-callback-variable: "off" */
/**
 * What: Generates per-project queues for canonicalization work.
 * Why: Portfolio findings need actionable project-side tasks rather than one undifferentiated list.
 * How: Reads curated-build context and project metadata, then writes or prints queue handoffs.
 * Callers: Controllers and project agents use the queues to choose the next bounded task.
 * Example: `node tools/sma-repo-queues.ts --help`
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
import type { PortfolioProject } from "./lib/portfolio-projects.ts";

interface QualityReport { score?: number; grade?: string; analyzed_code_file_count?: number; hotspot_file_count?: number; brick_hotspot_count?: number; duplicate_cluster_count?: number; total_smell_count?: number; by_type?: Record<string, number> }
interface ScannerReport {
  readiness?: { score?: number; grade?: string }; compliance_report?: { score?: number; grade?: string };
  clone_preflight?: { copy_ready?: number; guided?: number; manual_review?: number; blocked?: number };
  env_contract_report?: { bricks_with_undeclared_refs?: number; undeclared_reference_count?: number };
  boundary_report?: { unresolved_local_import_count?: number; unowned_local_dependency_count?: number; cross_brick_owned_import_count?: number; private_cross_brick_import_count?: number };
  manifest_drift?: { count?: number }; code_quality_report?: QualityReport;
  remediation_report?: { counts?: Record<string, unknown> };
}
interface QueueAction { project?: string; category?: string; name?: string; brick_name?: string; brick_id?: string; path?: string; priority_score?: number; why?: string; first_action?: string; reason_codes?: unknown[]; top_types?: Array<{ label?: string; key?: string; count?: number }> }
interface RemediationPlan { project?: string; actions?: QueueAction[] }
interface StateProject { project: string; readiness?: { score?: number; grade?: string }; compliance?: { score?: number; grade?: string }; code_quality_report?: QualityReport; remediation_counts?: Record<string, unknown>; canonicalization?: { top_targets?: CandidateTarget[] } }
interface CandidateTarget { target_id?: string; target_type?: string; name?: string; priority_score?: number; blocker_reasons?: unknown[]; evidence_summary?: { source_path?: string; why?: string } }
interface RegistryProject { id?: string; project?: string; scanner?: ScannerReport }
interface QueueBuild { build_id: string; source_project?: string; name?: string; manifest_path?: string | null; status?: string; verified_ready?: boolean; publish_ready?: boolean; private_publish_status?: string; promotion?: { blockers?: Array<{ code?: string }> } | null; verificationEntry?: { top_blockers?: Array<{ code?: string }> } | null; publishBundle?: { top_blockers?: Array<{ rule_id?: string }> } | null; first_actions?: string[] }
interface QueueContext { state: { projects?: StateProject[] }; registry: { projects?: RegistryProject[]; scanner_report?: { remediation_report?: { project_action_plans?: RemediationPlan[]; top_actions?: QueueAction[]; quality_queue?: QueueAction[] } } }; curatedBuilds: QueueBuild[] }
interface FirstActionInput { projectId: string; curatedBuilds: QueueBuild[]; scanner: ScannerReport; remediationActions: QueueAction[]; topQualityActions: QueueAction[] }
interface RenderedQuality { score: number; grade: string; analyzed_code_file_count: number; hotspot_file_count: number; brick_hotspot_count: number; duplicate_cluster_count: number; total_smell_count: number; top_smells: Array<{ key: string; count: number }> }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const DEFAULT_OUT = "handoffs/repo-queues.generated.json";

const HELP_TEXT = `Usage: node tools/sma-repo-queues.ts [options]

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const outPath = path.resolve(typeof args.out === "string" ? args.out : DEFAULT_OUT);
  const projectArgs = Array.isArray(args.project) ? args.project : args.project ? [args.project] : [];
  const selectedProjects = new Set(projectArgs.map((value) => String(value || "").trim()).filter(Boolean));
  const context = await loadCuratedBuildContext(args as unknown as Record<string, string | undefined>) as unknown as QueueContext;
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

function buildProjectQueues(context: QueueContext, portfolioProjects: PortfolioProject[] = []) {
  const projectStates = new Map<string, StateProject>(toArray(context.state.projects).map((entry) => [entry.project, entry]));
  const registryProjects = new Map<string, RegistryProject>(toArray(context.registry.projects).flatMap((entry) => {
    const id = entry.id || entry.project;
    return id ? [[id, entry] as [string, RegistryProject]] : [];
  }));
  const remediationPlans = new Map<string, RemediationPlan>(
    toArray(context.registry.scanner_report?.remediation_report?.project_action_plans)
      .flatMap((entry) => entry.project ? [[entry.project, entry] as [string, RemediationPlan]] : [])
  );
  const topActions = toArray(context.registry.scanner_report?.remediation_report?.top_actions);
  const qualityQueue = toArray(context.registry.scanner_report?.remediation_report?.quality_queue);
  const portfolioById = new Map(portfolioProjects.map((entry) => [entry.id, entry]));
  const curatedByProject = new Map<string, QueueBuild[]>();
  for (const build of context.curatedBuilds) {
    const projectId = build.source_project ?? "";
    const builds = curatedByProject.get(projectId) ?? [];
    builds.push(build);
    curatedByProject.set(projectId, builds);
  }

  const projectIds = uniqueStrings(portfolioProjects.map((entry) => entry.id));

  return projectIds.map((projectId) => {
    const portfolioProject = portfolioById.get(projectId) || null;
    const stateProject: StateProject = projectStates.get(projectId) ?? { project: projectId };
    const registryProject: RegistryProject = registryProjects.get(projectId) ?? {};
    const scanner: ScannerReport = registryProject.scanner ?? {};
    const clone = scanner.clone_preflight || {};
    const env = scanner.env_contract_report || {};
    const boundary = scanner.boundary_report || {};
    const drift = scanner.manifest_drift || {};
    const quality = scanner.code_quality_report || stateProject.code_quality_report || {};
    const curatedBuilds = toArray(curatedByProject.get(projectId)).sort((left, right) =>
      String(left.name || "").localeCompare(String(right.name || ""))
    );
    const topTargets = toArray<CandidateTarget>(stateProject.canonicalization?.top_targets).slice(0, 6);
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
        handoff_refs: buildHandoffPaths({ source_project: build.source_project, build_id: build.build_id }),
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

function deriveProjectFirstActions({ projectId, curatedBuilds, scanner, remediationActions, topQualityActions }: FirstActionInput): string[] {
  const actions: string[] = [];
  const push = (value: unknown): void => {
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

function formatNumber(value: unknown): string {
  return new Intl.NumberFormat("en-US").format(Number(value || 0));
}

function renderList<T>(items: T[], renderItem: (item: T, index: number) => string): string {
  if (!items.length) return "- None recorded";
  return items.map(renderItem).join("\n");
}

function renderProjectQueueMarkdown(entry: ProjectQueue): string {
  const quality: RenderedQuality = entry.current.code_quality;
  const topSmells: Array<{ key: string; count: number }> = quality.top_smells;
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

function renderQueueReadme(document: QueueDocument): string {
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

async function writeQueueDocs(document: QueueDocument): Promise<void> {
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

function compareProjectQueues(left: ProjectQueue, right: ProjectQueue, portfolioProjects: PortfolioProject[] = []): number {
  return projectPriorityRank(left.project, portfolioProjects) - projectPriorityRank(right.project, portfolioProjects)
    || String(left.project).localeCompare(String(right.project));
}

type ProjectQueue = ReturnType<typeof buildProjectQueues>[number];
interface QueueDocument { generated_at: string; summary: { project_count: number; curated_build_count: number; execution_order: string[]; top_repo: string | null }; portfolio: { total_project_count: number; priority_projects: string[] }; projects: ProjectQueue[] }
