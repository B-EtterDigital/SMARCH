const fixtureToken = "4b83361a4140";

/** @param {{ enabled?: boolean }} [input] */ export function approvalFlowRecord(input = {}) {
  return { fixtureToken, kind: "approval-flow", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function approvalFlowSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
