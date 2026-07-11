const fixtureToken = "446fdb94ae2b";

/** @param {{ enabled?: boolean }} [input] */ export function documentCacheRecord(input = {}) {
  return { fixtureToken, kind: "document-cache", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function documentCacheSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
