/**
 * Compliance scoring and build-candidate analysis.
 * Extracted from sma-scan.ts; keep registry behavior byte-identical.
 */

import path from "node:path";
import { gradeForScore } from "./scan-refactor.ts";

type BuildSignalType = "feature" | "domain" | "path" | "group";
type BuildSignal = { type: BuildSignalType; value: string; group_size?: number };
export type ScanBrick = {
  id: string; name: string; kind: string; status?: string; score?: number; source_paths?: string[]; domain?: unknown[];
  feature_cluster?: string | { id?: string; name?: string } | null; brick_group?: string | null;
};
type BuildCandidate = {
  candidate_key: string; recurrence_key: string; project: string; name: string; confidence_score: number; confidence_label: string;
  brick_count: number; average_brick_score: number; detection_sources: BuildSignalType[]; dominant_feature_cluster: string | null;
  dominant_domain: string | null; dominant_path_root: string | null; dominant_group: string | null;
  signal_type_counts: Record<string, number>; kind_counts: Record<string, number>; status_counts: Record<string, number>;
  sample_paths: string[]; brick_ids: string[]; sample_bricks: Array<{ id: string; name: string; kind: string; status?: string; score?: number; feature_cluster: string | null; source_path: string }>;
  recurrent_projects: string[]; recurrent_project_count: number; why: string;
};
type CandidateSignature = Pick<BuildCandidate, "candidate_key" | "recurrence_key" | "project" | "confidence_score" | "brick_count" | "detection_sources" | "dominant_feature_cluster" | "dominant_domain" | "dominant_path_root" | "dominant_group">;
type BuildProjectSummary = { project?: string; candidate_count?: number; average_confidence_score?: number; recurrent_candidate_count?: number; candidate_signatures?: CandidateSignature[]; [key: string]: unknown };
type ProjectBuildReport = {
  project?: string; candidate_count: number; detected_brick_count: number; recurrent_candidate_count: number; recurrent_family_count: number;
  average_confidence_score: number; signal_type_counts: Record<BuildSignalType, number>; top_candidates: BuildCandidate[];
  candidate_signatures: CandidateSignature[]; projects: BuildProjectSummary[];
};
type ComplianceDimension = { label: string; weight: number; ready_count: number; coverage_units: number; total_count: number; coverage_rate: number };
type GapBrick = { missing_count: number; raw_source_tokens: number; path: string; [key: string]: unknown };
type ComplianceReport = { project?: string; trackable_brick_count: number; score: number; grade: string; dimensions: Record<string, Partial<ComplianceDimension>>; weakest_dimensions: Array<Partial<ComplianceDimension> & { key?: string }>; highest_gap_bricks: GapBrick[] };

