import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildEmbeddingIndex, createDeterministicHashEmbedder, semanticRerankQuery } from "./graph-embeddings.mjs";
import { communitySummaryBlock } from "./graph-summaries.mjs";

const GLOBAL_QUERY_SCRIPT = String.raw`
import json
import sys
import unicodedata
from pathlib import Path

from networkx.readwrite import json_graph
from graphify.serve import _query_graph_text

graph_path = Path(sys.argv[1])
wanted_tags = {tag.casefold() for tag in json.loads(sys.argv[2])}
budget = int(sys.argv[3])
question = sys.argv[4]

raw = json.loads(graph_path.read_text(encoding="utf-8"))
if "links" not in raw and "edges" in raw:
    raw = dict(raw, links=raw["edges"])
try:
    graph = json_graph.node_link_graph(raw, edges="links")
except TypeError:
    graph = json_graph.node_link_graph(raw)

def portfolio_tag(node_id, data):
    repo = str(data.get("repo") or "").strip()
    if repo:
        return repo
    text_id = str(node_id)
    return text_id.split("::", 1)[0] if "::" in text_id else "untagged"

selected = [
    node_id for node_id, data in graph.nodes(data=True)
    if not wanted_tags or portfolio_tag(node_id, data).casefold() in wanted_tags
]
if wanted_tags and not selected:
    print(f"error: no global graph nodes matched tags: {', '.join(sorted(wanted_tags))}", file=sys.stderr)
    raise SystemExit(2)

graph = graph.subgraph(selected).copy()
for node_id, data in graph.nodes(data=True):
    tag = portfolio_tag(node_id, data)
    label = str(data.get("label") or node_id)
    if not data.get("norm_label"):
        normalized = unicodedata.normalize("NFKD", label)
        data["norm_label"] = "".join(ch for ch in normalized if not unicodedata.combining(ch)).lower()
    prefix = f"[{tag}] "
    if not label.startswith(prefix):
        data["label"] = prefix + label

print(_query_graph_text(graph, question, mode="bfs", depth=2, token_budget=budget))
`;

/** @param {string | string[] | undefined} tags */
function normalizeTags(tags) {
  const values = Array.isArray(tags) ? tags : String(tags || "").split(",");
  return [...new Set(values.map((tag) => String(tag).trim()).filter(Boolean))];
}

function resolveGraphifyLauncher(graphifyPath = "graphify") {
  if (graphifyPath && existsSync(graphifyPath)) return realpathSync(graphifyPath);
  const found = spawnSync("which", [graphifyPath || "graphify"], { encoding: "utf8" });
  const launcher = String(found.stdout || "").trim();
  if (found.status !== 0 || !launcher) {
    throw new Error("Graphify CLI is unavailable; install graphify before running a global query.");
  }
  return realpathSync(launcher);
}

function graphifyPython(graphifyPath) {
  const launcher = resolveGraphifyLauncher(graphifyPath);
  const shebang = readFileSync(launcher, "utf8").split(/\r?\n/, 1)[0];
  const interpreter = shebang.startsWith("#!") ? shebang.slice(2).trim().split(/\s+/)[0] : "";
  if (interpreter && existsSync(interpreter)) return interpreter;
  const siblingPython = path.join(path.dirname(launcher), "python");
  if (existsSync(siblingPython)) return realpathSync(siblingPython);
  throw new Error(`Could not resolve Graphify's Python runtime from ${launcher}.`);
}

export function globalGraphPath(home = process.env.HOME || homedir()) {
  return path.join(home, ".graphify", "global-graph.json");
}

