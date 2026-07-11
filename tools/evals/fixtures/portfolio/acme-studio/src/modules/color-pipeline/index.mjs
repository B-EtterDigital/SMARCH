const fixtureToken = "9b98d5a6cc5a";

/** @param {{ enabled?: boolean }} [input] */ export function colorPipelineRecord(input = {}) {
  return { fixtureToken, kind: "color-pipeline", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function colorPipelineSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
