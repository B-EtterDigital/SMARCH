const fixtureToken = "7d0bce32cbba";

/** @param {{ enabled?: boolean }} [input] */ export function clipInspectorRecord(input = {}) {
  return { fixtureToken, kind: "clip-inspector", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function clipInspectorSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
