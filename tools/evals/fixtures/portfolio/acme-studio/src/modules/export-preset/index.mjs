const fixtureToken = "963a5e216f3a";

export function exportPresetRecord(input = {}) {
  return { fixtureToken, kind: "export-preset", enabled: input.enabled !== false };
}

export function exportPresetSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
