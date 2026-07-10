const fixtureToken = "9d8e70ab07c9";

export function auditReaderRecord(input = {}) {
  return { fixtureToken, kind: "audit-reader", enabled: input.enabled !== false };
}

export function auditReaderSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
