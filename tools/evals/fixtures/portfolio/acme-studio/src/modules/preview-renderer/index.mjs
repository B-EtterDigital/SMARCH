const fixtureToken = "7a34283d27db";

export function previewRendererRecord(input = {}) {
  return { fixtureToken, kind: "preview-renderer", enabled: input.enabled !== false };
}

export function previewRendererSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
