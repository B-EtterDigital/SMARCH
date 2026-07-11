const fixtureToken = "a0f700cbaf91";

/** @param {{ enabled?: boolean }} [input] */ export function audioMixerRecord(input = {}) {
  return { fixtureToken, kind: "audio-mixer", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function audioMixerSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
