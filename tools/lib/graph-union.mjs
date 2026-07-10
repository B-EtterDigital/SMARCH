const NAMESPACE_SEPARATOR = "::";

function graphArray(value) {
  return Array.isArray(value) ? value : [];
}

export function graphNodes(graph) {
  return graphArray(graph?.nodes ?? graph?.elements?.nodes);
}

export function graphEdges(graph) {
  return graphArray(graph?.edges ?? graph?.links ?? graph?.elements?.edges);
}

export function graphHyperedges(graph) {
  return graphArray(graph?.hyperedges);
}

function namespaceId(namespace, id) {
  return `${namespace}${NAMESPACE_SEPARATOR}${String(id)}`;
}

function edgeKey(edge) {
  return [
    edge.source,
    edge.target,
    edge.relation,
    edge.context,
    edge.source_file,
    edge.source_location,
  ].map((value) => String(value ?? "")).join("\0");
}

function hyperedgeKey(edge) {
  return JSON.stringify(edge);
}

export function namespaceGraph(graph, namespace) {
  const normalizedNamespace = String(namespace || "").trim();
  if (!normalizedNamespace) throw new Error("graph union namespace must not be empty");

  const idMap = new Map();
  const nodes = graphNodes(graph)
    .filter((node) => node?.id)
    .map((node) => {
      const id = String(node.id);
      const namespacedId = namespaceId(normalizedNamespace, id);
      idMap.set(id, namespacedId);
      return {
        ...node,
        id: namespacedId,
        original_id: String(node.original_id ?? id),
      };
    });
  const namespacedReference = (id) => idMap.get(String(id)) ?? namespaceId(normalizedNamespace, id);
  const edges = graphEdges(graph)
    .filter((edge) => edge?.source && edge?.target)
    .map((edge) => ({
      ...edge,
      source: namespacedReference(edge.source),
      target: namespacedReference(edge.target),
    }));
  const hyperedges = graphHyperedges(graph).map((edge) => ({
    ...edge,
    ...(edge?.id ? {
      id: namespaceId(normalizedNamespace, edge.id),
      original_id: String(edge.original_id ?? edge.id),
    } : {}),
    ...(Array.isArray(edge?.nodes) ? { nodes: edge.nodes.map(namespacedReference) } : {}),
  }));
  const {
    nodes: _nodes,
    edges: _edges,
    links: _links,
    hyperedges: _hyperedges,
    elements: _elements,
    ...metadata
  } = graph || {};

  return { ...metadata, nodes, edges, hyperedges };
}

export function mergeNamespacedGraphs(entries) {
  const nodes = new Map();
  const edges = new Map();
  const hyperedges = new Map();
  let inputTokens = 0;
  let outputTokens = 0;

  for (const entry of entries) {
    const graph = namespaceGraph(entry.graph, entry.namespace);
    for (const node of graph.nodes) nodes.set(String(node.id), node);
    for (const edge of graph.edges) edges.set(edgeKey(edge), edge);
    for (const edge of graph.hyperedges) hyperedges.set(hyperedgeKey(edge), edge);
    inputTokens += Number(entry.graph?.input_tokens || 0);
    outputTokens += Number(entry.graph?.output_tokens || 0);
  }

  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    hyperedges: [...hyperedges.values()],
    inputTokens,
    outputTokens,
  };
}

export function resolveGraphNodeInput(graph, input) {
  const requested = String(input || "").trim();
  if (!requested) return requested;
  const nodes = graphNodes(graph);
  const exact = nodes.find((node) => String(node?.id || "") === requested);
  if (exact) return String(exact.id);

  const originalMatches = nodes.filter((node) => String(node?.original_id || "") === requested);
  if (originalMatches.length === 1) return String(originalMatches[0].id);
  if (originalMatches.length > 1) {
    const choices = originalMatches.map((node) => String(node.id)).sort().join(", ");
    throw new Error(`node id "${requested}" is ambiguous; use a namespaced id: ${choices}`);
  }
  return requested;
}
