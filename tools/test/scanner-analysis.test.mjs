import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectProjectBuildCandidates, buildProjectBuildReport, finalizeMergedBuildReport } from "../lib/scan-build.ts";
import {
  countExports, extractEnvReferences, extractImportSpecifiers, extractSupabaseTableRefs,
  importResolutionCandidates, isIgnoredProjectImportSpecifier, isTestLikePath,
  looksLikeProjectImport, normalizeDuplicateStem, resolveProjectImport,
} from "../lib/scan-project-analysis.ts";
import {
  analyzeCodeQualityCounts, analyzeProjectRefactorOpportunities, buildQualityDuplicateGroups,
  buildQualityQueue, buildRefactorQueue, buildRefactorReport, detectSplitPoints,
  duplicateFingerprintForFile, gradeForScore, isContractRelevantEnvReference,
  isIgnoredEnvReference, severityForLineCount, suggestSplitStrategy,
} from "../lib/scan-refactor.ts";
import { dashboardHtml } from "../lib/wiki-dashboard-page.ts";

test("scanner analysis extracts boundary, environment, database, and refactor evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-scanner-analysis-"));
  try {
    const src = path.join(root, "src");
    await mkdir(src, { recursive: true });
    const helper = path.join(src, "helper.ts");
    const app = path.join(src, "app.ts");
    await writeFile(helper, "export const helper = 1;\n");
    await writeFile(app, `
      import { helper } from "./helper";
      export { helper } from "./helper";
      const lazy = import("./lazy");
      const token = process.env.PRIVATE_API_TOKEN;
      const publicUrl = import.meta.env.VITE_PUBLIC_URL;
      const query = supabase.from("accounts");
      export function GET() { return helper + token + publicUrl + query; }
    `);

    assert.equal(normalizeDuplicateStem("create-User_Service.ts"), "user-service");
    assert.equal(isIgnoredProjectImportSpecifier("./logo.svg?raw"), true);
    assert.equal(looksLikeProjectImport("@/services/auth"), true);
    assert.equal(looksLikeProjectImport("react"), false);
    assert.equal(isTestLikePath("src/__tests__/unit.ts"), true);
    assert.ok(importResolutionCandidates(path.join(src, "helper")).includes(helper));
    assert.deepEqual(extractImportSpecifiers(await (await import("node:fs/promises")).readFile(app, "utf8")), ["./helper", "./lazy"]);
    assert.equal(countExports("export const a=1; export default function B(){}; module.exports = {}"), 3);
    assert.deepEqual(extractEnvReferences("process.env.AA; process.env['BB']; import.meta.env.CC; Deno.env.get('DD'); Bun.env.EE"), ["AA", "BB", "CC", "DD", "EE"]);
    assert.deepEqual(extractSupabaseTableRefs("db.from('accounts');", app), ["accounts"]);
    const resolvedHelper = await resolveProjectImport(root, app, "./helper");
    assert.ok(resolvedHelper);
    assert.equal(resolvedHelper.absolute_path, helper);
    const unresolvedImport = await resolveProjectImport(root, app, "./missing");
    assert.ok(unresolvedImport);
    assert.equal(unresolvedImport.unresolved, true);

    assert.equal(severityForLineCount(2501), "critical");
    const points = detectSplitPoints("export async function GET() {}\n\n\n\n\n\n\n\n\n\n\n\n// section billing\n\n\n\n\n\n\n\n\n\n\n\nexport class AccountService {}");
    assert.deepEqual(points.map((point) => point.kind), ["route_handler", "section", "export_class"]);
    assert.match(suggestSplitStrategy(points), /route handlers/);
    assert.equal(isIgnoredEnvReference("PATH"), true);
    assert.equal(isContractRelevantEnvReference("PRIVATE_API_TOKEN"), true);
    assert.equal(gradeForScore(92), "A");

    const repeated = "export function same(){ return 1; }\n".repeat(130);
    const fingerprint = duplicateFingerprintForFile({ filePath: app, sourceText: repeated, lineCount: 130 });
    assert.ok(fingerprint);
    const groups = buildQualityDuplicateGroups([
      { fingerprint, project: "one", path: "src/a.ts", line_count: 130, raw_source_tokens: 100 },
      { fingerprint, project: "two", path: "src/b.ts", line_count: 130, raw_source_tokens: 100 },
    ]);
    assert.equal(groups.length, 1);
    const smells = analyzeCodeQualityCounts("console.log('x');\n// TODO fix\nany as any", { filePath: app, lineCount: 3 });
    assert.ok(Object.values(smells).some((count) => count > 0));
    const qualityQueue = buildQualityQueue([{ project: "one", path: "src/a.ts", line_count: 30, raw_source_tokens: 100, total_matches: 3, smell_score: 4, by_type: {}, top_types: [] }], groups);
    assert.ok(qualityQueue.length >= 1);
    assert.ok(qualityQueue.some((entry) => entry.path === "src/a.ts" || entry.category === "duplicate_cluster"));

    const report = await analyzeProjectRefactorOpportunities(root, "fixture", [{ id: "app", source_paths: ["src/app.ts", "src/helper.ts"] }]);
    assert.equal(report.project, "fixture");
    const merged = buildRefactorReport([report]);
    assert.equal(merged.projects.length, 1);
    assert.ok(Array.isArray(buildRefactorQueue(merged.oversized_files)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("build candidate detection groups recurring capability signals and preserves bounded summaries", () => {
  const bricks = [1, 2, 3, 4].map((index) => ({
    id: `auth-${index}`, name: `Identity Login ${index}`, kind: "service", status: index < 3 ? "verified" : "candidate",
    score: 80 + index, source_paths: [`src/features/identity/login-${index}.ts`], domain: ["identity"],
    feature_cluster: { id: "identity", name: "Identity" }, brick_group: "fixture:src/features/identity",
  }));
  const candidates = detectProjectBuildCandidates("fixture", bricks);
  assert.ok(candidates.length > 0);
  assert.equal(candidates[0].project, "fixture");
  assert.ok(candidates[0].brick_count >= 2);
  assert.match(candidates[0].why, /shared/i);
  const report = buildProjectBuildReport("fixture", candidates);
  assert.equal(report.project, "fixture");
  assert.equal(report.candidate_count, candidates.length);
  const merged = finalizeMergedBuildReport({ projects: [report], top_candidates: candidates, candidate_signatures: report.candidate_signatures });
  assert.equal(merged.projects.length, 1);
  assert.ok(merged.average_confidence_score >= 0);
});

test("dashboard rendering converts scanner evidence into escaped, navigable operational HTML", () => {
  const registry = {
    projects: [{ id: "fixture<script>", root: "/tmp/fixture", brick_count: 1, warning_count: 1, error_count: 0, health_counts: { warn: 1 } }],
    scanner_report: {
      readiness: { average_score: 74, average_grade: "C", projects: [{ project: "fixture", readiness: { score: 74, grade: "C", label: "review", reasons: ["boundary gap"], metrics: { boundary_violation_count: 1 } } }] },
      compliance_report: { average_score: 80, average_grade: "B", dimensions: {}, weakest_dimensions: [], highest_gap_bricks: [] },
      build_report: { candidate_count: 1, average_confidence_score: 75, recurrent_candidate_count: 0, recurrent_family_count: 0, top_candidates: [{ project: "fixture", name: "Identity Build", confidence_score: 75, confidence_label: "medium", brick_count: 3, detection_sources: ["feature"], why: "shared identity", sample_paths: ["src/auth.ts"] }] },
      remediation_report: { top_actions: [], project_action_plans: [], quality_queue: [], counts: {} },
      duplicate_clusters: [], token_economics: { raw_source_tokens: 1000, estimated_summary_tokens: 200, top_token_heavy_bricks: [] },
    },
  };
  const bricks = [{ id: "auth", name: "Auth", project: "fixture", status: "candidate", score: 80, risk: "medium", health: { status: "warn" }, feature_cluster: { name: "Identity" } }];
  const html = dashboardHtml(/** @type {any} */ (registry), /** @type {any} */ (bricks), new Map(), null);
  assert.match(html, /Sweetspot Modular Architecture/);
  assert.match(html, /Identity Build/);
  assert.match(html, /80%/);
  assert.doesNotMatch(html, /fixture<script>/);
  assert.match(html, /fixture&lt;script&gt;/);
  assert.match(html, /projects\/fixture-script\.md/);
});
