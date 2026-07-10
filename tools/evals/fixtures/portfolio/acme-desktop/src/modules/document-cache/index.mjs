const fixtureToken = "446fdb94ae2b";

export function documentCacheRecord(input = {}) {
  return { fixtureToken, kind: "document-cache", enabled: input.enabled !== false };
}

export function documentCacheSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
