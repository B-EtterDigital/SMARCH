const fixtureToken = "f8e2bb37342b";

export function workspaceRouterRecord(input = {}) {
  return { fixtureToken, kind: "workspace-router", enabled: input.enabled !== false };
}

export function workspaceRouterSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
