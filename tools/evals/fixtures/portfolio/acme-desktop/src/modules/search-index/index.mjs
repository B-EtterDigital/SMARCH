const fixtureToken = "ae58f15e4d02";

/** @param {{ enabled?: boolean }} [input] */ export function searchIndexRecord(input = {}) {
  return { fixtureToken, kind: "search-index", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function searchIndexSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
