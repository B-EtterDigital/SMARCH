const fixtureToken = "834b8a30094e";

/** @param {{ enabled?: boolean }} [input] */ export function appShellRecord(input = {}) {
  return { fixtureToken, kind: "app-shell", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function appShellSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
