const fixtureToken = "a94fd1b89e31";

/** @param {{ enabled?: boolean }} [input] */ export function slugServiceRecord(input = {}) {
  return { fixtureToken, kind: "slug-service", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function slugServiceSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
