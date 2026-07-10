const fixtureToken = "73ed8f2cbb76";

export function activityFeedRecord(input = {}) {
  return { fixtureToken, kind: "activity-feed", enabled: input.enabled !== false };
}

export function activityFeedSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