function graphNodes(graph) {
  const nodes = graph?.nodes ?? graph?.elements?.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

function nodeId(node) {
  return String(node?.id ?? node?.data?.id ?? "").trim();
}

function portfolioTag(node) {
  const repo = String(node?.repo ?? node?.data?.repo ?? "").trim();
  if (repo) return repo;
  const id = nodeId(node);
  return id.includes("::") ? id.split("::", 1)[0] : "untagged";
}

function allowedNodeIds(graph, tags) {
  if (!tags.length) return undefined;
  const wanted = new Set(tags.map((tag) => tag.toLowerCase()));
  return new Set(graphNodes(graph)
    .filter((node) => wanted.has(portfolioTag(node).toLowerCase()))
    .map(nodeId)
    .filter(Boolean));
}

/**
 * @param {{ question?: string, tags?: string | string[], budget?: string | number, home?: string, graphifyPath?: string, embedder?: object }} [options]
 */
export async function queryGlobalGraph(options = {}) {
  const { question, tags = [], budget = 2000, home, graphifyPath, embedder } = options;
  const query = String(question || "").trim();
  if (!query) throw new Error("global query requires a question");
  const parsedBudget = Number(budget);
  if (!Number.isInteger(parsedBudget) || parsedBudget <= 0) {
    throw new Error("--budget must be a positive integer");
  }

  const resolvedHome = home || process.env.HOME || homedir();
  const graphPath = globalGraphPath(resolvedHome);
  if (!existsSync(graphPath)) {
    throw new Error(
      `Missing global Graphify graph: ${graphPath}. Add one with \`node tools/sma-graphify.mjs refresh --project <id> --global\` before querying.`,
    );
  }

  const normalizedTags = normalizeTags(tags);
  const graph = JSON.parse(readFileSync(graphPath, "utf8"));
  const ranked = await semanticRerankQuery({
    graphPath,
    question: query,
    embedder,
    allowedNodeIds: allowedNodeIds(graph, normalizedTags),
  });

  const result = spawnSync(
    graphifyPython(graphifyPath),
    ["-c", GLOBAL_QUERY_SCRIPT, graphPath, JSON.stringify(normalizedTags), String(parsedBudget), ranked.expandedQuestion],
    {
      encoding: "utf8",
      env: { ...process.env, HOME: resolvedHome },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error) throw new Error(`Global graph query failed: ${result.error.message}`);
  if (result.status !== 0) {
    const details = String(result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`Global graph query failed: ${details}`);
  }
  const traversalOutput = String(result.stdout || "").trimEnd();
  const communityBlock = communitySummaryBlock({
    graphPath,
    question: normalizedTags.length ? "" : query,
    hits: ranked.hits,
    traversalOutput,
  });
  return communityBlock
    ? `${communityBlock}\n\n## Traversal result\n${traversalOutput}`
    : traversalOutput;
}

function fixtureGraph(tag) {
  const semanticNodes = tag === "alpha" ? [
    { id: "session-signin", label: "session-signin", community: "alpha-session", source_snippet: "Establishes a user session." },
    {
      id: "session-summary",
      label: "Community alpha-session summary",
      type: "community_summary",
      kind: "community_summary",
      community: "alpha-session",
      summary: "Map context for session persistence.",
      source_snippet: "Map context for session persistence.",
      sma_generated: "community_summary",
    },
  ] : [];
  const semanticLinks = tag === "alpha" ? [{
    source: "session-summary",
    target: "session-signin",
    relation: "rationale_for",
    type: "rationale_for",
    sma_generated: "community_summary",
  }] : [];
  return {
    directed: false,
    multigraph: false,
    graph: {},
    nodes: [
      { id: `${tag}-target`, label: `shared target ${tag}`, source_file: `${tag}/target.mjs` },
      { id: `${tag}-detail`, label: `${tag} detail ${"x".repeat(120)}`, source_file: `${tag}/detail.mjs` },
      ...semanticNodes,
    ],
    links: [
      { source: `${tag}-target`, target: `${tag}-detail`, relation: "contains" },
      ...semanticLinks,
    ],
  };
}

function assertSelftest(condition, message) {
  if (!condition) throw new Error(`global query selftest failed: ${message}`);
}

/** @param {{ graphifyPath?: string }} [options] */
export async function selftestGlobalQuery(options = {}) {
  const { graphifyPath } = options;
  const root = mkdtempSync(path.join(tmpdir(), "sma-graph-global-"));
  const home = path.join(root, "home");
  const launcher = resolveGraphifyLauncher(graphifyPath);
  try {
    mkdirSync(home, { recursive: true });
    for (const tag of ["alpha", "beta"]) {
      const fixturePath = path.join(root, `${tag}.json`);
      writeFileSync(fixturePath, JSON.stringify(fixtureGraph(tag), null, 2) + "\n");
      const added = spawnSync(launcher, ["global", "add", fixturePath, "--as", tag], {
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      });
      assertSelftest(added.status === 0, `${tag} fixture should be added to the global graph`);
    }

    const graphPath = globalGraphPath(home);
    const semanticEmbedder = createDeterministicHashEmbedder({ aliases: { auth: "session", login: "signin", flow: "" } });
    await buildEmbeddingIndex({ graphPath, embedder: semanticEmbedder });

    const combined = await queryGlobalGraph({ question: "shared target", budget: 1000, home, graphifyPath: launcher, embedder: semanticEmbedder });
    assertSelftest(combined.includes("NODE [alpha] shared target alpha"), "alpha result should be tag-prefixed");
    assertSelftest(combined.includes("NODE [beta] shared target beta"), "beta result should be tag-prefixed");

    const filtered = await queryGlobalGraph({ question: "shared target", tags: "alpha", budget: 1000, home, graphifyPath: launcher, embedder: semanticEmbedder });
    assertSelftest(filtered.includes("[alpha]"), "tag filter should retain matching nodes");
    assertSelftest(!filtered.includes("[beta]"), "tag filter should exclude other portfolios");

    const semantic = await queryGlobalGraph({ question: "auth login flow", budget: 1000, home, graphifyPath: launcher, embedder: semanticEmbedder });
    assertSelftest(semantic.includes("NODE [alpha] session-signin"), "global query should use semantic reranking to seed traversal");
    assertSelftest(semantic.startsWith("## Community summaries"), "global query should prepend matching community summaries");
    assertSelftest(semantic.includes("Map context for session persistence."), "global query should include semantic community context");

    const semanticFiltered = await queryGlobalGraph({ question: "auth login flow", tags: "beta", budget: 1000, home, graphifyPath: launcher, embedder: semanticEmbedder });
    assertSelftest(!semanticFiltered.includes("[alpha]"), "semantic reranking should honor global tag filters");
    assertSelftest(!semanticFiltered.includes("Map context for session persistence."), "community summaries should honor global tag filters");

    const truncated = await queryGlobalGraph({ question: "shared target", budget: 10, home, graphifyPath: launcher, embedder: semanticEmbedder });
    assertSelftest(truncated.includes("truncated"), "budget should truncate query output");

    let missingError = "";
    try {
      await queryGlobalGraph({ question: "anything", home: path.join(root, "missing-home"), graphifyPath: launcher });
    } catch (error) {
      missingError = error instanceof Error ? error.message : String(error);
    }
    assertSelftest(missingError.includes("Missing global Graphify graph"), "missing graph error should be actionable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
