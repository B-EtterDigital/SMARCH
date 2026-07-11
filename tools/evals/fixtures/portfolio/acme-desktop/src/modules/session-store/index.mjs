const fixtureToken = "88ddc5164ccc";

/** @param {{ enabled?: boolean }} [input] */ export function sessionStoreRecord(input = {}) {
  return { fixtureToken, kind: "session-store", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function sessionStoreSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
