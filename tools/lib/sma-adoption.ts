/**
 * WHAT: Loads portfolio evidence and ranks projects, bricks, and curated builds for adoption decisions.
 * WHY: Recommendations should follow current registry evidence instead of names or intuition alone.
 * HOW: Tokenizes a query, scores field overlap, and formats matches from generated state and build indexes.
 * INPUTS: Generated portfolio state, registry and build-index paths, plus a project or free-text query.
 * OUTPUTS: Loaded adoption context, matched records, recommendation objects, and formatted reasons.
 * CALLERS: Adoption and recommendation commands use these shared lookup and ranking helpers.
 * @example node --input-type=module -e "import { tokenize } from './tools/lib/sma-adoption.ts'; console.log(tokenize('approval workflow project'));"
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "build", "builds", "by", "for", "from", "in", "into",
  "is", "it", "of", "on", "or", "that", "the", "this", "to", "with", "your", "you", "app", "project"
]);

export const defaultPaths = {
  repoRoot,
  state: path.resolve(repoRoot, "wiki/SMA_STATE.generated.json"),
  registry: path.resolve(repoRoot, "scans/all-projects/latest.registry.json"),
  buildIndex: path.resolve(repoRoot, "builds/build-index.generated.json"),
};

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function maybeReadJson(filePath) {
  try {
    return await readJson(filePath);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
    if (code !== 'ENOENT') console.error(JSON.stringify({ area: 'sma-adoption.read-json', severity: 'warning', hint: 'Repair the JSON file or check its permissions.', error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) }));
    return null;
  }
}

export async function loadAdoptionContext(options: Record<string, any> = {}) {
  const statePath = path.resolve(options.state || defaultPaths.state);
  const registryPath = path.resolve(options.registry || defaultPaths.registry);
  const buildIndexPath = path.resolve(options.buildIndex || defaultPaths.buildIndex);
  const [state, registry, buildIndex] = await Promise.all([
    maybeReadJson(statePath),
    maybeReadJson(registryPath),
    maybeReadJson(buildIndexPath),
  ]);

  return {
    state,
    registry,
    buildIndex,
    paths: {
      state: statePath,
      registry: registryPath,
      buildIndex: buildIndexPath,
    },
  };
}

export function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9+/_-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

export function overlapScore(query, fields) {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return { score: 0, matches: [] };

  const weightedTokens = [];
  for (const field of fields) {
    if (field == null) continue;
    if (Array.isArray(field)) {
      for (const entry of field) weightedTokens.push(...tokenize(entry));
      continue;
    }
    weightedTokens.push(...tokenize(field));
  }

  const matches = [...new Set(weightedTokens.filter((token) => queryTokens.has(token)))];
  return {
    score: matches.length,
    matches,
  };
}

export function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).flatMap((value) => {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    return [String(value)];
  }).map((value) => value.trim()).filter(Boolean))];
}

export function findProject(state, projectId) {
  return (state?.projects || []).find((project) => String(project.project) === String(projectId)) || null;
}

export function findCanonicalizationTarget(state, query) {
  const needle = String(query || "").toLowerCase().trim();
  if (!needle) return null;

  return (state?.trust?.canonicalization?.top_targets || []).find((target) => {
    const haystack = [
      target.project,
      target.target_id,
      target.name,
      target.target_type,
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(needle);
  }) || null;
}

export function findCuratedBuild(state, buildIndex, query) {
  const needle = String(query || "").toLowerCase().trim();
  if (!needle) return null;

  const curated = buildIndex?.builds || state?.build_plane?.curated_builds || [];
  return curated.find((entry) => {
    const haystack = [
      entry.build_id,
      entry.artifact_id,
      entry.name,
      entry.project,
      ...(entry.domains || []),
      entry.summary,
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(needle);
  }) || null;
}

export function findBrick(registry, query) {
  const needle = String(query || "").toLowerCase().trim();
  if (!needle) return null;

  return (registry?.bricks || []).find((brick) => {
    const haystack = [
      brick.id,
      brick.name,
      brick.project,
      brick.kind,
      brick.path,
      ...(brick.source_paths || []),
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(needle);
  }) || null;
}

export function buildRecommendations({ state, registry, buildIndex, query, limit = 10, project = "" }) {
  const projectNeedle = String(project || "").trim();
  const results = [];

  for (const build of buildIndex?.builds || []) {
    if (projectNeedle && String(build.project) !== projectNeedle) continue;
    const scored = overlapScore(query, [
      build.name,
      build.build_id,
      build.artifact_id,
      build.summary,
      build.domains,
      build.runtimes,
      build.project,
    ]);
    if (scored.score <= 0) continue;
    results.push({
      type: "curated_build",
      id: build.build_id || build.artifact_id,
      name: build.name,
      project: build.project,
      score: scored.score + 4,
      matches: scored.matches,
      readiness: build.status,
      trust: build.release_summary?.latest_verification_status || null,
      release_count: build.release_summary?.release_count || 0,
      why: build.summary || "Curated build manifest with release linkage.",
    });
  }

  for (const candidate of registry?.scanner_report?.build_report?.top_candidates || []) {
    if (projectNeedle && String(candidate.project) !== projectNeedle) continue;
    const scored = overlapScore(query, [
      candidate.name,
      candidate.candidate_key,
      candidate.recurrence_key,
      candidate.dominant_feature_cluster,
      candidate.dominant_domain,
      candidate.dominant_group,
      candidate.sample_paths,
      candidate.why,
    ]);
    if (scored.score <= 0) continue;
    results.push({
      type: "build_candidate",
      id: candidate.candidate_key,
      name: candidate.name,
      project: candidate.project,
      score: scored.score + Math.round(Number(candidate.confidence_score || 0) / 20),
      matches: scored.matches,
      readiness: candidate.confidence_label,
      trust: `${candidate.confidence_score || 0}/100`,
      release_count: 0,
      why: candidate.why || "Scanner-detected repeated capability.",
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const entry of results
    .sort((left, right) =>
      right.score - left.score
      || (right.release_count || 0) - (left.release_count || 0)
      || String(left.name || "").localeCompare(String(right.name || ""))
    )) {
    const key = [entry.type, entry.project, entry.name].join("::").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
    if (deduped.length >= limit) break;
  }

  return deduped;
}

export function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function formatReasonList(reasons) {
  return (reasons || []).map((reason) => {
    if (typeof reason === "string") return `- ${reason}`;
    return `- ${reason.message || reason.code || "reason"}`;
  }).join("\n");
}