export const complianceDimensionDefinitions = [
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

const genericBuildTokens = new Set([
  "api",
  "app",
  "apps",
  "asset",
  "assets",
  "client",
  "common",
  "component",
  "components",
  "config",
  "context",
  "contexts",
  "core",
  "data",
  "domain",
  "feature",
  "features",
  "file",
  "files",
  "general",
  "helper",
  "helpers",
  "hook",
  "hooks",
  "internal",
  "lib",
  "libs",
  "main",
  "module",
  "modules",
  "page",
  "pages",
  "private",
  "provider",
  "providers",
  "public",
  "renderer",
  "route",
  "routes",
  "screen",
  "screens",
  "server",
  "service",
  "services",
  "shared",
  "src",
  "state",
  "store",
  "stores",
  "system",
  "test",
  "tests",
  "type",
  "types",
  "ui",
  "util",
  "utils",
  "view",
  "views",
  "web"
]);
export function emptyComplianceReport(project: string | null = null): ComplianceReport {
  return {
    ...(project ? { project } : {}),
    trackable_brick_count: 0,
    score: 0,
    grade: "F",
    dimensions: Object.fromEntries(complianceDimensionDefinitions.map((definition) => [definition.key, {
      label: definition.label,
      weight: definition.weight,
      ready_count: 0,
      coverage_units: 0,
      total_count: 0,
      coverage_rate: 0
    }])),
    weakest_dimensions: [],
    highest_gap_bricks: []
  };
}

function emptyBuildReport(project: string | null = null): ProjectBuildReport {
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

export function contractStatusScore(status: unknown): number {
  const normalized = String(status || "").toLowerCase();

  if (["pass", "complete", "ready"].includes(normalized)) {
    return 1;
  }

  if (["partial", "in_progress", "draft"].includes(normalized)) {
    return 0.4;
  }

  if (["not_applicable", "n/a", "na"].includes(normalized)) {
    return 1;
  }

  return 0;
}

export function finalizeComplianceReport(report: ComplianceReport) {
  const dimensions = Object.fromEntries(complianceDimensionDefinitions.map((definition) => {
    const current = report.dimensions?.[definition.key] || {};
    const totalCount = Number(current.total_count || 0);
    const readyCount = Number(current.ready_count || 0);
    const coverageUnits = Number((current.coverage_units ?? readyCount) || 0);
    const coverageRate = totalCount > 0 ? Math.round((coverageUnits / totalCount) * 100) : 100;

    return [definition.key, {
      label: current.label || definition.label,
      weight: Number(current.weight || definition.weight),
      ready_count: readyCount,
      coverage_units: Number(coverageUnits.toFixed(2)),
      total_count: totalCount,
      coverage_rate: coverageRate
    }];
  }));
  const activeDimensions = Object.entries(dimensions).filter(([, dimension]) => dimension.total_count > 0);
  const weightTotal = activeDimensions.reduce((sum, [, dimension]) => sum + dimension.weight, 0);
  const score = weightTotal > 0
    ? Math.round(activeDimensions.reduce((sum, [, dimension]) => sum + (dimension.coverage_rate * dimension.weight), 0) / weightTotal)
    : 100;

  return {
    ...report,
    score,
    grade: gradeForScore(score),
    dimensions,
    weakest_dimensions: [...activeDimensions]
      .sort((a, b) => a[1].coverage_rate - b[1].coverage_rate || b[1].total_count - a[1].total_count || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([key, dimension]) => ({
        key,
        label: dimension.label,
        coverage_rate: dimension.coverage_rate,
        ready_count: dimension.ready_count,
        total_count: dimension.total_count
      })),
    highest_gap_bricks: [...(report.highest_gap_bricks || [])]
      .sort((a, b) => b.missing_count - a.missing_count || b.raw_source_tokens - a.raw_source_tokens || String(a.path).localeCompare(String(b.path)))
      .slice(0, 80)
  };
}

function normalizeBuildToken(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|php|cs|sql|json|md|mdx)$/i, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isMeaningfulBuildToken(value: unknown): boolean {
  const token = normalizeBuildToken(value);

  if (!token || token.length < 3) {
    return false;
  }

  if (/^\d+$/.test(token)) {
    return false;
  }

  return !genericBuildTokens.has(token);
}

function titleCaseBuildToken(value: unknown): string {
  return String(value || "")
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizedKindFamily(kind: unknown): string {
  return String(kind || "unknown").replace(/_(module|file)$/, "");
}

function primarySourcePath(brick: ScanBrick): string {
  return String((brick.source_paths || [])[0] || "");
}

function meaningfulDomainTokens(brick: ScanBrick): string[] {
  const tokens: string[] = [];

  for (const entry of brick.domain || []) {
    for (const part of String(entry || "").split(/[^a-zA-Z0-9]+/)) {
      const normalized = normalizeBuildToken(part);

      if (isMeaningfulBuildToken(normalized) && !tokens.includes(normalized)) {
        tokens.push(normalized);
      }
    }
  }

  return tokens.slice(0, 3);
}

function featureTokenForBrick(brick: ScanBrick): string {
  const cluster = brick.feature_cluster;

  if (cluster && typeof cluster === "object") {
    return normalizeBuildToken(cluster.id || cluster.name || "");
  }

  return normalizeBuildToken(cluster);
}

function pathSignalTokensForBrick(brick: ScanBrick): string[] {
  const sourcePath = primarySourcePath(brick);

  if (!sourcePath) {
    return [];
  }

  const parsed = path.parse(sourcePath);
  const baseToken = normalizeBuildToken(parsed.name);
  const segmentTokens = path.dirname(sourcePath)
    .split(/[\\/]+/)
    .map((segment) => normalizeBuildToken(segment))
    .filter((segment) => isMeaningfulBuildToken(segment));
  const meaningfulSegments = [...new Set(segmentTokens)];
  const signals: string[] = [];

  if (meaningfulSegments.length > 0) {
    signals.push(meaningfulSegments[meaningfulSegments.length - 1]);
  }

  if (meaningfulSegments.length > 1) {
    signals.push(`${meaningfulSegments[meaningfulSegments.length - 2]}-${meaningfulSegments[meaningfulSegments.length - 1]}`);
  }

  if (isMeaningfulBuildToken(baseToken)) {
    signals.push(baseToken);

    if (meaningfulSegments.length > 0) {
      signals.push(`${meaningfulSegments[meaningfulSegments.length - 1]}-${baseToken}`);
    }
  }

  return [...new Set(signals.filter((signal) => isMeaningfulBuildToken(signal) || signal.includes("-")))].slice(0, 3);
}

function buildSignalsForBrick(brick: ScanBrick): BuildSignal[] {
  const signals: BuildSignal[] = [];
  const seen = new Set<string>();
  const pushSignal = (type: BuildSignalType, value: unknown) => {
    const normalized = normalizeBuildToken(value);

    if (!isMeaningfulBuildToken(normalized)) {
      return;
    }

    const key = `${type}:${normalized}`;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    signals.push({ type, value: normalized });
  };

  const featureToken = featureTokenForBrick(brick);

  if (isMeaningfulBuildToken(featureToken)) {
    pushSignal("feature", featureToken);
  }

  for (const token of meaningfulDomainTokens(brick)) {
    pushSignal("domain", token);
  }

  for (const token of pathSignalTokensForBrick(brick)) {
    pushSignal("path", token);
  }

  const brickGroupToken = normalizeBuildToken(String(brick.brick_group || "").split(":").pop() || "");

  if (isMeaningfulBuildToken(brickGroupToken)) {
    pushSignal("group", brickGroupToken);
  }

  return signals;
}

function buildSignalWeight(type: BuildSignalType, groupSize: number): number {
  const base = {
    group: 5,
    feature: 4,
    domain: 3,
    path: 3
  }[type] || 1;

  return Math.max(1, base - Math.floor(Math.max(0, groupSize - 2) / 5));
}

function buildSignalGroupLimit(type: BuildSignalType): number {
  return {
    group: 18,
    feature: 12,
    domain: 10,
    path: 8
  }[type] || 10;
}

function buildPairKey(leftId: string, rightId: string): string {
  return leftId < rightId ? `${leftId}\0${rightId}` : `${rightId}\0${leftId}`;
}

function buildCandidateName(candidate: Pick<BuildCandidate, "dominant_feature_cluster" | "dominant_domain" | "dominant_path_root" | "dominant_group">): string {
  const primary = candidate.dominant_feature_cluster
    || candidate.dominant_domain
    || candidate.dominant_path_root
    || candidate.dominant_group
    || "capability";
  const secondary = [candidate.dominant_domain, candidate.dominant_path_root]
    .filter(Boolean)
    .find((value) => value !== primary);
  const label = secondary ? `${titleCaseBuildToken(primary)} ${titleCaseBuildToken(secondary)}` : titleCaseBuildToken(primary);
  return `${label} Build Candidate`;
}

function confidenceLabel(score: number): string {
  if (score >= 80) return "high";
  if (score >= 60) return "medium";
  return "low";
}

function candidateRecurrenceKey(candidate: Pick<BuildCandidate, "dominant_feature_cluster" | "dominant_domain" | "dominant_path_root" | "dominant_group">): string {
  const ordered = [
    candidate.dominant_feature_cluster,
    candidate.dominant_domain,
    candidate.dominant_path_root,
    candidate.dominant_group
  ].filter(Boolean);
  const unique = [...new Set(ordered)];
  return unique.slice(0, 2).join("::") || "capability";
}

function summarizeBuildCandidate(projectIdValue: string, bricks: ScanBrick[], sharedSignals: BuildSignal[]): BuildCandidate {
  const featureCounts = new Map<string, number>();
  const domainCounts = new Map<string, number>();
  const pathCounts = new Map<string, number>();
  const groupCounts = new Map<string, number>();
  const signalTypeCounts = new Map<BuildSignalType, number>();
  const kindCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  const sharedSignalTypes = new Set<BuildSignalType>();

  for (const brick of bricks) {
    const kindFamily = normalizedKindFamily(brick.kind);
    kindCounts.set(kindFamily, (kindCounts.get(kindFamily) || 0) + 1);
    statusCounts.set(brick.status || "unknown", (statusCounts.get(brick.status || "unknown") || 0) + 1);

    for (const signal of buildSignalsForBrick(brick)) {
      if (signal.type === "feature") {
        featureCounts.set(signal.value, (featureCounts.get(signal.value) || 0) + 1);
      } else if (signal.type === "domain") {
        domainCounts.set(signal.value, (domainCounts.get(signal.value) || 0) + 1);
      } else if (signal.type === "path") {
        pathCounts.set(signal.value, (pathCounts.get(signal.value) || 0) + 1);
      } else if (signal.type === "group") {
        groupCounts.set(signal.value, (groupCounts.get(signal.value) || 0) + 1);
      }
    }
  }

  for (const signal of sharedSignals) {
    sharedSignalTypes.add(signal.type);
    signalTypeCounts.set(signal.type, (signalTypeCounts.get(signal.type) || 0) + 1);
  }

  const sortCounts = (entries: Map<string, number>) => [...entries.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const dominantFeatureCluster = sortCounts(featureCounts)[0]?.[0] || null;
  const dominantDomain = sortCounts(domainCounts)[0]?.[0] || null;
  const dominantPathRoot = sortCounts(pathCounts)[0]?.[0] || null;
  const dominantGroup = sortCounts(groupCounts)[0]?.[0] || null;
  const averageBrickScore = bricks.length
    ? Math.round(bricks.reduce((sum, brick) => sum + Number(brick.score || 0), 0) / bricks.length)
    : 0;
  const confidenceScore = Math.min(100, Math.round(
    12
    + Math.min(18, Math.round(bricks.length * 1.5))
    + (sharedSignalTypes.size * 10)
    + (Math.min(4, kindCounts.size) * 3)
    + Math.min(6, Math.round(averageBrickScore / 25))
    + (dominantFeatureCluster ? 8 : 0)
    + (dominantDomain ? 6 : 0)
    + (dominantPathRoot ? 4 : 0)
    + (dominantGroup ? 6 : 0)
    - (Math.max(0, bricks.length - 12) * 2)
  ));
  const sampleBricks = [...bricks]
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || a.id.localeCompare(b.id))
    .slice(0, 8)
    .map((brick) => ({
      id: brick.id,
      name: brick.name,
      kind: brick.kind,
      status: brick.status,
      score: brick.score,
      feature_cluster: featureTokenForBrick(brick) || null,
      source_path: primarySourcePath(brick)
    }));
  const brickIds = [...new Set(bricks.map((brick) => brick.id))].sort();
  const recurrenceKey = candidateRecurrenceKey({
    dominant_feature_cluster: dominantFeatureCluster,
    dominant_domain: dominantDomain,
    dominant_path_root: dominantPathRoot,
    dominant_group: dominantGroup
  });

  const candidate = {
    candidate_key: `${projectIdValue}:${recurrenceKey}:${normalizeBuildToken(sampleBricks[0]?.name || brickIds[0] || "build")}:${brickIds.length}`,
    recurrence_key: recurrenceKey,
    project: projectIdValue,
    name: "",
    confidence_score: confidenceScore,
    confidence_label: confidenceLabel(confidenceScore),
    brick_count: brickIds.length,
    average_brick_score: averageBrickScore,
    detection_sources: [...sharedSignalTypes].sort(),
    dominant_feature_cluster: dominantFeatureCluster,
    dominant_domain: dominantDomain,
    dominant_path_root: dominantPathRoot,
    dominant_group: dominantGroup,
    signal_type_counts: Object.fromEntries([...signalTypeCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    kind_counts: Object.fromEntries(sortCounts(kindCounts)),
    status_counts: Object.fromEntries(sortCounts(statusCounts)),
    sample_paths: [...new Set(sampleBricks.map((brick) => brick.source_path).filter(Boolean))].slice(0, 6),
    brick_ids: brickIds,
    sample_bricks: sampleBricks,
    recurrent_projects: [],
    recurrent_project_count: 0,
    why: ""
  };

  candidate.name = buildCandidateName(candidate);
  candidate.why = `Shared ${candidate.detection_sources.join(", ")} around ${titleCaseBuildToken(dominantFeatureCluster || dominantDomain || dominantPathRoot || dominantGroup || "capability")}.`;
  return candidate;
}

export function buildProjectBuildReport(projectIdValue: string, candidates: BuildCandidate[]): ProjectBuildReport {
  const report = emptyBuildReport(projectIdValue);
  const detectedBrickIds = new Set();

  for (const candidate of candidates) {
    for (const brickId of candidate.brick_ids || []) {
      detectedBrickIds.add(brickId);
    }

    for (const type of candidate.detection_sources || []) {
      report.signal_type_counts[type] = (report.signal_type_counts[type] || 0) + 1;
    }
  }

  report.candidate_count = candidates.length;
  report.detected_brick_count = detectedBrickIds.size;
  report.average_confidence_score = candidates.length
    ? Math.round(candidates.reduce((sum, candidate) => sum + Number(candidate.confidence_score || 0), 0) / candidates.length)
    : 0;
  report.top_candidates = [...candidates]
    .sort((a, b) => Number(b.confidence_score || 0) - Number(a.confidence_score || 0) || Number(b.brick_count || 0) - Number(a.brick_count || 0) || a.name.localeCompare(b.name))
    .slice(0, 24);
  report.candidate_signatures = candidates.map((candidate) => ({
    candidate_key: candidate.candidate_key,
    recurrence_key: candidate.recurrence_key,
    project: projectIdValue,
    confidence_score: candidate.confidence_score,
    brick_count: candidate.brick_count,
    detection_sources: candidate.detection_sources,
    dominant_feature_cluster: candidate.dominant_feature_cluster,
    dominant_domain: candidate.dominant_domain,
    dominant_path_root: candidate.dominant_path_root,
    dominant_group: candidate.dominant_group
  }));
  return report;
}

export function detectProjectBuildCandidates(projectIdValue: string, bricks: ScanBrick[]): BuildCandidate[] {
  if (bricks.length < 2) {
    return [];
  }

  const signalsByBrick = new Map<string, BuildSignal[]>();
  const signalBuckets = new Map<string, { type: BuildSignalType; value: string; brick_ids: string[] }>();

  for (const brick of bricks) {
    const signals = buildSignalsForBrick(brick);
    signalsByBrick.set(brick.id, signals);

    for (const signal of signals) {
      const key = `${signal.type}:${signal.value}`;
      const current = signalBuckets.get(key) || { type: signal.type, value: signal.value, brick_ids: [] };
      current.brick_ids.push(brick.id);
      signalBuckets.set(key, current);
    }
  }

  const pairScores = new Map<string, { score: number; shared_signals: Array<BuildSignal & { group_size: number }> }>();

  for (const bucket of signalBuckets.values()) {
    const brickIds = [...new Set(bucket.brick_ids)].sort();

    if (brickIds.length < 2 || brickIds.length > buildSignalGroupLimit(bucket.type)) {
      continue;
    }

    for (let index = 0; index < brickIds.length; index += 1) {
      for (let nextIndex = index + 1; nextIndex < brickIds.length; nextIndex += 1) {
        const pairKey = buildPairKey(brickIds[index], brickIds[nextIndex]);
        const current = pairScores.get(pairKey) || {
          score: 0,
          shared_signals: []
        };

        current.score += buildSignalWeight(bucket.type, brickIds.length);
        current.shared_signals.push({
          type: bucket.type,
          value: bucket.value,
          group_size: brickIds.length
        });
        pairScores.set(pairKey, current);
      }
    }
  }

  const adjacency = new Map<string, Set<string>>();
  const addEdge = (leftId: string, rightId: string) => {
    const left = adjacency.get(leftId) || new Set<string>();
    const right = adjacency.get(rightId) || new Set<string>();
    left.add(rightId);
    right.add(leftId);
    adjacency.set(leftId, left);
    adjacency.set(rightId, right);
  };

  for (const [pairKey, details] of pairScores.entries()) {
    const [leftId, rightId] = pairKey.split("\0");
    const signalTypes = new Set(details.shared_signals.map((signal) => signal.type));
    const smallFeatureLink = details.shared_signals.some((signal) => signal.type === "feature" && signal.group_size <= 6);
    const mixedLink = (signalTypes.has("feature") && (signalTypes.has("domain") || signalTypes.has("path")))
      || (signalTypes.has("domain") && signalTypes.has("path"));
    const strongLink = signalTypes.has("group") || details.score >= 7;

    if (smallFeatureLink || mixedLink || strongLink) {
      addEdge(leftId, rightId);
    }
  }

  const brickById = new Map<string, ScanBrick>(bricks.map((brick) => [brick.id, brick]));
  const visited = new Set<string>();
  const candidates: BuildCandidate[] = [];

  for (const brick of bricks) {
    if (visited.has(brick.id) || !adjacency.has(brick.id)) {
      continue;
    }

    const stack: string[] = [brick.id];
    const componentIds: string[] = [];

    while (stack.length > 0) {
      const currentId = stack.pop();

      if (!currentId || visited.has(currentId)) {
        continue;
      }

      visited.add(currentId);
      componentIds.push(currentId);

      for (const linkedId of adjacency.get(currentId) || []) {
        if (!visited.has(linkedId)) {
          stack.push(linkedId);
        }
      }
    }

    const componentBricks = componentIds
      .map((id) => brickById.get(id))
      .filter((entry): entry is ScanBrick => entry !== undefined);

    if (componentBricks.length < 2) {
      continue;
    }

    const sharedSignals: BuildSignal[] = [];
    const sharedSignalKeys = new Set<string>();

    for (const candidateBrick of componentBricks) {
      for (const signal of signalsByBrick.get(candidateBrick.id) || []) {
        const overlapCount = componentBricks.filter((entry) => (signalsByBrick.get(entry.id) || []).some((candidateSignal) => candidateSignal.type === signal.type && candidateSignal.value === signal.value)).length;

        if (overlapCount < 2) {
          continue;
        }

        const key = `${signal.type}:${signal.value}`;

        if (!sharedSignalKeys.has(key)) {
          sharedSignalKeys.add(key);
          sharedSignals.push(signal);
        }
      }
    }

    const distinctKinds = new Set(componentBricks.map((candidateBrick) => normalizedKindFamily(candidateBrick.kind)));

    if (sharedSignals.length === 0 || (componentBricks.length === 2 && distinctKinds.size < 2 && !sharedSignals.some((signal) => signal.type === "group"))) {
      continue;
    }

    candidates.push(summarizeBuildCandidate(projectIdValue, componentBricks, sharedSignals));
  }

  return candidates
    .sort((a, b) => Number(b.confidence_score || 0) - Number(a.confidence_score || 0) || Number(b.brick_count || 0) - Number(a.brick_count || 0) || a.name.localeCompare(b.name))
    .slice(0, 60);
}

export function finalizeMergedBuildReport(report: Partial<ProjectBuildReport>): ProjectBuildReport {
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
  const recurrence = new Map<string, { projects: Set<string>; candidate_count: number; max_confidence_score: number }>();

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
    .sort((a, b) => (b.recurrent_project_count || 0) - (a.recurrent_project_count || 0) || Number(b.confidence_score || 0) - Number(a.confidence_score || 0) || Number(b.brick_count || 0) - Number(a.brick_count || 0) || a.name.localeCompare(b.name))
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
