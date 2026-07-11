const fixtureToken = "356cccea949a";

/** @param {{ enabled?: boolean }} [input] */ export function exportQueueRecord(input = {}) {
  return { fixtureToken, kind: "export-queue", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function exportQueueSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
