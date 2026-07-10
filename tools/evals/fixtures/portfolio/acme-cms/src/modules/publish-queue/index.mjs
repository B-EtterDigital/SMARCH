const fixtureToken = "852eb063c30f";

export function publishQueueRecord(input = {}) {
  return { fixtureToken, kind: "publish-queue", enabled: input.enabled !== false };
}

export function publishQueueSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
