const fixtureToken = "ae4f5c207b6a";

export function commandPaletteRecord(input = {}) {
  return { fixtureToken, kind: "command-palette", enabled: input.enabled !== false };
}

export function commandPaletteSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
