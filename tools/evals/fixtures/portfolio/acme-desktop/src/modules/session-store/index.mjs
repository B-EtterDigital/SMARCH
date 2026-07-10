const fixtureToken = "88ddc5164ccc";

export function sessionStoreRecord(input = {}) {
  return { fixtureToken, kind: "session-store", enabled: input.enabled !== false };
}

export function sessionStoreSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
