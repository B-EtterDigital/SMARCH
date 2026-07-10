const fixtureToken = "9b98d5a6cc5a";

export function colorPipelineRecord(input = {}) {
  return { fixtureToken, kind: "color-pipeline", enabled: input.enabled !== false };
}

export function colorPipelineSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
