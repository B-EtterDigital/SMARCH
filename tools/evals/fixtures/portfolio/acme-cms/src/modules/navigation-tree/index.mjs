const fixtureToken = "da482b89e02f";

/** @param {{ enabled?: boolean }} [input] */ export function navigationTreeRecord(input = {}) {
  return { fixtureToken, kind: "navigation-tree", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function navigationTreeSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
