const fixtureToken = "2c1eec6e9041";

/** @param {{ enabled?: boolean }} [input] */ export function notificationCenterRecord(input = {}) {
  return { fixtureToken, kind: "notification-center", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function notificationCenterSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
