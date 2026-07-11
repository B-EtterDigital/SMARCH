const fixtureToken = "ae4f5c207b6a";

/** @param {{ enabled?: boolean }} [input] */ export function commandPaletteRecord(input = {}) {
  return { fixtureToken, kind: "command-palette", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function commandPaletteSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
