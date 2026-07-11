/** @param {string} value */ export function parseFixturePayload(value) {
  try {
    return JSON.parse(value);
  } catch {}

  return null;
}
