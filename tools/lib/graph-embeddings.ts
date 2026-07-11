import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const NO_LOCAL_EMBEDDER_WARNING = "WARN no local embedder available; using substring ranking";
const OLLAMA_URL = "http://127.0.0.1:11434/api/embeddings";
const OLLAMA_MODEL = "nomic-embed-text";
const TRANSFORMERS_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_TOP_K = 50;

type GraphNode = Record<string, unknown>;
type Graph = Record<string, unknown> & { nodes?: GraphNode[]; elements?: { nodes?: GraphNode[] } };
type Embedder = { backend: string; model: string; embed(texts: string[]): Promise<number[][]> };
type TensorLike = { tolist?: () => unknown; data?: Iterable<unknown> | ArrayLike<unknown> };
type TransformerModule = {
  pipeline?: (task: string, model: string) => Promise<(text: string, options: { pooling: string; normalize: boolean }) => Promise<unknown>>;
  default?: TransformerModule;
};
type EmbedderOptions = {
  embedder?: Embedder;
  backend?: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  importTransformers?: () => Promise<TransformerModule>;
};
type IndexPaths = { root: string; vectorsPath: string; idsPath: string; metaPath: string };
type EmbeddingMeta = { graphContentHash: string; dims: number; backend: string; [key: string]: unknown };
type EmbeddingIndex = { meta: EmbeddingMeta; ids: string[]; buffer: Buffer };
type LexicalHit = { id: string; label: string; lexicalScore: number; index: number };
type SemanticHit = { id: string; semanticScore: number };
type RankedHit = { id: string; label: string; lexicalScore: number; semanticScore: number; score: number };
type SemanticQueryResult = { usedSemantic: boolean; hits: Array<LexicalHit | RankedHit>; expandedQuestion: string; reason?: string };
type AssertResult = (condition: unknown, message: string) => void;

function graphNodes(graph: Graph): GraphNode[] {
  const nodes = graph?.nodes ?? graph?.elements?.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function graphNodeContentHash(graph: Graph): string {
  const canonicalNodes = graphNodes(graph)
    .map((node) => JSON.stringify(canonicalize(node)))
    .sort();
  return createHash("sha256").update(JSON.stringify(canonicalNodes)).digest("hex");
}

function nodeId(node: GraphNode): string {
  return String(node?.id ?? "").trim();
}

function nodeLabel(node: GraphNode): string {
  return String(node?.label ?? node?.name ?? nodeId(node)).trim();
}

function sourceSnippet(node: GraphNode): string {
  const candidate = [
    node?.source_snippet,
    node?.snippet,
    node?.code,
    node?.source,
    node?.description,
    node?.text,
    node?.content,
  ].find((value) => typeof value === "string" && value.trim());
  return String(candidate ?? "").replace(/\s+/g, " ").trim().slice(0, 256);
}

export function embeddingTextForNode(node: GraphNode): string {
  const label = nodeLabel(node);
  const snippet = sourceSnippet(node);
  return snippet ? `${label}\n${snippet}` : label;
}

function normalizeVector(values: Iterable<unknown> | ArrayLike<unknown> | null | undefined): number[] {
  const vector = Array.from(values ?? [], Number);
  if (!vector.length || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("local embedder returned an invalid vector");
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude > 0 ? vector.map((value) => value / magnitude) : vector;
}

function normalizeBatch(vectors: unknown, expectedCount: number): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new Error(`local embedder returned ${Array.isArray(vectors) ? vectors.length : 0} vectors for ${expectedCount} inputs`);
  }
  const normalized = vectors.map(normalizeVector);
  const dims = normalized[0]?.length ?? 0;
  if (!dims || normalized.some((vector) => vector.length !== dims)) {
    throw new Error("local embedder returned inconsistent vector dimensions");
  }
  return normalized;
}

