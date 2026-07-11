import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dispatch } from "./workforce/contract.mjs";

const SUMMARY_KIND = "community_summary";
const SUMMARY_RELATION = "rationale_for";

/** @typedef {{ data?: GraphRecord } & Record<string, unknown>} GraphRecord */
/** @typedef {GraphRecord & { nodes?: GraphRecord[], edges?: GraphRecord[], links?: GraphRecord[], elements?: { nodes?: GraphRecord[], edges?: GraphRecord[] }, metadata?: GraphRecord }} GraphDocument */
/** @typedef {{ nodes: GraphRecord[], edges: GraphRecord[], setEdges: (edges: GraphRecord[]) => void }} GraphCollections */
/** @typedef {{ id: string, label: string, type: string, source: string, snippet: string }} StableMember */
/** @typedef {{ version?: number, hash: string, community?: string, member_ids: string[], summary: string, generated_at?: string }} CacheRecord */
/** @typedef {{ community: string, hash: string, memberIds: string[], summary: string }} SummaryInput */
/** @typedef {{ task: string, instructions: string[], community: string, members: StableMember[], internal_edges: Array<{source: string, target: string, relation: string}> }} SummaryPacket */

/** @param {unknown} value @returns {value is GraphRecord} */
function isGraphRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {string} filePath @returns {GraphDocument} */
function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** @param {string} filePath @returns {CacheRecord} */
function readCacheJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

/** @param {GraphDocument} graph @returns {GraphCollections} */
function graphCollections(graph) {
  if (Array.isArray(graph.nodes)) {
    return {
      nodes: graph.nodes,
      edges: Array.isArray(graph.edges) ? graph.edges : Array.isArray(graph.links) ? graph.links : [],
      /** @param {GraphRecord[]} edges */
      setEdges(edges) {
        if (Array.isArray(graph.edges)) graph.edges = edges;
        else graph.links = edges;
      },
    };
  }
  const elements = graph.elements ?? {};
  return {
    nodes: Array.isArray(elements.nodes) ? elements.nodes : [],
    edges: Array.isArray(elements.edges) ? elements.edges : [],
    /** @param {GraphRecord[]} edges */
    setEdges(edges) { elements.edges = edges; },
  };
}

/** @param {GraphRecord} node @returns {string} */
function nodeId(node) {
  return String(node?.id ?? node?.data?.id ?? "").trim();
}

/** @param {GraphRecord | undefined} node @param {string} key @returns {unknown} */
function nodeValue(node, key) {
  return node?.[key] ?? node?.data?.[key];
}

/** @param {GraphRecord} edge @param {string} key @returns {unknown} */
function edgeValue(edge, key) {
  return edge?.[key] ?? edge?.data?.[key];
}

/** @param {GraphRecord} node @returns {string} */
function communityId(node) {
  for (const key of ["community", "community_id", "cluster", "cluster_id"]) {
    const value = nodeValue(node, key);
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value);
  }
  return "";
}

/** @param {GraphRecord} node @returns {boolean} */
function isSummaryNode(node) {
  return nodeValue(node, "kind") === SUMMARY_KIND
    || nodeValue(node, "type") === SUMMARY_KIND
    || nodeValue(node, "sma_generated") === SUMMARY_KIND;
}

/** @param {GraphRecord} edge @returns {string} */
function edgeRelation(edge) {
  return String(edgeValue(edge, "relation") ?? edgeValue(edge, "type") ?? "");
}

/** @param {GraphRecord} edge @returns {string} */
function edgeSource(edge) {
  return String(edgeValue(edge, "source") ?? "");
}

/** @param {GraphRecord} edge @returns {string} */
function edgeTarget(edge) {
  return String(edgeValue(edge, "target") ?? "");
}

/** @param {GraphRecord} node @returns {StableMember} */
function stableMember(node) {
  return {
    id: nodeId(node),
    label: String(nodeValue(node, "label") ?? nodeId(node)),
    type: String(nodeValue(node, "type") ?? nodeValue(node, "kind") ?? ""),
    source: String(nodeValue(node, "source") ?? nodeValue(node, "file") ?? nodeValue(node, "path") ?? ""),
    snippet: String(nodeValue(node, "source_snippet") ?? nodeValue(node, "description") ?? ""),
  };
}

