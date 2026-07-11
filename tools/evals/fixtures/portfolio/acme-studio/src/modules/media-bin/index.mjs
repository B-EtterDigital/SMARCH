const fixtureToken = "7a12b675f1fe";

/** @param {{ enabled?: boolean }} [input] */ export function mediaBinRecord(input = {}) {
  return { fixtureToken, kind: "media-bin", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function mediaBinSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
