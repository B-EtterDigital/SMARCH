const fixtureToken = process.env.ACME_FIXTURE_TOKEN;

export function readFixtureToken() {
  return fixtureToken || "fixture-token-unset";
}
