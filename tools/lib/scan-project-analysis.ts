/**
 * Project source graph, boundary, clone, and readiness analysis.
 * Extracted from sma-scan.ts; keep registry behavior byte-identical.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isWithinRoot, pathExists, toSlashPath } from "./scan-discovery.ts";
import {
  analyzeCodeQualityCounts, attachFileReference, buildQualityDuplicateGroups, buildQualityQueue,
  codeQualityMatchCount, codeQualityWeightedScore, compactCodeQualityCounts, countBy,
  dedupeQualityHotspots, duplicateFingerprintForFile, emptyCodeQualityCounts, estimateTokens,
  gradeForScore, isCodeFile, isContractRelevantEnvReference,
  mergeCodeQualityCounts, oversizedThresholds, readinessLabel, resolveSourceTarget,
  sourcePathCandidates, topCodeQualityTypes, walkAnalyzableFiles
} from "./scan-refactor.ts";
import {
  buildProjectBuildReport, contractStatusScore, detectProjectBuildCandidates,
  emptyComplianceReport, finalizeComplianceReport
} from "./scan-build.ts";

const smaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ignoredImportExtensions = new Set([
  ".css", ".scss", ".sass", ".less", ".styl",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico",
  ".mp3", ".wav", ".ogg", ".mp4", ".webm",
  ".woff", ".woff2", ".ttf", ".otf", ".eot"
]);
export function normalizeDuplicateStem(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|php|cs|sql)$/i, "")
    .replace(/^(use|get|set|create|build|render)-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^(acme-desktop|acme-studio|acme-factory|workspace-root|acme-desktop)-/, "")
    .replace(/^-+|-+$/g, "");
}

export function normalizeImportSpecifier(specifier) {
  return String(specifier || "")
    .split("?")[0]
    .split("#")[0]
    .trim();
}

export function isIgnoredProjectImportSpecifier(specifier) {
  const normalized = normalizeImportSpecifier(specifier);

  if (!normalized || /^virtual:/i.test(normalized)) {
    return true;
  }

  const ext = path.extname(normalized).toLowerCase();
  return ignoredImportExtensions.has(ext);
}

export function isTestLikePath(value) {
  const normalized = String(value || "").replaceAll("\\", "/");
  return /(^|\/)(__tests__|tests?|suites)(\/|$)|\.(test|spec)\.[a-z0-9]+$/i.test(normalized)
    || normalized.includes("0000testing/");
}

export function isTestLikeBrick(brick) {
  if (!brick) {
    return false;
  }

  if (/test/i.test(String(brick.kind || ""))) {
    return true;
  }

  if (isTestLikePath(brick.name) || isTestLikePath(brick.brick_group)) {
    return true;
  }

  return (brick.source_paths || []).some((sourcePath) => isTestLikePath(sourcePath));
}

export function normalizeBrickGroupKey(value) {
  const group = String(value || "");
  const [, relative = ""] = group.split(":");
  return relative.replace(/\/+$/g, "");
}

export function sharedSourceRoot(brick) {
  const [sourcePath = ""] = brick?.source_paths || [];
  return String(sourcePath || "").replace(/\/+$/g, "");
}

export function sharesBrickGroupFamily(left, right) {
  if (!left || !right) {
    return false;
  }

  const leftGroup = normalizeBrickGroupKey(left.brick_group);
  const rightGroup = normalizeBrickGroupKey(right.brick_group);

  if (leftGroup && rightGroup && (
    leftGroup === rightGroup
    || leftGroup.startsWith(`${rightGroup}/`)
    || rightGroup.startsWith(`${leftGroup}/`)
  )) {
    return true;
  }

  const leftRoot = sharedSourceRoot(left);
  const rightRoot = sharedSourceRoot(right);

  return Boolean(leftRoot && rightRoot && (
    leftRoot === rightRoot
    || leftRoot.startsWith(`${rightRoot}/`)
    || rightRoot.startsWith(`${leftRoot}/`)
  ));
}

export function isCloneTrackableBrick(brick) {
  return brick.status === "candidate"
    || brick.status === "canonical"
    || ["copy_ready", "guided", "semi_automatic"].includes(brick.clone_readiness)
    || (brick.clone_install_steps || []).length > 0
    || (brick.clone_known_traps || []).length > 0;
}

export function shouldTrackManifestDrift(brick, files) {
  if ((files || []).length === 0) {
    return false;
  }

  return isCloneTrackableBrick(brick);
}

export function duplicateStemForBrick(brick) {
  const firstSourcePath = String((brick.source_paths || [])[0] || "");
  const pathStem = normalizeDuplicateStem(path.basename(firstSourcePath));
  const nameStem = normalizeDuplicateStem(brick.name || brick.id);
  return pathStem || nameStem || "unknown";
}

export function looksLikeProjectImport(specifier) {
  if (isIgnoredProjectImportSpecifier(specifier)) {
    return false;
  }

  if (specifier === "electron") {
    return false;
  }

  return specifier.startsWith(".")
    || specifier.startsWith("/")
    || specifier.startsWith("@/")
    || specifier.startsWith("~/")
    || /^(src|app|apps|web|packages|acme-agent|supabase|electron|renderer|main|sidecar|shared|lib|libs|0000[a-z0-9._-]*|000_[a-z0-9._-]+|002-[a-z0-9._-]+|099_[a-z0-9._-]+)/i.test(specifier);
}

export function importResolutionCandidates(basePath) {
  const ext = path.extname(basePath).toLowerCase();
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".sql"];
  const candidates = [basePath];

  if (!ext) {
    for (const candidateExt of extensions) {
      candidates.push(`${basePath}${candidateExt}`);
    }

    for (const candidateExt of extensions) {
      candidates.push(path.join(basePath, `index${candidateExt}`));
    }

    return [...new Set(candidates)];
  }

  const baseWithoutExt = basePath.slice(0, -ext.length);

  if (extensions.includes(ext)) {
    for (const candidateExt of extensions) {
      candidates.push(`${baseWithoutExt}${candidateExt}`);
    }

    for (const candidateExt of extensions) {
      candidates.push(path.join(baseWithoutExt, `index${candidateExt}`));
    }

    return [...new Set(candidates)];
  }

  for (const candidateExt of extensions) {
    candidates.push(`${basePath}${candidateExt}`);
  }

  for (const candidateExt of extensions) {
    candidates.push(path.join(basePath, `index${candidateExt}`));
  }

  return [...new Set(candidates)];
}

export function importBasePath(projectRoot, fromFile, specifier) {
  if (specifier.startsWith(".")) {
    return path.resolve(path.dirname(fromFile), specifier);
  }

  if (specifier.startsWith("/")) {
    return path.resolve(projectRoot, `.${specifier}`);
  }

  if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
    return null;
  }

  if (looksLikeProjectImport(specifier)) {
    return path.resolve(projectRoot, specifier);
  }

  return null;
}

export function contextualProjectRoots(projectRoot, fromFile, leadingSegment = "src") {
  const roots = [projectRoot];
  let current = path.dirname(fromFile);

  while (isWithinRoot(projectRoot, current)) {
    if (path.basename(current) === leadingSegment) {
      roots.push(path.dirname(current));
    }

    if (current === projectRoot) {
      break;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      break;
    }

    current = parent;
  }

  return [...new Set(roots)];
}

export async function resolveProjectImport(projectRoot, fromFile, specifier, cache = null, existsCache = null) {
  const normalizedSpecifier = normalizeImportSpecifier(specifier);
  const cacheKey = `${fromFile}\0${normalizedSpecifier}`;

  if (cache?.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  if (!normalizedSpecifier || !looksLikeProjectImport(normalizedSpecifier)) {
    return null;
  }

  const basePaths = [];

  if (normalizedSpecifier.startsWith("@/") || normalizedSpecifier.startsWith("~/")) {
    const trimmed = normalizedSpecifier.slice(2);
    const roots = contextualProjectRoots(projectRoot, fromFile, "src");

    for (const root of roots) {
      basePaths.push(
        path.resolve(root, trimmed),
        path.resolve(root, "src", trimmed),
        path.resolve(root, "web", "src", trimmed),
        path.resolve(root, "app", trimmed)
      );
    }
  } else {
    const basePath = importBasePath(projectRoot, fromFile, normalizedSpecifier);

    if (basePath) {
      basePaths.push(basePath);
    }

    if (!normalizedSpecifier.startsWith(".") && !normalizedSpecifier.startsWith("/")) {
      const [leadingSegment = "src"] = normalizedSpecifier.split("/");

      for (const root of contextualProjectRoots(projectRoot, fromFile, leadingSegment)) {
        basePaths.push(path.resolve(root, normalizedSpecifier));
      }
    }
  }

  const scopedBasePaths = [...new Set(basePaths)].filter((basePath) => basePath && isWithinRoot(projectRoot, basePath));

  if (scopedBasePaths.length === 0) {
    return null;
  }

  for (const basePath of scopedBasePaths) {
    for (const candidate of importResolutionCandidates(basePath)) {
      if (!isWithinRoot(projectRoot, candidate)) {
        continue;
      }

      const exists = existsCache?.has(candidate)
        ? existsCache.get(candidate)
        : await pathExists(candidate);

      if (existsCache && !existsCache.has(candidate)) {
        existsCache.set(candidate, exists);
      }

      if (exists) {
        const resolved = {
          absolute_path: candidate,
          unresolved: false
        };

        if (cache) {
          cache.set(cacheKey, resolved);
        }

        return resolved;
      }
    }
  }

  const unresolved = {
    absolute_path: importResolutionCandidates(scopedBasePaths[0])[0],
    unresolved: true
  };

  if (cache) {
    cache.set(cacheKey, unresolved);
  }

  return unresolved;
}

export function extractImportSpecifiers(sourceText) {
  const specifiers = new Set();
  const patterns = [
    /\bimport\s+(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\bexport\s+(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g,
    /\brequire\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
    /\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g
  ];

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(sourceText)) !== null) {
      const specifier = match[1];

      if (!specifier || specifier.startsWith("node:") || /^[a-z]+:\/\//i.test(specifier)) {
        continue;
      }

      specifiers.add(specifier);
    }
  }

  return [...specifiers];
}

export function countExports(sourceText) {
  const matches = sourceText.match(/\bexport\s+(default\s+)?(async\s+)?(function|class|const|let|var|type|interface|enum)\b/g) || [];
  const moduleExports = sourceText.match(/\bmodule\.exports\b|\bexports\.[A-Za-z0-9_]+\b/g) || [];
  return matches.length + moduleExports.length;
}

export function extractEnvReferences(sourceText) {
  const names = [];
  const patterns = [
    /\bprocess\.env\.([A-Z][A-Z0-9_]+)/g,
    /\bprocess\.env\[\s*["'`]([A-Z][A-Z0-9_]+)["'`]\s*\]/g,
    /\bimport\.meta\.env\.([A-Z][A-Z0-9_]+)/g,
    /\bimport\.meta\.env\[\s*["'`]([A-Z][A-Z0-9_]+)["'`]\s*\]/g,
    /\bDeno\.env\.get\(\s*["'`]([A-Z][A-Z0-9_]+)["'`]\s*\)/g,
    /\bBun\.env\.([A-Z][A-Z0-9_]+)/g,
    /\bBun\.env\[\s*["'`]([A-Z][A-Z0-9_]+)["'`]\s*\]/g
  ];

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.exec(sourceText)) !== null) {
      if (match[1]) {
        names.push(match[1]);
      }
    }
  }

  return names;
}

export function extractSupabaseTableRefs(sourceText, filePath = "") {
  const names = new Set();
  const fromPattern = /\.\s*from\(\s*["'`]([A-Za-z0-9_.-]+)["'`]\s*\)/g;
  let match;
  const sqlKeywords = new Set([
    "all",
    "and",
    "as",
    "before",
    "by",
    "cascade",
    "case",
    "check",
    "constraint",
    "default",
    "delete",
    "desc",
    "distinct",
    "do",
    "else",
    "end",
    "exists",
    "false",
    "for",
    "from",
    "function",
    "group",
    "if",
    "in",
    "insert",
    "into",
    "is",
    "join",
    "not",
    "null",
    "on",
    "or",
    "order",
    "primary",
    "references",
    "returning",
    "select",
    "set",
    "table",
    "then",
    "true",
    "unique",
    "update",
    "using",
    "values",
    "when",
    "where",
    "with"
  ]);

  const addTableName = (value) => {
    const normalized = String(value || "").replace(/^public\./i, "");
    if (!normalized || sqlKeywords.has(normalized.toLowerCase())) {
      return;
    }

    names.add(normalized);
  };

  while ((match = fromPattern.exec(sourceText)) !== null) {
    if (match[1]) {
      addTableName(match[1]);
    }
  }

  if (path.extname(filePath).toLowerCase() === ".sql") {
    const sqlPatterns = [
      /\b(?:from|into|update|join)\s+(?:public\.)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi,
      /\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi,
      /\balter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi,
      /\bdrop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/gi,
      /\breferences\s+(?:public\.)?["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s*\(/gi
    ];

    for (const sqlPattern of sqlPatterns) {
      while ((match = sqlPattern.exec(sourceText)) !== null) {
        if (match[1]) {
          addTableName(match[1]);
        }
      }
    }
  }

  return [...names].sort();
}

export function envRemediationPriority(entry) {
  const blockedWeight = entry.effective_status === "blocked" ? 18 : entry.effective_status === "manual_review" ? 8 : 0;
  return (entry.undeclared_env_refs?.length || 0) * 18
    + (entry.observed_env_variable_count || 0) * 2
    + blockedWeight
    + Math.min(24, Math.round((entry.raw_source_tokens || 0) / 12000));
}

export function rlsRemediationPriority(entry) {
  const blockedWeight = entry.effective_status === "blocked" ? 16 : entry.effective_status === "manual_review" ? 7 : 0;
  return (entry.observed_table_refs?.length || 0) * 16
    + ((entry.negative_test_count || 0) === 0 ? 12 : 0)
    + blockedWeight
    + Math.min(24, Math.round((entry.raw_source_tokens || 0) / 12000));
}

export function boundaryRemediationPriority(entry) {
  return (entry.private_cross_import_count || 0) * 60
    + (entry.cross_brick_owned_import_count || 0) * 12
    + (entry.unresolved_local_import_count || 0) * 10
    + (entry.unowned_local_dependency_count || 0) * 5
    + Math.min(24, Math.round((entry.raw_source_tokens || 0) / 12000));
}

export function remediationActionProjectPlans(actions, limit = 3) {
  const byProject = new Map();

  for (const action of actions) {
    const current = byProject.get(action.project) || [];
    current.push(action);
    byProject.set(action.project, current);
  }

  return [...byProject.entries()]
    .map(([project, entries]) => ({
      project,
      actions: entries
        .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0) || String(a.path).localeCompare(String(b.path)))
        .slice(0, limit)
    }))
    .sort((a, b) => {
      const aTop = a.actions[0]?.priority_score || 0;
      const bTop = b.actions[0]?.priority_score || 0;
      return bTop - aTop || a.project.localeCompare(b.project);
    });
}

export function manifestPathHint(projectRoot, sourcePath) {
  for (const candidate of sourcePathCandidates(projectRoot, sourcePath)) {
    if (!isWithinRoot(projectRoot, candidate)) {
      continue;
    }

    return {
      absolute_path: candidate,
      relative_path: toSlashPath(path.relative(projectRoot, candidate))
    };
  }

  return null;
}

export function pathRuleMatches(rulePath, targetPath) {
  return rulePath === targetPath || isWithinRoot(rulePath, targetPath);
}

export function buildBoundaryRules(projectRoot, bricks) {
  const rules = [];
  const rulesByBrick = new Map();
  const scopes = [
    ["private", "private_paths"],
    ["public", "public_paths"],
    ["owned", "owned_paths"],
    ["source", "source_paths"]
  ];

  for (const brick of bricks) {
    const brickRules = [];

    for (const [scope, field] of scopes) {
      for (const sourcePath of brick[field] || []) {
        const hint = manifestPathHint(projectRoot, sourcePath);

        if (!hint) {
          continue;
        }

        const rule = {
          brick_id: brick.id,
          scope,
          absolute_path: hint.absolute_path,
          relative_path: hint.relative_path
        };

        brickRules.push(rule);
        rules.push(rule);
      }
    }

    rulesByBrick.set(brick.id, brickRules.sort((a, b) => b.absolute_path.length - a.absolute_path.length));
  }

  const scopeWeight = { private: 4, public: 3, owned: 2, source: 1 };

  rules.sort((a, b) => {
    const byLength = b.absolute_path.length - a.absolute_path.length;
    return byLength || (scopeWeight[b.scope] || 0) - (scopeWeight[a.scope] || 0);
  });

  return { rules, rulesByBrick };
}

export function findBoundaryMatch(rules, targetPath) {
  return rules.find((rule) => pathRuleMatches(rule.absolute_path, targetPath)) || null;
}

export function matchesOwnBoundary(targetPath, ownRules = []) {
  return ownRules.some((rule) => pathRuleMatches(rule.absolute_path, targetPath));
}

export async function collectProjectSourceGraph(projectRoot, projectIdValue, bricks) {
  const sourceTargets = new Map();
  const missingSourcePathMap = new Map();

  for (const brick of bricks) {
    for (const sourcePath of brick.source_paths || []) {
      const resolvedTarget = await resolveSourceTarget(projectRoot, sourcePath);

      if (!resolvedTarget) {
        const key = `${brick.id}\0${sourcePath}`;
        missingSourcePathMap.set(key, {
          project: projectIdValue,
          brick_id: brick.id,
          path: toSlashPath(sourcePath)
        });
        continue;
      }

      const key = toSlashPath(resolvedTarget.absolute_path);
      const current = sourceTargets.get(key) || {
        absolute_path: resolvedTarget.absolute_path,
        relative_path: resolvedTarget.relative_path,
        brick_ids: new Set()
      };

      current.brick_ids.add(brick.id);
      sourceTargets.set(key, current);
    }
  }

  const fileMap = new Map();
  const brickFiles = new Map();
  const analysisFailures = [];

  for (const target of sourceTargets.values()) {
    const sourceFiles = [];

    try {
      await walkAnalyzableFiles(target.absolute_path, sourceFiles);
    } catch (error) {
      analysisFailures.push({
        project: projectIdValue,
        path: target.relative_path,
        error: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    for (const sourceFile of sourceFiles) {
      const relativePath = toSlashPath(path.relative(projectRoot, sourceFile));
      attachFileReference(fileMap, sourceFile, relativePath, target.brick_ids);

      for (const brickId of target.brick_ids) {
        const existing = brickFiles.get(brickId) || [];

        if (!existing.some((item) => item.absolute_path === sourceFile)) {
          existing.push({
            absolute_path: sourceFile,
            relative_path: relativePath
          });
        }

        brickFiles.set(brickId, existing);
      }
    }
  }

  return {
    file_map: fileMap,
    brick_files: brickFiles,
    missing_source_paths: [...missingSourcePathMap.values()].sort((a, b) => a.path.localeCompare(b.path)),
    analysis_failures: analysisFailures.sort((a, b) => a.path.localeCompare(b.path))
  };
}

export async function loadCompactCardIndex() {
  const filePath = path.join(smaRoot, "security", "brick_cards.jsonl");
  const index = new Map();

  try {
    const raw = await fs.readFile(filePath, "utf8");

    for (const line of raw.split(/\r?\n/).filter(Boolean)) {
      try {
        const record = JSON.parse(line);

        if (record.id) {
          index.set(record.id, record);
        }
      } catch (error) {
        void error;
        // ignore malformed lines
      }
    }
  } catch (error) {
    void error;
    return index;
  }

  return index;
}

export function cardTokenEstimate(card) {
  return estimateTokens(JSON.stringify(card || {}));
}

export function buildDuplicateClusters(bricks) {
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

export function readinessReasons(penalties) {
  return penalties
    .filter((penalty) => penalty.points > 0)
    .sort((a, b) => b.points - a.points || a.label.localeCompare(b.label))
    .slice(0, 5)
    .map((penalty) => `${penalty.label} (-${penalty.points})`);
}

export function boundaryViolationPriority(kind) {
  return {
    private_cross_brick_import: 4,
    unresolved_local_import: 3,
    unowned_local_dependency: 2,
    cross_brick_owned_import: 1
  }[kind] || 0;
}

export async function analyzeProjectScannerReport(projectRoot, projectIdValue, bricks, unmanifestedCount = 0, compactCardIndex = new Map()) {
  const sourceGraph = await collectProjectSourceGraph(projectRoot, projectIdValue, bricks);
  const buildCandidates = detectProjectBuildCandidates(projectIdValue, bricks);
  const buildReport = buildProjectBuildReport(projectIdValue, buildCandidates);
  const { rules, rulesByBrick } = buildBoundaryRules(projectRoot, bricks);
  const brickById = new Map(bricks.map((brick) => [brick.id, brick]));
  const importResolutionCache = new Map();
  const importExistsCache = new Map();
  const boundaryMatchCache = new Map();
  const boundaryViolations = [];
  const driftEntries = [];
  const cloneEntries = [];
  const tokenHeavyBricks = [];
  const envGapBricks = [];
  const blockerCounts = new Map();
  const observedEnvNameCounts = new Map();
  const undeclaredEnvNameCounts = new Map();
  const ignoredEnvNameCounts = new Map();
  const declaredEnvNames = new Set();
  const complianceReport = emptyComplianceReport(projectIdValue);
  const rlsGapBricks = [];
  const boundaryHotspots = [];
  let localImportCount = 0;
  let publicCrossBrickImportCount = 0;
  let sameGroupInternalImportCount = 0;
  let crossBrickOwnedImportCount = 0;
  let privateCrossBrickImportCount = 0;
  let unresolvedLocalImportCount = 0;
  let unownedLocalDependencyCount = 0;
  let rawSourceTokens = 0;
  let estimatedSummaryTokens = 0;
  let compactCardTokens = 0;
  let compactCardCoverageCount = 0;
  let observedEnvReferenceCount = 0;
  let ignoredEnvReferenceCount = 0;
  let analyzedCodeFileCount = 0;
  let totalQualitySmellCount = 0;
  let totalQualityWeightedScore = 0;
  const aggregateQualityCounts = emptyCodeQualityCounts();
  const codeQualityHotspots = [];
  const codeQualityBricks = [];
  const duplicateFingerprintEntries = [];

  for (const brick of bricks) {
    const files = sourceGraph.brick_files.get(brick.id) || [];
    let totalLines = 0;
    let maxFileLines = 0;
    let exportCount = 0;
    let brickTokens = 0;
    let localImportsForBrick = 0;
    let publicImportsForBrick = 0;
    let sameGroupImportsForBrick = 0;
    let ownedImportsForBrick = 0;
    let privateImportsForBrick = 0;
    let unresolvedImportsForBrick = 0;
    let unknownDepsForBrick = 0;
    let brickQualitySmellCount = 0;
    let brickQualityWeighted = 0;
    const brickQualityCounts = emptyCodeQualityCounts();
    const observedEnvRefs = new Set();
    const observedTableRefs = new Set();
    const ownRules = rulesByBrick.get(brick.id) || [];
    const testLikeBrick = isTestLikeBrick(brick);
    const cloneTrackable = isCloneTrackableBrick(brick);
    const strictReuseBrick = brick.status === "candidate"
      || brick.status === "canonical"
      || ["copy_ready", "guided", "semi_automatic"].includes(brick.clone_readiness);
    const declaredEnvSet = new Set((brick.env_contract?.variables || []).map((entry) => entry?.name).filter(Boolean));

    for (const name of declaredEnvSet) {
      declaredEnvNames.add(name);
    }

    for (const file of files) {
      const sourceText = await fs.readFile(file.absolute_path, "utf8");
      const lineCount = sourceText.split(/\r?\n/).length;
      const tokenCount = estimateTokens(sourceText);

      totalLines += lineCount;
      maxFileLines = Math.max(maxFileLines, lineCount);
      brickTokens += tokenCount;
      exportCount += isCodeFile(file.absolute_path) ? countExports(sourceText) : 0;

      if (!isCodeFile(file.absolute_path)) {
        continue;
      }

      analyzedCodeFileCount += 1;
      const fileIsTestLike = testLikeBrick || isTestLikePath(file.relative_path);
      const qualityCounts = analyzeCodeQualityCounts(sourceText, {
        filePath: file.relative_path,
        lineCount,
        testLike: fileIsTestLike
      });
      const qualityMatchCount = codeQualityMatchCount(qualityCounts);
      const qualityWeighted = codeQualityWeightedScore(qualityCounts);
      const duplicateFingerprint = duplicateFingerprintForFile({
        filePath: file.relative_path,
        sourceText,
        lineCount,
        testLike: fileIsTestLike
      });

      if (qualityMatchCount > 0) {
        totalQualitySmellCount += qualityMatchCount;
        totalQualityWeightedScore += qualityWeighted;
        brickQualitySmellCount += qualityMatchCount;
        brickQualityWeighted += qualityWeighted;
        mergeCodeQualityCounts(aggregateQualityCounts, qualityCounts);
        mergeCodeQualityCounts(brickQualityCounts, qualityCounts);

        codeQualityHotspots.push({
          project: projectIdValue,
          brick_id: brick.id,
          brick_name: brick.name,
          path: file.relative_path,
          smell_score: qualityWeighted,
          total_matches: qualityMatchCount,
          line_count: lineCount,
          raw_source_tokens: tokenCount,
          by_type: compactCodeQualityCounts(qualityCounts),
          top_types: topCodeQualityTypes(qualityCounts)
        });
      }

      if (duplicateFingerprint) {
        duplicateFingerprintEntries.push({
          project: projectIdValue,
          brick_id: brick.id,
          brick_name: brick.name,
          path: file.relative_path,
          line_count: lineCount,
          raw_source_tokens: tokenCount,
          fingerprint: duplicateFingerprint
        });
      }

      if (!fileIsTestLike) {
        for (const envName of extractEnvReferences(sourceText)) {
          if (!isContractRelevantEnvReference(envName)) {
            ignoredEnvReferenceCount += 1;
            ignoredEnvNameCounts.set(envName, (ignoredEnvNameCounts.get(envName) || 0) + 1);
            continue;
          }

          observedEnvReferenceCount += 1;
          observedEnvRefs.add(envName);
          observedEnvNameCounts.set(envName, (observedEnvNameCounts.get(envName) || 0) + 1);
        }

        for (const tableName of extractSupabaseTableRefs(sourceText, file.absolute_path)) {
          observedTableRefs.add(tableName);
        }
      }

      for (const specifier of extractImportSpecifiers(sourceText)) {
        const normalizedSpecifier = normalizeImportSpecifier(specifier);

        if (!normalizedSpecifier || isIgnoredProjectImportSpecifier(normalizedSpecifier)) {
          continue;
        }

        const cachedResolved = await resolveProjectImport(projectRoot, file.absolute_path, normalizedSpecifier, importResolutionCache, importExistsCache);
        if (!cachedResolved) {
          continue;
        }

        localImportCount += 1;
        localImportsForBrick += 1;

        if (cachedResolved.unresolved) {
          unresolvedLocalImportCount += 1;
          unresolvedImportsForBrick += 1;

          if (!testLikeBrick && !isTestLikePath(file.relative_path)) {
            boundaryViolations.push({
              project: projectIdValue,
              brick_id: brick.id,
              file: file.relative_path,
              specifier: normalizedSpecifier,
              kind: "unresolved_local_import"
            });
          }
          continue;
        }

        const match = boundaryMatchCache.has(cachedResolved.absolute_path)
          ? boundaryMatchCache.get(cachedResolved.absolute_path)
          : findBoundaryMatch(rules, cachedResolved.absolute_path);

        if (!boundaryMatchCache.has(cachedResolved.absolute_path)) {
          boundaryMatchCache.set(cachedResolved.absolute_path, match);
        }

        if (match && match.brick_id !== brick.id) {
          const targetBrick = brickById.get(match.brick_id);
          const testContext = fileIsTestLike;

          if (testContext) {
            continue;
          }

          if (match.scope === "private") {
            privateCrossBrickImportCount += 1;
            privateImportsForBrick += 1;
            boundaryViolations.push({
              project: projectIdValue,
              brick_id: brick.id,
              target_brick_id: match.brick_id,
              file: file.relative_path,
              target: match.relative_path,
              specifier: normalizedSpecifier,
              kind: "private_cross_brick_import"
            });
          } else if (sharesBrickGroupFamily(brick, targetBrick)) {
            sameGroupInternalImportCount += 1;
            sameGroupImportsForBrick += 1;
          } else if (match.scope !== "public") {
            crossBrickOwnedImportCount += 1;
            ownedImportsForBrick += 1;
            boundaryViolations.push({
              project: projectIdValue,
              brick_id: brick.id,
              target_brick_id: match.brick_id,
              file: file.relative_path,
              target: match.relative_path,
              specifier: normalizedSpecifier,
              kind: "cross_brick_owned_import"
            });
          } else {
            publicCrossBrickImportCount += 1;
            publicImportsForBrick += 1;
          }
        } else if (!match && !matchesOwnBoundary(cachedResolved.absolute_path, ownRules)) {
          unownedLocalDependencyCount += 1;
          unknownDepsForBrick += 1;

          if (!testLikeBrick && !isTestLikePath(file.relative_path)) {
            boundaryViolations.push({
              project: projectIdValue,
              brick_id: brick.id,
              file: file.relative_path,
              target: toSlashPath(path.relative(projectRoot, cachedResolved.absolute_path)),
              specifier: normalizedSpecifier,
              kind: "unowned_local_dependency"
            });
          }
        }
      }
    }

    const envContractTrackable = cloneTrackable && (
      Boolean(brick.env_contract?.required)
      || observedEnvRefs.size > 0
      || declaredEnvSet.size > 0
    );
    const undeclaredEnvRefs = envContractTrackable
      ? [...observedEnvRefs].filter((name) => !declaredEnvSet.has(name)).sort()
      : [];

    for (const name of undeclaredEnvRefs) {
      const current = undeclaredEnvNameCounts.get(name) || {
        name,
        brick_count: 0,
        bricks: new Set()
      };

      if (!current.bricks.has(brick.id)) {
        current.brick_count += 1;
        current.bricks.add(brick.id);
      }

      undeclaredEnvNameCounts.set(name, current);
    }

    rawSourceTokens += brickTokens;
    const card = compactCardIndex.get(brick.id);
    const compactTokens = card ? cardTokenEstimate(card) : 0;
    const summaryTokens = compactTokens || estimateTokens([
      brick.name,
      ...(brick.public_api || []).slice(0, 4),
      ...(brick.clone_install_steps || []).slice(0, 2),
      ...(brick.adapters || []).slice(0, 2)
    ].join(" "));

    estimatedSummaryTokens += summaryTokens;
    compactCardTokens += compactTokens;
    compactCardCoverageCount += compactTokens > 0 ? 1 : 0;

    tokenHeavyBricks.push({
      project: projectIdValue,
      brick_id: brick.id,
      name: brick.name,
      path: (brick.source_paths || [])[0] || "",
      raw_source_tokens: brickTokens,
      summary_tokens: summaryTokens,
      compact_card_tokens: compactTokens,
      estimated_savings_tokens: Math.max(0, brickTokens - summaryTokens),
      file_count: files.length
    });

    const driftTrackable = shouldTrackManifestDrift(brick, files);

    const maxFileLineDiff = Math.abs((brick.quality_line_count?.max_file_lines || 0) - maxFileLines);
    const featureLineDiff = Math.abs((brick.code_budget?.feature_lines || 0) - totalLines);
    const fileCountDiff = Math.abs((brick.code_budget?.file_count || 0) - files.length);

    if (
      driftTrackable
      && ((brick.quality_line_count?.max_file_lines || 0) > 0 || (strictReuseBrick && maxFileLines >= oversizedThresholds.critical))
      && maxFileLineDiff >= Math.max(120, Math.round((brick.quality_line_count?.max_file_lines || 0) * 0.5))
    ) {
      driftEntries.push({
        project: projectIdValue,
        brick_id: brick.id,
        kind: "max_file_lines_drift",
        manifest_value: brick.quality_line_count?.max_file_lines || 0,
        actual_value: maxFileLines,
        path: (brick.source_paths || [])[0] || ""
      });
    }

    if (driftTrackable && (brick.code_budget?.file_count || 0) > 0 && fileCountDiff >= Math.max(5, Math.round((brick.code_budget?.file_count || 0) * 0.3))) {
      driftEntries.push({
        project: projectIdValue,
        brick_id: brick.id,
        kind: "file_count_drift",
        manifest_value: brick.code_budget?.file_count || 0,
        actual_value: files.length,
        path: (brick.source_paths || [])[0] || ""
      });
    }

    if (
      driftTrackable
      && ((brick.code_budget?.feature_lines || 0) > 0 || (strictReuseBrick && totalLines >= 1200))
      && featureLineDiff >= Math.max(400, Math.round((brick.code_budget?.feature_lines || 0) * 0.35))
    ) {
      driftEntries.push({
        project: projectIdValue,
        brick_id: brick.id,
        kind: "feature_line_drift",
        manifest_value: brick.code_budget?.feature_lines || 0,
        actual_value: totalLines,
        path: (brick.source_paths || [])[0] || ""
      });
    }

    if (driftTrackable && isCloneTrackableBrick(brick) && (brick.public_api || []).length === 0 && exportCount >= 3) {
      driftEntries.push({
        project: projectIdValue,
        brick_id: brick.id,
        kind: "missing_public_api_declaration",
        manifest_value: 0,
        actual_value: exportCount,
        path: (brick.source_paths || [])[0] || ""
      });
    }

    const blockerCodes = [];
    const warningCodes = [];
    const highRiskFindings = (brick.vulnerability_findings?.critical || 0) + (brick.vulnerability_findings?.high || 0);
    const skippedVerification = (brick.verification || []).some((event) => event.status === "skipped");
    const missingSourceForBrick = sourceGraph.missing_source_paths.some((entry) => entry.brick_id === brick.id);

    if (brick.health.error_count > 0) blockerCodes.push("validation_error");
    if (missingSourceForBrick) blockerCodes.push("missing_source_files");
    if (highRiskFindings > 0) blockerCodes.push("high_risk_vulnerability");
    if (privateImportsForBrick > 0) blockerCodes.push("private_cross_brick_import");
    if (((strictReuseBrick && ownedImportsForBrick >= 6) || ownedImportsForBrick >= 20)) blockerCodes.push("cross_brick_owned_import");
    if (((strictReuseBrick && unknownDepsForBrick >= 4) || unknownDepsForBrick >= 20)) blockerCodes.push("unowned_local_dependency");
    if (((strictReuseBrick && unresolvedImportsForBrick >= 4) || unresolvedImportsForBrick >= 20)) blockerCodes.push("unresolved_local_import");
    if (strictReuseBrick && undeclaredEnvRefs.length > 0) blockerCodes.push("env_reference_undeclared");
    if (cloneTrackable && brick.clone_readiness !== "manual_only" && (brick.clone_install_steps || []).length === 0) blockerCodes.push("missing_clone_steps");
    if (cloneTrackable && brick.clone_readiness !== "manual_only" && (brick.clone_known_traps || []).length === 0) blockerCodes.push("missing_known_traps");
    if (envContractTrackable && brick.env_contract?.required && brick.env_contract.status !== "complete") blockerCodes.push("env_contract_incomplete");
    if (cloneTrackable && brick.rls_contract?.required && brick.rls_contract.status !== "complete") blockerCodes.push("rls_contract_incomplete");

    if (cloneTrackable && (brick.test_commands || []).length === 0) warningCodes.push("missing_test_commands");
    if (cloneTrackable && (brick.public_api || []).length === 0 && exportCount >= 3) warningCodes.push("public_api_missing");
    if ((brick.status === "candidate" || brick.status === "canonical") && !brick.source_commit && !brick.source_archive_hash) warningCodes.push("source_attestation_missing");
    if ((brick.status === "candidate" || brick.status === "canonical") && skippedVerification) warningCodes.push("verification_skipped");
    if (!strictReuseBrick && undeclaredEnvRefs.length > 0) warningCodes.push("env_reference_undeclared");
    if (ownedImportsForBrick > 0) warningCodes.push("cross_group_dependency");
    if (unknownDepsForBrick > 0 && !blockerCodes.includes("unowned_local_dependency")) warningCodes.push("unowned_local_dependency");
    if (unresolvedImportsForBrick > 0 && !blockerCodes.includes("unresolved_local_import")) warningCodes.push("unresolved_local_import");
    if (maxFileLines > 600) warningCodes.push("file_over_600");
    if (brick.code_budget?.status === "bloated") warningCodes.push("code_budget_bloated");
    if (brick.health.warning_count > 0) warningCodes.push("validation_warning");

    for (const code of [...blockerCodes, ...warningCodes]) {
      blockerCounts.set(code, (blockerCounts.get(code) || 0) + 1);
    }

    const effectiveStatus = blockerCodes.length > 0
      ? "blocked"
      : brick.clone_readiness === "copy_ready" && warningCodes.length === 0
        ? "copy_ready"
        : brick.clone_readiness === "guided" && warningCodes.length <= 2
          ? "guided"
          : "manual_review";

    cloneEntries.push({
      project: projectIdValue,
      brick_id: brick.id,
      name: brick.name,
      path: (brick.source_paths || [])[0] || "",
      declared_readiness: brick.clone_readiness,
      effective_status: effectiveStatus,
      blocker_codes: blockerCodes,
      warning_codes: warningCodes,
      local_import_count: localImportsForBrick,
      public_cross_import_count: publicImportsForBrick,
      same_group_internal_import_count: sameGroupImportsForBrick,
      cross_brick_owned_import_count: ownedImportsForBrick,
      private_cross_import_count: privateImportsForBrick,
      unresolved_local_import_count: unresolvedImportsForBrick,
      unowned_local_dependency_count: unknownDepsForBrick,
      undeclared_env_refs: undeclaredEnvRefs,
      raw_source_tokens: brickTokens,
      file_count: files.length
    });

    if (undeclaredEnvRefs.length > 0) {
      envGapBricks.push({
        project: projectIdValue,
        brick_id: brick.id,
        name: brick.name,
        path: (brick.source_paths || [])[0] || "",
        undeclared_env_refs: undeclaredEnvRefs,
        observed_env_variable_count: observedEnvRefs.size,
        declared_env_variable_count: declaredEnvSet.size,
        effective_status: effectiveStatus,
        raw_source_tokens: brickTokens
      });
    }

    if (cloneTrackable && Boolean(brick.rls_contract?.required) && contractStatusScore(brick.rls_contract?.status) < 1) {
      rlsGapBricks.push({
        project: projectIdValue,
        brick_id: brick.id,
        name: brick.name,
        path: (brick.source_paths || [])[0] || "",
        rls_status: brick.rls_contract?.status || "unknown",
        observed_table_refs: [...observedTableRefs].slice(0, 8),
        negative_test_count: (brick.rls_contract?.negative_tests || []).length,
        effective_status: effectiveStatus,
        raw_source_tokens: brickTokens
      });
    }

    const boundaryPriority = boundaryRemediationPriority({
      private_cross_import_count: privateImportsForBrick,
      cross_brick_owned_import_count: ownedImportsForBrick,
      unresolved_local_import_count: unresolvedImportsForBrick,
      unowned_local_dependency_count: unknownDepsForBrick,
      raw_source_tokens: brickTokens
    });

    if (boundaryPriority > 0) {
      boundaryHotspots.push({
        project: projectIdValue,
        brick_id: brick.id,
        name: brick.name,
        path: (brick.source_paths || [])[0] || "",
        private_cross_import_count: privateImportsForBrick,
        cross_brick_owned_import_count: ownedImportsForBrick,
        unresolved_local_import_count: unresolvedImportsForBrick,
        unowned_local_dependency_count: unknownDepsForBrick,
        effective_status: effectiveStatus,
        raw_source_tokens: brickTokens,
        priority_score: boundaryPriority
      });
    }

    if (cloneTrackable) {
      complianceReport.trackable_brick_count += 1;
    }

    const complianceDimensions = [
      {
        key: "boundary_clean",
        active: cloneTrackable,
        ready: privateImportsForBrick === 0 && ownedImportsForBrick === 0 && unresolvedImportsForBrick === 0 && unknownDepsForBrick === 0,
        contribution: privateImportsForBrick === 0 && ownedImportsForBrick === 0 && unresolvedImportsForBrick === 0 && unknownDepsForBrick === 0 ? 1 : 0
      },
      {
        key: "env_contract",
        active: envContractTrackable,
        ready: undeclaredEnvRefs.length === 0
          && contractStatusScore(brick.env_contract?.status) >= 1
          && (observedEnvRefs.size === 0 || declaredEnvSet.size > 0),
        contribution: (() => {
          const statusScore = contractStatusScore(brick.env_contract?.status);
          const declarationCoverage = observedEnvRefs.size > 0
            ? Math.max(0, (observedEnvRefs.size - undeclaredEnvRefs.length) / observedEnvRefs.size)
            : declaredEnvSet.size > 0
              ? 1
              : statusScore;

          return Number(((statusScore * 0.5) + (declarationCoverage * 0.5)).toFixed(2));
        })()
      },
      {
        key: "clone_steps",
        active: cloneTrackable && brick.clone_readiness !== "manual_only",
        ready: (brick.clone_install_steps || []).length > 0,
        contribution: (brick.clone_install_steps || []).length > 0 ? 1 : 0
      },
      {
        key: "test_commands",
        active: cloneTrackable,
        ready: (brick.test_commands || []).length > 0,
        contribution: (brick.test_commands || []).length > 0 ? 1 : 0
      },
      {
        key: "known_traps",
        active: cloneTrackable && brick.clone_readiness !== "manual_only",
        ready: (brick.clone_known_traps || []).length > 0,
        contribution: (brick.clone_known_traps || []).length > 0 ? 1 : 0
      },
      {
        key: "public_api",
        active: cloneTrackable && ((brick.public_api || []).length > 0 || exportCount >= 3),
        ready: (brick.public_api || []).length > 0,
        contribution: (brick.public_api || []).length > 0 ? 1 : 0
      },
      {
        key: "rls_contract",
        active: cloneTrackable && Boolean(brick.rls_contract?.required),
        ready: contractStatusScore(brick.rls_contract?.status) >= 1,
        contribution: contractStatusScore(brick.rls_contract?.status)
      },
      {
        key: "source_attestation",
        active: brick.status === "candidate" || brick.status === "canonical",
        ready: Boolean(brick.source_commit || brick.source_archive_hash),
        contribution: brick.source_commit || brick.source_archive_hash ? 1 : 0
      },
      {
        key: "security_clean",
        active: cloneTrackable,
        ready: highRiskFindings === 0,
        contribution: highRiskFindings === 0 ? 1 : 0
      }
    ];
    const missingDimensions = [];

    for (const dimension of complianceDimensions) {
      if (!dimension.active) {
        continue;
      }

      complianceReport.dimensions[dimension.key].total_count += 1;
      complianceReport.dimensions[dimension.key].coverage_units += Number(dimension.contribution ?? (dimension.ready ? 1 : 0));

      if (dimension.ready) {
        complianceReport.dimensions[dimension.key].ready_count += 1;
      } else {
        missingDimensions.push(dimension.key);
      }
    }

    if (cloneTrackable && missingDimensions.length > 0) {
      complianceReport.highest_gap_bricks.push({
        project: projectIdValue,
        brick_id: brick.id,
        name: brick.name,
        path: (brick.source_paths || [])[0] || "",
        effective_status: effectiveStatus,
        missing_dimensions: missingDimensions,
        missing_count: missingDimensions.length,
        raw_source_tokens: brickTokens
      });
    }

    if (brickQualitySmellCount > 0) {
      codeQualityBricks.push({
        project: projectIdValue,
        brick_id: brick.id,
        name: brick.name,
        path: (brick.source_paths || [])[0] || "",
        smell_score: brickQualityWeighted,
        total_matches: brickQualitySmellCount,
        by_type: compactCodeQualityCounts(brickQualityCounts),
        top_types: topCodeQualityTypes(brickQualityCounts),
        raw_source_tokens: brickTokens
      });
    }
  }

  const uniqueCodeQualityHotspots = dedupeQualityHotspots(codeQualityHotspots);
  const duplicateGroups = buildQualityDuplicateGroups(duplicateFingerprintEntries);
  const qualityQueue = buildQualityQueue(uniqueCodeQualityHotspots, duplicateGroups);
  const cloneStatusCounts = Object.fromEntries(countBy(cloneEntries, (entry) => entry.effective_status));
  const codeQualityPenalty = analyzedCodeFileCount > 0
    ? Math.min(
      80,
      Math.round(
        ((codeQualityHotspots.length / analyzedCodeFileCount) * 55)
        + ((totalQualityWeightedScore / analyzedCodeFileCount) * 0.7)
      )
    )
    : 0;
  const codeQualityScore = Math.max(0, 100 - codeQualityPenalty);
  const penalties = [
    { label: "validation blockers", points: Math.min(28, Math.round((cloneEntries.filter((entry) => entry.blocker_codes.includes("validation_error")).length / Math.max(1, bricks.length)) * 80)) },
    { label: "blocked clone preflight", points: Math.min(24, Math.round(((cloneStatusCounts.blocked || 0) / Math.max(1, bricks.length)) * 70)) },
    { label: "boundary violations", points: Math.min(16, Math.round(((privateCrossBrickImportCount + unownedLocalDependencyCount + unresolvedLocalImportCount + Math.ceil(crossBrickOwnedImportCount / 3)) / Math.max(1, bricks.length)) * 8)) },
    { label: "env contract drift", points: Math.min(14, Math.round((envGapBricks.length / Math.max(1, bricks.length)) * 60)) },
    { label: "manifest drift", points: Math.min(12, Math.round((driftEntries.length / Math.max(1, bricks.length)) * 8)) },
    { label: "unmanifested backlog", points: Math.min(10, unmanifestedCount * 2) },
    { label: "oversized code", points: Math.min(10, Math.round((cloneEntries.filter((entry) => entry.warning_codes.includes("file_over_600")).length / Math.max(1, bricks.length)) * 24)) }
  ];
  const readinessScore = Math.max(0, 100 - penalties.reduce((sum, penalty) => sum + penalty.points, 0));
  const finalizedComplianceReport = finalizeComplianceReport(complianceReport);
  const envContractQueue = envGapBricks
    .map((entry) => ({
      ...entry,
      category: "env_contract",
      priority_score: envRemediationPriority(entry),
      first_action: `Declare ${entry.undeclared_env_refs.slice(0, 3).join(", ")} in the manifest env contract.`,
      why: `${entry.undeclared_env_refs.length} undeclared env var(s) keep this brick from being clone-safe.`
    }))
    .sort((a, b) => b.priority_score - a.priority_score || (b.undeclared_env_refs?.length || 0) - (a.undeclared_env_refs?.length || 0) || a.path.localeCompare(b.path))
    .slice(0, 80);
  const rlsContractQueue = rlsGapBricks
    .map((entry) => ({
      ...entry,
      category: "rls_contract",
      priority_score: rlsRemediationPriority(entry),
      first_action: entry.observed_table_refs.length > 0
        ? `Review RLS and negative tests for ${entry.observed_table_refs.slice(0, 3).join(", ")}.`
        : "Review required RLS contract and add negative tests in the manifest.",
      why: entry.observed_table_refs.length > 0
        ? `RLS is partial and this brick touches ${entry.observed_table_refs.length} table(s).`
        : "RLS is required but the contract is not complete."
    }))
    .sort((a, b) => b.priority_score - a.priority_score || (b.observed_table_refs?.length || 0) - (a.observed_table_refs?.length || 0) || a.path.localeCompare(b.path))
    .slice(0, 80);
  const boundaryQueue = boundaryHotspots
    .map((entry) => ({
      ...entry,
      category: "boundary",
      first_action: entry.private_cross_import_count > 0
        ? "Stop importing a sibling brick's private path; expose a public seam or merge the ownership."
        : "Resolve cross-brick ownership leaks and local unresolved imports before promoting reuse.",
      why: `${entry.private_cross_import_count || 0} private, ${entry.cross_brick_owned_import_count || 0} owned, ${entry.unresolved_local_import_count || 0} unresolved, ${entry.unowned_local_dependency_count || 0} unowned imports.`
    }))
    .sort((a, b) => b.priority_score - a.priority_score || a.path.localeCompare(b.path))
    .slice(0, 80);
  const remediationActions = [...envContractQueue, ...rlsContractQueue, ...boundaryQueue, ...qualityQueue]
    .sort((a, b) => b.priority_score - a.priority_score || String(a.category).localeCompare(String(b.category)) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 120);

  return {
    project: projectIdValue,
    readiness: {
      score: readinessScore,
      grade: gradeForScore(readinessScore),
      label: readinessLabel(readinessScore),
      reasons: readinessReasons(penalties),
      metrics: {
        brick_count: bricks.length,
        unmanifested_count: unmanifestedCount,
        blocked_clone_count: cloneStatusCounts.blocked || 0,
        copy_ready_count: cloneStatusCounts.copy_ready || 0,
        guided_count: cloneStatusCounts.guided || 0,
        manual_review_count: cloneStatusCounts.manual_review || 0,
        drift_count: driftEntries.length,
        boundary_violation_count: privateCrossBrickImportCount + crossBrickOwnedImportCount + unownedLocalDependencyCount + unresolvedLocalImportCount,
        same_group_coupling_count: sameGroupInternalImportCount,
        env_gap_count: envGapBricks.length,
        compliance_score: finalizedComplianceReport.score
      }
    },
    boundary_report: {
      import_scan_count: localImportCount,
      public_cross_brick_import_count: publicCrossBrickImportCount,
      same_group_internal_import_count: sameGroupInternalImportCount,
      cross_brick_owned_import_count: crossBrickOwnedImportCount,
      private_cross_brick_import_count: privateCrossBrickImportCount,
      unresolved_local_import_count: unresolvedLocalImportCount,
      unowned_local_dependency_count: unownedLocalDependencyCount,
      top_violations: boundaryViolations
        .sort((a, b) => boundaryViolationPriority(b.kind) - boundaryViolationPriority(a.kind) || String(a.file).localeCompare(String(b.file)))
        .slice(0, 100)
    },
    clone_preflight: {
      counts: {
        copy_ready: cloneStatusCounts.copy_ready || 0,
        guided: cloneStatusCounts.guided || 0,
        manual_review: cloneStatusCounts.manual_review || 0,
        blocked: cloneStatusCounts.blocked || 0
      },
      blocker_counts: Object.fromEntries([...blockerCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
      highest_risk_bricks: cloneEntries
        .sort((a, b) => b.blocker_codes.length - a.blocker_codes.length || b.warning_codes.length - a.warning_codes.length || b.raw_source_tokens - a.raw_source_tokens)
        .slice(0, 80)
    },
    manifest_drift: {
      count: driftEntries.length,
      by_type: Object.fromEntries(countBy(driftEntries, (entry) => entry.kind)),
      entries: driftEntries
        .sort((a, b) => String(a.path).localeCompare(String(b.path)))
        .slice(0, 120)
    },
    code_quality_report: {
      score: codeQualityScore,
      grade: gradeForScore(codeQualityScore),
      analyzed_code_file_count: analyzedCodeFileCount,
      hotspot_file_count: uniqueCodeQualityHotspots.length,
      brick_hotspot_count: codeQualityBricks.length,
      duplicate_cluster_count: duplicateGroups.length,
      total_smell_count: totalQualitySmellCount,
      weighted_smell_score: totalQualityWeightedScore,
      by_type: compactCodeQualityCounts(aggregateQualityCounts),
      top_hotspots: uniqueCodeQualityHotspots
        .sort((a, b) => b.smell_score - a.smell_score || b.total_matches - a.total_matches || String(a.path).localeCompare(String(b.path)))
        .slice(0, 100),
      highest_risk_bricks: codeQualityBricks
        .sort((a, b) => b.smell_score - a.smell_score || b.total_matches - a.total_matches || String(a.path).localeCompare(String(b.path)))
        .slice(0, 80),
      duplicate_groups: duplicateGroups.slice(0, 60)
    },
    env_contract_report: {
      observed_reference_count: observedEnvReferenceCount,
      observed_variable_count: observedEnvNameCounts.size,
      observed_variable_names: [...observedEnvNameCounts.keys()].sort(),
      ignored_reference_count: ignoredEnvReferenceCount,
      ignored_variable_count: ignoredEnvNameCounts.size,
      ignored_variable_names: [...ignoredEnvNameCounts.keys()].sort(),
      declared_variable_count: declaredEnvNames.size,
      undeclared_reference_count: envGapBricks.reduce((sum, entry) => sum + entry.undeclared_env_refs.length, 0),
      bricks_with_undeclared_refs: envGapBricks.length,
      top_undeclared_refs: [...undeclaredEnvNameCounts.values()]
        .sort((a, b) => b.brick_count - a.brick_count || a.name.localeCompare(b.name))
        .slice(0, 24)
        .map((entry) => ({
          name: entry.name,
          brick_count: entry.brick_count,
          sample_bricks: [...entry.bricks].sort().slice(0, 6)
        })),
      highest_gap_bricks: envGapBricks
        .map((entry) => {
          const cloneEntry = cloneEntries.find((candidate) => candidate.brick_id === entry.brick_id);

          return {
            ...entry,
            effective_status: cloneEntry?.effective_status || "manual_review"
          };
        })
        .sort((a, b) => b.undeclared_env_refs.length - a.undeclared_env_refs.length || a.path.localeCompare(b.path))
        .slice(0, 80)
    },
    compliance_report: finalizedComplianceReport,
    build_report: buildReport,
    remediation_report: {
      counts: {
        env_contract: envGapBricks.length,
        rls_contract: rlsGapBricks.length,
        boundary: boundaryHotspots.length,
        quality: qualityQueue.length
      },
      env_contract_queue: envContractQueue,
      rls_contract_queue: rlsContractQueue,
      boundary_queue: boundaryQueue,
      quality_queue: qualityQueue.slice(0, 80),
      top_actions: remediationActions,
      project_action_plans: remediationActionProjectPlans(remediationActions)
    },
    duplicate_clusters: [],
    token_economics: {
      raw_source_tokens: rawSourceTokens,
      estimated_summary_tokens: estimatedSummaryTokens,
      compact_card_tokens: compactCardTokens,
      compact_card_coverage_count: compactCardCoverageCount,
      compact_card_coverage_rate: bricks.length ? Number((compactCardCoverageCount / bricks.length).toFixed(3)) : 0,
      estimated_reduction_percent: rawSourceTokens ? Math.round(((rawSourceTokens - estimatedSummaryTokens) / rawSourceTokens) * 100) : 0,
      top_token_heavy_bricks: tokenHeavyBricks
        .sort((a, b) => b.raw_source_tokens - a.raw_source_tokens || a.path.localeCompare(b.path))
        .slice(0, 60)
    },
    missing_source_paths: sourceGraph.missing_source_paths,
    analysis_failures: sourceGraph.analysis_failures
  };
}
