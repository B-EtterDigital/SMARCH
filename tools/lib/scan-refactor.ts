/* eslint-disable @typescript-eslint/no-unnecessary-type-conversion, @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-base-to-string, @typescript-eslint/restrict-template-expressions -- Refactor analysis normalizes untrusted scanner records and intentionally preserves defensive conversions, truthy fallback, and report formatting. */
/* eslint-disable complexity, max-lines-per-function -- Refactor scoring is an ordered heuristic ledger; keeping all weights visible together prevents hidden precedence drift. */
/**
 * Refactor opportunity and code-quality analysis.
 * Extracted from sma-scan.ts; keep registry behavior byte-identical.
 */

import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { isExcludedDirName, isExcludedPath, isWithinRoot, pathExists, toSlashPath } from "./scan-discovery.ts";

type Severity = "medium" | "high" | "critical";
export interface SplitPoint { line: number; kind: string; label: string }
export interface RefactorBrick { id: string; source_paths?: string[] }
interface FileReference { absolute_path: string; relative_path: string; brick_ids: Set<string> }
export interface OversizedFile {
  project: string; path: string; absolute_path: string; extension: string; lines: number; bytes: number; severity: Severity;
  related_brick_count: number; related_bricks: string[]; split_points: SplitPoint[]; split_strategy: string;
}
interface MissingSourcePath { project: string; path: string; related_brick_count: number; related_bricks: string[] }
interface AnalysisFailure { project: string; path: string; error: string }
export interface RefactorProjectReport {
  project: string; analyzed_file_count: number; oversized_file_count: number; split_opportunity_count: number;
  missing_source_path_count: number; analysis_failure_count: number; severity_counts: Record<Severity, number>;
  oversized_files: OversizedFile[]; missing_source_paths: MissingSourcePath[]; analysis_failures: AnalysisFailure[];
}
type CodeQualityCounts = Record<string, number>;
interface QualityType { key: string; label: string; count: number; weighted_score: number }
export interface QualityHotspot {
  project: string; path: string; brick_id?: string; brick_name?: string; smell_score: number; total_matches: number;
  line_count: number; raw_source_tokens: number; by_type: CodeQualityCounts; top_types: QualityType[]; [key: string]: unknown;
}
export interface QualityFingerprintEntry { fingerprint: string; project: string; path: string; brick_id?: string; brick_name?: string; line_count: number; raw_source_tokens: number }
interface QualityQueueEntry { project: string; category: string; path: string; priority_score: number; [key: string]: unknown }

export const oversizedThresholds = {
  medium: 350,
  high: 600,
  critical: 900
};
const codeFileExtensions = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".kt",
  ".swift", ".php", ".cs", ".sql"
]);
const analyzableSourceExtensions = new Set([
  ...codeFileExtensions,
  ".json", ".md", ".mdx", ".yaml", ".yml", ".toml", ".txt"
]);
const ignoredEnvNames = new Set([
  "APPDATA",
  "CI",
  "COMSPEC",
  "DEBUG",
  "DEV",
  "HOME",
  "HOSTNAME",
  "INIT_CWD",
  "LOCALAPPDATA",
  "MODE",
  "NODE_ENV",
  "OS",
  "PATH",
  "PROD",
  "PRODUCTION",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES_X86",
  "PWD",
  "SHELL",
  "SHLVL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TEST",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "USERNAME",
  "USERPROFILE"
]);

const ignoredEnvPrefixes = [
  "ALLOW_",
  "ANT_",
  "CLAUDE_CODE_",
  "CLAUDE_",
  "COO_",
  "CURSOR_",
  "DEBUG_",
  "DISABLE_",
  "ENABLE_",
  "FLY_",
  "GITHUB_",
  "OTEL_",
  "RAILWAY_",
  "SESSION_",
  "SSH_",
  "TERM_",
  "TEST_",
  "USE_",
  "VSCODE_",
  "WEBSITE_",
  "NETLIFY_",
  "NPM_",
  "VITEST_"
];

const contractEnvSignals = [
  "ACCOUNT",
  "ANON",
  "API",
  "APP_URL",
  "AUTH",
  "BASE_URL",
  "BEDROCK",
  "BUCKET",
  "CREDENTIAL",
  "CRON",
  "DATABASE",
  "DB",
  "DOMAIN",
  "EMBED",
  "ENCRYPTION",
  "ENDPOINT",
  "FCM",
  "FUNCTION_SECRET",
  "GEMINI",
  "GOOGLE",
  "HOST",
  "INTERNAL",
  "KEY",
  "MODEL",
  "OPENAI",
  "OPENROUTER",
  "OPEN_ROUTER",
  "PASSWORD",
  "PORT",
  "PROJECT",
  "REDIS",
  "REGION",
  "RESEND",
  "R2",
  "RUNPOD",
  "SECRET",
  "SENTRY",
  "SERVICE_ROLE",
  "SMTP",
  "STRIPE",
  "SUPABASE",
  "TOKEN",
  "TWILIO",
  "UPSTASH",
  "URI",
  "URL",
  "USERNAME",
  "VAPID",
  "VERTEX",
  "WEBHOOK",
  "WORKOS"
];
export function isCodeFile(filePath: string): boolean {
  return codeFileExtensions.has(path.extname(filePath).toLowerCase());
}

