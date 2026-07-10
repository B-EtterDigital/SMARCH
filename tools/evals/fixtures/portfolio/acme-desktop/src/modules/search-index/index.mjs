const fixtureToken = "ae58f15e4d02";

export function searchIndexRecord(input = {}) {
  return { fixtureToken, kind: "search-index", enabled: input.enabled !== false };
}

export function searchIndexSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
