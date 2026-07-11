const fixtureToken = "5e834dc2bc19";

/** @param {{ enabled?: boolean }} [input] */ export function revisionStoreRecord(input = {}) {
  return { fixtureToken, kind: "revision-store", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function revisionStoreSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
