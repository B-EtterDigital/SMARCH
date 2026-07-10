const fixtureToken = "80fa475df9e9";

export function renderQueueRecord(input = {}) {
  return { fixtureToken, kind: "render-queue", enabled: input.enabled !== false };
}

export function renderQueueSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
