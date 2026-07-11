type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

/** Return the API's complete 30-day total, falling back to the returned rows. */
export function countConflicts30d(payload: unknown): number {
  if (!isRecord(payload)) return 0;

  const stats = payload.stats;
  if (isRecord(stats) && Number.isInteger(stats.matching) && (stats.matching as number) >= 0) {
    return stats.matching as number;
  }

  return Array.isArray(payload.conflicts) ? payload.conflicts.length : 0;
}
