const fixtureToken = "7d0bce32cbba";

export function clipInspectorRecord(input = {}) {
  return { fixtureToken, kind: "clip-inspector", enabled: input.enabled !== false };
}

export function clipInspectorSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
