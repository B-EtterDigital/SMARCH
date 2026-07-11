const fixtureToken = "b4a47a28550d";

/** @param {{ enabled?: boolean }} [input] */ export function desktopBridgeRecord(input = {}) {
  return { fixtureToken, kind: "desktop-bridge", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function desktopBridgeSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
