#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-base-to-string, @typescript-eslint/no-unnecessary-condition -- Publish-index diagnostics preserve compatibility stringification and validate persisted bundle data defensively. */
/* eslint-disable complexity -- Publishability is an auditable ordered policy decision; centralized branches keep blocker precedence visible. */
/**
 * What: Builds a local inventory of community-export bundles and their gate results.
 * Why: Operators need one view of publish candidates without opening every bundle directory.
 * How: Scans a publish root and writes or prints a structured index of valid bundle artifacts.
 * Callers: Publishing dashboards and release reviews consume the generated index.
 * Example: `node tools/sma-publish-index.ts --help`
 */

import fs from "node:fs/promises";
import path from "node:path";

type FalsyValue = false | 0 | 0n | '' | null | undefined;
function orElse<T, U>(value: T, fallback: () => U): Exclude<T, FalsyValue> | U {
  if (!value) return fallback();
  return value as Exclude<T, FalsyValue>;
}

const SCHEMA_VERSION = "1.0.0";
const DEFAULT_ROOT = "publish";
const DEFAULT_OUT = "publish/publish-index.generated.json";
const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".nuxt", ".turbo", "dist", "coverage"]);
const EXPECTED_FILES = ["bundle.json", "publish-report.json", "manifest.community.json"] as const;
type ExpectedFile = (typeof EXPECTED_FILES)[number];

interface PublishArgs { root: string; out: string; stdout: boolean; dryRun: boolean; help: boolean }
interface ArtifactInput { community_id?: unknown; name?: unknown; type?: unknown; version?: unknown }
interface DecisionInput {
  counts?: { blocker?: unknown; warning?: unknown; info?: unknown };
  status?: unknown;
  strict_mode?: unknown;
}
interface BundleDocument {
  artifact?: ArtifactInput;
  decision?: DecisionInput;
  export_kind?: unknown;
  export_mode?: unknown;
  generated_at?: unknown;
  source_artifact?: { original_id?: unknown };
}
interface PublishFinding {
  category?: string;
  location?: string;
  rule_id?: string;
  scope?: string;
  severity?: string;
  summary?: string;
}
interface ReportDocument {
  artifact?: ArtifactInput;
  decision?: DecisionInput;
  export_mode?: unknown;
  findings?: PublishFinding[];
  generated_at?: unknown;
  limitations?: unknown[];
  redaction_summary?: { count?: unknown };
  root_aliases?: unknown[];
  scanned_files?: { finding_count?: unknown }[];
  source_artifact?: { original_id?: unknown };
}
interface ManifestDocument {
  brick?: { id?: unknown; name?: unknown; version?: unknown; visibility?: unknown };
  build?: { id?: unknown; name?: unknown; version?: unknown; visibility?: unknown };
  classification?: { risk?: unknown };
  publishing?: { license?: unknown; publishable?: boolean; redaction_profile?: unknown; visibility?: unknown };
}
interface ArtifactSummary { community_id: string; original_id: string | null; name: string; type: string; version: string }
interface DecisionSummary { status: string; counts: { blocker: number; warning: number; info: number }; strict_mode: boolean }
interface FindingRule { rule_id: string; severity: string; category: string; summary: string; count: number }
interface BundleSummary {
  artifact: ArtifactSummary;
  artifact_visibility: unknown;
  bundle_path: string;
  complete: boolean;
  decision: DecisionSummary;
  declared_publishable: boolean | null;
  finding_counts: { blocker: number; warning: number; info: number; total: number };
  finding_rules: FindingRule[];
  license: unknown;
  publish_safe: boolean;
  publishing_visibility: unknown;
  redaction_count: number;
  risk: unknown;
  scanned_file_count: number;
  scanned_finding_count: number;
  [key: string]: unknown;
}
type BundleResult = { ok: true; value: BundleSummary } | { ok: false; reason: string; error?: string };

