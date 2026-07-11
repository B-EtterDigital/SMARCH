import { existsSync } from "node:fs";
import path from "node:path";

import {
  fuzzyMatchScore,
  loadStateAndRegistry,
} from "../lib/adoption-utils.mjs";
import {
  findBrick,
  findCuratedBuild,
  findProject,
  maybeReadJson,
} from "../lib/sma-adoption.mjs";
import { SMA_ROOT } from "../lib/sma-paths.ts";

const STATE_CANDIDATES = [
  "wiki/SMA_STATE.generated.json",
];

const REGISTRY_CANDIDATES = [
  "scans/all-projects/latest.registry.json",
  "registry/global-modules.generated.json",
];

const BUILD_INDEX_CANDIDATES = [
  "builds/build-index.generated.json",
];

export function currentRoot() {
  return path.resolve(process.env.SMA_ROOT || SMA_ROOT);
}

function firstExisting(root, candidates) {
  for (const candidate of candidates) {
    const absolute = path.resolve(root, candidate);
    if (existsSync(absolute)) return absolute;
  }
  return path.resolve(root, candidates[0]);
}

export async function loadRegistryContext() {
  const root = currentRoot();
  const statePath = firstExisting(root, STATE_CANDIDATES);
  const registryPath = firstExisting(root, REGISTRY_CANDIDATES);
  const buildIndexPath = firstExisting(root, BUILD_INDEX_CANDIDATES);

  let state = null;
  let registry = null;

  if (existsSync(statePath) && existsSync(registryPath)) {
    ({ state, registry } = await loadStateAndRegistry({
      cwd: root,
      statePath,
      registryPath,
    }));
  } else {
    [state, registry] = await Promise.all([
      maybeReadJson(statePath),
      maybeReadJson(registryPath),
    ]);
  }

  if (!registry) {
    throw new Error(`MCP_REGISTRY_MISSING: no registry snapshot at ${registryPath}`);
  }

  return {
    root,
    state: state || {},
    registry,
    buildIndex: await maybeReadJson(buildIndexPath),
    paths: { state: statePath, registry: registryPath, buildIndex: buildIndexPath },
  };
}

function canonicalTargetForBrick(state, brick) {
  const targets = [
    ...(state?.trust?.canonicalization?.top_targets || []),
    ...(state?.projects || []).flatMap((project) => project?.canonicalization?.top_targets || []),
  ];
  return targets.find((target) => (
    String(target?.target_id || "") === String(brick?.id || "")
    || (
      String(target?.project || "") === String(brick?.project || "")
      && String(target?.name || "") === String(brick?.name || "")
    )
  )) || null;
}

export function trustFields(brick, state = {}) {
  const target = canonicalTargetForBrick(state, brick);
  const health = brick?.health || {};
  const verification = Array.isArray(brick?.verification) ? brick.verification : [];
  const latestVerification = verification.at(-1) || null;
  const score = Number.isFinite(Number(brick?.score))
    ? Number(brick.score)
    : Number.isFinite(Number(health?.calculated_score))
      ? Number(health.calculated_score)
      : null;

  return {
    score,
    status: brick?.status || null,
    risk: brick?.risk || null,
    health_status: health?.status || null,
    health_score: Number.isFinite(Number(health?.calculated_score))
      ? Number(health.calculated_score)
      : null,
    error_count: Number(health?.error_count || 0),
    warning_count: Number(health?.warning_count || 0),
    clone_readiness: brick?.clone_readiness || null,
    verification_status: latestVerification?.status || null,
    verification_count: verification.length,
    canonicalization_stage: target?.promotion_stage || null,
    canonicalization_priority: target?.priority_score ?? null,
  };
}

export function brickSummary(brick, state = {}) {
  const trust = trustFields(brick, state);
  return {
    id: brick?.id || null,
    name: brick?.name || null,
    project: brick?.project || null,
    kind: brick?.kind || null,
    path: brick?.path || brick?.manifest_path || null,
    domains: brick?.domain || brick?.domains || [],
    trust,
    trust_score: trust.score,
    trust_status: trust.status,
  };
}

export function searchBricks({ registry, state }, options = {}) {
  const query = String(options.query || "").trim();
  const limit = Math.max(1, Math.min(100, Number(options.limit || 20)));
  const project = String(options.project || "").trim();
  const kind = String(options.kind || "").trim();
  const status = String(options.status || "").trim();

  return (registry?.bricks || [])
    .filter((brick) => !project || String(brick?.project) === project)
    .filter((brick) => !kind || String(brick?.kind) === kind)
    .filter((brick) => !status || String(brick?.status) === status)
    .map((brick) => ({
      brick,
      score: query
        ? fuzzyMatchScore(
          query,
          brick?.id,
          brick?.name,
          brick?.project,
          brick?.kind,
          brick?.path,
          brick?.manifest_path,
          (brick?.source_paths || []).join(" "),
          (brick?.domain || []).join(" "),
        )
        : 1,
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => (
      right.score - left.score
      || Number(right.brick?.score || 0) - Number(left.brick?.score || 0)
      || String(left.brick?.id || "").localeCompare(String(right.brick?.id || ""))
    ))
    .slice(0, limit)
    .map(({ brick, score }) => ({ ...brickSummary(brick, state), match_score: score }));
}

export function getBrick({ registry }, query) {
  const exact = (registry?.bricks || []).find((brick) => String(brick?.id) === String(query));
  return exact || findBrick(registry, query);
}

export function getBuild({ state, buildIndex }, query) {
  return findCuratedBuild(state, buildIndex, query);
}

export function getProject({ state }, projectId) {
  return findProject(state, projectId);
}

export function requireString(value, field) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`MCP_INVALID_INPUT: ${field} is required`);
  return normalized;
}

export function normalizeLimit(value, fallback = 20) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("MCP_INVALID_INPUT: limit must be an integer between 1 and 100");
  }
  return parsed;
}

