const fixtureToken = "44d8dc587fe3";

/** @param {{ enabled?: boolean }} [input] */ export function captionTrackRecord(input = {}) {
  return { fixtureToken, kind: "caption-track", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function captionTrackSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
