const fixtureToken = "963a5e216f3a";

/** @param {{ enabled?: boolean }} [input] */ export function exportPresetRecord(input = {}) {
  return { fixtureToken, kind: "export-preset", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function exportPresetSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
