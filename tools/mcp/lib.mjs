import { existsSync } from "node:fs";
import path from "node:path";

import {
  fuzzyMatchScore,
  loadStateAndRegistry,
} from "../lib/adoption-utils.ts";
import {
  findBrick,
  findCuratedBuild,
  findProject,
  maybeReadJson,
} from "../lib/sma-adoption.ts";
import { SMA_ROOT } from "../lib/sma-paths.ts";
import { McpToolError } from "./contract.mjs";

/** @typedef {Record<string, unknown> & { status?: string | null, calculated_score?: number | string | null, error_count?: number | string | null, warning_count?: number | string | null }} Health */
/** @typedef {Record<string, unknown> & { status?: string | null }} Verification */
/** @typedef {Record<string, unknown> & { target_id?: string | null, project?: string | null, name?: string | null, promotion_stage?: string | null, priority_score?: number | null }} CanonicalTarget */
/** @typedef {Record<string, unknown> & { top_targets?: CanonicalTarget[] }} Canonicalization */
/** @typedef {Record<string, unknown> & { id?: string, name?: string, project?: string, kind?: string, path?: string, manifest_path?: string, domain?: string[], domains?: string[], source_paths?: string[], status?: string, risk?: string, score?: number | string, health?: Health, verification?: Verification[], clone_readiness?: string, data_classes?: string[], env_contract?: ContractStatus, rls_contract?: ContractStatus }} Brick */
/** @typedef {Record<string, unknown> & { required?: unknown, status?: unknown }} ContractStatus */
/** @typedef {Record<string, unknown> & { project?: string, canonicalization?: Canonicalization, top_actions?: Action[], quality_queue?: Action[] }} Project */
/** @typedef {Record<string, unknown> & { code?: unknown, reason?: unknown, name?: unknown }} Action */
/** @typedef {Record<string, unknown> & { build_id?: unknown, artifact_id?: unknown, name?: unknown, project?: unknown, source_project?: unknown, readiness_score?: unknown, installable?: boolean, verified_ready?: boolean, publish_ready?: boolean, top_blockers?: Blocker[], verification_top_blockers?: Blocker[], promotion_blockers?: Blocker[] }} Build */
/** @typedef {string | (Record<string, unknown> & { code?: unknown })} Blocker */
/** @typedef {Record<string, unknown> & { bricks?: Brick[], projects?: Project[], generated_at?: unknown, validation_error_count?: unknown, validation_warning_count?: unknown, failure_count?: unknown, failures?: unknown[], count?: unknown, unmanifested_count?: unknown, scanner_report?: unknown }} Registry */
/** @typedef {Record<string, unknown> & { generated_at?: unknown, projects?: Project[], trust?: Record<string, unknown> & { canonicalization?: Canonicalization }, totals?: Record<string, unknown> & { brick_count?: unknown, project_count?: unknown }, build_plane?: Record<string, unknown> & { curated_builds?: Build[] } }} State */
/** @typedef {Record<string, unknown> & { builds?: Build[] }} BuildIndex */
/** @typedef {{ root: string, state: State, registry: Registry, buildIndex: BuildIndex | null, paths: { state: string, registry: string, buildIndex: string } }} RegistryContext */
/** @typedef {{ query?: unknown, limit?: unknown, project?: unknown, kind?: unknown, status?: unknown }} SearchOptions */

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

/**
 * @param {string} root
 * @param {readonly string[]} candidates
 */
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

  /** @type {State | null} */
  let state = null;
  /** @type {Registry | null} */
  let registry = null;

  if (existsSync(statePath) && existsSync(registryPath)) {
    const loaded = /** @type {{ state: State, registry: Registry }} */ (/** @type {unknown} */ (await loadStateAndRegistry({
      cwd: root,
      statePath,
      registryPath,
    })));
    state = loaded.state;
    registry = loaded.registry;
  } else {
    const loaded = await Promise.all([
      maybeReadJson(statePath),
      maybeReadJson(registryPath),
    ]);
    state = /** @type {State | null} */ (loaded[0]);
    registry = /** @type {Registry | null} */ (loaded[1]);
  }

  if (!registry) {
    throw new McpToolError(
      "MCP_REGISTRY_MISSING",
      "No registry snapshot is available",
      { registry_path: registryPath },
    );
  }

  /** @type {BuildIndex | null} */
  const buildIndex = await maybeReadJson(buildIndexPath);
  return /** @type {RegistryContext} */ ({
    root,
    state: state || {},
    registry,
    buildIndex,
    paths: { state: statePath, registry: registryPath, buildIndex: buildIndexPath },
  });
}

/**
 * @param {State} state
 * @param {Brick} brick
 * @returns {CanonicalTarget | null}
 */
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

/**
 * @param {Brick} brick
 * @param {State} [state]
 */
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

/**
 * @param {Brick} brick
 * @param {State} [state]
 */
function brickSummary(brick, state = {}) {
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

/**
 * @param {{ registry: Registry, state: State }} context
 * @param {SearchOptions} [options]
 */
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

/**
 * @param {{ registry: Registry }} context
 * @param {unknown} query
 * @returns {Brick | null}
 */
export function getBrick({ registry }, query) {
  const exact = (registry?.bricks || []).find((brick) => String(brick?.id) === String(query));
  const adoptionRegistry = /** @type {Parameters<typeof findBrick>[0]} */ (/** @type {unknown} */ (registry));
  return exact || findBrick(adoptionRegistry, query);
}

/**
 * @param {{ state: State, buildIndex: BuildIndex | null }} context
 * @param {unknown} query
 * @returns {Build | null}
 */
export function getBuild({ state, buildIndex }, query) {
  const adoptionState = /** @type {Parameters<typeof findCuratedBuild>[0]} */ (/** @type {unknown} */ (state));
  const adoptionBuildIndex = /** @type {Parameters<typeof findCuratedBuild>[1]} */ (/** @type {unknown} */ (buildIndex));
  return /** @type {Build | null} */ (findCuratedBuild(adoptionState, adoptionBuildIndex, query));
}

/**
 * @param {{ state: State }} context
 * @param {unknown} projectId
 * @returns {Project | null}
 */
export function getProject({ state }, projectId) {
  const adoptionState = /** @type {Parameters<typeof findProject>[0]} */ (/** @type {unknown} */ (state));
  return /** @type {Project | null} */ (findProject(adoptionState, projectId));
}

/**
 * @param {unknown} value
 * @param {string} field
 */
export function requireString(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new McpToolError(
    "MCP_INVALID_INPUT",
    "Invalid MCP tool input",
    { field, expectation: "non-empty string" },
  );
  return normalized;
}

/**
 * @param {unknown} value
 * @param {number} [fallback]
 */
export function normalizeLimit(value, fallback = 20) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new McpToolError(
      "MCP_INVALID_INPUT",
      "Invalid MCP tool input",
      { field: "limit", expectation: "integer between 1 and 100" },
    );
  }
  return parsed;
}
