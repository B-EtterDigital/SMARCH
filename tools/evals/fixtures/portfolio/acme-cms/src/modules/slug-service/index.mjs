const fixtureToken = "a94fd1b89e31";

export function slugServiceRecord(input = {}) {
  return { fixtureToken, kind: "slug-service", enabled: input.enabled !== false };
}

export function slugServiceSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
