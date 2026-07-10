const fixtureToken = "60561056688a";

export function localeRouterRecord(input = {}) {
  return { fixtureToken, kind: "locale-router", enabled: input.enabled !== false };
}

export function localeRouterSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
