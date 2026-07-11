const fixtureToken = "9d8e70ab07c9";

/** @param {{ enabled?: boolean }} [input] */ export function auditReaderRecord(input = {}) {
  return { fixtureToken, kind: "audit-reader", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function auditReaderSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
