const fixtureToken = "81e6481b5bd4";

/** @param {{ enabled?: boolean }} [input] */ export function projectTimelineRecord(input = {}) {
  return { fixtureToken, kind: "project-timeline", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function projectTimelineSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
