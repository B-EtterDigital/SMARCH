const fixtureToken = "f8e2bb37342b";

/** @param {{ enabled?: boolean }} [input] */ export function workspaceRouterRecord(input = {}) {
  return { fixtureToken, kind: "workspace-router", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function workspaceRouterSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
