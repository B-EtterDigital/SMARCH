/* Adoption inputs cross generated JSON boundaries, so defensive guards and existing diagnostic coercion remain required. */
/* Recommendation scoring is a declarative evidence checklist; complexity counts independent weights and fallbacks as branches. */
/* eslint @typescript-eslint/no-base-to-string: "off", @typescript-eslint/no-unnecessary-condition: "off", complexity: "off" */
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

interface CanonicalTarget { project?: string; target_id?: string; name?: string; target_type?: string }
interface CuratedBuild { build_id?: string; artifact_id?: string; name?: string; project?: string; domains?: string[]; runtimes?: string[]; summary?: string; status?: string; release_summary?: { latest_verification_status?: string | null; release_count?: number } }
interface BuildCandidate { candidate_key?: string; recurrence_key?: string; name?: string; project?: string; dominant_feature_cluster?: string; dominant_domain?: string; dominant_group?: string; sample_paths?: string[]; why?: string; confidence_score?: number; confidence_label?: string }
interface AdoptionState { projects?: { project?: string; [key: string]: unknown }[]; trust?: { canonicalization?: { top_targets?: CanonicalTarget[] } }; build_plane?: { curated_builds?: CuratedBuild[] } }
interface AdoptionRegistry { bricks?: { id?: string; name?: string; project?: string; kind?: string; path?: string; source_paths?: string[] }[]; scanner_report?: { build_report?: { top_candidates?: BuildCandidate[] } } }
interface BuildIndex { builds?: CuratedBuild[] }
interface AdoptionOptions { state?: string; registry?: string; buildIndex?: string }
interface Recommendation { type: string; id?: string; name?: string; project?: string; score: number; matches: string[]; readiness?: string; trust: string | null; release_count: number; why: string }

export const defaultPaths = {
  repoRoot,
  state: path.resolve(repoRoot, "wiki/SMA_STATE.generated.json"),
  registry: path.resolve(repoRoot, "scans/all-projects/latest.registry.json"),
  buildIndex: path.resolve(repoRoot, "builds/build-index.generated.json"),
};

async function readJson<T = unknown>(filePath: string): Promise<T> {
  const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
  return parsed as T;
}

export async function maybeReadJson<T = unknown>(filePath: string): Promise<T | null> {
  try {
    return await readJson(filePath);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code ?? '') : '';
    if (code !== 'ENOENT') console.error(JSON.stringify({ area: 'sma-adoption.read-json', severity: 'warning', hint: 'Repair the JSON file or check its permissions.', error: error instanceof Error ? error.message : String(error), ...(code ? { code } : {}) }));
    return null;
  }
}

export async function loadAdoptionContext(options: AdoptionOptions = {}) {
  const statePath = path.resolve(options.state ?? defaultPaths.state);
  const registryPath = path.resolve(options.registry ?? defaultPaths.registry);
  const buildIndexPath = path.resolve(options.buildIndex ?? defaultPaths.buildIndex);
  const [state, registry, buildIndex] = await Promise.all([
    maybeReadJson<AdoptionState>(statePath),
    maybeReadJson<AdoptionRegistry>(registryPath),
    maybeReadJson<BuildIndex>(buildIndexPath),
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

function tokenize(value: unknown): string[] {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9+/_-]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function overlapScore(query: unknown, fields: unknown[]): { score: number; matches: string[] } {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return { score: 0, matches: [] };

  const weightedTokens: string[] = [];
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

export function findProject(state: AdoptionState | null | undefined, projectId: unknown) {
  return (state?.projects ?? []).find((project) => String(project.project) === String(projectId)) ?? null;
}

export function findCuratedBuild(state: AdoptionState | null | undefined, buildIndex: BuildIndex | null | undefined, query: unknown): CuratedBuild | null {
  const needle = String(query ?? "").toLowerCase().trim();
  if (!needle) return null;

  const curated = (buildIndex?.builds ?? state?.build_plane?.curated_builds) ?? [];
  return curated.find((entry) => {
    const haystack = [
      entry.build_id,
      entry.artifact_id,
      entry.name,
      entry.project,
      ...(entry.domains ?? []),
      entry.summary,
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(needle);
  }) ?? null;
}

export function findBrick(registry: AdoptionRegistry | null | undefined, query: unknown) {
  const needle = String(query ?? "").toLowerCase().trim();
  if (!needle) return null;

  return (registry?.bricks ?? []).find((brick) => {
    const haystack = [
      brick.id,
      brick.name,
      brick.project,
      brick.kind,
      brick.path,
      ...(brick.source_paths ?? []),
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(needle);
  }) ?? null;
}

function curatedBuildRecommendation(build: CuratedBuild, query: unknown, project: string): Recommendation | null {
  if (project && String(build.project) !== project) return null;
  const scored = overlapScore(query, [build.name, build.build_id, build.artifact_id, build.summary, build.domains, build.runtimes, build.project]);
  if (scored.score <= 0) return null;
  return {
    type: "curated_build", id: build.build_id ?? build.artifact_id, name: build.name, project: build.project,
    score: scored.score + 4, matches: scored.matches, readiness: build.status,
    trust: build.release_summary?.latest_verification_status ?? null,
    release_count: build.release_summary?.release_count ?? 0,
    why: build.summary ?? "Curated build manifest with release linkage.",
  };
}

function buildCandidateRecommendation(candidate: BuildCandidate, query: unknown, project: string): Recommendation | null {
  if (project && String(candidate.project) !== project) return null;
  const scored = overlapScore(query, [candidate.name, candidate.candidate_key, candidate.recurrence_key,
    candidate.dominant_feature_cluster, candidate.dominant_domain, candidate.dominant_group, candidate.sample_paths, candidate.why]);
  if (scored.score <= 0) return null;
  return {
    type: "build_candidate", id: candidate.candidate_key, name: candidate.name, project: candidate.project,
    score: scored.score + Math.round((candidate.confidence_score ?? 0) / 20), matches: scored.matches,
    readiness: candidate.confidence_label, trust: `${String(candidate.confidence_score ?? 0)}/100`, release_count: 0,
    why: candidate.why ?? "Scanner-detected repeated capability.",
  };
}

export function buildRecommendations({ state: _state, registry, buildIndex, query, limit = 10, project = "" }: { state?: AdoptionState | null; registry?: AdoptionRegistry | null; buildIndex?: BuildIndex | null; query: unknown; limit?: number; project?: string }): Recommendation[] {
  const projectNeedle = (project || "").trim();
  const results: Recommendation[] = [];

  for (const build of buildIndex?.builds ?? []) {
    const recommendation = curatedBuildRecommendation(build, query, projectNeedle);
    if (recommendation) results.push(recommendation);
  }

  for (const candidate of registry?.scanner_report?.build_report?.top_candidates ?? []) {
    const recommendation = buildCandidateRecommendation(candidate, query, projectNeedle);
    if (recommendation) results.push(recommendation);
  }

  const deduped: Recommendation[] = [];
  const seen = new Set<string>();
  for (const entry of results
    .sort((left, right) =>
      right.score - left.score
      || (right.release_count || 0) - (left.release_count || 0)
      || (left.name ?? "").localeCompare((right.name ?? ""))
    )) {
    const key = [entry.type, entry.project, entry.name].join("::").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
    if (deduped.length >= limit) break;
  }

  return deduped;
}

export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
