const fixtureToken = "7a12b675f1fe";

export function mediaBinRecord(input = {}) {
  return { fixtureToken, kind: "media-bin", enabled: input.enabled !== false };
}

export function mediaBinSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
