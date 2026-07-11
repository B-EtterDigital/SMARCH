import path from "node:path";
import { DASH_API_MAX_ROWS, readJsonFile, runReadHandler, validateQuery } from "./core.mjs";

export const LEASES_SCOPE = "dashboard:leases:read";
export const LEASES_CONTRACT = Object.freeze({ method: "GET", path: "/api/leases", idempotent: true, retry: "safe with exponential backoff after 502/504", timeout_ms: 500, max_rows: DASH_API_MAX_ROWS });

export function validateLeasesQuery(query) {
  return validateQuery(query, { limit: { type: "integer", min: 1, max: DASH_API_MAX_ROWS, default: 200 } });
}

export async function loadLeases(smaRoot, input) {
  const source = await readJsonFile(path.join(smaRoot, "registry", "active-leases.generated.json"), { schema_version: "1.0.0", generated_at: new Date(0).toISOString(), leases: [] });
  const now = Date.now();
  const active = (Array.isArray(source.leases) ? source.leases : []).filter((lease) => Date.parse(lease?.expires_at || "") > now);
  return {
    schema_version: "1.0.0",
    generated_at: source.generated_at || new Date(0).toISOString(),
    leases: active.slice(0, input.limit),
    stats: {
      active: active.length,
      returned: Math.min(active.length, input.limit),
      truncated: active.length > input.limit,
      expiring_soon: active.filter((lease) => Date.parse(lease.expires_at) - now < 300_000).length
    }
  };
}

export function handleLeases(options) {
  return runReadHandler({
    ...options,
    area: "dashboard.api.leases",
    scope: LEASES_SCOPE,
    validate: validateLeasesQuery,
    load: options.load || ((input) => loadLeases(options.root, input))
  });
}
