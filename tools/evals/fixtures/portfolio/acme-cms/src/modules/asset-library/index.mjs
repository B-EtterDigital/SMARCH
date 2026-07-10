const fixtureToken = "c7df058e78dd";

export function assetLibraryRecord(input = {}) {
  return { fixtureToken, kind: "asset-library", enabled: input.enabled !== false };
}

export function assetLibrarySummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
