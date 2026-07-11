#!/usr/bin/env node
/**
 * WHAT: Turns a product vision into a registry-grounded selection and integration plan for builds and bricks.
 * WHY: Agents need ranked reusable components plus explicit coverage gaps, not an ungrounded language-model recommendation.
 * HOW: Pre-filters registry candidates, asks Codex to plan over that slice, and prints structured output for another agent or operator.
 * Usage: `node tools/sma-codex-rank.ts --vision "Add an approval workflow" --top 5`
 */
/**
 * sma-codex-rank: take a vision string + the merged registry and ask codex
 * to return a real integration plan grounded in the registry's semantic
 * data — brick semantics plus first-class build candidates when present.
 *
 * Two-stage pipeline:
 *   1. Token-overlap pre-filter (sma-match logic, inlined here) → top N
 *      candidates. Default N=80 to give the LLM enough surface without
 *      blowing context.
 *   2. Codex pass with the vision + the candidate slice. It returns:
 *        - selected_builds / selected_bricks: ordered lists with a one-line
 *          reason each
 *        - integration_plan: ordered build steps that combine them
 *        - missing_bricks: things the vision needs but no build/brick covers
 *        - risks: integration-time pitfalls to watch for
 *
 * Output: JSON. Pipe straight into another agent.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { codex } from "./lib/codex-runner.ts";
import { smaPath } from "./lib/sma-paths.ts";

type ArtifactType = "build" | "brick";
interface SampleBrick { id?: string; name?: string; kind?: string; status?: string; feature_cluster?: string; source_path?: string }
interface RegistryBrick {
  id: string; name: string; project: string; kind: string; manifest_path: string; status?: string; source_paths: string[];
}
interface BrickSemantics {
  purpose: string; tags: string[]; use_when: string[]; public_api: string[];
  connections: { target: string; kind: string }[];
  compact: { tagline: string; hashtags: string[]; verbs: string[]; inputs: string[]; outputs: string[]; token_budget: number | null } | null;
}
interface RegistryDocument { bricks: RegistryBrick[]; buildCandidates: BuildInput[] }
interface RankArtifact {
  type: ArtifactType; id: string; name: string; project?: string; kind?: string; status?: string;
  score: number; purpose: string; tags: string[]; paths: string[]; public_api: string[];
  use_when: string[]; inputs: string[]; outputs: string[]; verbs: string[];
  connections: { to: string; kind: string }[]; confidence_label?: string; confidence_score?: number;
  brick_count?: number; recurrent_project_count?: number; sample_bricks?: SampleBrick[];
  recurrent_projects?: string[]; detection_sources?: string[]; why?: string; token_budget?: number | null;
}
interface BuildInput {
  candidate_key?: string; name?: string; project?: string; why?: string; dominant_feature_cluster?: string;
  dominant_domain?: string; dominant_group?: string; dominant_path_root?: string; brick_count?: number;
  brick_ids?: string[]; recurrent_project_count?: number; confidence_score?: number; confidence_label?: string;
  sample_paths?: string[]; sample_bricks?: SampleBrick[]; recurrent_projects?: string[]; detection_sources?: string[];
  signal_type_counts?: Record<string, unknown>;
}
interface SelectedItem { id: string; role: string; rank: number; reason: string }
interface RankOptions {
  registry: string; candidates: string; vision: string; visionFile: string; top: number; preFilter: number;
  minStatus: string; model: string; timeoutMs: number; json: boolean;
}

function parseArgs(argv: string[]): RankOptions {
  const opts: RankOptions = {
    registry: smaPath("scans/all-projects/latest.registry.json"),
    candidates: smaPath("security/reuse_candidates.json"),
    vision: "",
    visionFile: "",
    top: 12,
    preFilter: 80,
    minStatus: "project_bound",
    model: "gpt-5.4",
    timeoutMs: 360000,
    json: true
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]; const n = argv[i + 1];
    if (a === "--no-json") opts.json = false;
    else if (n && applyRankOption(opts, a, n)) i += 1;
  }
  return opts;
}

function applyRankOption(options: RankOptions, flag: string, value: string) {
  if (flag === "--registry") options.registry = path.resolve(value);
  else if (flag === "--candidates") options.candidates = path.resolve(value);
  else if (flag === "--vision") options.vision = value;
  else if (flag === "--vision-file") options.visionFile = path.resolve(value);
  else if (flag === "--top") options.top = Number(value);
  else if (flag === "--pre-filter") options.preFilter = Number(value);
  else if (flag === "--min-status") options.minStatus = value;
  else if (flag === "--model") options.model = value;
  else if (flag === "--timeout") options.timeoutMs = Number(value) * 1000;
  else return false;
  return true;
}

const STOPWORDS = new Set(["the","a","an","and","or","of","to","for","with","without","in","on","at","by","from","be","is","are","was","were","it","its","this","that","these","those","as","into","want","need","like","build","create","make","get","have","has","had","app","application","apps"]);
function tokenize(value: unknown): string[] {
  const text = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return text.toLowerCase().replace(/[^a-z0-9+\-]/g," ").split(/\s+/).filter((word)=>word.length>=3 && !STOPWORDS.has(word));
}

const STATUS_RANK = { project_bound: 0, candidate: 1, canonical: 2 };
const ARTIFACT_TYPE_RANK = { build: 0, brick: 1 };

const SELECTED_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "role", "rank", "reason"],
  properties: {
    id: { type: "string" },
    role: { type: "string" },
    rank: { type: "integer" },
    reason: { type: "string" }
  }
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["selected_builds", "selected_bricks", "integration_plan", "missing_bricks", "risks", "summary"],
  properties: {
    summary: { type: "string" },
    selected_builds: {
      type: "array",
      items: SELECTED_SCHEMA
    },
    selected_bricks: {
      type: "array",
      items: SELECTED_SCHEMA
    },
    integration_plan: { type: "array", items: { type: "string" } },
    missing_bricks: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } }
  }
};

async function readJson(p: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await fs.readFile(p, "utf8"));
  return parsed;
}

async function loadManifest(p: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await readJson(p);
    return objectValue(parsed);
  } catch {
    return null;
  }
}

function scoreText(text: unknown, visionSet: Set<string>, weight: number) {
  let score = 0;
  for (const t of tokenize(text)) if (visionSet.has(t)) score += weight;
  return score;
}

function topKeys(obj: Record<string, unknown> | null | undefined, limit = 3) {
  return Object.entries(obj ?? {})
    .sort((a, b) => Number(b[1] ?? 0) - Number(a[1] ?? 0))
    .slice(0, limit)
    .map(([key]) => key);
}

function compactBuildPurpose(build: BuildInput) {
  const why = (build.why ?? "").trim();
  if (why) return why;
  const focus = [
    build.dominant_feature_cluster,
    build.dominant_domain,
    build.dominant_group
  ].filter(Boolean).slice(0, 2).join(" / ");
  const brickCount = ((build.brick_count ?? build.brick_ids?.length) ?? 0);
  if (focus) return `Reusable multi-brick capability around ${focus} spanning ${String(brickCount)} bricks.`;
  return `Reusable multi-brick capability spanning ${String(brickCount)} bricks.`;
}

function summarizeBuildCandidate(build: BuildInput, visionSet: Set<string>): RankArtifact | null {
  if (!build.candidate_key) return null;
  const uniqueTags = buildCandidateTags(build);
  const purpose = compactBuildPurpose(build);
  const useWhen = buildCandidateUseWhen(build);
  const score = scoreBuildCandidate(build, purpose, uniqueTags, visionSet);
  if (score <= 0) return null;
  return buildRankArtifact(build, purpose, uniqueTags, useWhen, score);
}

function buildCandidateTags(build: BuildInput) {
  const tags = [build.dominant_feature_cluster, build.dominant_domain, build.dominant_group, build.dominant_path_root,
    ...topKeys(build.signal_type_counts, 2), ...(build.sample_bricks ?? []).map((brick) => brick.feature_cluster).filter(Boolean).slice(0, 2)];
  return [...new Set(tags.map((value) => value?.toLowerCase() ?? "").filter(Boolean))].slice(0, 8);
}

function buildCandidateUseWhen(build: BuildInput) {
  return [build.dominant_feature_cluster ? `Need ${build.dominant_feature_cluster} capability.` : "",
    (build.recurrent_project_count ?? 0) > 1 ? `Pattern repeats across ${String(build.recurrent_project_count)} projects.` : "",
    build.dominant_path_root ? `Touches ${build.dominant_path_root} surfaces.` : ""].filter(Boolean);
}

function scoreBuildCandidate(build: BuildInput, purpose: string, tags: string[], visionSet: Set<string>) {
  const sampleBrickText = (build.sample_bricks ?? []).map((brick) => [brick.name, brick.kind, brick.feature_cluster, brick.source_path].filter(Boolean).join(" ")).join(" ");
  let score = 0;
  score += scoreText(build.name, visionSet, 3);
  score += scoreText(purpose, visionSet, 3);
  score += scoreText(build.why, visionSet, 2);
  score += scoreText([
    build.dominant_feature_cluster,
    build.dominant_domain,
    build.dominant_group,
    build.dominant_path_root
  ].join(" "), visionSet, 2);
  score += scoreText((build.sample_paths ?? []).join(" "), visionSet, 1);
  score += scoreText(sampleBrickText, visionSet, 2);
  for (const tag of tags) if (visionSet.has(tag)) score += 2;
  score += Math.min((build.recurrent_project_count ?? 0), 4) * 2;
  score += Math.round((build.confidence_score ?? 0) / 20);
  return score;
}

function buildRankArtifact(build: BuildInput, purpose: string, tags: string[], useWhen: string[], score: number): RankArtifact {
  return {
    type: "build",
    id: build.candidate_key ?? "",
    name: build.name ?? build.candidate_key ?? "Build Candidate",
    project: build.project,
    kind: "build",
    status: "build_candidate",
    confidence_label: build.confidence_label ?? "medium",
    confidence_score: (build.confidence_score ?? 0),
    paths: (build.sample_paths ?? []).slice(0, 3),
    purpose,
    tags,
    use_when: useWhen,
    public_api: [],
    inputs: [],
    outputs: [],
    verbs: [],
    connections: [],
    score,
    brick_count: ((build.brick_count ?? build.brick_ids?.length) ?? 0),
    sample_bricks: (build.sample_bricks ?? []).slice(0, 6).map((brick) => ({
      id: brick.id,
      name: brick.name,
      kind: brick.kind,
      status: brick.status
    })),
    recurrent_project_count: (build.recurrent_project_count ?? 0),
    recurrent_projects: (build.recurrent_projects ?? []).slice(0, 6),
    detection_sources: (build.detection_sources ?? []).slice(0, 4),
    why: (build.why ?? "")
  };
}

function mergePrefilter(bricks: RankArtifact[], builds: RankArtifact[], total: number) {
  if (builds.length === 0) return bricks.slice(0, total);
  const buildBudget = Math.min(
    Math.max(Math.round(total * 0.2), 4),
    Math.ceil(total / 2),
    builds.length
  );
  const initialBricks = bricks.slice(0, Math.max(total - buildBudget, 0));
  const initialBuilds = builds.slice(0, buildBudget);
  const combined = [...initialBricks, ...initialBuilds];
  const seen = new Set(combined.map((item) => `${item.type}:${item.id}`));
  const remaining = [
    ...bricks.slice(initialBricks.length),
    ...builds.slice(initialBuilds.length)
  ].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return ARTIFACT_TYPE_RANK[a.type] - ARTIFACT_TYPE_RANK[b.type];
  });
  for (const item of remaining) {
    if (combined.length >= total) break;
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(item);
  }
  combined.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return ARTIFACT_TYPE_RANK[a.type] - ARTIFACT_TYPE_RANK[b.type];
  });
  return combined.slice(0, total);
}

function parseRegistry(value: unknown): RegistryDocument {
  const root = objectValue(value);
  if (!root) throw new Error("registry must be a JSON object");
  const bricks = Array.isArray(root.bricks) ? root.bricks.map(parseRegistryBrick).filter((brick): brick is RegistryBrick => brick !== null) : [];
  const scanner = objectValue(root.scanner_report);
  const buildReport = objectValue(scanner?.build_report);
  const buildCandidates = Array.isArray(buildReport?.top_candidates)
    ? buildReport.top_candidates.map(parseBuildInput).filter((build): build is BuildInput => build !== null)
    : [];
  return { bricks, buildCandidates };
}

function parseRegistryBrick(value: unknown): RegistryBrick | null {
  const brick = objectValue(value);
  if (!brick || typeof brick.id !== "string" || typeof brick.name !== "string" || typeof brick.project !== "string"
    || typeof brick.kind !== "string" || typeof brick.manifest_path !== "string") return null;
  return {
    id: brick.id, name: brick.name, project: brick.project, kind: brick.kind, manifest_path: brick.manifest_path,
    status: typeof brick.status === "string" ? brick.status : undefined, source_paths: stringList(brick.source_paths),
  };
}

function parseBuildInput(value: unknown): BuildInput | null {
  const build = objectValue(value);
  if (!build) return null;
  const sampleBricks = Array.isArray(build.sample_bricks)
    ? build.sample_bricks.map(parseSampleBrick).filter((brick): brick is SampleBrick => brick !== null)
    : [];
  return {
    candidate_key: optionalText(build.candidate_key), name: optionalText(build.name), project: optionalText(build.project), why: optionalText(build.why),
    dominant_feature_cluster: optionalText(build.dominant_feature_cluster), dominant_domain: optionalText(build.dominant_domain),
    dominant_group: optionalText(build.dominant_group), dominant_path_root: optionalText(build.dominant_path_root),
    brick_count: optionalNumber(build.brick_count), brick_ids: stringList(build.brick_ids), recurrent_project_count: optionalNumber(build.recurrent_project_count),
    confidence_score: optionalNumber(build.confidence_score), confidence_label: optionalText(build.confidence_label), sample_paths: stringList(build.sample_paths),
    sample_bricks: sampleBricks, recurrent_projects: stringList(build.recurrent_projects), detection_sources: stringList(build.detection_sources),
    signal_type_counts: objectValue(build.signal_type_counts) ?? {},
  };
}

function parseSampleBrick(value: unknown): SampleBrick | null {
  const brick = objectValue(value);
  if (!brick) return null;
  return { id: optionalText(brick.id), name: optionalText(brick.name), kind: optionalText(brick.kind), status: optionalText(brick.status),
    feature_cluster: optionalText(brick.feature_cluster), source_path: optionalText(brick.source_path) };
}

function parseSemantics(manifest: Record<string, unknown> | null): BrickSemantics {
  const semantics = objectValue(manifest?.semantics) ?? {};
  const compactRecord = objectValue(semantics.compact);
  const connections = Array.isArray(semantics.connections)
    ? semantics.connections.map(parseConnection).filter((connection): connection is { target: string; kind: string } => connection !== null)
    : [];
  return {
    purpose: optionalText(semantics.purpose) ?? "", tags: stringList(semantics.tags), use_when: stringList(semantics.use_when),
    public_api: stringList(semantics.public_api), connections,
    compact: compactRecord ? { tagline: optionalText(compactRecord.tagline) ?? "", hashtags: stringList(compactRecord.hashtags),
      verbs: stringList(compactRecord.verbs), inputs: stringList(compactRecord.inputs), outputs: stringList(compactRecord.outputs),
      token_budget: optionalNumber(compactRecord.token_budget) ?? null } : null,
  };
}

function parseConnection(value: unknown): { target: string; kind: string } | null {
  const connection = objectValue(value);
  return connection && typeof connection.target === "string" && typeof connection.kind === "string"
    ? { target: connection.target, kind: connection.kind } : null;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function preFilter(opts: ReturnType<typeof parseArgs>, vision: unknown) {
  const registry = parseRegistry(await readJson(opts.registry));
  const visionSet = new Set(tokenize(vision));
  const brickCandidates: RankArtifact[] = [];
  for (const brick of registry.bricks) {
    const candidate = await summarizeBrickCandidate(brick, visionSet, opts.minStatus);
    if (candidate) brickCandidates.push(candidate);
  }
  brickCandidates.sort((a,b)=>b.score-a.score);

  const buildCandidates: RankArtifact[] = [];
  for (const build of registry.buildCandidates) {
    const candidate = summarizeBuildCandidate(build, visionSet);
    if (candidate) buildCandidates.push(candidate);
  }
  buildCandidates.sort((a, b) => b.score - a.score);

  return {
    slice: mergePrefilter(brickCandidates, buildCandidates, opts.preFilter),
    brickCount: brickCandidates.length,
    buildCount: buildCandidates.length
  };
}

async function summarizeBrickCandidate(brick: RegistryBrick, visionSet: Set<string>, minStatus: string): Promise<RankArtifact | null> {
  const status = brick.status ?? "project_bound";
  if (statusRank(status) < statusRank(minStatus)) return null;
  const semantics = parseSemantics(await loadManifest(brick.manifest_path));
  const tags = semantics.tags.map((tag) => tag.toLowerCase());
  const score = scoreBrickCandidate(brick, semantics, tags, status, visionSet);
  if (score <= 0) return null;
  return brickRankArtifact(brick, semantics, tags, status, score);
}

function scoreBrickCandidate(brick: RegistryBrick, semantics: BrickSemantics, tags: string[], status: string, visionSet: Set<string>) {
  let score = scoreText(semantics.purpose, visionSet, 3);
  for (const tag of tags) if (visionSet.has(tag)) score += 2;
  score += scoreText(semantics.use_when.join(" "), visionSet, 2);
  score += scoreText(`${brick.name} ${brick.source_paths.join(" ")}`, visionSet, 1);
  if (semantics.compact) score += scoreText(`${semantics.compact.tagline} ${semantics.compact.hashtags.join(" ")} ${semantics.compact.verbs.join(" ")}`, visionSet, 2);
  if (status === "canonical") score += 8;
  else if (status === "candidate") score += 4;
  return score;
}

function brickRankArtifact(brick: RegistryBrick, semantics: BrickSemantics, tags: string[], status: string, score: number): RankArtifact {
  const compact = semantics.compact;
  return {
    type: "brick", id: brick.id, name: brick.name, project: brick.project, kind: brick.kind, status,
    paths: brick.source_paths.slice(0, 2), purpose: compact?.tagline ?? semantics.purpose.slice(0, 200),
    tags: compact?.hashtags.map((hashtag) => hashtag.replace(/^#/, "")) ?? tags.slice(0, 8),
    use_when: semantics.use_when.slice(0, 3), public_api: semantics.public_api.slice(0, 5),
    inputs: compact?.inputs ?? [], outputs: compact?.outputs ?? [], verbs: compact?.verbs ?? [],
    connections: semantics.connections.slice(0, 4).map((connection) => ({ to: connection.target, kind: connection.kind })),
    score, token_budget: compact?.token_budget ?? null,
  };
}

function buildPrompt(vision: string, slice: RankArtifact[]) {
  const buildBlock = slice.filter((item) => item.type === "build").map(formatBuildLine).join("\n");

  // One line per brick. Compact format puts ~10x more candidates in the
  // same context window. Full fields are available from the registry if the
  // agent wants to drill down afterwards.
  const brickBlock = slice.filter((item) => item.type === "brick").map(formatBrickLine).join("\n");
  return `You compose new applications from a registry of reusable software artifacts.

- Bricks are individual reusable modules with documented purpose, public API, and connections.
- Builds are first-class multi-brick capability bundles mined from real projects. Prefer a build when it cleanly covers a capability; add constituent bricks only when they matter for customization, gaps, or wiring.

Given a product vision and a pre-filtered list of registry artifacts, return an integration plan.

## Vision
${vision.trim()}

## Available builds (pre-filtered for relevance)
${buildBlock || "None"}

## Available bricks (pre-filtered for relevance)
${brickBlock || "None"}

## Your task
Return JSON matching the schema. In particular:
- selected_builds: the ordered builds you would actually use. Use the build id verbatim. Return \`[]\` if no build candidates are useful. Each entry's \`role\` says what capability the build covers. \`rank\` is integer 1..N in build order across both builds and bricks.
- selected_bricks: the ordered individual bricks you would actually use. Use the brick id verbatim. Return \`[]\` if none are needed. Each entry's \`role\` says what it covers in the integration (e.g. "auth backbone", "transcription provider"). \`rank\` is integer 1..N in build order across both builds and bricks.
- integration_plan: ordered prose steps that turn the selected artifacts into the running app. Mention env vars, deploys, wiring.
- missing_bricks: capabilities the vision needs that none of the listed builds or bricks cover. Be specific; an agent may go look for these.
- risks: cross-artifact integration pitfalls or known limitations.
- summary: one paragraph executive summary.

Be brutal: do not pad with artifacts that don't add real value. Prefer proven builds when they cover a whole capability, and prefer canonical > candidate > project_bound bricks when alternatives exist.

Return only JSON.`;
}

function formatBuildLine(build: RankArtifact, index: number) {
  return [`BUILD ${String(index + 1)}. ${build.id}`, `[${build.confidence_label ?? "medium"}/${String(build.project)}]`, build.purpose,
    build.tags.length ? `tags:${build.tags.slice(0, 8).join(",")}` : "", build.brick_count ? `covers:${String(build.brick_count)} bricks` : "",
    build.recurrent_project_count ? `repeats:${String(build.recurrent_project_count)} projects` : "",
    build.sample_bricks?.length ? `includes:${build.sample_bricks.slice(0, 4).map((brick) => brick.name ?? brick.id).join(",")}` : "",
    build.paths.length ? `paths:${build.paths.join(",")}` : "", build.detection_sources?.length ? `signals:${build.detection_sources.join(",")}` : ""].filter(Boolean).join("  ");
}

function formatBrickLine(brick: RankArtifact, index: number) {
  return [`BRICK ${String(index + 1)}. ${brick.id}`, `[${String(brick.status)}/${String(brick.kind)}/${String(brick.project)}]`, brick.purpose,
    brick.tags.length ? `tags:${brick.tags.slice(0, 8).join(",")}` : "", brick.inputs.length ? `in:${brick.inputs.join(",")}` : "",
    brick.outputs.length ? `out:${brick.outputs.join(",")}` : "", brick.verbs.length ? `does:${brick.verbs.join(",")}` : "",
    brick.connections.length ? `conn:${brick.connections.slice(0, 3).map((connection) => `${connection.kind}->${String(connection.to.split(".").pop())}`).join(";")}` : ""].filter(Boolean).join("  ");
}

function enrichSelection(items: SelectedItem[], byKey: Map<string, RankArtifact>, type: ArtifactType, top: number) {
  return items.slice(0, top).map((selection) => enrichSelectedItem(selection, byKey.get(`${type}:${selection.id}`), type));
}

function enrichSelectedItem(selection: SelectedItem, artifact: RankArtifact | undefined, type: ArtifactType) {
  return type === "build" ? enrichSelectedBuild(selection, artifact) : enrichSelectedBrick(selection, artifact);
}

function enrichSelectedBuild(selection: SelectedItem, artifact: RankArtifact | undefined) {
  return { ...selection, type: "build" as const, project: artifact?.project, kind: "build", status: artifact?.status,
    confidence_label: artifact?.confidence_label, confidence_score: artifact?.confidence_score, paths: artifact?.paths,
    purpose: artifact?.purpose, brick_count: artifact?.brick_count, recurrent_project_count: artifact?.recurrent_project_count,
    sample_bricks: artifact?.sample_bricks };
}

function enrichSelectedBrick(selection: SelectedItem, artifact: RankArtifact | undefined) {
  return { ...selection, type: "brick" as const, project: artifact?.project, kind: artifact?.kind, status: artifact?.status,
    paths: artifact?.paths, public_api: artifact?.public_api, purpose: artifact?.purpose };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let vision = opts.vision;
  if (opts.visionFile) vision = await fs.readFile(opts.visionFile, "utf8");
  if (!vision) { console.error("error: provide --vision or --vision-file"); process.exit(2); }

  console.error(`pre-filtering registry...`);
  const { slice, brickCount, buildCount } = await preFilter(opts, vision);
  console.error(`pre-filter: ${String(slice.length)} candidate artifacts (${String(brickCount)} bricks matched, ${String(buildCount)} builds matched)`);

  if (slice.length === 0) {
    console.log(JSON.stringify({
      vision,
      summary: "No bricks or builds matched the vision keywords.",
      selected_artifacts: [],
      selected_builds: [],
      selected_bricks: [],
      integration_plan: [],
      missing_bricks: [],
      risks: []
    }, null, 2));
    return;
  }

  const prompt = buildPrompt(vision, slice);
  console.error(`asking codex (model=${opts.model})...`);
  const r = await codex({ prompt, schema: SCHEMA, model: opts.model, timeoutMs: opts.timeoutMs });
  if (!r.ok) {
    console.error(JSON.stringify(r, null, 2));
    process.exit(1);
  }

  const data = rankPayload(r.data);
  if (!data) throw new Error("codex returned an invalid ranking payload");
  const byKey = new Map(slice.map((artifact): [string, RankArtifact] => [`${artifact.type}:${artifact.id}`, artifact]));
  const selectedBuilds = enrichSelection(data.selected_builds, byKey, "build", opts.top);
  const selectedBricks = enrichSelection(data.selected_bricks, byKey, "brick", opts.top);
  const selectedArtifacts = [...selectedBuilds, ...selectedBricks]
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return ARTIFACT_TYPE_RANK[a.type] - ARTIFACT_TYPE_RANK[b.type];
    })
    .slice(0, opts.top);

  const out = {
    vision: vision.trim().slice(0, 800),
    pre_filter_size: slice.length,
    pre_filter_brick_size: brickCount,
    pre_filter_build_size: buildCount,
    summary: data.summary,
    selected_artifacts: selectedArtifacts,
    selected_builds: selectedBuilds,
    selected_bricks: selectedBricks,
    integration_plan: data.integration_plan,
    missing_bricks: data.missing_bricks,
    risks: data.risks,
    used_model: opts.model,
    from_cache: r.fromCache,
    duration_ms: r.durationMs
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err: unknown) => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });

function rankPayload(value: unknown): {
  summary: string; selected_builds: SelectedItem[]; selected_bricks: SelectedItem[];
  integration_plan: string[]; missing_bricks: string[]; risks: string[];
} | null {
  const data = objectValue(value);
  if (!data || typeof data.summary !== "string") return null;
  return {
    summary: data.summary,
    selected_builds: selectedItems(data.selected_builds),
    selected_bricks: selectedItems(data.selected_bricks),
    integration_plan: stringList(data.integration_plan),
    missing_bricks: stringList(data.missing_bricks),
    risks: stringList(data.risks),
  };
}

function selectedItems(value: unknown): SelectedItem[] {
  if (!Array.isArray(value)) return [];
  const out: SelectedItem[] = [];
  for (const candidate of value) {
    const item = objectValue(candidate);
    if (!item || typeof item.id !== "string" || typeof item.role !== "string"
      || typeof item.rank !== "number" || typeof item.reason !== "string") continue;
    out.push({ id: item.id, role: item.role, rank: item.rank, reason: item.reason });
  }
  return out;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function statusRank(value: unknown): number {
  if (value === "canonical") return STATUS_RANK.canonical;
  if (value === "candidate") return STATUS_RANK.candidate;
  return STATUS_RANK.project_bound;
}
