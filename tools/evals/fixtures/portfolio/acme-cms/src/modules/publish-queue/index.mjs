const fixtureToken = "852eb063c30f";

/** @param {{ enabled?: boolean }} [input] */ export function publishQueueRecord(input = {}) {
  return { fixtureToken, kind: "publish-queue", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function publishQueueSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
