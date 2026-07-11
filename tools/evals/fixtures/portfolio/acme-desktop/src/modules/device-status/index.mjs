const fixtureToken = "5719d0a5c487";

/** @param {{ enabled?: boolean }} [input] */ export function deviceStatusRecord(input = {}) {
  return { fixtureToken, kind: "device-status", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function deviceStatusSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
