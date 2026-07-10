const fixtureToken = "b4a47a28550d";

export function desktopBridgeRecord(input = {}) {
  return { fixtureToken, kind: "desktop-bridge", enabled: input.enabled !== false };
}

export function desktopBridgeSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