function isAnalyzableSourceFile(filePath: string): boolean {
  return analyzableSourceExtensions.has(path.extname(filePath).toLowerCase());
}

export function severityForLineCount(lineCount: number): Severity | "" {
  if (lineCount >= oversizedThresholds.critical) {
    return "critical";
  }

  if (lineCount >= oversizedThresholds.high) {
    return "high";
  }

  if (lineCount >= oversizedThresholds.medium) {
    return "medium";
  }

  return "";
}

function severityWeight(severity: string): number {
  return {
    medium: 1,
    high: 2,
    critical: 3
  }[severity] || 0;
}
function topLevelIndent(line: string): number {
  const match = /^(\s*)/.exec(line);
  return match ? match[1].length : 0;
}

export function detectSplitPoints(sourceText: string): SplitPoint[] {
  const lines = sourceText.split(/\r?\n/);
  const rawPoints: SplitPoint[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const trimmed = rawLine.trim();

    if (!trimmed) {
      continue;
    }

    const indent = topLevelIndent(rawLine);
    const line = index + 1;
    let point: SplitPoint | null = null;

    if (/^export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.test(trimmed)) {
      const [, , method] = (/^export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/.exec(trimmed)) || [];
      point = { line, kind: "route_handler", label: method || "handler" };
    } else if (/^(\/\/|#|\/\*+)\s*(region|section|feature|domain|flow|phase)\b/i.test(trimmed)
      || /^(\/\/|#|\/\*+)\s*[=-]{3,}/.test(trimmed)) {
      point = { line, kind: "section", label: trimmed.replace(/^(\/*\s*|#+\s*|\/\/\s*)/, "").slice(0, 80) || "section" };
    } else if (indent <= 2 && /^export\s+class\s+([A-Za-z0-9_]+)/.test(trimmed)) {
      const [, name] = (/^export\s+class\s+([A-Za-z0-9_]+)/.exec(trimmed)) || [];
      point = { line, kind: "export_class", label: name || "class" };
    } else if (indent <= 2 && /^(export\s+default\s+)?function\s+(use[A-Z][A-Za-z0-9_]*)\b/.test(trimmed)) {
      const [, , name] = (/^(export\s+default\s+)?function\s+(use[A-Z][A-Za-z0-9_]*)\b/.exec(trimmed)) || [];
      point = { line, kind: "hook", label: name || "hook" };
    } else if (indent <= 2 && /^(export\s+default\s+)?function\s+([A-Z][A-Za-z0-9_]*)\b/.test(trimmed)) {
      const [, , name] = (/^(export\s+default\s+)?function\s+([A-Z][A-Za-z0-9_]*)\b/.exec(trimmed)) || [];
      point = { line, kind: "react_component", label: name || "component" };
    } else if (indent <= 2 && /^export\s+(async\s+)?function\s+([A-Za-z0-9_]+)/.test(trimmed)) {
      const [, , name] = (/^export\s+(async\s+)?function\s+([A-Za-z0-9_]+)/.exec(trimmed)) || [];
      point = { line, kind: "export_function", label: name || "function" };
    } else if (indent <= 2 && /^export\s+const\s+([A-Za-z0-9_]+)\s*=/.test(trimmed)) {
      const [, name] = (/^export\s+const\s+([A-Za-z0-9_]+)\s*=/.exec(trimmed)) || [];
      point = { line, kind: /^use[A-Z]/.test(name || "") ? "hook" : "export_const", label: name || "export" };
    } else if (indent <= 2 && /^class\s+([A-Za-z0-9_]+)/.test(trimmed)) {
      const [, name] = (/^class\s+([A-Za-z0-9_]+)/.exec(trimmed)) || [];
      point = { line, kind: "class", label: name || "class" };
    } else if (indent <= 2 && /^(async\s+)?function\s+([A-Za-z0-9_]+)/.test(trimmed)) {
      const [, , name] = (/^(async\s+)?function\s+([A-Za-z0-9_]+)/.exec(trimmed)) || [];
      point = { line, kind: /^use[A-Z]/.test(name || "") ? "hook" : "helper_function", label: name || "function" };
    } else if (indent <= 2 && /^const\s+([A-Za-z0-9_]+)\s*=\s*(async\s*)?\(/.test(trimmed)) {
      const [, name] = (/^const\s+([A-Za-z0-9_]+)\s*=/.exec(trimmed)) || [];
      point = { line, kind: /^[A-Z]/.test(name || "") ? "react_component" : /^use[A-Z]/.test(name || "") ? "hook" : "helper_const", label: name || "const" };
    }

    if (point) {
      rawPoints.push(point);
    }
  }

  const filtered: SplitPoint[] = [];

  for (const point of rawPoints) {
    const previous = filtered.at(-1);

    if (previous && point.line - previous.line < 12) {
      continue;
    }

    filtered.push(point);

    if (filtered.length >= 8) {
      break;
    }
  }

  return filtered;
}

export function suggestSplitStrategy(splitPoints: SplitPoint[]): string {
  if (splitPoints.length === 0) {
    return "Start by separating orchestration from helpers, then add explicit section boundaries for the next pass.";
  }

  const kinds = new Set(splitPoints.map((point) => point.kind));
  const exportCount = splitPoints.filter((point) => point.kind.startsWith("export_")).length;

  if (kinds.has("route_handler")) {
    return "Split route handlers from shared orchestration and move reusable logic into sibling services.";
  }

  if (kinds.has("hook") && kinds.has("react_component")) {
    return "Separate hooks, presentation, and orchestration into sibling modules.";
  }

  if (kinds.has("section")) {
    return "Split along the existing section markers and pull shared utilities into support files.";
  }

  if (exportCount >= 3) {
    return "Extract exported units into focused sibling modules with one primary responsibility each.";
  }

  if (splitPoints.length >= 4) {
    return "Break helpers and side effects into smaller modules around these seam lines.";
  }

  return "Start with the first seam, extract one cohesive concern, then re-scan for the next split.";
}

async function walkMatchingFiles(
  targetPath: string,
  files: string[],
  acceptsFile: (filePath: string) => boolean,
): Promise<string[]> {
  if (isExcludedPath(targetPath)) {
    return files;
  }

  let stats;

  try {
    stats = await fs.stat(targetPath);
  } catch (error) {
    void error;
    return files;
  }

  if (stats.isFile()) {
    if (acceptsFile(targetPath)) {
      files.push(targetPath);
    }

    return files;
  }

  if (!stats.isDirectory()) {
    return files;
  }

  const entries = await fs.readdir(targetPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(targetPath, entry.name);

    if (entry.isDirectory()) {
      if (isExcludedDirName(entry.name) || isExcludedPath(fullPath)) {
        continue;
      }

      await walkMatchingFiles(fullPath, files, acceptsFile);
      continue;
    }

    if (entry.isFile() && !isExcludedPath(fullPath) && acceptsFile(fullPath)) {
      files.push(fullPath);
    }
  }

  return files;
}

async function walkCodeFiles(targetPath: string, files: string[] = []): Promise<string[]> {
  return walkMatchingFiles(targetPath, files, isCodeFile);
}

export async function walkAnalyzableFiles(targetPath: string, files: string[] = []): Promise<string[]> {
  return walkMatchingFiles(targetPath, files, isAnalyzableSourceFile);
}

export function sourcePathCandidates(projectRoot: string, sourcePath: string): string[] {
  const requestedPath = String(sourcePath || "").split("/").join(path.sep);
  const candidates = [path.resolve(projectRoot, requestedPath)];
  const projectDirName = path.basename(projectRoot);
  const prefixedPattern = new RegExp(`^${projectDirName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\\\/]`);

  if (prefixedPattern.test(requestedPath)) {
    candidates.push(path.resolve(projectRoot, requestedPath.replace(prefixedPattern, "")));
  }

  return [...new Set(candidates)];
}

export async function resolveSourceTarget(projectRoot: string, sourcePath: string): Promise<{ absolute_path: string; relative_path: string } | null> {
  for (const candidate of sourcePathCandidates(projectRoot, sourcePath)) {
    if (!isWithinRoot(projectRoot, candidate)) {
      continue;
    }

    if (await pathExists(candidate)) {
      return {
        absolute_path: candidate,
        relative_path: toSlashPath(path.relative(projectRoot, candidate))
      };
    }
  }

  return null;
}

export function attachFileReference(fileMap: Map<string, FileReference>, absolutePath: string, relativePath: string, brickIds: Iterable<string>): void {
  const key = toSlashPath(absolutePath);
  const current = fileMap.get(key) || {
    absolute_path: absolutePath,
    relative_path: toSlashPath(relativePath),
    brick_ids: new Set<string>()
  };

  for (const brickId of brickIds) {
    current.brick_ids.add(brickId);
  }

  fileMap.set(key, current);
}

export async function analyzeProjectRefactorOpportunities(projectRoot: string, projectIdValue: string, bricks: RefactorBrick[]): Promise<RefactorProjectReport> {
  const sourceTargets = new Map<string, FileReference>();
  const missingSourcePathMap = new Map<string, { project: string; path: string; brick_ids: Set<string> }>();

  for (const brick of bricks) {
    for (const sourcePath of brick.source_paths || []) {
      const resolvedTarget = await resolveSourceTarget(projectRoot, sourcePath);

      if (!resolvedTarget) {
        const key = toSlashPath(sourcePath);
        const currentMissing = missingSourcePathMap.get(key) || {
          project: projectIdValue,
          path: key,
          brick_ids: new Set<string>()
        };

        currentMissing.brick_ids.add(brick.id);
        missingSourcePathMap.set(key, currentMissing);
        continue;
      }

      const key = toSlashPath(resolvedTarget.absolute_path);
      const current = sourceTargets.get(key) || {
        absolute_path: resolvedTarget.absolute_path,
        relative_path: resolvedTarget.relative_path,
        brick_ids: new Set<string>()
      };

      current.brick_ids.add(brick.id);
      sourceTargets.set(key, current);
    }
  }

  const fileMap = new Map<string, FileReference>();
  const missingSourcePaths = [...missingSourcePathMap.values()].map((entry) => ({
    project: entry.project,
    path: entry.path,
    related_brick_count: entry.brick_ids.size,
    related_bricks: [...entry.brick_ids].sort().slice(0, 12)
  }));
  const analysisFailures: AnalysisFailure[] = [];

  for (const target of sourceTargets.values()) {
    const sourceFiles: string[] = [];

    try {
      await walkCodeFiles(target.absolute_path, sourceFiles);
    } catch (error) {
      analysisFailures.push({
        project: projectIdValue,
        path: target.relative_path,
        error: error instanceof Error ? error.message : `Failed to walk source path ${target.relative_path}`
      });
      continue;
    }

    for (const sourceFile of sourceFiles) {
      attachFileReference(
        fileMap,
        sourceFile,
        path.relative(projectRoot, sourceFile),
        target.brick_ids
      );
    }
  }

  const oversizedFiles: OversizedFile[] = [];
  const severityCounts = { medium: 0, high: 0, critical: 0 };

  for (const file of fileMap.values()) {
    try {
      const sourceText = await fs.readFile(file.absolute_path, "utf8");
      const lineCount = sourceText.split(/\r?\n/).length;
      const severity = severityForLineCount(lineCount);

      if (!severity) {
        continue;
      }

      const splitPoints = detectSplitPoints(sourceText);
      severityCounts[severity] += 1;
      oversizedFiles.push({
        project: projectIdValue,
        path: file.relative_path,
        absolute_path: file.absolute_path,
        extension: path.extname(file.absolute_path).toLowerCase(),
        lines: lineCount,
        bytes: Buffer.byteLength(sourceText, "utf8"),
        severity,
        related_brick_count: file.brick_ids.size,
        related_bricks: [...file.brick_ids].sort().slice(0, 12),
        split_points: splitPoints,
        split_strategy: suggestSplitStrategy(splitPoints)
      });
    } catch (error) {
      analysisFailures.push({
        project: projectIdValue,
        path: file.relative_path,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
  }

  oversizedFiles.sort((a, b) => {
    const severityOrder = severityWeight(b.severity) - severityWeight(a.severity);
    return severityOrder || b.lines - a.lines || a.path.localeCompare(b.path);
  });

  return {
    project: projectIdValue,
    analyzed_file_count: fileMap.size,
    oversized_file_count: oversizedFiles.length,
    split_opportunity_count: oversizedFiles.filter((file) => file.split_points.length > 0).length,
    missing_source_path_count: missingSourcePaths.length,
    analysis_failure_count: analysisFailures.length,
    severity_counts: severityCounts,
    oversized_files: oversizedFiles,
    missing_source_paths: missingSourcePaths.sort((a, b) => a.path.localeCompare(b.path)),
    analysis_failures: analysisFailures.sort((a, b) => a.path.localeCompare(b.path))
  };
}

export function buildRefactorReport(projectReports: RefactorProjectReport[]) {
  const oversizedFiles = projectReports
    .flatMap((report) => report.oversized_files)
    .sort((a, b) => {
      const severityOrder = severityWeight(b.severity) - severityWeight(a.severity);
      return severityOrder || b.lines - a.lines || a.path.localeCompare(b.path);
    });

  const missingSourcePaths = projectReports
    .flatMap((report) => report.missing_source_paths)
    .sort((a, b) => a.project.localeCompare(b.project) || a.path.localeCompare(b.path));
  const analysisFailures = projectReports
    .flatMap((report) => report.analysis_failures)
    .sort((a, b) => a.project.localeCompare(b.project) || a.path.localeCompare(b.path));
  const refactorQueue = buildRefactorQueue(oversizedFiles);

  return {
    thresholds: { ...oversizedThresholds },
    analyzed_file_count: projectReports.reduce((sum, report) => sum + report.analyzed_file_count, 0),
    oversized_file_count: oversizedFiles.length,
    split_opportunity_count: oversizedFiles.filter((file) => file.split_points.length > 0).length,
    missing_source_path_count: missingSourcePaths.length,
    analysis_failure_count: analysisFailures.length,
    severity_counts: projectReports.reduce((counts, report) => ({
      medium: counts.medium + report.severity_counts.medium,
      high: counts.high + report.severity_counts.high,
      critical: counts.critical + report.severity_counts.critical
    }), { medium: 0, high: 0, critical: 0 }),
    projects: projectReports.map((report) => ({
      project: report.project,
      analyzed_file_count: report.analyzed_file_count,
      oversized_file_count: report.oversized_file_count,
      split_opportunity_count: report.split_opportunity_count,
      missing_source_path_count: report.missing_source_path_count,
      analysis_failure_count: report.analysis_failure_count,
      severity_counts: report.severity_counts
    })),
    top_split_opportunities: oversizedFiles
      .filter((file) => file.split_points.length > 0)
      .slice(0, 50),
    refactor_queue: refactorQueue,
    oversized_files: oversizedFiles,
    missing_source_paths: missingSourcePaths,
    analysis_failures: analysisFailures
  };
}

function inferRefactorTheme(file: OversizedFile): string {
  const splitKinds = new Set((file.split_points || []).map((point) => point.kind));
  const lowerPath = String(file.path || "").toLowerCase();
  const isUiFile = [".tsx", ".jsx"].includes(String(file.extension || "").toLowerCase())
    || lowerPath.includes("/components/")
    || lowerPath.includes("/pages/");

  if (splitKinds.has("route_handler")) {
    return "route_orchestration";
  }

  if (splitKinds.has("react_component") && splitKinds.has("hook")) {
    return "react_orchestration";
  }

  if (splitKinds.has("react_component") || isUiFile) {
    return "ui_component";
  }

  if (splitKinds.has("section")) {
    return "sectioned_module";
  }

  if (splitKinds.has("export_class") || splitKinds.has("class")) {
    return "service_or_engine";
  }

  if (lowerPath.includes("/types/") || lowerPath.endsWith(".types.ts") || lowerPath.includes("schema")) {
    return "types_or_schema";
  }

  if (lowerPath.includes("/data/") || lowerPath.includes("dictionary") || lowerPath.includes("messages")) {
    return "data_payload";
  }

  return "utility_module";
}

function queuePriorityScore(file: OversizedFile): number {
  const severityBase = severityWeight(file.severity) * 1000;
  const lineFactor = Math.min(file.lines || 0, 12000);
  const splitFactor = Math.min((file.split_points || []).length, 8) * 120;
  const brickFactor = Math.min(file.related_brick_count || 0, 5) * 60;
  return severityBase + lineFactor + splitFactor + brickFactor;
}

function extractionTargets(file: OversizedFile, theme: string): string[] {
  const labels = (file.split_points || []).map((point) => point.label).filter(Boolean);
  const uniqueLabels = [...new Set(labels)];

  if (theme === "route_orchestration") {
    return ["handlers", "service", "schema", "shared-utils"];
  }

  if (theme === "react_orchestration" || theme === "ui_component") {
    return ["view", "hooks", "state", "supporting-components"];
  }

  if (theme === "sectioned_module") {
    const sectionTargets = uniqueLabels
      .map((label) => slugifyRefactorLabel(label))
      .filter((label) => label !== "segment");

    if (sectionTargets.length > 0) {
      return sectionTargets.slice(0, 4);
    }

    return ["section-1", "section-2", "section-3", "section-4"];
  }

  if (theme === "service_or_engine") {
    return ["contracts", "core-service", "helpers", "errors"];
  }

  if (theme === "types_or_schema") {
    return ["shared-types", "feature-types", "generated-types", "constants"];
  }

  if (theme === "data_payload") {
    return ["catalog-part-1", "catalog-part-2", "constants", "lookup-utils"];
  }

  const utilityTargets = uniqueLabels.slice(0, 4).map((label) => slugifyRefactorLabel(label));
  return utilityTargets.length > 0 ? utilityTargets : ["exports", "helpers", "state", "compat"];
}

function slugifyRefactorLabel(label: unknown): string {
  return String(label || "segment")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "segment";
}

function firstActionForTheme(theme: string): string {
  return {
    route_orchestration: "Extract shared route logic and validation into sibling service modules before touching handlers.",
    react_orchestration: "Move hooks and state transitions out first, then split presentational components.",
    ui_component: "Extract helper hooks and child panels before changing the top-level component contract.",
    sectioned_module: "Cut along existing section markers and keep the current public entrypoint as a thin facade.",
    service_or_engine: "Separate errors, contracts, and pure helpers before breaking the main service class.",
    types_or_schema: "Shard generated and feature-specific types into import-safe slices, then leave a barrel file.",
    data_payload: "Split static payloads into smaller shards and add a lookup/index layer.",
    utility_module: "Extract exported helpers into focused modules and leave compatibility re-exports."
  }[theme] || "Extract one cohesive concern at a time and keep the old entrypoint as a facade until imports are updated.";
}

function riskNoteForTheme(theme: string): string {
  return {
    route_orchestration: "Watch for request/response shape drift and auth checks moving out of the handler path.",
    react_orchestration: "Watch for hook order regressions and prop contract churn across child components.",
    ui_component: "Watch for state ownership moving too early and turning a render split into a behavior regression.",
    sectioned_module: "Watch for circular imports if section helpers start reaching back into the facade.",
    service_or_engine: "Watch for hidden singleton state and side-effect ordering across extracted helpers.",
    types_or_schema: "Watch for import storms and generated-type consumers relying on a single mega-file path.",
    data_payload: "Watch for lookup performance regressions and duplicated constants across shards.",
    utility_module: "Watch for accidental behavior changes in shared helpers with many downstream callers."
  }[theme] || "Watch for import churn and compatibility breaks while the file is still the main integration point.";
}

export function buildRefactorQueue(oversizedFiles: OversizedFile[]) {
  return oversizedFiles
    .filter((file) => file.severity === "critical" || (file.severity === "high" && (file.split_points || []).length > 0))
    .map((file) => {
      const theme = inferRefactorTheme(file);
      const targets = extractionTargets(file, theme).filter(Boolean).slice(0, 4);
      const expectedSlices = Math.max(2, Math.min(targets.length || 2, Math.ceil((file.lines || 0) / 900)));
      const score = queuePriorityScore(file);

      return {
        project: file.project,
        path: file.path,
        severity: file.severity,
        lines: file.lines,
        priority_score: score,
        theme,
        expected_slices: expectedSlices,
        first_action: firstActionForTheme(theme),
        extraction_targets: targets,
        split_points: (file.split_points || []).slice(0, 6),
        strategy: file.split_strategy,
        risk_note: riskNoteForTheme(theme),
        related_brick_count: file.related_brick_count,
        related_bricks: file.related_bricks
      };
    })
    .sort((a, b) => b.priority_score - a.priority_score || b.lines - a.lines || a.path.localeCompare(b.path))
    .slice(0, 100)
    .map((entry, index) => ({
      rank: index + 1,
      ...entry
    }));
}

export function countBy<T>(items: T[], keyFn: (item: T) => string): [string, number][] {
  const counts = new Map<string, number>();

  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

const codeQualityPatternDefinitions = [
  {
    key: "ts_any",
    label: "TypeScript any",
    weight: 4,
    regex: /(?:\:\s*any\b|<\s*any\s*>|\bas\s+any\b)/g
  },
  {
    key: "ts_suppression",
    label: "TS suppression",
    weight: 6,
    regex: /@ts-ignore\b|@ts-expect-error\b|@ts-nocheck\b/g
  },
  {
    key: "lint_suppression",
    label: "Lint suppression",
    weight: 5,
    regex: /eslint-disable(?:-next-line|-line)?\b|biome-ignore\b/g
  },
  {
    key: "console_debug",
    label: "Console debug",
    weight: 2,
    regex: /\bconsole\.(?:log|debug|trace)\s*\(/g
  },
  {
    key: "todo_fixme",
    label: "TODO/FIXME debt",
    weight: 1,
    regex: /\b(?:TODO|FIXME|HACK|XXX)\b/g
  },
  {
    key: "deep_relative_import",
    label: "Deep relative import",
    weight: 3,
    regex: /from\s+['"](?:\.\.\/){3,}[^'"]+['"]|require\(\s*['"](?:\.\.\/){3,}[^'"]+['"]\s*\)|import\(\s*['"](?:\.\.\/){3,}[^'"]+['"]\s*\)/g
  },
  {
    key: "empty_catch",
    label: "Empty catch",
    weight: 6,
    regex: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g
  }
];

const codeQualityStructuralDefinitions = [
  {
    key: "oversized_react_component",
    label: "Oversized React component",
    weight: 18
  },
  {
    key: "oversized_custom_hook",
    label: "Oversized custom hook",
    weight: 14
  },
  {
    key: "oversized_service_file",
    label: "Oversized service file",
    weight: 12
  }
];

const codeQualityDefinitions = [
  ...codeQualityPatternDefinitions,
  ...codeQualityStructuralDefinitions
];

export function emptyCodeQualityCounts(): CodeQualityCounts {
  return Object.fromEntries(codeQualityDefinitions.map((definition) => [definition.key, 0]));
}

function countMatches(sourceText: unknown, regex: RegExp): number {
  const matches = String(sourceText || "").match(regex);
  return matches ? matches.length : 0;
}

function qualitySeverityLevel(lineCount: number, baseThreshold: number, step: number, maxLevel = 3): number {
  if (lineCount < baseThreshold) {
    return 0;
  }

  return Math.max(1, Math.min(maxLevel, 1 + Math.floor((lineCount - baseThreshold) / step)));
}

function looksLikeReactComponentFile(filePath: string, sourceText: string): boolean {
  if (!/\.(?:tsx|jsx)$/i.test(filePath)) {
    return false;
  }

  return /<[A-Za-z][\w:-]*/.test(sourceText)
    || /\buse(?:State|Effect|Memo|Callback|Reducer|Ref|LayoutEffect|Transition|DeferredValue)\b/.test(sourceText);
}

function looksLikeHookFile(filePath: string, sourceText: string): boolean {
  const base = path.basename(filePath);
  return /^use[A-Z0-9].*\.(?:ts|tsx|js|jsx)$/i.test(base)
    || /\bfunction\s+use[A-Z0-9_]/.test(sourceText)
    || /\bconst\s+use[A-Z0-9_]\w*\s*=\s*(?:async\s*)?\(/.test(sourceText);
}

function looksLikeServiceFile(filePath: string): boolean {
  return /(?:^|\/)(?:src\/)?(?:main\/)?services?(?:\/|$)/i.test(toSlashPath(filePath))
    || /Service\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(path.basename(filePath));
}

function structuralCodeQualityCounts({ filePath, sourceText, lineCount, testLike = false }: { filePath: string; sourceText: string; lineCount: number; testLike?: boolean }): CodeQualityCounts {
  const counts = emptyCodeQualityCounts();

  if (testLike) {
    return counts;
  }

  if (looksLikeReactComponentFile(filePath, sourceText)) {
    counts.oversized_react_component = qualitySeverityLevel(lineCount, 320, 220);
  }

  if (looksLikeHookFile(filePath, sourceText)) {
    counts.oversized_custom_hook = qualitySeverityLevel(lineCount, 220, 180);
  }

  if (looksLikeServiceFile(filePath)) {
    counts.oversized_service_file = qualitySeverityLevel(lineCount, 320, 220);
  }

  return counts;
}

function normalizeCodeFingerprint(sourceText: unknown): string {
  return String(sourceText || "")
    .replace(/\b\d+(?:\.\d+)?\b/g, "0")
    .replace(/\s+/g, "");
}

export function duplicateFingerprintForFile({ filePath, sourceText, lineCount, testLike = false }: { filePath: string; sourceText: string; lineCount: number; testLike?: boolean }): string | null {
  if (testLike || lineCount < 120 || !isCodeFile(filePath)) {
    return null;
  }

  const normalized = normalizeCodeFingerprint(sourceText);

  if (normalized.length < 800) {
    return null;
  }

  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

export function analyzeCodeQualityCounts(sourceText: string, { filePath = "", lineCount = 0, testLike = false }: { filePath?: string; lineCount?: number; testLike?: boolean } = {}): CodeQualityCounts {
  const counts = emptyCodeQualityCounts();

  for (const definition of codeQualityPatternDefinitions) {
    if (testLike && definition.key === "console_debug") {
      continue;
    }

    counts[definition.key] = countMatches(sourceText, definition.regex);
  }

  mergeCodeQualityCounts(
    counts,
    structuralCodeQualityCounts({ filePath, sourceText, lineCount, testLike })
  );

  return counts;
}

export function mergeCodeQualityCounts(target: CodeQualityCounts, nextCounts: CodeQualityCounts): CodeQualityCounts {
  for (const definition of codeQualityDefinitions) {
    target[definition.key] = (target[definition.key] || 0) + (nextCounts?.[definition.key] || 0);
  }

  return target;
}

export function codeQualityMatchCount(counts: CodeQualityCounts): number {
  return Object.values(counts || {}).reduce<number>((sum, value) => sum + Number(value || 0), 0);
}

export function codeQualityWeightedScore(counts: CodeQualityCounts): number {
  return codeQualityDefinitions.reduce((sum, definition) => sum + ((counts?.[definition.key] || 0) * definition.weight), 0);
}

export function compactCodeQualityCounts(counts: CodeQualityCounts): CodeQualityCounts {
  return Object.fromEntries(
    Object.entries(counts || {})
      .filter(([, value]) => Number(value || 0) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1]) || String(a[0]).localeCompare(String(b[0])))
  );
}

export function topCodeQualityTypes(counts: CodeQualityCounts, limit = 3): QualityType[] {
  return codeQualityDefinitions
    .map((definition) => ({
      key: definition.key,
      label: definition.label,
      count: counts?.[definition.key] || 0,
      weighted_score: (counts?.[definition.key] || 0) * definition.weight
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.weighted_score - a.weighted_score || b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

export function buildQualityDuplicateGroups(entries: QualityFingerprintEntry[]): QualityQueueEntry[] {
  const byFingerprint = new Map<string, QualityFingerprintEntry[]>();

  for (const entry of entries) {
    const current = byFingerprint.get(entry.fingerprint) || [];
    current.push(entry);
    byFingerprint.set(entry.fingerprint, current);
  }

  return [...byFingerprint.entries()]
    .map(([fingerprint, files]) => ({
      fingerprint,
      files
    }))
    .map((group) => {
      const uniqueFiles = [...new Map(group.files.map((entry) => [entry.path, entry])).values()];
      const files = uniqueFiles
        .sort((a, b) => (b.line_count || 0) - (a.line_count || 0) || String(a.path).localeCompare(String(b.path)));
      const relatedBricks = [...new Set(files.map((entry) => entry.brick_id).filter(Boolean))];

      return {
        project: files[0]?.project || "",
        category: "duplicate_code",
        fingerprint: group.fingerprint,
        path: files[0]?.path || "",
        related_bricks: relatedBricks,
        file_count: files.length,
        brick_count: relatedBricks.length,
        total_lines: files.reduce((sum, entry) => sum + Number(entry.line_count || 0), 0),
        total_tokens: files.reduce((sum, entry) => sum + Number(entry.raw_source_tokens || 0), 0),
        sample_paths: files.map((entry) => entry.path).slice(0, 8),
        priority_score: (files.length * 60) + Math.round(files.reduce((sum, entry) => sum + Number(entry.line_count || 0), 0) / 20),
        why: `Normalized code fingerprint repeats across ${files.length} file(s) and ${relatedBricks.length} brick(s).`,
        first_action: "Extract a shared seam or delete one fork instead of maintaining duplicate code."
      };
    })
    .filter((group) => group.file_count >= 2)
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || String(a.path).localeCompare(String(b.path)));
}

function qualityQueuePriority(entry: QualityHotspot): number {
  return Math.round(
    Number(entry.smell_score || 0)
    + Math.min(120, Number(entry.line_count || 0) / 6)
    + Math.min(80, Number(entry.raw_source_tokens || 0) / 3000)
  );
}

function qualityQueueAction(topTypes: QualityType[] = []): string {
  const primary = topTypes[0]?.key;

  switch (primary) {
    case "ts_any":
      return "Replace `any` at the public seam first, then narrow the internal flow types.";
    case "deep_relative_import":
      return "Cut deep relative imports behind a local barrel, alias, or public module seam.";
    case "console_debug":
      return "Remove noisy debug logging or route it through a real debug/logger seam.";
    case "empty_catch":
      return "Replace empty catches with explicit handling, telemetry, or a documented ignore path.";
    case "lint_suppression":
    case "ts_suppression":
      return "Delete broad suppressions and fix the underlying type or lint issue at the boundary.";
    case "oversized_react_component":
      return "Split this component into smaller presentational and stateful seams before adding more features.";
    case "oversized_custom_hook":
      return "Break this hook into smaller hooks or pure helpers so behavior and state are isolated.";
    case "oversized_service_file":
      return "Split orchestration, adapters, and domain rules out of this service file.";
    default:
      return "Reduce the dominant code smells in this file before promoting it further.";
  }
}

export function buildQualityQueue(hotspots: QualityHotspot[], duplicateGroups: QualityQueueEntry[]): QualityQueueEntry[] {
  const hotspotActions = hotspots
    .filter((entry) => Number(entry.smell_score || 0) >= 40 || Number(entry.total_matches || 0) >= 12)
    .map((entry) => ({
      project: entry.project,
      category: "quality_hotspot",
      path: entry.path,
      brick_id: entry.brick_id,
      brick_name: entry.brick_name,
      smell_score: entry.smell_score,
      total_matches: entry.total_matches,
      line_count: entry.line_count,
      raw_source_tokens: entry.raw_source_tokens,
      by_type: entry.by_type,
      top_types: entry.top_types,
      priority_score: qualityQueuePriority(entry),
      why: `${entry.total_matches} smell hit(s) with dominant issues in ${entry.top_types.map((type) => type.label).join(", ")}.`,
      first_action: qualityQueueAction(entry.top_types)
    }));

  return [...hotspotActions, ...duplicateGroups]
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 120);
}

export function dedupeQualityHotspots(entries: QualityHotspot[]): QualityHotspot[] {
  const byKey = new Map<string, QualityHotspot>();

  for (const entry of entries || []) {
    const key = `${entry.project || ""}:${entry.path || ""}`;
    const current = byKey.get(key);

    if (!current || Number(entry.smell_score || 0) > Number(current.smell_score || 0) || Number(entry.total_matches || 0) > Number(current.total_matches || 0)) {
      byKey.set(key, entry);
    }
  }

  return [...byKey.values()];
}

export function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(String(value || "").length / 4));
}

export function gradeForScore(score: number): string {
  if (score >= 90) return "A";
  if (score >= 80) return "B";
  if (score >= 70) return "C";
  if (score >= 55) return "D";
  return "F";
}

export function readinessLabel(score: number): string {
  if (score >= 90) return "launch_ready";
  if (score >= 80) return "strong_foundation";
  if (score >= 70) return "promising_but_incomplete";
  if (score >= 55) return "refactor_required";
  return "heavy_repair_required";
}

export function isIgnoredEnvReference(name: unknown): boolean {
  const normalized = String(name || "").trim().toUpperCase();

  if (!normalized) {
    return true;
  }

  if (ignoredEnvNames.has(normalized)) {
    return true;
  }

  if (normalized.startsWith("NPM_")) {
    return true;
  }

  return ignoredEnvPrefixes.some((prefix) => normalized.startsWith(prefix));
}

export function isContractRelevantEnvReference(name: unknown): boolean {
  const normalized = String(name || "").trim().toUpperCase();

  if (!normalized || isIgnoredEnvReference(normalized)) {
    return false;
  }

  return contractEnvSignals.some((signal) => normalized === signal || normalized.includes(`_${signal}`) || normalized.startsWith(`${signal}_`) || normalized.endsWith(`_${signal}`));
}
