#!/usr/bin/env node
/**
 * WHAT: Validates brick manifests and calculates their readiness reports.
 * WHY: Invalid boundaries, security declarations, or gate claims must fail before reuse.
 * HOW: Reads one manifest, a project tree, or a registry and checks required contract fields.
 * OUTPUTS: Prints per-brick findings plus a final count, with structured output when requested.
 * CALLERS: The sma command router and continuous-integration pipeline run it before release.
 * USAGE: `node tools/sma-validate.ts --manifest tools/evals/fixtures/portfolio/acme-cms/src/modules/approval-flow/module.sweetspot.json`
 * Glossary: [SMA](../docs/GLOSSARY.md).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { calculateScore } from "./sma-score.ts";
import type { BrickManifest } from './lib/schema-types/brick.manifest.schema.d.ts';

type DeepPartial<T> = T extends readonly unknown[]
  ? DeepPartial<T[number]>[]
  : T extends object
    ? { [Key in keyof T]?: DeepPartial<T[Key]> }
    : T;
type ManifestInput = DeepPartial<BrickManifest> & Record<string, unknown>;
interface ValidationFinding { code: string; message: string }
interface ValidationReport {
  brick_id: string; calculated_score?: number; declared_score?: number | null;
  errors: ValidationFinding[]; manifest_path: string; status: string; warnings: ValidationFinding[];
}
type Severity = 'errors' | 'warnings';

const defaultOptions = {
  root: "",
  manifest: "",
  registry: "",
  json: false
};

const excludedDirs = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".astro",
  ".turbo",
  ".netlify",
  ".tmp",
  "tmp",
  "playwright-report",
  "test-results"
]);

const requiredTopLevel = [
  "schema_version",
  "brick",
  "source",
  "owner",
  "boundaries",
  "classification",
  "sweetspot",
  "interfaces",
  "security",
  "supply_chain",
  "quality",
  "clone",
  "provenance"
];

const requiredGates: (keyof BrickManifest['sweetspot'])[] = [
  "ssa_v2",
  "ssi",
  "sstf",
  "spe",
  "srs",
  "ssra",
  "sas",
  "sva",
  "srls",
  "sev",
  "ssc",
  "sai"
];

const privateDataClasses = new Set([
  "user_private",
  "org_private",
  "admin_only",
  "pii",
  "payment",
  "credential",
  "health_sensitive",
  "regulated"
]);

function parseArgs(argv: string[]): typeof defaultOptions {
  const options = { ...defaultOptions };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === "--root" && next) {
      options.root = path.resolve(next);
      i += 1;
    } else if ((arg === "--manifest" || arg === "-m") && next) {
      options.manifest = path.resolve(next);
      i += 1;
    } else if (arg === "--registry" && next) {
      options.registry = path.resolve(next);
      i += 1;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`SMA validate

Usage:
  node tools/sma-validate.ts --manifest path/to/module.sweetspot.json
  node tools/sma-validate.ts --root ~/DEV/Projects
  node tools/sma-validate.ts --registry registry/global-modules.generated.json
`);
      process.exit(0);
    }
  }

  if (!options.root && !options.manifest && !options.registry) {
    options.root = process.cwd();
  }

  return options;
}

async function walk(dir: string, results: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (excludedDirs.has(entry.name) || entry.name.startsWith("SSA_SSI_SSTF_SPA_COLLECTION_")) {
        continue;
      }

      await walk(path.join(dir, entry.name), results);
      continue;
    }

    if (entry.isFile() && entry.name === "module.sweetspot.json") {
      results.push(path.join(dir, entry.name));
    }
  }

  return results;
}

async function manifestsFromRegistry(registryPath: string): Promise<string[]> {
  const registry = JSON.parse(await fs.readFile(registryPath, "utf8")) as { bricks?: { manifest_path?: string }[] };
  return [...new Set((registry.bricks ?? []).map((brick) => brick.manifest_path).filter((value): value is string => typeof value === 'string'))];
}

async function manifestPaths(options: typeof defaultOptions): Promise<string[]> {
  if (options.manifest) {
    return [options.manifest];
  }

  if (options.registry) {
    return manifestsFromRegistry(options.registry);
  }

  return walk(options.root);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function add(report: ValidationReport, severity: Severity, code: string, message: string): void {
  report[severity].push({ code, message });
}

function canonical(manifest: ManifestInput): boolean {
  return manifest.brick?.status === "canonical";
}

function candidateOrCanonical(manifest: ManifestInput): boolean {
  return manifest.brick?.status === "candidate" || manifest.brick?.status === "canonical";
}

export function validateManifest(manifestPath: string, manifest: ManifestInput): ValidationReport {
  const report: ValidationReport = {
    manifest_path: manifestPath,
    brick_id: manifest.brick?.id ?? "unknown",
    status: manifest.brick?.status ?? "unknown",
    errors: [],
    warnings: []
  };

  for (const key of requiredTopLevel) {
    if (!(key in manifest)) {
      add(report, "errors", "missing_top_level", `Missing top-level key: ${key}`);
    }
  }

  if (manifest.schema_version !== "1.0.0") {
    add(report, "errors", "schema_version", "schema_version must be 1.0.0");
  }

  if (!hasText(manifest.brick?.id)) {
    add(report, "errors", "brick_id", "brick.id is required");
  }

  if (!hasText(manifest.brick?.name)) {
    add(report, "errors", "brick_name", "brick.name is required");
  }

  if (!Array.isArray(manifest.source?.paths) || manifest.source.paths.length === 0) {
    add(report, "errors", "source_paths", "source.paths must list copied source paths");
  }

  if (!hasText(manifest.owner?.primary)) {
    add(report, "errors", "owner_primary", "owner.primary is required");
  }

  if (!Array.isArray(manifest.boundaries?.owned_paths) || manifest.boundaries.owned_paths.length === 0) {
    add(report, "errors", "owned_paths", "boundaries.owned_paths must declare ownership");
  }

  if (candidateOrCanonical(manifest) && !hasText(manifest.hierarchy?.level)) {
    add(report, "warnings", "hierarchy_missing", "Candidate/canonical brick should declare hierarchy.level");
  }

  if (manifest.hierarchy?.level === "component" && !hasText(manifest.hierarchy.parent_module_id) && !hasText(manifest.hierarchy.parent_brick_id)) {
    add(report, "warnings", "component_parent_missing", "Component brick should name its parent module or parent brick");
  }

  if (!hasText(manifest.source?.commit) && !hasText(manifest.source?.archive_hash)) {
    const severity = canonical(manifest) ? "errors" : "warnings";
    add(report, severity, "source_attestation", "source.commit or source.archive_hash should be recorded");
  }

  for (const gate of requiredGates) {
    const gateData = manifest.sweetspot?.[gate];

    if (!gateData) {
      add(report, "errors", "missing_gate", `Missing sweetspot gate: ${gate}`);
      continue;
    }

    if (typeof gateData.score !== "number") {
      add(report, "errors", "gate_score", `${gate}.score must be a number`);
    }

    if (canonical(manifest) && ["missing", "blocked"].includes(gateData.status ?? '')) {
      add(report, "errors", "canonical_gate_blocked", `Canonical brick cannot have ${gate} status ${String(gateData.status)}`);
    } else if (candidateOrCanonical(manifest) && ["missing", "blocked"].includes(gateData.status ?? '')) {
      add(report, "warnings", "candidate_gate_blocked", `Candidate brick has ${gate} status ${String(gateData.status)}`);
    }
  }

  const findings = manifest.security?.vulnerability_findings ?? {};
  const highRiskFindings = (findings.critical ?? 0) + (findings.high ?? 0);

  if (highRiskFindings > 0) {
    const severity = canonical(manifest) ? "errors" : "warnings";
    add(report, severity, "vulnerability_blocker", "High or critical vulnerability findings are present");
  }

  if (canonical(manifest) && (manifest.quality?.score ?? 0) < 90) {
    add(report, "errors", "canonical_score", "Canonical brick requires quality.score >= 90");
  }

  const calculatedScore = calculateScore(manifest);
  const declaredScore = manifest.quality?.score;

  if (typeof declaredScore === "number" && Math.abs(declaredScore - calculatedScore) > 10) {
    add(report, "warnings", "score_drift", `Declared score ${String(declaredScore)} differs from calculated score ${String(calculatedScore)}`);
  }

  if ((manifest.quality?.line_count?.max_file_lines ?? 0) > 600) {
    const severity = canonical(manifest) ? "errors" : "warnings";
    add(report, severity, "file_size_hard_limit", "A source file is over the 600-line hard limit");
  } else if ((manifest.quality?.line_count?.max_file_lines ?? 0) > 400) {
    add(report, "warnings", "file_size_target", "A source file is over the 400-line target");
  }

  if (!manifest.quality?.code_budget) {
    add(report, candidateOrCanonical(manifest) ? "errors" : "warnings", "code_budget_missing", "quality.code_budget is required to enforce minimum responsible code");
  } else {
    if (manifest.quality.code_budget.status === "bloated") {
      const severity = canonical(manifest) ? "errors" : "warnings";
      add(report, severity, "code_bloat", "Code budget status is bloated");
    }

    if ((manifest.quality.code_budget.dependency_count ?? 0) > 12) {
      add(report, "warnings", "dependency_creep", "Brick declares more than 12 dependencies; verify they earn their place");
    }

    if ((manifest.quality.code_budget.file_count ?? 0) > 30) {
      add(report, "warnings", "wide_brick", "Brick spans more than 30 files; consider module_group or submodules");
    }
  }

  if (!Array.isArray(manifest.quality?.test_commands) || manifest.quality.test_commands.length === 0) {
    add(report, candidateOrCanonical(manifest) ? "errors" : "warnings", "test_commands", "test_commands should be declared");
  }

  const skippedVerification = (manifest.quality?.verification ?? []).some((event) => event.status === "skipped");
  if (candidateOrCanonical(manifest) && skippedVerification) {
    add(report, "warnings", "skipped_verification", "Candidate/canonical brick has skipped verification");
  }

  if (manifest.security?.rls?.required && manifest.security.rls.status !== "complete") {
    const severity = canonical(manifest) ? "errors" : "warnings";
    add(report, severity, "rls_incomplete", "Required RLS contract is not complete");
  }

  if (manifest.security?.env?.required && manifest.security.env.status !== "complete") {
    const severity = canonical(manifest) ? "errors" : "warnings";
    add(report, severity, "env_incomplete", "Required env contract is not complete");
  }

  const privateClasses = (manifest.classification?.data_classes ?? []).filter((item) => privateDataClasses.has(item));
  if (privateClasses.length > 0 && manifest.security?.rls?.status === "not_applicable" && !hasText(manifest.classification?.notes)) {
    add(report, "warnings", "private_data_no_rls_note", "Private data class with RLS marked not_applicable needs an explanation");
  }

  if (!Array.isArray(manifest.interfaces?.public_api) || manifest.interfaces.public_api.length === 0) {
    add(report, "warnings", "public_api", "interfaces.public_api should list the public contract");
  }

  if (!Array.isArray(manifest.supply_chain?.dependencies)) {
    add(report, "errors", "supply_chain_dependencies", "supply_chain.dependencies must be declared");
  }

  if (canonical(manifest) && (!Array.isArray(manifest.supply_chain?.checksums) || manifest.supply_chain.checksums.length === 0)) {
    add(report, "errors", "canonical_checksums", "Canonical brick requires at least one supply_chain checksum");
  }

  if (!Array.isArray(manifest.clone?.install_steps) || manifest.clone.install_steps.length === 0) {
    add(report, "errors", "clone_steps", "clone.install_steps are required");
  }

  if (!Array.isArray(manifest.clone?.known_traps) || manifest.clone.known_traps.length === 0) {
    add(report, "errors", "known_traps", "clone.known_traps are required");
  }

  if (canonical(manifest) && !["copy_ready", "guided"].includes(manifest.clone?.readiness ?? '')) {
    add(report, "errors", "clone_readiness", "Canonical brick requires clone.readiness copy_ready or guided");
  }

  if (canonical(manifest) && (!Array.isArray(manifest.provenance?.reviewed_by) || manifest.provenance.reviewed_by.length === 0)) {
    add(report, "errors", "review_required", "Canonical brick requires at least one provenance.reviewed_by event");
  } else if (manifest.brick?.status === "candidate" && (!Array.isArray(manifest.provenance?.reviewed_by) || manifest.provenance.reviewed_by.length === 0)) {
    add(report, "warnings", "review_missing", "Candidate brick should get a review event before promotion");
  }

  const modelTouches = [
    manifest.provenance?.created_by,
    ...(manifest.provenance?.touched_by ?? []),
    ...(manifest.provenance?.reviewed_by ?? [])
  ].filter((event): event is NonNullable<typeof event> => event !== undefined)
    .filter((event) => event.actor_kind === "ai_model" || (event.actor_kind === "agent" && Boolean(event.model)));

  for (const event of modelTouches) {
    if (!Array.isArray(event.verification) || event.verification.length === 0) {
      add(report, "warnings", "model_touch_without_verification", `Model/agent touch by ${String(event.model ?? event.actor_id)} has no verification evidence`);
    }
  }

  report.calculated_score = calculatedScore;
  report.declared_score = declaredScore ?? null;

  return report;
}

function printReports(reports: ValidationReport[]): void {
  for (const report of reports) {
    console.log(`${report.errors.length ? "FAIL" : "OK"} ${report.brick_id} (${report.status})`);

    for (const error of report.errors) {
      console.log(`  ERROR ${error.code}: ${error.message}`);
    }

    for (const warning of report.warnings) {
      console.log(`  WARN  ${warning.code}: ${warning.message}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const paths = await manifestPaths(options);
  const reports: ValidationReport[] = [];

  for (const manifestPath of paths) {
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ManifestInput;
      reports.push(validateManifest(manifestPath, manifest));
    } catch (error) {
      reports.push({
        manifest_path: manifestPath,
        brick_id: "unreadable",
        status: "unknown",
        errors: [{ code: "read_manifest", message: error instanceof Error ? error.message : String(error) }],
        warnings: []
      });
    }
  }

  const errorCount = reports.reduce((sum, report) => sum + report.errors.length, 0);
  const warningCount = reports.reduce((sum, report) => sum + report.warnings.length, 0);

  if (options.json) {
    console.log(JSON.stringify({ count: reports.length, error_count: errorCount, warning_count: warningCount, reports }, null, 2));
  } else {
    printReports(reports);
    console.log(`SMA validation complete: ${String(reports.length)} manifest(s), ${String(errorCount)} error(s), ${String(warningCount)} warning(s)`);
  }

  if (errorCount > 0) {
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
