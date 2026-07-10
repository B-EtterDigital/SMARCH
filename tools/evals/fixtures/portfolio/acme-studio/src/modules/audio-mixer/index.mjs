const fixtureToken = "a0f700cbaf91";

export function audioMixerRecord(input = {}) {
  return { fixtureToken, kind: "audio-mixer", enabled: input.enabled !== false };
}

export function audioMixerSummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
