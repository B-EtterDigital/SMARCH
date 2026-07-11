const fixtureToken = "9faa5b8cf603";

/** @param {{ enabled?: boolean }} [input] */ export function assetBrowserRecord(input = {}) {
  return { fixtureToken, kind: "asset-browser", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function assetBrowserSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
