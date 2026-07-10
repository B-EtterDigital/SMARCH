import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const NO_LOCAL_EMBEDDER_WARNING = "WARN no local embedder available; using substring ranking";
const OLLAMA_URL = "http://127.0.0.1:11434/api/embeddings";
const OLLAMA_MODEL = "nomic-embed-text";
const TRANSFORMERS_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_TOP_K = 50;

function graphNodes(graph) {
  const nodes = graph?.nodes ?? graph?.elements?.nodes;
  return Array.isArray(nodes) ? nodes : [];
}

function nodeId(node) {
  return String(node?.id ?? "").trim();
}

function nodeLabel(node) {
  return String(node?.label ?? node?.name ?? nodeId(node)).trim();
}

function sourceSnippet(node) {
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

export function embeddingTextForNode(node) {
  const label = nodeLabel(node);
  const snippet = sourceSnippet(node);
  return snippet ? `${label}\n${snippet}` : label;
}

function normalizeVector(values) {
  const vector = Array.from(values ?? [], Number);
  if (!vector.length || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("local embedder returned an invalid vector");
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude > 0 ? vector.map((value) => value / magnitude) : vector;
}

function normalizeBatch(vectors, expectedCount) {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount) {
    throw new Error(`local embedder returned ${vectors?.length ?? 0} vectors for ${expectedCount} inputs`);
  }
  const normalized = vectors.map(normalizeVector);
  const dims = normalized[0]?.length ?? 0;
  if (!dims || normalized.some((vector) => vector.length !== dims)) {
    throw new Error("local embedder returned inconsistent vector dimensions");
  }
  return normalized;
}

async function ollamaEmbedding(prompt, fetchImpl, timeoutMs) {
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

async function createOllamaEmbedder({ fetchImpl = globalThis.fetch, timeoutMs = 2_000 } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  await ollamaEmbedding("local embedder probe", fetchImpl, timeoutMs);
  return {
    backend: "ollama",
    model: OLLAMA_MODEL,
    async embed(texts) {
      const vectors = [];
      for (const text of texts) vectors.push(await ollamaEmbedding(text, fetchImpl, timeoutMs));
      return normalizeBatch(vectors, texts.length);
    },
  };
}

function tensorVector(output) {
  if (typeof output?.tolist === "function") {
    const listed = output.tolist();
    return Array.isArray(listed?.[0]) ? listed[0] : listed;
  }
  if (output?.data) return Array.from(output.data);
  if (Array.isArray(output)) return Array.isArray(output[0]) ? output[0] : output;
  throw new Error("transformers embedder returned an unsupported tensor");
}

async function createTransformersEmbedder(importTransformers) {
  const packageName = "@xenova/transformers";
  const loadTransformers = importTransformers ?? (() => import(packageName));
  const transformers = await loadTransformers();
  const createPipeline = transformers?.pipeline ?? transformers?.default?.pipeline;
  if (typeof createPipeline !== "function") throw new Error("@xenova/transformers has no pipeline export");
  const extractor = await createPipeline("feature-extraction", TRANSFORMERS_MODEL);
  return {
    backend: "transformers",
    model: "all-MiniLM-L6-v2",
    async embed(texts) {
      const vectors = [];
      for (const text of texts) {
        const output = await extractor(text, { pooling: "mean", normalize: true });
        vectors.push(tensorVector(output));
      }
      return normalizeBatch(vectors, texts.length);
    },
  };
}

export async function resolveLocalEmbedder(options = {}) {
  if (options.embedder) return options.embedder;
  const requiredBackend = options.backend ?? null;
  if (!requiredBackend || requiredBackend === "ollama") {
    try {
      return await createOllamaEmbedder(options);
    } catch {
      if (requiredBackend === "ollama") return null;
    }
  }
  if (!requiredBackend || requiredBackend === "transformers") {
    try {
      return await createTransformersEmbedder(options.importTransformers);
    } catch {
      return null;
    }
  }
  return null;
}

function indexPaths(graphPath) {
  const root = path.join(path.dirname(path.resolve(graphPath)), "embeddings");
  return {
    root,
    vectorsPath: path.join(root, "vectors.bin"),
    idsPath: path.join(root, "ids.jsonl"),
    metaPath: path.join(root, "meta.json"),
  };
}

function vectorBuffer(vectors, dims) {
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

export async function buildEmbeddingIndex({ graphPath, embedder = undefined, onWarning = console.warn, ...embedderOptions }) {
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
  const graphStat = statSync(absoluteGraphPath);
  const meta = {
    dims,
    backend: localEmbedder.backend,
    model: localEmbedder.model,
    count: nodes.length,
    builtAt: graphStat.mtime.toISOString(),
  };

  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.vectorsPath, vectorBuffer(vectors, dims));
  writeFileSync(paths.idsPath, `${nodes.map((node) => JSON.stringify({ id: nodeId(node) })).join("\n")}\n`);
  writeFileSync(paths.metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return { built: true, ...meta, ...paths };
}

function readEmbeddingIndex(graphPath) {
  const paths = indexPaths(graphPath);
  if (![paths.vectorsPath, paths.idsPath, paths.metaPath].every(existsSync)) return null;
  const meta = JSON.parse(readFileSync(paths.metaPath, "utf8"));
  const graphMtime = statSync(graphPath).mtime.toISOString();
  if (meta.builtAt !== graphMtime) return null;
  const ids = readFileSync(paths.idsPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
    const value = JSON.parse(line);
    return String(value?.id ?? value);
  });
  const buffer = readFileSync(paths.vectorsPath);
  const dims = Number(meta.dims);
  if (!Number.isInteger(dims) || dims <= 0 || buffer.length !== ids.length * dims * 4) return null;
  return { meta, ids, buffer };
}

function cosineRows(index, queryVector, topK) {
  const dims = index.meta.dims;
  if (queryVector.length !== dims) throw new Error(`embedding dimensions changed: index=${dims}, query=${queryVector.length}`);
  const scored = [];
  for (let row = 0; row < index.ids.length; row += 1) {
    let score = 0;
    const offset = row * dims * 4;
    for (let col = 0; col < dims; col += 1) score += index.buffer.readFloatLE(offset + col * 4) * queryVector[col];
    scored.push({ id: index.ids[row], semanticScore: score });
  }
  return scored.sort((left, right) => right.semanticScore - left.semanticScore || left.id.localeCompare(right.id)).slice(0, topK);
}

function searchTokens(value) {
  return String(value ?? "").toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

export function substringIdfHits(graph, question) {
  const nodes = graphNodes(graph).filter((node) => nodeId(node));
  const terms = [...new Set(searchTokens(question))];
  if (!terms.length) return [];
  const documents = nodes.map((node) => `${nodeLabel(node)} ${nodeId(node)} ${node?.source_file ?? ""}`.toLocaleLowerCase());
  const idf = new Map(terms.map((term) => {
    const matches = documents.reduce((count, document) => count + Number(document.includes(term)), 0);
    return [term, Math.log((nodes.length + 1) / (matches + 1)) + 1];
  }));
  return nodes.map((node, index) => {
    const label = nodeLabel(node).toLocaleLowerCase();
    const id = nodeId(node).toLocaleLowerCase();
    const source = String(node?.source_file ?? "").toLocaleLowerCase();
    let lexicalScore = 0;
    for (const term of terms) {
      const weight = idf.get(term);
      if (term === label || term === id) lexicalScore += 100 * weight;
      else if (label.startsWith(term) || id.startsWith(term)) lexicalScore += 10 * weight;
      else if (label.includes(term) || id.includes(term)) lexicalScore += weight;
      if (source.includes(term)) lexicalScore += 0.5 * weight;
    }
    return { id: nodeId(node), label: nodeLabel(node), lexicalScore, index };
  }).filter((hit) => hit.lexicalScore > 0)
    .sort((left, right) => right.lexicalScore - left.lexicalScore || left.label.length - right.label.length || left.id.localeCompare(right.id));
}

function reciprocalRankMerge(nodesById, lexical, semantic, limit) {
  const merged = new Map();
  const add = (hit, rank, field) => {
    const prior = merged.get(hit.id) ?? { id: hit.id, label: nodesById.get(hit.id)?.label ?? hit.id, lexicalScore: 0, semanticScore: -1, score: 0 };
    prior[field] = hit[field];
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

export async function semanticRerankQuery({ graphPath, question, embedder = undefined, topK = DEFAULT_TOP_K, onWarning = console.warn, ...embedderOptions }) {
  const absoluteGraphPath = path.resolve(graphPath);
  const graph = JSON.parse(readFileSync(absoluteGraphPath, "utf8"));
  const lexicalHits = substringIdfHits(graph, question);
  const index = readEmbeddingIndex(absoluteGraphPath);
  if (!index) return { usedSemantic: false, hits: lexicalHits, expandedQuestion: question };

  const localEmbedder = await resolveLocalEmbedder({ embedder, backend: index.meta.backend, ...embedderOptions });
  if (!localEmbedder) {
    onWarning(NO_LOCAL_EMBEDDER_WARNING);
    return { usedSemantic: false, hits: lexicalHits, expandedQuestion: question, reason: "no-local-embedder" };
  }
  const [queryVector] = normalizeBatch(await localEmbedder.embed([question]), 1);
  const semanticHits = cosineRows(index, queryVector, topK);
  const nodesById = new Map(graphNodes(graph).map((node) => [nodeId(node), { id: nodeId(node), label: nodeLabel(node) }]));
  const hits = reciprocalRankMerge(nodesById, lexicalHits, semanticHits, topK);
  const seedLabels = hits.slice(0, 3).map((hit) => hit.label).filter(Boolean);
  return {
    usedSemantic: true,
    hits,
    expandedQuestion: seedLabels.length ? `${question} ${seedLabels.join(" ")}` : question,
  };
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

export function createDeterministicHashEmbedder({ dims = 32, aliases = {} } = {}) {
  return {
    backend: "stub",
    model: "deterministic-hash-v1",
    async embed(texts) {
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
