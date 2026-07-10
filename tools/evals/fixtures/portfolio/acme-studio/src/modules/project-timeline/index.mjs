const fixtureToken = "81e6481b5bd4";

export function projectTimelineRecord(input = {}) {
  return { fixtureToken, kind: "project-timeline", enabled: input.enabled !== false };
}

export function projectTimelineSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
