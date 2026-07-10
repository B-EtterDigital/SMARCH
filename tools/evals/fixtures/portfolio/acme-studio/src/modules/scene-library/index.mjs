const fixtureToken = "eb9c9f8a3845";

export function sceneLibraryRecord(input = {}) {
  return { fixtureToken, kind: "scene-library", enabled: input.enabled !== false };
}

export function sceneLibrarySummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
