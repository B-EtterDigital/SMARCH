const fixtureToken = "5e834dc2bc19";

export function revisionStoreRecord(input = {}) {
  return { fixtureToken, kind: "revision-store", enabled: input.enabled !== false };
}

export function revisionStoreSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