async function ollamaEmbedding(prompt: string, fetchImpl: typeof globalThis.fetch, timeoutMs: number): Promise<number[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(OLLAMA_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`ollama embeddings returned HTTP ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body?.embedding)) throw new Error("ollama embeddings response has no vector");
    return body.embedding;
  } finally {
    clearTimeout(timer);
  }
}

async function createOllamaEmbedder({ fetchImpl = globalThis.fetch, timeoutMs = 2_000 }: EmbedderOptions = {}): Promise<Embedder> {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  await ollamaEmbedding("local embedder probe", fetchImpl, timeoutMs);
  return {
    backend: "ollama",
    model: OLLAMA_MODEL,
    async embed(texts: string[]) {
      const vectors: number[][] = [];
      for (const text of texts) vectors.push(await ollamaEmbedding(text, fetchImpl, timeoutMs));
      return normalizeBatch(vectors, texts.length);
    },
  };
}

function tensorVector(output: unknown): number[] {
  if (isRecord(output) && typeof (output as TensorLike).tolist === "function") {
    const listed = (output as TensorLike).tolist?.();
    const vector = Array.isArray(listed) && Array.isArray(listed[0]) ? listed[0] : listed;
    return normalizeVector(Array.isArray(vector) ? vector : []);
  }
  if (isRecord(output) && (output as TensorLike).data) return normalizeVector((output as TensorLike).data);
  if (Array.isArray(output)) return normalizeVector(Array.isArray(output[0]) ? output[0] : output);
  throw new Error("transformers embedder returned an unsupported tensor");
}

async function createTransformersEmbedder(importTransformers?: () => Promise<TransformerModule>): Promise<Embedder> {
  const packageName = "@xenova/transformers";
  const loadTransformers = importTransformers ?? (() => import(packageName));
  const transformers = await loadTransformers();
  const createPipeline = transformers?.pipeline ?? transformers?.default?.pipeline;
  if (typeof createPipeline !== "function") throw new Error("@xenova/transformers has no pipeline export");
  const extractor = await createPipeline("feature-extraction", TRANSFORMERS_MODEL);
  return {
    backend: "transformers",
    model: "all-MiniLM-L6-v2",
    async embed(texts: string[]) {
      const vectors: number[][] = [];
      for (const text of texts) {
        const output = await extractor(text, { pooling: "mean", normalize: true });
        vectors.push(tensorVector(output));
      }
      return normalizeBatch(vectors, texts.length);
    },
  };
}

export async function resolveLocalEmbedder(options: EmbedderOptions = {}): Promise<Embedder | null> {
  if (options.embedder) return options.embedder;
  const requiredBackend = options.backend ?? null;
  if (!requiredBackend || requiredBackend === "ollama") {
    try {
      return await createOllamaEmbedder(options);
    } catch (error) {
      console.error('[graph-embeddings] ollama embedder unavailable', { backend: 'ollama', error });
      if (requiredBackend === "ollama") return null;
    }
  }
  if (!requiredBackend || requiredBackend === "transformers") {
    try {
      return await createTransformersEmbedder(options.importTransformers);
    } catch (error) {
      console.error('[graph-embeddings] transformers embedder unavailable', { backend: 'transformers', error });
      return null;
    }
  }
  return null;
}

function indexPaths(graphPath: string): IndexPaths {
  const root = path.join(path.dirname(path.resolve(graphPath)), "embeddings");
  return {
    root,
    vectorsPath: path.join(root, "vectors.bin"),
    idsPath: path.join(root, "ids.jsonl"),
    metaPath: path.join(root, "meta.json"),
  };
}

function vectorBuffer(vectors: number[][], dims: number): Buffer {
  const buffer = Buffer.allocUnsafe(vectors.length * dims * Float32Array.BYTES_PER_ELEMENT);
  let offset = 0;
  for (const vector of vectors) {
    for (const value of vector) {
      buffer.writeFloatLE(value, offset);
      offset += Float32Array.BYTES_PER_ELEMENT;
    }
  }
  return buffer;
}

export async function buildEmbeddingIndex({ graphPath, embedder = undefined, onWarning = console.warn, ...embedderOptions }: { graphPath: string; embedder?: Embedder; onWarning?: (warning: string) => void } & EmbedderOptions) {
  const absoluteGraphPath = path.resolve(graphPath);
  const graph = JSON.parse(readFileSync(absoluteGraphPath, "utf8"));
  const nodes = graphNodes(graph).filter((node) => nodeId(node));
  const localEmbedder = await resolveLocalEmbedder({ embedder, ...embedderOptions });
  if (!localEmbedder) {
    onWarning(NO_LOCAL_EMBEDDER_WARNING);
    return { built: false, reason: "no-local-embedder" };
  }
  if (!nodes.length) throw new Error(`cannot build embedding index for empty graph: ${absoluteGraphPath}`);

  const vectors = normalizeBatch(
    await localEmbedder.embed(nodes.map(embeddingTextForNode)),
    nodes.length,
  );
  const dims = vectors[0].length;
  const paths = indexPaths(absoluteGraphPath);
  const meta = {
    dims,
    backend: localEmbedder.backend,
    model: localEmbedder.model,
    count: nodes.length,
    graphContentHash: graphNodeContentHash(graph),
    builtAt: new Date().toISOString(),
  };

  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.vectorsPath, vectorBuffer(vectors, dims));
  writeFileSync(paths.idsPath, `${nodes.map((node) => JSON.stringify({ id: nodeId(node) })).join("\n")}\n`);
  writeFileSync(paths.metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return { built: true, ...meta, ...paths };
}

function readEmbeddingIndex(graphPath: string, graph: Graph): EmbeddingIndex | null {
  const paths = indexPaths(graphPath);
  if (![paths.vectorsPath, paths.idsPath, paths.metaPath].every(existsSync)) return null;
  const meta = JSON.parse(readFileSync(paths.metaPath, "utf8"));
  if (meta.graphContentHash !== graphNodeContentHash(graph)) return null;
  const ids = readFileSync(paths.idsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
    const value = JSON.parse(line);
    return String(value?.id ?? value);
  });
  const buffer = readFileSync(paths.vectorsPath);
  const dims = Number(meta.dims);
  if (!Number.isInteger(dims) || dims <= 0 || buffer.length !== ids.length * dims * 4) return null;
  return { meta, ids, buffer };
}

function cosineRows(index: EmbeddingIndex, queryVector: number[], topK: number, allowedNodeIds: Set<string> | null = null): SemanticHit[] {
  const dims = index.meta.dims;
  if (queryVector.length !== dims) throw new Error(`embedding dimensions changed: index=${dims}, query=${queryVector.length}`);
  const scored: SemanticHit[] = [];
  for (let row = 0; row < index.ids.length; row += 1) {
    if (allowedNodeIds && !allowedNodeIds.has(index.ids[row])) continue;
    let score = 0;
    const offset = row * dims * 4;
    for (let col = 0; col < dims; col += 1) score += index.buffer.readFloatLE(offset + col * 4) * queryVector[col];
    scored.push({ id: index.ids[row], semanticScore: score });
  }
  return scored.sort((left, right) => right.semanticScore - left.semanticScore || left.id.localeCompare(right.id)).slice(0, topK);
}

function searchTokens(value: unknown): string[] {
  return String(value ?? "").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

export function substringIdfHits(graph: Graph, question: string): LexicalHit[] {
  const nodes = graphNodes(graph).filter((node) => nodeId(node));
  const terms = [...new Set(searchTokens(question))];
  if (!terms.length) return [];
  const documents = nodes.map((node) => `${nodeLabel(node)} ${nodeId(node)} ${node?.source_file ?? ""}`.toLowerCase());
  const idf = new Map(terms.map((term) => {
    const matches = documents.reduce((count, document) => count + Number(document.includes(term)), 0);
    return [term, Math.log((nodes.length + 1) / (matches + 1)) + 1];
  }));
  return nodes.map((node, index) => {
    const label = nodeLabel(node).toLowerCase();
    const id = nodeId(node).toLowerCase();
    const source = String(node?.source_file ?? "").toLowerCase();
    let lexicalScore = 0;
    for (const term of terms) {
      const weight = idf.get(term) ?? 1;
      if (term === label || term === id) lexicalScore += 100 * weight;
      else if (label.startsWith(term) || id.startsWith(term)) lexicalScore += 10 * weight;
      else if (label.includes(term) || id.includes(term)) lexicalScore += weight;
      if (source.includes(term)) lexicalScore += 0.5 * weight;
    }
    return { id: nodeId(node), label: nodeLabel(node), lexicalScore, index };
  }).filter((hit) => hit.lexicalScore > 0)
    .sort((left, right) => right.lexicalScore - left.lexicalScore || left.label.length - right.label.length || left.id.localeCompare(right.id));
}

function reciprocalRankMerge(nodesById: Map<string, { id: string; label: string }>, lexical: LexicalHit[], semantic: SemanticHit[], limit: number): RankedHit[] {
  const merged = new Map<string, RankedHit>();
  const add = (hit: LexicalHit | SemanticHit, rank: number, field: 'lexicalScore' | 'semanticScore') => {
    const prior = merged.get(hit.id) ?? { id: hit.id, label: nodesById.get(hit.id)?.label ?? hit.id, lexicalScore: 0, semanticScore: -1, score: 0 };
    if (field === 'lexicalScore' && 'lexicalScore' in hit) prior.lexicalScore = hit.lexicalScore;
    if (field === 'semanticScore' && 'semanticScore' in hit) prior.semanticScore = hit.semanticScore;
    prior.score += 1 / (60 + rank + 1);
    merged.set(hit.id, prior);
  };
  lexical.forEach((hit, rank) => add(hit, rank, "lexicalScore"));
  semantic.forEach((hit, rank) => add(hit, rank, "semanticScore"));
  return [...merged.values()].sort((left, right) => right.score - left.score
    || right.semanticScore - left.semanticScore
    || right.lexicalScore - left.lexicalScore
    || left.id.localeCompare(right.id)).slice(0, limit);
}

export async function semanticRerankQuery({ graphPath, question, embedder = undefined, topK = DEFAULT_TOP_K, allowedNodeIds = undefined, onWarning = console.warn, ...embedderOptions }: { graphPath: string; question: string; embedder?: Embedder; topK?: number; allowedNodeIds?: Iterable<string>; onWarning?: (warning: string) => void } & EmbedderOptions): Promise<SemanticQueryResult> {
  const absoluteGraphPath = path.resolve(graphPath);
  const graph = JSON.parse(readFileSync(absoluteGraphPath, "utf8"));
  const allowed = allowedNodeIds ? new Set([...allowedNodeIds].map(String)) : null;
  const lexicalHits = substringIdfHits(graph, question).filter((hit) => !allowed || allowed.has(hit.id));
  const index = readEmbeddingIndex(absoluteGraphPath, graph);
  if (!index) return { usedSemantic: false, hits: lexicalHits, expandedQuestion: question };

  const localEmbedder = await resolveLocalEmbedder({ embedder, backend: index.meta.backend, ...embedderOptions });
  if (!localEmbedder) {
    onWarning(NO_LOCAL_EMBEDDER_WARNING);
    return { usedSemantic: false, hits: lexicalHits, expandedQuestion: question, reason: "no-local-embedder" };
  }
  const [queryVector] = normalizeBatch(await localEmbedder.embed([question]), 1);
  const semanticHits = cosineRows(index, queryVector, topK, allowed);
  const nodesById = new Map(graphNodes(graph)
    .filter((node) => !allowed || allowed.has(nodeId(node)))
    .map((node) => [nodeId(node), { id: nodeId(node), label: nodeLabel(node) }]));
  const hits = reciprocalRankMerge(nodesById, lexicalHits, semanticHits, topK);
  const seedLabels = hits.slice(0, 3).map((hit) => hit.label).filter(Boolean);
  return {
    usedSemantic: true,
    hits,
    expandedQuestion: seedLabels.length ? `${question} ${seedLabels.join(" ")}` : question,
  };
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

export function createDeterministicHashEmbedder({ dims = 32, aliases = {} }: { dims?: number; aliases?: Record<string, string> } = {}): Embedder {
  assertLocaleStableSelftest();
  return {
    backend: "stub",
    model: "deterministic-hash-v1",
    async embed(texts: string[]) {
      return texts.map((text) => {
        const vector = Array(dims).fill(0);
        for (const rawToken of searchTokens(text)) {
          const token = aliases[rawToken] ?? rawToken;
          if (!token) continue;
          const hash = hashString(token);
          vector[hash % dims] += (hash & 1) ? 1 : -1;
        }
        return normalizeVector(vector);
      });
    },
  };
}

export async function selftestEmbeddingContentAddress({ fixtureRoot, assert: assertResult }: { fixtureRoot: string; assert: AssertResult }): Promise<void> {
  const graphRoot = path.join(fixtureRoot, "embedding-fixture", "graphify-out");
  const graphPath = path.join(graphRoot, "graph.json");
  mkdirSync(graphRoot, { recursive: true });
  writeFileSync(graphPath, `${JSON.stringify({
    nodes: [
      { id: "session-signin", label: "session-signin", source_snippet: "Establishes a user session." },
      { id: "invoice-total", label: "invoice-total", source_snippet: "Calculates billing totals." },
    ],
    edges: [],
  })}\n`);
  const embedder = createDeterministicHashEmbedder({ aliases: { auth: "session", login: "signin", flow: "" } });
  const built = await buildEmbeddingIndex({ graphPath, embedder });
  assertResult(built.built && "count" in built && built.count === 2, "stub embedding index should build without a model");
  assertResult("graphContentHash" in built && /^[a-f0-9]{64}$/.test(built.graphContentHash), "embedding metadata must use a SHA-256 graph content hash");
  assertResult(substringIdfHits(JSON.parse(readFileSync(graphPath, "utf8")), "auth login flow").length === 0, "synonym fixture must miss substring ranking");
  const semantic = await semanticRerankQuery({ graphPath, question: "auth login flow", embedder });
  assertResult(semantic.usedSemantic && semantic.hits[0]?.id === "session-signin", "semantic rerank should find the synonym node");
  assertResult(semantic.expandedQuestion.includes("session-signin"), "semantic seed should feed the existing traversal query");

  const originalMtime = statSync(graphPath).mtime;
  const graph = JSON.parse(readFileSync(graphPath, "utf8"));
  writeFileSync(graphPath, `${JSON.stringify({ ...graph, nodes: [...graph.nodes].reverse() })}\n`);
  utimesSync(graphPath, originalMtime, originalMtime);
  const reordered = await semanticRerankQuery({ graphPath, question: "auth login flow", embedder });
  assertResult(reordered.usedSemantic, "canonical graph hashing must ignore node order changes");

  const changed = JSON.parse(readFileSync(graphPath, "utf8"));
  changed.nodes[0].source_snippet = "Graph content changed without changing its filesystem timestamp.";
  writeFileSync(graphPath, `${JSON.stringify(changed)}\n`);
  utimesSync(graphPath, originalMtime, originalMtime);
  const stale = await semanticRerankQuery({ graphPath, question: "auth login flow", embedder });
  assertResult(!stale.usedSemantic, "content changes with an unchanged graph mtime must invalidate the embedding index");

  const warnings: string[] = [];
  const missing = await buildEmbeddingIndex({ graphPath, backend: "unavailable-fixture", onWarning: (warning) => warnings.push(warning) });
  assertResult(!missing.built && warnings.length === 1, "missing local embedder should warn exactly once and skip");
}

let localeStableSelftestComplete = false;

function assertLocaleStableSelftest(): void {
  if (localeStableSelftestComplete
    || process.argv[2] !== "selftest"
    || process.env.SMA_GRAPH_EMBEDDINGS_LOCALE_PROBE === "1") return;
  localeStableSelftestComplete = true;

  const probe = `
    import { createDeterministicHashEmbedder } from ${JSON.stringify(import.meta.url)};
    const embedder = createDeterministicHashEmbedder();
    process.stdout.write(JSON.stringify(await embedder.embed(["Iİ"])));
  `;
  const outputs = ["C", "tr_TR.UTF-8"].map((locale) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", probe], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: locale, SMA_GRAPH_EMBEDDINGS_LOCALE_PROBE: "1" },
    });
    if (result.status !== 0) {
      throw new Error(`stub embedder locale selftest failed under LC_ALL=${locale}: ${result.stderr.trim()}`);
    }
    return result.stdout;
  });
  if (outputs[0] !== outputs[1]) {
    throw new Error("stub embedder tokenization changed across LC_ALL variants");
  }
}
