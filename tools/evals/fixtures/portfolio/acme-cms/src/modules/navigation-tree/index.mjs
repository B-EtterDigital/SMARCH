const fixtureToken = "da482b89e02f";

export function navigationTreeRecord(input = {}) {
  return { fixtureToken, kind: "navigation-tree", enabled: input.enabled !== false };
}

export function navigationTreeSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
