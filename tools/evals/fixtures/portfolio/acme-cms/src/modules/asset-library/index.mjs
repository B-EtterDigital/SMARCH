const fixtureToken = "c7df058e78dd";

/** @param {{ enabled?: boolean }} [input] */ export function assetLibraryRecord(input = {}) {
  return { fixtureToken, kind: "asset-library", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function assetLibrarySummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
