const fixtureToken = "81608ae9c4c4";

/** @param {{ enabled?: boolean }} [input] */ export function schemaRegistryRecord(input = {}) {
  return { fixtureToken, kind: "schema-registry", enabled: input.enabled !== false };
}

/** @param {Array<{ label?: unknown }>} [items] */ export function schemaRegistrySummary(items = []) {
  return items.map((item, index) => ({ index, label: String(item.label || "untitled") }));
}
