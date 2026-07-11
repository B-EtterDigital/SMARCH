import { loadRegistryContext } from "../lib.mjs";
import {
  boundedDiagnosticValue,
  executeTool,
  readOnlyAnnotations,
  readOnlyAuthorization,
} from "../contract.mjs";

export const name = "registry-doctor";
export const description = "Summarize registry health, validation pressure, trust, and snapshot freshness.";
export const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
export const annotations = readOnlyAnnotations;
export const authorization = readOnlyAuthorization;
export const timeoutMs = 500;

export function summarizeRegistryDoctor({ registry, state, paths }) {
  const validationErrors = Number(registry.validation_error_count || 0);
  const scanFailures = Number(registry.failure_count || registry.failures?.length || 0);
  const brickCount = Number(state?.totals?.brick_count || registry.bricks?.length || registry.count || 0);
  const projectCount = Number(state?.totals?.project_count || registry.projects?.length || 0);
  return {
    healthy: validationErrors === 0 && scanFailures === 0,
    snapshots: {
      state_generated_at: state?.generated_at || null,
      registry_generated_at: registry?.generated_at || null,
      state_path: paths.state,
      registry_path: paths.registry,
    },
    totals: { brick_count: brickCount, project_count: projectCount },
    validation: {
      error_count: validationErrors,
      warning_count: Number(registry.validation_warning_count || 0),
      failure_count: scanFailures,
      unmanifested_count: Number(registry.unmanifested_count || 0),
    },
    trust: boundedDiagnosticValue(state?.trust || {}),
    build_plane: boundedDiagnosticValue(state?.build_plane || {}),
    scanner_report: boundedDiagnosticValue(registry?.scanner_report || {}),
  };
}

export async function handler(args = {}) {
  return executeTool({
    name,
    inputSchema,
    args,
    timeoutMs,
    operation: async () => summarizeRegistryDoctor(await loadRegistryContext()),
  });
}
