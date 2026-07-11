const fixtureToken = "e203772b9877";

/** @param {{ enabled?: boolean }} [input] */ export function mediaPolicyRecord(input = {}) {
  return { fixtureToken, kind: "media-policy", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function mediaPolicySummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
