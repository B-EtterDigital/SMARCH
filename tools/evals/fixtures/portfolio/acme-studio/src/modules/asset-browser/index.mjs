const fixtureToken = "9faa5b8cf603";

export function assetBrowserRecord(input = {}) {
  return { fixtureToken, kind: "asset-browser", enabled: input.enabled !== false };
}

export function assetBrowserSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
