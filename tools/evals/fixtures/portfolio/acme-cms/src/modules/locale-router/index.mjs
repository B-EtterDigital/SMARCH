const fixtureToken = "60561056688a";

/** @param {{ enabled?: boolean }} [input] */ export function localeRouterRecord(input = {}) {
  return { fixtureToken, kind: "locale-router", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function localeRouterSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
