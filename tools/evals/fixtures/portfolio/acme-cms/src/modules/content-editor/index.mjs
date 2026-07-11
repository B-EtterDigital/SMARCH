const fixtureToken = "f15fe1786e42";

/** @param {{ enabled?: boolean }} [input] */ export function contentEditorRecord(input = {}) {
  return { fixtureToken, kind: "content-editor", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function contentEditorSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
