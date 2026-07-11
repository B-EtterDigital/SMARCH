const fixtureToken = "6384e44e8656";

/** @param {{ enabled?: boolean }} [input] */ export function transitionEngineRecord(input = {}) {
  return { fixtureToken, kind: "transition-engine", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function transitionEngineSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
