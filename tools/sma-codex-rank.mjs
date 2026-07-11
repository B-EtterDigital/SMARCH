#!/usr/bin/env node
/**
 * WHAT: Turns a product vision into a registry-grounded selection and integration plan for builds and bricks.
 * WHY: Agents need ranked reusable components plus explicit coverage gaps, not an ungrounded language-model recommendation.
 * HOW: Pre-filters registry candidates, asks Codex to plan over that slice, and prints structured output for another agent or operator.
 * Usage: `node tools/sma-codex-rank.mjs --vision "Add an approval workflow" --top 5`
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
import { codex } from "./lib/codex-runner.mjs";
import { smaPath } from "./lib/sma-paths.ts";

function parseArgs(argv) {
  const opts = {
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
    if (a === "--registry" && n) { opts.registry = path.resolve(n); i += 1; }
    else if (a === "--candidates" && n) { opts.candidates = path.resolve(n); i += 1; }
    else if (a === "--vision" && n) { opts.vision = n; i += 1; }
    else if (a === "--vision-file" && n) { opts.visionFile = path.resolve(n); i += 1; }
    else if (a === "--top" && n) { opts.top = Number(n); i += 1; }
    else if (a === "--pre-filter" && n) { opts.preFilter = Number(n); i += 1; }
    else if (a === "--min-status" && n) { opts.minStatus = n; i += 1; }
    else if (a === "--model" && n) { opts.model = n; i += 1; }
    else if (a === "--timeout" && n) { opts.timeoutMs = Number(n) * 1000; i += 1; }
    else if (a === "--no-json") { opts.json = false; }
  }
  return opts;
}

const STOPWORDS = new Set(["the","a","an","and","or","of","to","for","with","without","in","on","at","by","from","be","is","are","was","were","it","its","this","that","these","those","as","into","want","need","like","build","create","make","get","have","has","had","app","application","apps"]);
function tokenize(s) { return String(s||"").toLowerCase().replace(/[^a-z0-9+\-]/g," ").split(/\s+/).filter((w)=>w.length>=3 && !STOPWORDS.has(w)); }

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

async function readJson(p) { return JSON.parse(await fs.readFile(p, "utf8")); }

async function loadManifest(p) {
  try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return null; }
}

function scoreText(text, visionSet, weight) {
  let score = 0;
  for (const t of tokenize(text)) if (visionSet.has(t)) score += weight;
  return score;
}

function topKeys(obj, limit = 3) {
  return Object.entries(obj || {})
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, limit)
    .map(([key]) => key);
}

function compactBuildPurpose(build) {
  const why = String(build.why || "").trim();
  if (why) return why;
  const focus = [
    build.dominant_feature_cluster,
    build.dominant_domain,
    build.dominant_group
  ].filter(Boolean).slice(0, 2).join(" / ");
  const brickCount = Number(build.brick_count || build.brick_ids?.length || 0);
  if (focus) return `Reusable multi-brick capability around ${focus} spanning ${brickCount} bricks.`;
  return `Reusable multi-brick capability spanning ${brickCount} bricks.`;
}

function summarizeBuildCandidate(build, visionSet) {
  if (!build?.candidate_key) return null;
  const tags = [
    build.dominant_feature_cluster,
    build.dominant_domain,
    build.dominant_group,
    build.dominant_path_root,
    ...topKeys(build.signal_type_counts, 2),
    ...(build.sample_bricks || []).map((brick) => brick.feature_cluster).filter(Boolean).slice(0, 2)
  ].map((value) => String(value || "").toLowerCase()).filter(Boolean);
  const uniqueTags = [...new Set(tags)].slice(0, 8);
  const purpose = compactBuildPurpose(build);
  const sampleBrickText = (build.sample_bricks || [])
    .map((brick) => [brick.name, brick.kind, brick.feature_cluster, brick.source_path].filter(Boolean).join(" "))
    .join(" ");
  const useWhen = [
    build.dominant_feature_cluster ? `Need ${build.dominant_feature_cluster} capability.` : "",
    build.recurrent_project_count > 1 ? `Pattern repeats across ${build.recurrent_project_count} projects.` : "",
    build.dominant_path_root ? `Touches ${build.dominant_path_root} surfaces.` : ""
  ].filter(Boolean);
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
  score += scoreText((build.sample_paths || []).join(" "), visionSet, 1);
  score += scoreText(sampleBrickText, visionSet, 2);
  for (const tag of uniqueTags) if (visionSet.has(tag)) score += 2;
  score += Math.min(Number(build.recurrent_project_count || 0), 4) * 2;
  score += Math.round(Number(build.confidence_score || 0) / 20);
  if (score <= 0) return null;
  return {
    type: "build",
    id: String(build.candidate_key || ""),
    name: String(build.name || build.candidate_key || "Build Candidate"),
    project: build.project,
    kind: "build",
    status: "build_candidate",
    confidence_label: build.confidence_label || "medium",
    confidence_score: Number(build.confidence_score || 0),
    paths: (build.sample_paths || []).slice(0, 3),
    purpose,
    tags: uniqueTags,
    use_when: useWhen,
    public_api: [],
    inputs: [],
    outputs: [],
    verbs: [],
    connections: [],
    score,
    brick_count: Number(build.brick_count || build.brick_ids?.length || 0),
    sample_bricks: (build.sample_bricks || []).slice(0, 6).map((brick) => ({
      id: brick.id,
      name: brick.name,
      kind: brick.kind,
      status: brick.status
    })),
    recurrent_project_count: Number(build.recurrent_project_count || 0),
    recurrent_projects: (build.recurrent_projects || []).slice(0, 6),
    detection_sources: (build.detection_sources || []).slice(0, 4),
    why: String(build.why || "")
  };
}

function mergePrefilter(bricks, builds, total) {
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
    return (ARTIFACT_TYPE_RANK[a.type] ?? 9) - (ARTIFACT_TYPE_RANK[b.type] ?? 9);
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
    return (ARTIFACT_TYPE_RANK[a.type] ?? 9) - (ARTIFACT_TYPE_RANK[b.type] ?? 9);
  });
  return combined.slice(0, total);
}

async function preFilter(opts, vision) {
  const registry = await readJson(opts.registry);
  const visionSet = new Set(tokenize(vision));
  const brickCandidates = [];
  for (const b of registry.bricks || []) {
    const status = b.status || "project_bound";
    if (STATUS_RANK[status] < (STATUS_RANK[opts.minStatus] ?? 0)) continue;
    const mf = await loadManifest(b.manifest_path);
    const sem = mf?.semantics || {};
    const purpose = String(sem.purpose || "");
    const tags = (sem.tags || []).map((t) => String(t).toLowerCase());
    const useWhen = (sem.use_when || []).join(" ");
    const name = `${b.name || ""} ${(b.source_paths||[]).join(" ")}`;
    const compact = sem.compact || null;
    const compactText = compact ? `${compact.tagline || ""} ${(compact.hashtags||[]).join(" ")} ${(compact.verbs||[]).join(" ")}` : "";
    let score = 0;
    score += scoreText(purpose, visionSet, 3);
    for (const t of tags) if (visionSet.has(t)) score += 2;
    score += scoreText(useWhen, visionSet, 2);
    score += scoreText(name, visionSet, 1);
    score += scoreText(compactText, visionSet, 2);
    if (status === "canonical") score += 8;
    else if (status === "candidate") score += 4;
    if (score <= 0) continue;
    brickCandidates.push({
      type: "brick",
      id: b.id, name: b.name, project: b.project, kind: b.kind, status,
      paths: (b.source_paths||[]).slice(0, 2),
      // Prefer compact form when available — saves ~10× tokens in the LLM prompt.
      purpose: compact?.tagline || purpose.slice(0, 200),
      tags: compact?.hashtags?.map((h) => h.replace(/^#/, "")) || tags.slice(0, 8),
      use_when: (sem.use_when || []).slice(0, 3),
      public_api: (sem.public_api || []).slice(0, 5),
      inputs: compact?.inputs || [],
      outputs: compact?.outputs || [],
      verbs: compact?.verbs || [],
      connections: (sem.connections || []).slice(0, 4).map((c) => ({ to: c.target, kind: c.kind })),
      score,
      token_budget: compact?.token_budget || null
    });
  }
  brickCandidates.sort((a,b)=>b.score-a.score);

  const buildCandidates = [];
  for (const build of registry.scanner_report?.build_report?.top_candidates || []) {
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

function buildPrompt(vision, slice) {
  const buildBlock = slice.filter((item) => item.type === "build").map((build, i) => {
    const parts = [
      `BUILD ${i+1}. ${build.id}`,
      `[${build.confidence_label || "medium"}/${build.project}]`,
      build.purpose,
      build.tags.length ? `tags:${build.tags.slice(0, 8).join(",")}` : "",
      build.brick_count ? `covers:${build.brick_count} bricks` : "",
      build.recurrent_project_count ? `repeats:${build.recurrent_project_count} projects` : "",
      build.sample_bricks?.length ? `includes:${build.sample_bricks.slice(0, 4).map((brick) => brick.name || brick.id).join(",")}` : "",
      build.paths?.length ? `paths:${build.paths.join(",")}` : "",
      build.detection_sources?.length ? `signals:${build.detection_sources.join(",")}` : ""
    ].filter(Boolean);
    return parts.join("  ");
  }).join("\n");

  // One line per brick. Compact format puts ~10x more candidates in the
  // same context window. Full fields are available from the registry if the
  // agent wants to drill down afterwards.
  const brickBlock = slice.filter((item) => item.type === "brick").map((b, i) => {
    const parts = [
      `BRICK ${i+1}. ${b.id}`,
      `[${b.status}/${b.kind}/${b.project}]`,
      b.purpose,
      b.tags.length ? `tags:${b.tags.slice(0, 8).join(",")}` : "",
      b.inputs?.length ? `in:${b.inputs.join(",")}` : "",
      b.outputs?.length ? `out:${b.outputs.join(",")}` : "",
      b.verbs?.length ? `does:${b.verbs.join(",")}` : "",
      b.connections?.length ? `conn:${b.connections.slice(0, 3).map((c) => `${c.kind}->${c.to.split(".").pop()}`).join(";")}` : ""
    ].filter(Boolean);
    return parts.join("  ");
  }).join("\n");
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

function enrichSelection(items, byKey, type, top) {
  return (items || [])
    .slice(0, top)
    .map((selection) => {
      const artifact = byKey.get(`${type}:${selection.id}`);
      if (type === "build") {
        return {
          ...selection,
          type,
          project: artifact?.project,
          kind: "build",
          status: artifact?.status,
          confidence_label: artifact?.confidence_label,
          confidence_score: artifact?.confidence_score,
          paths: artifact?.paths,
          purpose: artifact?.purpose,
          brick_count: artifact?.brick_count,
          recurrent_project_count: artifact?.recurrent_project_count,
          sample_bricks: artifact?.sample_bricks
        };
      }
      return {
        ...selection,
        type,
        project: artifact?.project,
        kind: artifact?.kind,
        status: artifact?.status,
        paths: artifact?.paths,
        public_api: artifact?.public_api,
        purpose: artifact?.purpose
      };
    });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let vision = opts.vision;
  if (opts.visionFile) vision = await fs.readFile(opts.visionFile, "utf8");
  if (!vision) { console.error("error: provide --vision or --vision-file"); process.exit(2); }

  console.error(`pre-filtering registry...`);
  const { slice, brickCount, buildCount } = await preFilter(opts, vision);
  console.error(`pre-filter: ${slice.length} candidate artifacts (${brickCount} bricks matched, ${buildCount} builds matched)`);

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

  const byKey = new Map(slice.map((artifact) => [`${artifact.type}:${artifact.id}`, artifact]));
  const selectedBuilds = enrichSelection(r.data.selected_builds, byKey, "build", opts.top);
  const selectedBricks = enrichSelection(r.data.selected_bricks, byKey, "brick", opts.top);
  const selectedArtifacts = [...selectedBuilds, ...selectedBricks]
    .sort((a, b) => {
      if ((a.rank ?? 0) !== (b.rank ?? 0)) return (a.rank ?? 0) - (b.rank ?? 0);
      return (ARTIFACT_TYPE_RANK[a.type] ?? 9) - (ARTIFACT_TYPE_RANK[b.type] ?? 9);
    })
    .slice(0, opts.top);

  const out = {
    vision: vision.trim().slice(0, 800),
    pre_filter_size: slice.length,
    pre_filter_brick_size: brickCount,
    pre_filter_build_size: buildCount,
    summary: r.data.summary,
    selected_artifacts: selectedArtifacts,
    selected_builds: selectedBuilds,
    selected_bricks: selectedBricks,
    integration_plan: r.data.integration_plan,
    missing_bricks: r.data.missing_bricks,
    risks: r.data.risks,
    used_model: opts.model,
    from_cache: r.fromCache,
    duration_ms: r.durationMs
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => { console.error(err instanceof Error ? err.stack : err); process.exit(1); });