const HELP_TEXT = `Usage: node tools/sma-publish-index.ts [options]

Scan local publish bundles produced by sma-publish and build a private index of
community-export candidates. This is a local inventory and gate summary only.
It does not upload, publish, or talk to any remote marketplace.

Options:
  --root <dir>    Publish bundle root directory. Default: ${DEFAULT_ROOT}
  --out <file>    Output JSON path. Default: ${DEFAULT_OUT}
  --stdout        Print the generated index to stdout
  --dry-run       Analyze without writing a file. Implies --stdout
  --help          Show this help text
`;

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const bundleDirs = await collectBundleDirectories(options.root);
  const bundles: BundleSummary[] = [];
  const skipped: { bundle_path: string; reason: string; error: string | null }[] = [];

  for (const bundleDir of bundleDirs) {
    const result = await summarizeBundle(bundleDir, options.root);
    if (!result.ok) {
      skipped.push({
        bundle_path: toPosix(path.relative(process.cwd(), bundleDir)),
        reason: result.reason,
        error: 'error' in result ? orElse(result.error, () => null) : null,
      });
      continue;
    }
    bundles.push(result.value);
  }

  bundles.sort(compareBundleEntries);
  skipped.sort((left, right) => (left.bundle_path || "").localeCompare((right.bundle_path || "")));

  const document = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    root: toPosix(path.relative(process.cwd(), options.root)),
    root_exists: await pathExists(options.root),
    summary: summarizeIndex(bundles),
    bundles,
    skipped,
  };

  if (options.stdout || options.dryRun) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  }

  if (!options.dryRun) {
    await fs.mkdir(path.dirname(options.out), { recursive: true });
    await fs.writeFile(options.out, `${JSON.stringify(sortJson(document), null, 2)}\n`, "utf8");
  }
}

