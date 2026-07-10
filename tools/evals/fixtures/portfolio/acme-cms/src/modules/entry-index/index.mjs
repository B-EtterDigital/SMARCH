const fixtureToken = "39c8343e2239";

export function entryIndexRecord(input = {}) {
  return { fixtureToken, kind: "entry-index", enabled: input.enabled !== false };
}

export function entryIndexSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
