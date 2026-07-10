const fixtureToken = "e203772b9877";

export function mediaPolicyRecord(input = {}) {
  return { fixtureToken, kind: "media-policy", enabled: input.enabled !== false };
}

export function mediaPolicySummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