function parseArgs(argv: string[]): PublishArgs {
  const options: PublishArgs = {
    root: path.resolve(process.cwd(), DEFAULT_ROOT),
    out: path.resolve(process.cwd(), DEFAULT_OUT),
    stdout: false,
    dryRun: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      options.root = path.resolve(requireValue(argv, ++index, "--root"));
      continue;
    }
    if (arg === "--out") {
      options.out = path.resolve(requireValue(argv, ++index, "--out"));
      continue;
    }
    if (arg === "--stdout") {
      options.stdout = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      options.stdout = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectBundleDirectories(rootPath: string): Promise<string[]> {
  const stat = await fs.stat(rootPath).catch(() => null);
  if (!stat?.isDirectory()) {
    return [];
  }

  const output: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    const names = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    if (EXPECTED_FILES.some((name) => names.has(name))) {
      output.push(currentPath);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(path.join(currentPath, entry.name));
    }
  }

  await walk(rootPath);
  return [...new Set(output)].sort((left, right) => left.localeCompare(right));
}

async function summarizeBundle(bundleDir: string, rootPath: string): Promise<BundleResult> {
  const fileEntries = await Promise.all(EXPECTED_FILES.map(async (fileName): Promise<readonly [ExpectedFile, boolean]> => [
    fileName,
    await pathExists(path.join(bundleDir, fileName)),
  ]));
  const filesPresent = Object.fromEntries(fileEntries) as Record<ExpectedFile, boolean>;
  const bundleDoc = await maybeReadJson<BundleDocument>(path.join(bundleDir, "bundle.json"));
  const reportDoc = await maybeReadJson<ReportDocument>(path.join(bundleDir, "publish-report.json"));
  const manifestDoc = await maybeReadJson<ManifestDocument>(path.join(bundleDir, "manifest.community.json"));

  if (!bundleDoc && !reportDoc && !manifestDoc) {
    return { ok: false, reason: "no_publish_files_found" };
  }

  const artifact = summarizeArtifact(bundleDoc, reportDoc, manifestDoc, bundleDir);
  const findings = Array.isArray(reportDoc?.findings) ? reportDoc.findings : [];
  const findingCounts = summarizeFindingCounts(findings);
  const scannedFiles = Array.isArray(reportDoc?.scanned_files) ? reportDoc.scanned_files : [];
  const decision = summarizeDecision(bundleDoc, reportDoc);
  const summary: BundleSummary = {
    bundle_path: toPosix(path.relative(process.cwd(), bundleDir)),
    bundle_root: toPosix(path.relative(process.cwd(), rootPath)),
    complete: filesPresent["bundle.json"] && filesPresent["publish-report.json"] && filesPresent["manifest.community.json"],
    generated_at: orElse(firstDefined(bundleDoc?.generated_at, reportDoc?.generated_at), () => null),
    artifact,
    decision,
    files_present: filesPresent,
    export_kind: orElse(bundleDoc?.export_kind, () => null),
    export_mode: orElse(firstDefined(bundleDoc?.export_mode, reportDoc?.export_mode), () => null),
    artifact_visibility: inferArtifactVisibility(manifestDoc),
    publishing_visibility: inferPublishingVisibility(manifestDoc),
    declared_publishable: inferDeclaredPublishable(manifestDoc),
    license: inferLicense(manifestDoc),
    redaction_profile: inferRedactionProfile(manifestDoc),
    risk: inferRisk(manifestDoc),
    redaction_count: Number(orElse(reportDoc?.redaction_summary?.count, () => 0)),
    scanned_file_count: scannedFiles.length,
    scanned_finding_count: scannedFiles.reduce((sum, file) => sum + Number(orElse(file.finding_count, () => 0)), 0),
    root_alias_count: Array.isArray(reportDoc?.root_aliases) ? reportDoc.root_aliases.length : 0,
    finding_counts: findingCounts,
    finding_categories: countBy(findings, (entry) => orElse(entry.category, () => "unknown")),
    finding_scopes: countBy(findings, (entry) => orElse(entry.scope, () => "unknown")),
    finding_rules: summarizeFindingRules(findings),
    top_blockers: selectTopFindings(findings, "blocker", 6),
    top_warnings: selectTopFindings(findings, "warning", 4),
    limitations: Array.isArray(reportDoc?.limitations) ? reportDoc.limitations : [],
    publish_safe:
      decision.status !== "blocked" &&
      inferDeclaredPublishable(manifestDoc) === true &&
      filesPresent["bundle.json"] &&
      filesPresent["publish-report.json"] &&
      filesPresent["manifest.community.json"],
  };

  return { ok: true, value: summary };
}

function summarizeArtifact(
  bundleDoc: BundleDocument | null,
  reportDoc: ReportDocument | null,
  manifestDoc: ManifestDocument | null,
  bundleDir: string,
): ArtifactSummary {
  const artifact = firstDefined(bundleDoc?.artifact, reportDoc?.artifact, inferArtifactFromManifest(manifestDoc)) ?? {};
  const type = firstDefined(artifact.type, manifestDoc?.build ? "build" : manifestDoc?.brick ? "brick" : "unknown");
  const communityId = firstDefined(artifact.community_id, manifestDoc?.build?.id, manifestDoc?.brick?.id, path.basename(bundleDir));
  const originalArtifactId = orElse(firstDefined(
    bundleDoc?.source_artifact?.original_id,
    reportDoc?.source_artifact?.original_id,
  ), () => null);
  const name = firstDefined(
    artifact.name,
    manifestDoc?.build?.name,
    manifestDoc?.brick?.name,
    communityId,
  );
  const version = firstDefined(
    artifact.version,
    manifestDoc?.build?.version,
    manifestDoc?.brick?.version,
    "0.0.0",
  );

  return {
    community_id: String(orElse(communityId, () => path.basename(bundleDir))),
    original_id: originalArtifactId ? String(originalArtifactId) : null,
    name: String(orElse(orElse(name, () => (communityId)), () => "publish bundle")),
    type: String(orElse(type, () => "unknown")),
    version: String(orElse(version, () => "0.0.0")),
  };
}

function inferArtifactFromManifest(manifestDoc: ManifestDocument | null): ArtifactInput | null {
  if (!manifestDoc || typeof manifestDoc !== "object") return null;
  if (manifestDoc.build?.id) {
    return {
      community_id: manifestDoc.build.id,
      name: manifestDoc.build.name,
      type: "build",
      version: manifestDoc.build.version,
    };
  }
  if (manifestDoc.brick?.id) {
    return {
      community_id: manifestDoc.brick.id,
      name: manifestDoc.brick.name,
      type: "brick",
      version: manifestDoc.brick.version,
    };
  }
  return null;
}

function summarizeDecision(bundleDoc: BundleDocument | null, reportDoc: ReportDocument | null): DecisionSummary {
  const decision = firstDefined(reportDoc?.decision, bundleDoc?.decision) ?? {};
  const counts = {
    blocker: Number(orElse(decision.counts?.blocker, () => 0)),
    warning: Number(orElse(decision.counts?.warning, () => 0)),
    info: Number(orElse(decision.counts?.info, () => 0)),
  };
  return {
    status: String(orElse(decision.status, () => "unknown")),
    counts,
    strict_mode: Boolean(decision.strict_mode),
  };
}

function summarizeFindingCounts(findings: PublishFinding[]) {
  return {
    blocker: findings.filter((entry) => entry.severity === "blocker").length,
    warning: findings.filter((entry) => entry.severity === "warning").length,
    info: findings.filter((entry) => entry.severity === "info").length,
    total: findings.length,
  };
}

function inferArtifactVisibility(manifestDoc: ManifestDocument | null): unknown {
  return orElse(firstDefined(manifestDoc?.build?.visibility, manifestDoc?.brick?.visibility), () => "unknown");
}

function inferPublishingVisibility(manifestDoc: ManifestDocument | null): unknown {
  return orElse(firstDefined(manifestDoc?.publishing?.visibility), () => "unknown");
}

function inferDeclaredPublishable(manifestDoc: ManifestDocument | null): boolean | null {
  if (typeof manifestDoc?.publishing?.publishable === "boolean") {
    return manifestDoc.publishing.publishable;
  }
  return null;
}

function inferLicense(manifestDoc: ManifestDocument | null): unknown {
  return orElse(firstDefined(manifestDoc?.publishing?.license), () => null);
}

function inferRedactionProfile(manifestDoc: ManifestDocument | null): unknown {
  return orElse(firstDefined(manifestDoc?.publishing?.redaction_profile), () => null);
}

function inferRisk(manifestDoc: ManifestDocument | null): unknown {
  return orElse(firstDefined(manifestDoc?.classification?.risk), () => null);
}

function selectTopFindings(findings: PublishFinding[], severity: string, limit: number) {
  return findings
    .filter((entry) => entry.severity === severity)
    .slice(0, limit)
    .map((entry) => ({
      severity: orElse(entry.severity, () => severity),
      category: orElse(entry.category, () => "unknown"),
      rule_id: orElse(entry.rule_id, () => "unknown"),
      summary: orElse(entry.summary, () => "Finding recorded."),
      location: orElse(entry.location, () => null),
      scope: orElse(entry.scope, () => null),
    }));
}

function countBy<T>(items: readonly T[], getKey: (item: T) => unknown): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = String(orElse(getKey(item), () => "unknown"));
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function summarizeFindingRules(findings: PublishFinding[]): FindingRule[] {
  const rows = new Map<string, FindingRule>();
  for (const finding of findings) {
    const key = `${orElse(finding.rule_id, () => "unknown")}:${orElse(finding.severity, () => "unknown")}`;
    const row: FindingRule = rows.get(key) ?? {
      rule_id: orElse(finding.rule_id, () => "unknown"),
      severity: orElse(finding.severity, () => "unknown"),
      category: orElse(finding.category, () => "unknown"),
      summary: orElse(finding.summary, () => "Finding recorded."),
      count: 0,
    };
    row.count += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((left, right) => right.count - left.count || (left.rule_id || "").localeCompare((right.rule_id || "")));
}

function summarizeIndex(bundles: BundleSummary[]) {
  const topRules = new Map<string, FindingRule & { sample_artifacts: string[] }>();

  for (const bundle of bundles) {
    for (const finding of bundle.finding_rules || []) {
      const key = `${finding.rule_id || "unknown"}:${finding.severity || "unknown"}`;
      const row: FindingRule & { sample_artifacts: string[] } = topRules.get(key) ?? {
        rule_id: finding.rule_id || "unknown",
        severity: finding.severity || "unknown",
        category: finding.category || "unknown",
        summary: finding.summary || "Finding recorded.",
        count: 0,
        sample_artifacts: [],
      };
      row.count += (finding.count || 0);
      if (row.sample_artifacts.length < 4 && !row.sample_artifacts.includes(bundle.artifact.community_id)) {
        row.sample_artifacts.push(bundle.artifact.community_id);
      }
      topRules.set(key, row);
    }
  }

  return {
    bundle_count: bundles.length,
    complete_bundle_count: bundles.filter((entry) => entry.complete).length,
    incomplete_bundle_count: bundles.filter((entry) => !entry.complete).length,
    publish_safe_count: bundles.filter((entry) => entry.publish_safe).length,
    blocker_bundle_count: bundles.filter((entry) => (entry.decision.counts.blocker || 0) > 0).length,
    warning_bundle_count: bundles.filter((entry) => (entry.decision.counts.warning || 0) > 0).length,
    by_artifact_type: countBy(bundles, (entry) => entry.artifact.type || "unknown"),
    by_original_artifact_type: countBy(bundles, (entry) => entry.artifact.original_id ? "linked" : "unlinked"),
    by_decision_status: countBy(bundles, (entry) => entry.decision.status || "unknown"),
    by_artifact_visibility: countBy(bundles, (entry) => orElse(entry.artifact_visibility, () => "unknown")),
    by_publishing_visibility: countBy(bundles, (entry) => orElse(entry.publishing_visibility, () => "unknown")),
    by_license: countBy(bundles, (entry) => orElse(entry.license, () => "unknown")),
    by_risk: countBy(bundles, (entry) => orElse(entry.risk, () => "unknown")),
    publishable_declared_count: bundles.filter((entry) => entry.declared_publishable === true).length,
    total_redaction_count: bundles.reduce((sum, entry) => sum + (entry.redaction_count || 0), 0),
    total_scanned_file_count: bundles.reduce((sum, entry) => sum + (entry.scanned_file_count || 0), 0),
    total_scanned_finding_count: bundles.reduce((sum, entry) => sum + (entry.scanned_finding_count || 0), 0),
    total_finding_count: bundles.reduce((sum, entry) => sum + (entry.finding_counts.total || 0), 0),
    top_rules: [...topRules.values()]
      .sort((left, right) => right.count - left.count || (left.rule_id || "").localeCompare((right.rule_id || "")))
      .slice(0, 12),
  };
}

async function maybeReadJson<T>(filePath: string): Promise<T | null> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function firstDefined<T>(...values: (T | null | undefined | "")[]): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function toPosix(value: unknown): string {
  return String(orElse(value, () => "")).split(path.sep).join("/");
}

function compareBundleEntries(left: BundleSummary, right: BundleSummary): number {
  return (left.artifact.type || "").localeCompare((right.artifact.type || ""))
    || (left.decision.status || "").localeCompare((right.decision.status || ""))
    || (left.artifact.name || "").localeCompare((right.artifact.name || ""))
    || (left.bundle_path || "").localeCompare((right.bundle_path || ""));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
