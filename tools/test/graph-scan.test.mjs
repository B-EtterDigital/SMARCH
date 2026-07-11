import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDeterministicHashEmbedder,
  embeddingTextForNode,
  graphNodeContentHash,
  selftestEmbeddingContentAddress,
  substringIdfHits,
} from "../lib/graph-embeddings.ts";
import {
  graphEdges,
  graphHyperedges,
  graphNodes,
  mergeNamespacedGraphs,
  namespaceGraph,
  resolveGraphNodeInput,
} from "../lib/graph-union.ts";
import { walk } from "../lib/scan-walk.ts";

test("graph embedding ranking is deterministic, content-addressed, and semantically useful", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-graph-ranking-"));
  try {
    const graph = {
      nodes: [
        { id: "auth", label: "Session Login", description: "Authenticate account sessions" },
        { id: "billing", label: "Invoice Totals", source_snippet: "Calculate money and tax" },
      ],
    };
    assert.equal(graphNodeContentHash(graph), graphNodeContentHash({ nodes: [...graph.nodes].reverse() }));
    assert.notEqual(graphNodeContentHash(graph), graphNodeContentHash({ nodes: [{ ...graph.nodes[0], description: "changed" }, graph.nodes[1]] }));
    assert.match(embeddingTextForNode(graph.nodes[0]), /Session Login[\s\S]*Authenticate account sessions/);
    assert.equal(substringIdfHits(graph, "invoice tax")[0].id, "billing");

    const embedder = createDeterministicHashEmbedder({ dims: 8, aliases: { login: "session" } });
    const [login, session] = await embedder.embed(["login", "session"]);
    assert.deepEqual(login, session);
    assert.equal(login.length, 8);
    assert.ok(Math.abs(Math.hypot(...login) - 1) < 1e-12);

    let assertions = 0;
    await selftestEmbeddingContentAddress({ fixtureRoot: root, assert(condition, message) {
      assertions += 1;
      assert.ok(condition, message);
    } });
    assert.ok(assertions >= 6, `expected the content-address selftest to prove multiple behaviors, got ${assertions}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("graph union namespaces identities, deduplicates edges, preserves metadata, and rejects ambiguous aliases", () => {
  const source = {
    title: "alpha graph",
    input_tokens: 4,
    output_tokens: 2,
    elements: {
      nodes: [{ id: "shared", label: "Shared" }, { id: "leaf", original_id: "legacy-leaf" }, { label: "invalid" }],
      edges: [{ source: "shared", target: "leaf", relation: "calls" }, { source: "", target: "leaf" }],
    },
    hyperedges: [{ id: "flow", nodes: ["shared", "external"] }],
  };
  assert.equal(graphNodes(source).length, 3);
  assert.equal(graphEdges(source).length, 2);
  assert.equal(graphHyperedges(source).length, 1);
  assert.throws(() => namespaceGraph(source, " "), /namespace must not be empty/);

  const namespaced = namespaceGraph(source, "alpha");
  assert.equal(namespaced.title, "alpha graph");
  assert.deepEqual(namespaced.nodes.map((node) => node.id), ["alpha::shared", "alpha::leaf"]);
  assert.deepEqual(namespaced.edges[0], { source: "alpha::shared", target: "alpha::leaf", relation: "calls" });
  assert.deepEqual(namespaced.hyperedges[0].nodes, ["alpha::shared", "alpha::external"]);

  const merged = mergeNamespacedGraphs([
    { namespace: "alpha", graph: source },
    { namespace: "beta", graph: { ...source, input_tokens: 3, output_tokens: 1 } },
    { namespace: "alpha", graph: source },
  ]);
  assert.equal(merged.nodes.length, 4);
  assert.equal(merged.edges.length, 2);
  assert.equal(merged.hyperedges.length, 2);
  assert.equal(merged.inputTokens, 11);
  assert.equal(merged.outputTokens, 5);
  assert.equal(resolveGraphNodeInput(merged, "alpha::leaf"), "alpha::leaf");
  assert.throws(() => resolveGraphNodeInput(merged, "legacy-leaf"), /ambiguous.*alpha::leaf, beta::leaf/);
  assert.throws(() => resolveGraphNodeInput(merged, "shared"), /ambiguous.*alpha::shared, beta::shared/);
  assert.equal(resolveGraphNodeInput(merged, "unknown"), "unknown");
  assert.equal(resolveGraphNodeInput(merged, ""), "");
});

test("scan walk finds only manifests while honoring directory and path exclusions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-scan-walk-"));
  try {
    await mkdir(path.join(root, "keep", "nested"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "ignored"), { recursive: true });
    await mkdir(path.join(root, "skip-path"), { recursive: true });
    await Promise.all([
      writeFile(path.join(root, "module.sweetspot.json"), "{}"),
      writeFile(path.join(root, "keep", "feature.module.sweetspot.json"), "{}"),
      writeFile(path.join(root, "keep", "nested", "not-a-manifest.json"), "{}"),
      writeFile(path.join(root, "node_modules", "ignored", "module.sweetspot.json"), "{}"),
      writeFile(path.join(root, "skip-path", "module.sweetspot.json"), "{}"),
    ]);
    const results = await walk(root, {
      isExcludedDirName: (name) => name === "node_modules",
      isExcludedPath: (candidate) => candidate.includes("skip-path"),
    });
    assert.deepEqual(results.map((file) => path.relative(root, file)).sort(), ["keep/feature.module.sweetspot.json", "module.sweetspot.json"]);
    await assert.rejects(() => walk(path.join(root, "missing")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
