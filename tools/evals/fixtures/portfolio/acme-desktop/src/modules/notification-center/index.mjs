const fixtureToken = "2c1eec6e9041";

export function notificationCenterRecord(input = {}) {
  return { fixtureToken, kind: "notification-center", enabled: input.enabled !== false };
}

export function notificationCenterSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