/** @param {Set<string>} memberIds @param {GraphRecord[]} edges */
function stableInternalEdges(memberIds, edges) {
  return edges
    .filter((edge) => memberIds.has(edgeSource(edge)) && memberIds.has(edgeTarget(edge)))
    .map((edge) => ({
      source: edgeSource(edge),
      target: edgeTarget(edge),
      relation: edgeRelation(edge),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

/** @param {GraphRecord[]} members @param {GraphRecord[]} [edges] @returns {string} */
export function clusterContentHash(members, edges = []) {
  const stableMembers = members.map(stableMember).sort((left, right) => left.id.localeCompare(right.id));
  const memberIds = new Set(stableMembers.map((member) => member.id));
  const payload = { members: stableMembers, edges: stableInternalEdges(memberIds, edges) };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** @param {unknown} output @returns {string} */
function summaryText(output) {
  if (isGraphRecord(output)) return String(output.summary ?? output.output ?? "").trim();
  const text = String(output ?? "").trim();
  if (!text) return "";
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(unfenced);
    return String(parsed?.summary ?? parsed?.output ?? "").trim() || text;
  } catch {
    return text;
  }
}

/** @param {string} community @param {GraphRecord[]} members @param {GraphRecord[]} edges @returns {SummaryPacket} */
function summaryPacket(community, members, edges) {
  const stableMembers = members.map(stableMember).sort((left, right) => left.id.localeCompare(right.id));
  const memberIds = new Set(stableMembers.map((member) => member.id));
  return {
    task: "summarize_graph_community",
    instructions: [
      "Summarize this graph community as concise map-level context for a later codebase query.",
      "Explain the shared responsibility, important relationships, and why these members belong together.",
      "Use only the supplied graph facts. Return only the summary text, with no heading or markdown fence.",
    ],
    community: String(community),
    members: stableMembers,
    internal_edges: stableInternalEdges(memberIds, edges),
  };
}

/** @param {string} cachePath @param {string} hash @param {string} community @param {string[]} memberIds @returns {CacheRecord | null} */
function cacheRecord(cachePath, hash, community, memberIds) {
  if (!existsSync(cachePath)) return null;
  try {
    const record = readCacheJson(cachePath);
    if (record.hash !== hash || typeof record.summary !== "string" || !record.summary.trim()) return null;
    if (!Array.isArray(record.member_ids) || record.member_ids.join("\0") !== memberIds.join("\0")) return null;
    return record;
  } catch {
    return null;
  }
}

/** @param {GraphDocument} graph @param {GraphCollections} collections @param {SummaryInput} input @returns {string} */
function addSummary(graph, collections, { community, hash, memberIds, summary }) {
  const summaryId = `community-summary:${hash.slice(0, 20)}`;
  collections.nodes.push({
    id: summaryId,
    label: `Community ${community} summary`,
    type: SUMMARY_KIND,
    kind: SUMMARY_KIND,
    community,
    summary,
    source_snippet: summary,
    cluster_content_hash: hash,
    member_ids: memberIds,
    sma_generated: SUMMARY_KIND,
  });
  for (const memberId of memberIds) {
    collections.edges.push({
      id: `${summaryId}:${SUMMARY_RELATION}:${memberId}`,
      source: summaryId,
      target: memberId,
      relation: SUMMARY_RELATION,
      type: SUMMARY_RELATION,
      sma_generated: SUMMARY_KIND,
    });
  }
  return summaryId;
}

/**
 * Generate and persist one cached summary node per clustered community.
 * The caller must explicitly opt into semantic mode; otherwise this function
 * performs no reads, writes, cache creation, or workforce dispatch.
 * @param {{ graphPath?: string, semantic?: boolean, backend?: string | Function | { execute: Function }, timeoutMs?: number, onWarning?: (warning: string) => void }} [options]
 */
export async function generateCommunitySummaries({
  graphPath,
  semantic = false,
  backend,
  timeoutMs,
  onWarning = (warning) => console.log(`WARN ${warning}`),
} = {}) {
  if (!semantic) return { skipped: true, reason: "semantic-disabled", generated: 0, reused: 0, summaryCount: 0 };
  if (!graphPath || !existsSync(graphPath)) {
    onWarning(`community summaries skipped: graph is missing at ${graphPath || "(unknown)"}`);
    return { skipped: true, reason: "missing-graph", generated: 0, reused: 0, summaryCount: 0 };
  }

  const graph = readJson(graphPath);
  const collections = graphCollections(graph);
  const previousSummaryIds = new Set(collections.nodes.filter(isSummaryNode).map(nodeId));
  const memberNodes = collections.nodes.filter((node) => !isSummaryNode(node) && nodeId(node));
  const baseEdges = collections.edges.filter((edge) => (
    !previousSummaryIds.has(edgeSource(edge))
    && edgeValue(edge, "sma_generated") !== SUMMARY_KIND
  ));
  collections.nodes.splice(0, collections.nodes.length, ...memberNodes);
  collections.setEdges(baseEdges);
  collections.edges = baseEdges;

  /** @type {Map<string, GraphRecord[]>} */
  const groups = new Map();
  for (const node of memberNodes) {
    const community = communityId(node);
    if (!community) continue;
    const members = groups.get(community);
    if (members) members.push(node);
    else groups.set(community, [node]);
  }
  if (!groups.size) {
    onWarning("community summaries skipped: semantic graph contains no clustered communities");
    return { skipped: true, reason: "no-communities", generated: 0, reused: 0, summaryCount: 0 };
  }

  const cacheRoot = path.join(path.dirname(graphPath), "summaries");
  mkdirSync(cacheRoot, { recursive: true });
  let generated = 0;
  let reused = 0;
  let failed = 0;

  for (const [community, members] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const hash = clusterContentHash(members, baseEdges);
    const memberIds = members.map(nodeId).sort();
    const cachePath = path.join(cacheRoot, `${hash}.json`);
    let record = cacheRecord(cachePath, hash, community, memberIds);
    if (record) {
      reused += 1;
    } else {
      const result = await dispatch(summaryPacket(community, members, baseEdges), {
        backend,
        readOnly: true,
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      const summary = result.ok ? summaryText(result.output) : "";
      if (!summary) {
        failed += 1;
        const detail = result?.raw?.error || result?.raw?.stderr || "workforce returned no summary";
        onWarning(`community ${community} summary skipped: ${String(detail).trim()}`);
        continue;
      }
      record = {
        version: 1,
        hash,
        community,
        member_ids: memberIds,
        summary,
        generated_at: new Date().toISOString(),
      };
      writeFileSync(cachePath, `${JSON.stringify(record, null, 2)}\n`);
      generated += 1;
    }
    addSummary(graph, collections, { community, hash, memberIds, summary: record.summary });
  }

  if (generated || reused || previousSummaryIds.size) {
    graph.metadata = {
      ...(graph.metadata && typeof graph.metadata === "object" ? graph.metadata : {}),
      community_summaries: {
        count: generated + reused,
        generated,
        reused,
        cache: "graphify-out/summaries",
      },
    };
    writeFileSync(graphPath, `${JSON.stringify(graph, null, 2)}\n`);
  }
  return {
    skipped: generated + reused === 0,
    reason: generated + reused === 0 ? "workforce-unavailable" : "",
    generated,
    reused,
    failed,
    summaryCount: generated + reused,
  };
}

/** @param {string} question @returns {Set<string>} */
function queryTerms(question) {
  return new Set(String(question || "").toLowerCase().match(/[a-z0-9_./:-]{3,}/g) || []);
}

/** @param {string} text @param {Set<string>} terms @returns {number} */
function lexicalMatch(text, terms) {
  const haystack = String(text || "").toLowerCase();
  let matches = 0;
  for (const term of terms) if (haystack.includes(term)) matches += 1;
  return matches;
}

/**
 * @param {{ graphPath?: string, question?: string, hits?: Array<{ id?: string, node_id?: string }>, traversalOutput?: string }} [options]
 */
export function communitySummaryBlock({ graphPath, question = "", hits = [], traversalOutput = "" } = {}) {
  if (!graphPath || !existsSync(graphPath)) return "";
  const graph = readJson(graphPath);
  const { nodes, edges } = graphCollections(graph);
  const summaries = nodes.filter(isSummaryNode);
  if (!summaries.length) return "";

  const nodesById = new Map(nodes.map((node) => [nodeId(node), node]));
  const hitIds = new Set((hits || []).map((hit) => String(hit?.id ?? hit?.node_id ?? "")).filter(Boolean));
  const terms = queryTerms(question);
  const output = String(traversalOutput || "").toLowerCase();
  /** @type {Array<{ community: string, summary: string, memberLabels: string[], score: number }>} */
  const selected = [];

  for (const summaryNode of summaries) {
    const summaryId = nodeId(summaryNode);
    const memberIds = edges
      .filter((edge) => edgeSource(edge) === summaryId && edgeRelation(edge) === SUMMARY_RELATION)
      .map(edgeTarget);
    const members = memberIds.map((id) => nodesById.get(id)).filter(isGraphRecord);
    const traversalMatched = memberIds.some((id) => {
      const member = nodesById.get(id);
      const label = String(nodeValue(member, "label") ?? "").toLowerCase();
      return output.includes(id.toLowerCase()) || (label.length >= 3 && output.includes(label));
    });
    const semanticMatched = hitIds.has(summaryId) || memberIds.some((id) => hitIds.has(id));
    const lexicalScore = lexicalMatch([
      nodeValue(summaryNode, "summary"),
      ...members.flatMap((node) => [nodeValue(node, "label"), nodeValue(node, "source_snippet")]),
    ].join(" "), terms);
    if (!semanticMatched && !traversalMatched && lexicalScore === 0) continue;
    selected.push({
      community: communityId(summaryNode),
      summary: String(nodeValue(summaryNode, "summary") ?? nodeValue(summaryNode, "source_snippet") ?? "").trim(),
      memberLabels: members.map((node) => String(nodeValue(node, "label") ?? nodeId(node))).slice(0, 8),
      score: Number(semanticMatched) * 100 + Number(traversalMatched) * 10 + lexicalScore,
    });
  }
  selected.sort((left, right) => right.score - left.score || left.community.localeCompare(right.community));
  if (!selected.length) return "";

  return [
    "## Community summaries (map-level context)",
    ...selected.flatMap((entry) => [
      `### Community ${entry.community}`,
      entry.summary,
      entry.memberLabels.length ? `Members: ${entry.memberLabels.join(", ")}` : "",
    ].filter(Boolean)),
  ].join("\n");
}

export const enrichGraphWithCommunitySummaries = generateCommunitySummaries;

/** @param {{ fixtureRoot: string, assert: (condition: unknown, message: string) => void }} options */
export async function selftestCommunitySummaries({ fixtureRoot, assert: assertResult }) {
  const summaryRoot = path.join(fixtureRoot, "summary-fixture", "graphify-out");
  const graphPath = path.join(summaryRoot, "graph.json");
  mkdirSync(summaryRoot, { recursive: true });
  writeFileSync(graphPath, `${JSON.stringify({
    nodes: [
      { id: "auth-session", label: "Auth session", community: 7, source_snippet: "Creates authenticated sessions." },
      { id: "auth-cookie", label: "Auth cookie", community: 7, source_snippet: "Persists the session cookie." },
      { id: "invoice-total", label: "Invoice total", community: 9, source_snippet: "Calculates an invoice total." },
    ],
    edges: [{ source: "auth-session", target: "auth-cookie", relation: "writes" }],
  })}\n`);
  let dispatches = 0;
  const backend = {
    /** @param {SummaryPacket} packet */
    async execute(packet) {
      dispatches += 1;
      return { ok: true, output: `Map context for community ${packet.community}.`, retryable: false };
    },
  };

  const nonSemantic = await generateCommunitySummaries({ graphPath, semantic: false, backend });
  assertResult(nonSemantic.reason === "semantic-disabled" && dispatches === 0, "non-semantic refresh must fully skip community summaries");
  assertResult(!existsSync(path.join(summaryRoot, "summaries")), "non-semantic refresh must not create a summary cache");

  const first = await generateCommunitySummaries({ graphPath, semantic: true, backend });
  assertResult(first.generated === 2 && first.reused === 0 && dispatches === 2, "semantic refresh should generate one summary per community");
  const graph = readJson(graphPath);
  const graphParts = graphCollections(graph);
  assertResult(graphParts.nodes.filter((node) => node.type === SUMMARY_KIND).length === 2, "community summaries must be persisted as graph nodes");
  assertResult(graphParts.edges.filter((edge) => edge.relation === SUMMARY_RELATION).length === 3, "summary nodes must connect to every member with rationale_for edges");
  assertResult(readdirSync(path.join(summaryRoot, "summaries")).filter((file) => file.endsWith(".json")).length === 2, "community summaries must cache by cluster content hash");

  const second = await generateCommunitySummaries({ graphPath, semantic: true, backend });
  assertResult(second.generated === 0 && second.reused === 2 && dispatches === 2, "unchanged communities must reuse cached summaries without workforce dispatch");
  const block = communitySummaryBlock({
    graphPath,
    question: "How is auth persisted?",
    hits: [{ id: "auth-cookie" }],
    traversalOutput: "auth-cookie writes session state",
  });
  assertResult(block.startsWith("## Community summaries"), "query context must start with the map-level community block");
  assertResult(block.includes("Map context for community 7."), "query context must include the matching community summary");
  assertResult(!block.includes("Map context for community 9."), "query context must exclude unrelated community summaries");

  const failedRoot = path.join(fixtureRoot, "failed-summary-fixture", "graphify-out");
  const failedGraphPath = path.join(failedRoot, "graph.json");
  mkdirSync(failedRoot, { recursive: true });
  writeFileSync(failedGraphPath, `${JSON.stringify({
    nodes: [{ id: "local-only", label: "Local only", community: 1 }],
    edges: [],
  })}\n`);
  /** @type {string[]} */
  const warnings = [];
  const failed = await generateCommunitySummaries({
    graphPath: failedGraphPath,
    semantic: true,
    backend: { execute: async () => ({ ok: false, retryable: false, raw: { error: "no configured key" } }) },
    onWarning: (warning) => { warnings.push(warning); },
  });
  assertResult(failed.summaryCount === 0 && warnings.length === 1, "unavailable/no-key workforce must skip with one warning");
}
