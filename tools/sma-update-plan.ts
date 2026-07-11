#!/usr/bin/env node
/**
 * WHAT: Produces a machine-readable update plan for an installed project.
 * WHY: Version changes need explicit placements, checks, and rollback data before files move.
 * HOW: Reads the target .smarch control plane and selected release metadata without editing targets.
 * OUTPUTS: Prints or writes a bounded update-plan document.
 * CALLERS: Propagation and installation workflows use the plan before applying a release.
 * USAGE: `node tools/sma-update-plan.ts --help`
 * Glossary: [SMA](../docs/GLOSSARY.md).
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { ImportLock, PlacementMap, Release } from "./lib/schema-types/index.js";

const PLAN_SCHEMA = "smarch.update-plan.v0";
const SCHEMA_VERSION = "1.0.0";
const DEFAULT_MAX_PLACEMENTS = 200;
const DEFAULT_MAX_CHECKS = 200;
const DEFAULT_MAX_JOURNAL = 20;
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HASH_RE = /^[A-Fa-f0-9]{7,128}$/;
const VERIFICATION_RANK: Record<string, number> = {
  failed: -1,
  unverified: 0,
  candidate: 1,
  verified: 2,
  canonical: 3
};
const UPDATE_RESULT_SUCCESS = new Set(["installed", "updated", "partial", "rolled_back"]);
const HELP_TEXT = `Usage: node tools/sma-update-plan.ts [options]

Plan a SMARCH update using installed .smarch control-plane files.
The tool is planner-only: it never edits target files.

Options:
  --target <path>            Target project root. Default: current directory
  --smarch-root <path>       Override .smarch directory. Default: <target>/.smarch
  --release <path>           Optional release artifact JSON to compare against
  --import-id <id>           Limit planning to one import_id. Repeatable.
  --artifact-id <id>         Limit planning to one artifact_id.
  --artifact-type <type>     Limit planning to brick or build.
  --out <path>               Write the generated plan JSON to a file.
  --stdout                   Print the generated plan JSON to stdout.
  --dry-run                  Do not write --out. Prints to stdout unless suppressed by caller.
  --compact                  Keep the plan machine-readable but trim large detail arrays.
  --max-placements <n>       Max impacted placements per import in output. Default: ${String(DEFAULT_MAX_PLACEMENTS)}
  --max-checks <n>           Max expected checks per import in output. Default: ${String(DEFAULT_MAX_CHECKS)}
  --max-journal <n>          Max journal events per import in output. Default: ${String(DEFAULT_MAX_JOURNAL)}
  --help                     Show this help.

Examples:
  node tools/sma-update-plan.ts --target /path/to/project
  node tools/sma-update-plan.ts --target /path/to/project --release releases/foo/1.2.0.json
  node tools/sma-update-plan.ts --target /path/to/project --artifact-id foo.bar.baz --stdout
`;

type JsonRecord = Record<string, unknown>;
interface PlanIssue { severity: string; code: string; message: string; [key: string]: unknown }
type Placement = PlacementMap["placements"][number];
type PlacementImport = PlacementMap["imports"][number];
type LockEntry = ImportLock["selected_builds"][number] | ImportLock["resolved_bricks"][number];
interface ImportContracts extends JsonRecord { env?: JsonRecord; env_bindings?: unknown }
interface ImportRecord extends JsonRecord { import_id: string; artifact_type?: string; artifact_id?: string; artifact_name?: string; source_project?: string; contracts?: ImportContracts; verification?: JsonRecord; status?: string; imported_at?: string; source_status?: string; clone_readiness?: string; install_state?: JsonRecord }
interface ImportsDocument { imports?: ImportRecord[] }
interface JournalRecord extends JsonRecord { import_id?: string; created_at?: string; timestamp?: string; event_id?: string; event_type?: string; result?: string; from_version?: string; to_version?: string; rollback_ref?: string }
interface EnvBinding { name: string; surface: string; required: boolean; bound_to: unknown; source: string }
interface EnvPlanItem { name: string; surface: string; required: boolean; current_state: string; release_state: string; action: string; bound_to: unknown }
interface Semver { raw: string; major: number; minor: number; patch: number; prerelease: string }
interface VersionDelta { kind: string; compare: number; major_changed: boolean }
interface PlacementImpactSummary { total_count: number; replace_in_place_count: number; already_matches_count: number; manual_count: number; blocked_count: number; drifted_count: number }
interface ExpectedCheck { kind: string; gate: string; required_status: unknown; source: string; description?: string; command?: string | null; name?: string; current_status?: string }
interface RollbackSnapshot { import_id: string; current: { release_version: string | null; release_hash: string | null } }
interface ImportSnapshot {
  import_id: string;
  artifact_type: string | null;
  artifact_id: string | null;
  artifact_name: string | null;
  source_project: string | null;
  import_record: ImportRecord;
  lock_entry: Partial<LockEntry>;
  placement_import: Partial<PlacementImport>;
  placements: Placement[];
  journal_events: JournalRecord[];
}
interface UpdatePlanArgs { target: string; smarchRoot: string; release: string; out: string; stdout: boolean; dryRun: boolean; compact: boolean; importIds: string[]; artifactId: string; artifactType: string; maxPlacements: number; maxChecks: number; maxJournal: number; help?: boolean }

function fail(message: string, code = 1): never {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function parseArgs(argv: string[]): UpdatePlanArgs {
  const options: UpdatePlanArgs = {
    target: process.cwd(),
    smarchRoot: "",
    release: "",
    out: "",
    stdout: false,
    dryRun: false,
    compact: false,
    importIds: [],
    artifactId: "",
    artifactType: "",
    maxPlacements: DEFAULT_MAX_PLACEMENTS,
    maxChecks: DEFAULT_MAX_CHECKS,
    maxJournal: DEFAULT_MAX_JOURNAL
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help") {
      options.help = true;
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
    if (arg === "--compact") {
      options.compact = true;
      continue;
    }

    const next = argv.at(index + 1);
    if (next === undefined) fail(`missing value for ${arg}`);
    applyValueOption(options, arg, next);

    index += 1;
  }

  if (!options.stdout && !options.out) options.stdout = true;
  if (options.artifactType && !["brick", "build"].includes(options.artifactType)) {
    fail(`--artifact-type must be "brick" or "build", got "${options.artifactType}"`);
  }

  return options;
}

function applyValueOption(options: UpdatePlanArgs, arg: string, next: string): void {
  const pathField = new Map<string, 'target' | 'smarchRoot' | 'release' | 'out'>([
    ['--target', 'target'], ['--smarch-root', 'smarchRoot'], ['--release', 'release'], ['--out', 'out'],
  ]).get(arg);
  if (pathField !== undefined) { options[pathField] = path.resolve(next); return; }
  if (arg === '--import-id') { options.importIds.push(next); return; }
  if (arg === '--artifact-id') { options.artifactId = next; return; }
  if (arg === '--artifact-type') { options.artifactType = next; return; }
  if (arg === '--max-placements') { options.maxPlacements = parsePositiveInt(next, arg); return; }
  if (arg === '--max-checks') { options.maxChecks = parsePositiveInt(next, arg); return; }
  if (arg === '--max-journal') { options.maxJournal = parsePositiveInt(next, arg); return; }
  fail(`unknown argument: ${arg}`);
}

function parsePositiveInt(value: unknown, label: string): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`${label} must be a non-negative integer`);
  return parsed;
}

function isObject(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (value instanceof Error) return value.message;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

function stringOr(value: unknown, fallback: string): string {
  return isNonEmptyString(value) ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return isNonEmptyString(value) ? value : null;
}

function safeArray<T>(value: readonly T[] | null | undefined): T[];
function safeArray(value: unknown): unknown[];
function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? Array.from(value as unknown[]) : [];
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ""))];
}

function uniqStrings(values: unknown): string[] {
  return uniq(
    safeArray(values)
      .map((value) => safeString(value).trim())
      .filter(Boolean)
  );
}

function incrementCounter(map: Record<string, number>, key: string): void {
  map[key] = (map[key] || 0) + 1;
}

function artifactIdAliases(value: unknown): string[] {
  const raw = safeString(value).trim();
  if (!raw) return [];
  const aliases = new Set([raw]);
  const parts = raw.split(".");
  if (parts.length >= 2 && parts[0] === parts[1]) {
    aliases.add(parts.slice(1).join("."));
  }
  return [...aliases];
}

function artifactIdsMatch(left: unknown, right: unknown): boolean {
  const leftAliases = new Set(artifactIdAliases(left));
  const rightAliases = artifactIdAliases(right);
  return rightAliases.some((alias) => leftAliases.has(alias));
}

function normalizePath(value: unknown): string {
  return safeString(value).split(path.sep).join("/");
}

function sortByDateDesc<T extends JsonRecord>(values: T[], key = "created_at"): T[] {
  return [...values].sort((left, right) => {
    const leftRecord = isObject(left.record) ? left.record : {};
    const rightRecord = isObject(right.record) ? right.record : {};
    const l = Date.parse(safeString((left[key] ?? leftRecord[key]) ?? 0));
    const r = Date.parse(safeString((right[key] ?? rightRecord[key]) ?? 0));
    return r - l;
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
}

async function readJsonLines(filePath: string): Promise<{ line_number: number; record: JournalRecord }[]> {
  const records: { line_number: number; record: JournalRecord }[] = [];
  const lines = (await fs.readFile(filePath, "utf8")).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    records.push({
      line_number: index + 1,
      record: JSON.parse(trimmed) as JournalRecord
    });
  }
  return records;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  return sha256(await fs.readFile(filePath));
}

function verificationRank(value: unknown): number {
  return VERIFICATION_RANK[safeString(value).toLowerCase()] ?? -1;
}

function compareVerification(left: unknown, right: unknown): number {
  return verificationRank(left) - verificationRank(right);
}

function parseSemver(value: unknown): Semver | null {
  const trimmed = safeString(value).trim();
  if (!SEMVER_RE.test(trimmed)) return null;
  const [core, pre = ""] = trimmed.split("-", 2);
  const [major, minor, patch] = core.split(".").map((part) => Number.parseInt(part, 10));
  return { raw: trimmed, major, minor, patch, prerelease: pre };
}

function compareSemver(left: unknown, right: unknown): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return 0;
  if (a.major !== b.major) return Math.sign(a.major - b.major);
  if (a.minor !== b.minor) return Math.sign(a.minor - b.minor);
  if (a.patch !== b.patch) return Math.sign(a.patch - b.patch);
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function summarizeVersionDelta(currentVersion: unknown, nextVersion: unknown): VersionDelta {
  const current = parseSemver(currentVersion);
  const next = parseSemver(nextVersion);
  if (!current || !next) {
    return {
      kind: currentVersion === nextVersion ? "same" : "unknown",
      compare: 0,
      major_changed: false
    };
  }
  const compare = compareSemver(currentVersion, nextVersion);
  const majorChanged = current.major !== next.major;
  if (compare === 0) return { kind: "same", compare, major_changed: majorChanged };
  if (compare < 0) {
    return {
      kind: majorChanged ? "major_upgrade" : "upgrade",
      compare,
      major_changed: majorChanged
    };
  }
  return {
    kind: majorChanged ? "major_downgrade" : "downgrade",
    compare,
    major_changed: majorChanged
  };
}

function dedupeBy<T>(values: T[], keyFn: (value: T) => string): T[] {
  const map = new Map<string, T>();
  for (const value of values) {
    const key = keyFn(value);
    if (!key || map.has(key)) continue;
    map.set(key, value);
  }
  return [...map.values()];
}

function makeIssue(severity: string, code: string, message: string, extra: JsonRecord = {}): PlanIssue {
  return {
    severity,
    code,
    message,
    ...extra
  };
}

function pushIssue(issues: PlanIssue[], severity: string, code: string, message: string, extra: JsonRecord = {}): void {
  issues.push(makeIssue(severity, code, message, extra));
}

function resolveRelativeToTarget(targetRoot: string, value: unknown, fallback: string): string {
  const candidate = safeString(value).trim();
  if (!candidate) return fallback;
  return path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(targetRoot, candidate);
}

function toRecordMap<T>(values: T[], keyFn: (value: T) => unknown): Map<string, T> {
  const map = new Map<string, T>();
  for (const value of safeArray(values)) {
    const key = keyFn(value);
    if (!isNonEmptyString(key)) continue;
    map.set(key, value);
  }
  return map;
}

function groupBy<T>(values: T[], keyFn: (value: T) => unknown): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const value of safeArray(values)) {
    const key = keyFn(value);
    if (!isNonEmptyString(key)) continue;
    const group = map.get(key);
    if (group) group.push(value);
    else map.set(key, [value]);
  }
  return map;
}

function clampItems<T>(values: T[], maxItems: number): { items: T[]; truncated: number } {
  if (maxItems < 0) return { items: values, truncated: 0 };
  if (values.length <= maxItems) return { items: values, truncated: 0 };
  return {
    items: values.slice(0, maxItems),
    truncated: values.length - maxItems
  };
}

function gatherCurrentEnvBindings(importRecord: ImportRecord, placementsForImport: Placement[]): EnvBinding[] {
  return mergeEnvBindings([
    ...importEnvBindings(importRecord),
    ...placementEnvBindings(placementsForImport),
  ]);
}

function importEnvBindings(importRecord: ImportRecord): EnvBinding[] {
  const results: EnvBinding[] = [];
  const contracts = isObject(importRecord.contracts) ? importRecord.contracts : {};
  const importEnv = isObject(contracts.env) ? contracts.env : {};
  const requiredSet = new Set(uniqStrings(importEnv.required));

  for (const variable of safeArray(importEnv.variables)) {
    if (typeof variable === "string") {
      results.push({
        name: variable,
        surface: "server",
        required: requiredSet.has(variable),
        bound_to: null,
        source: "import.contracts.env.variables"
      });
      continue;
    }
    if (!isObject(variable) || !isNonEmptyString(variable.name)) continue;
    results.push({
      name: variable.name,
      surface: stringOr(variable.surface, stringOr(variable.scope, "server")),
      required: requiredSet.has(variable.name),
      bound_to: (variable.bound_to ?? variable.example) ?? null,
      source: "import.contracts.env.variables"
    });
  }

  for (const name of requiredSet) {
    if (!results.find((binding) => binding.name === name)) {
      results.push({
        name,
        surface: "server",
        required: true,
        bound_to: null,
        source: "import.contracts.env.required"
      });
    }
  }

  for (const name of uniqStrings(contracts.env_bindings)) {
    if (!results.find((binding) => binding.name === name)) {
      results.push({
        name,
        surface: "server",
        required: false,
        bound_to: null,
        source: "import.contracts.env_bindings"
      });
    }
  }

  return results;
}

function placementEnvBindings(placementsForImport: Placement[]): EnvBinding[] {
  const results: EnvBinding[] = [];
  for (const placement of placementsForImport) {
    for (const binding of safeArray(placement.env_bindings)) {
      if (!isObject(binding) || !isNonEmptyString(binding.name)) continue;
      results.push({
        name: binding.name,
        surface: stringOr(binding.surface, "server"),
        required: binding.required,
        bound_to: binding.bound_to ?? null,
        source: `placement:${placement.placement_id}`
      });
    }
  }
  return results;
}

function mergeEnvBindings(results: EnvBinding[]): EnvBinding[] {
  const merged = new Map<string, EnvBinding>();
  for (const binding of results) {
    const key = `${binding.name}::${binding.surface}`;
    if (!merged.has(key)) {
      merged.set(key, { ...binding });
      continue;
    }
    const current = merged.get(key);
    if (!current) continue;
    current.required = current.required || binding.required;
    current.bound_to = (current.bound_to ?? binding.bound_to) ?? null;
    current.source = uniqStrings([current.source, binding.source]).join(", ");
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function summarizeReleaseCandidate(releaseArtifact: Release) {
  if (!isObject(releaseArtifact) || !isObject(releaseArtifact.release)) return null;
  const release = releaseArtifact.release;
  return {
    artifact_type: nullableString(release.artifact_type),
    artifact_id: nullableString(release.artifact_id),
    release_id: nullableString(release.release_id),
    version: nullableString(release.version),
    status: nullableString(release.status),
    channel: nullableString(release.channel),
    content_hash: nullableString(release.content_hash),
    breaking: Boolean(release.breaking),
    verification_status: nullableString(releaseArtifact.verification.status),
    rollback_supported: Boolean(releaseArtifact.verification.rollback_supported),
    source_project: nullableString(release.source_project),
    required_env: uniqStrings(releaseArtifact.contracts.required_env),
    optional_env: uniqStrings(releaseArtifact.contracts.optional_env),
    forbidden_env: uniqStrings(releaseArtifact.contracts.forbidden_env),
    smoke_commands: uniqStrings(releaseArtifact.verification.smoke_commands),
    manual_steps: uniqStrings(releaseArtifact.migration?.manual_steps),
    migration_commands: uniqStrings(releaseArtifact.migration?.commands),
    rollback_commands: uniqStrings(releaseArtifact.rollback?.commands),
    rollback_notes: nullableString(releaseArtifact.rollback?.notes),
    dependency_refs: safeArray(releaseArtifact.contracts.dependency_refs)
      .filter(isObject)
      .filter((ref) => isNonEmptyString(ref.artifact_id) && isNonEmptyString(ref.artifact_type))
      .map((ref) => ({
        artifact_type: ref.artifact_type,
        artifact_id: ref.artifact_id,
        required: Boolean(ref.required),
        version_range: nullableString(ref.version_range),
        release_ref: nullableString(ref.release_ref)
      })),
    artifacts: safeArray(releaseArtifact.content.artifacts)
      .filter(isObject)
      .filter((artifact) => isNonEmptyString(artifact.path))
      .map((artifact) => ({
        path: normalizePath(artifact.path),
        kind: stringOr(artifact.kind, "file"),
        sha256: HASH_RE.test((artifact.sha256 || "")) ? artifact.sha256 : null
      })),
    included_paths: uniqStrings(releaseArtifact.content.included_paths).map((entry) => normalizePath(entry)),
    checks: safeArray(releaseArtifact.verification.checks)
      .filter(isObject)
      .filter((check) => isNonEmptyString(check.name))
      .map((check) => ({
        name: check.name,
        status: stringOr(check.status, "skipped"),
        command: nullableString(check.command),
        evidence_path: nullableString(check.evidence_path)
      }))
  };
}

type ReleaseSummary = NonNullable<ReturnType<typeof summarizeReleaseCandidate>> & { raw_contract_hashes?: JsonRecord | null };

function releaseAppliesToImport(importSnapshot: Pick<ImportSnapshot, 'artifact_type' | 'artifact_id'>, releaseSummary: ReleaseSummary | null): boolean {
  if (!releaseSummary) return false;
  return importSnapshot.artifact_type === releaseSummary.artifact_type
    && artifactIdsMatch(importSnapshot.artifact_id, releaseSummary.artifact_id);
}

function matchReleaseArtifactToPlacement(placement: Placement, releaseSummary: ReleaseSummary | null) {
  if (!releaseSummary) {
    return {
      relation: "no_release",
      candidate_sha256: null,
      included: null
    };
  }

  const sourcePath = normalizePath(placement.source_path);
  for (const artifact of safeArray(releaseSummary.artifacts)) {
    if (artifact.path === sourcePath) {
      return {
        relation: "exact_path",
        candidate_sha256: artifact.sha256 ?? null,
        included: true,
        artifact_kind: artifact.kind
      };
    }
    if (artifact.kind === "directory" && (sourcePath === artifact.path || sourcePath.startsWith(`${artifact.path}/`))) {
      return {
        relation: "directory_member",
        candidate_sha256: null,
        included: true,
        artifact_kind: artifact.kind
      };
    }
  }

  for (const includedPath of safeArray(releaseSummary.included_paths)) {
    if (sourcePath === includedPath || sourcePath.startsWith(`${includedPath}/`)) {
      return {
        relation: "included_path",
        candidate_sha256: null,
        included: true,
        artifact_kind: null
      };
    }
  }

  return {
    relation: "missing_from_release",
    candidate_sha256: null,
    included: false
  };
}

async function collectPlacementImpact({ targetRoot, placement, releaseSummary, trustPolicy }: { targetRoot: string; placement: Placement; releaseSummary: ReleaseSummary | null; trustPolicy?: unknown }) {
  const policy = isObject(trustPolicy) ? trustPolicy : {};
  const targetAbsolutePath = path.resolve(targetRoot, placement.target_path || "");
  const exists = await pathExists(targetAbsolutePath);
  const currentHash = exists ? await sha256File(targetAbsolutePath) : null;
  const recordedHash = placement.target_hash ?? null;
  const sourceHash = placement.source_hash ?? null;
  const drifted = Boolean(exists && recordedHash && currentHash && currentHash !== recordedHash);
  const localOverrides = safeArray(placement.local_overrides);
  const overrideCount = localOverrides.length;
  const requiredAdapterPoints = safeArray(placement.adapter_points).filter(isObject).filter((point) => point.required);
  const pendingAdapterCount = requiredAdapterPoints.filter((point) => point.status !== "bound").length;
  const ownership = placement.ownership;
  const replaceable = ownership.replaceable;
  const managed = ownership.mode.toLowerCase() === "managed";
  const releaseMatch = matchReleaseArtifactToPlacement(placement, releaseSummary);
  const { impact, reasons } = classifyPlacementImpact({
    exists, drifted, overrideCount, managed, replaceable, pendingAdapterCount,
    releaseSummary, releaseMatch, currentHash, allowLocalOverrides: policy.allow_local_overrides,
  });

  return {
    placement_id: placement.placement_id || null,
    target_path: placement.target_path || null,
    kind: placement.kind,
    exists,
    ownership: {
      mode: nullableString(ownership.mode),
      owner: nullableString(ownership.owner),
      replaceable
    },
    current_hash: currentHash,
    recorded_target_hash: recordedHash,
    source_hash: sourceHash,
    drifted,
    override_count: overrideCount,
    pending_adapter_points: pendingAdapterCount,
    release_match: releaseMatch,
    impact,
    reasons: uniqStrings(reasons),
    local_override_kinds: uniqStrings(localOverrides.filter(isObject).map((override) => override.kind).filter(Boolean))
  };
}

function classifyPlacementImpact(input: {
  exists: boolean; drifted: boolean; overrideCount: number; managed: boolean; replaceable: boolean;
  pendingAdapterCount: number; releaseSummary: ReleaseSummary | null;
  releaseMatch: ReturnType<typeof matchReleaseArtifactToPlacement>; currentHash: string | null;
  allowLocalOverrides: unknown;
}): { impact: string; reasons: string[] } {
  const reasons: string[] = [];
  let impact = "verify_only";
  if (!input.exists) { impact = "blocked"; reasons.push("target_missing"); }
  if (input.drifted) { impact = "manual_review"; reasons.push("target_drifted"); }
  if (input.overrideCount > 0) { impact = "manual_review"; reasons.push("local_overrides"); }
  if (!input.managed || !input.replaceable) {
    if (impact !== "blocked") impact = "manual_review";
    reasons.push("non_replaceable_ownership");
  }
  if (input.pendingAdapterCount > 0) {
    if (impact !== "blocked") impact = "manual_review";
    reasons.push("pending_adapter_points");
  }
  ({ impact } = applyReleaseImpact(input, impact, reasons));
  if (input.allowLocalOverrides === false && input.overrideCount > 0) {
    impact = "blocked";
    reasons.push("trust_policy_blocks_local_overrides");
  }
  return { impact, reasons };
}

function applyReleaseImpact(
  input: Parameters<typeof classifyPlacementImpact>[0],
  currentImpact: string,
  reasons: string[],
): { impact: string } {
  if (!input.releaseSummary) return { impact: currentImpact };
  let impact = currentImpact;
  if (!input.releaseMatch.included) {
    if (impact !== "blocked") impact = "manual_review";
    reasons.push("placement_not_in_release");
  } else if (impact === "verify_only") impact = "replace_in_place";
  if (input.releaseMatch.candidate_sha256 && input.currentHash === input.releaseMatch.candidate_sha256) {
    impact = "already_matches_candidate";
    reasons.push("candidate_hash_matches_current");
  }
  return { impact };
}

type PlacementImpact = Awaited<ReturnType<typeof collectPlacementImpact>>;

function collectTrustPolicyIssues({
  importSnapshot,
  releaseSummary,
  lockEntry,
  buildLock,
  envSummary,
  contractDelta,
  placementImpactSummary
}: {
  importSnapshot: ImportSnapshot;
  releaseSummary: ReleaseSummary | null;
  lockEntry: ImportSnapshot['lock_entry'];
  buildLock: ImportLock;
  envSummary: ReturnType<typeof buildEnvPlan>;
  contractDelta: ReturnType<typeof summarizeContractDelta>;
  placementImpactSummary: PlacementImpactSummary;
}): PlanIssue[] {
  const issues: PlanIssue[] = [];
  collectInstalledTrustIssues(issues, importSnapshot, lockEntry, buildLock, envSummary, placementImpactSummary);
  if (releaseSummary) collectReleaseTrustIssues(issues, importSnapshot.import_id, releaseSummary, buildLock, contractDelta);
  return issues;
}

function collectInstalledTrustIssues(
  issues: PlanIssue[], snapshot: ImportSnapshot, lockEntry: ImportSnapshot['lock_entry'], buildLock: ImportLock,
  envSummary: ReturnType<typeof buildEnvPlan>, impact: PlacementImpactSummary,
): void {
  const { trust_policy: trust, verification_policy: verification } = buildLock;
  if ((lockEntry.local_overrides ?? 0) > 0 && !trust.allow_local_overrides) {
    pushIssue(issues, "error", "local_overrides_disallowed", "Local overrides are present but trust_policy.allow_local_overrides is false", { import_id: snapshot.import_id, local_overrides: lockEntry.local_overrides });
  }
  if (envSummary.missing_required.length > 0) {
    const severity = verification.fail_on_missing_env ? "error" : "warning";
    const message = verification.fail_on_missing_env ? "Required env bindings are missing for this import" : "Required env bindings are missing and must be set before update";
    pushIssue(issues, severity, "missing_required_env", message, { import_id: snapshot.import_id, env_names: envSummary.missing_required });
  }
  if (impact.drifted_count > 0) {
    pushIssue(issues, trust.allow_local_overrides ? "warning" : "error", "placement_drift", "One or more managed placements have drifted from their recorded target hash", { import_id: snapshot.import_id, drifted_count: impact.drifted_count });
  }
  if (impact.blocked_count > 0) {
    pushIssue(issues, "error", "blocked_placements", "One or more placements cannot be safely replaced automatically", { import_id: snapshot.import_id, blocked_count: impact.blocked_count });
  }
}

function collectReleaseTrustIssues(
  issues: PlanIssue[], importId: string, release: ReleaseSummary, buildLock: ImportLock,
  contractDelta: ReturnType<typeof summarizeContractDelta>,
): void {
  const trust = buildLock.trust_policy;
  const allowedStatuses = uniqStrings(trust.allowed_release_statuses);
  if (allowedStatuses.length > 0 && (!release.status || !allowedStatuses.includes(release.status))) {
    pushIssue(issues, "error", "release_status_disallowed", `Release status "${release.status ?? ""}" is not allowed by trust policy`, { import_id: importId, allowed_statuses: allowedStatuses });
  }
  if (release.status === "yanked" && trust.fail_on_yanked_release) pushIssue(issues, "error", "yanked_release", "Trust policy blocks updates to yanked releases", { import_id: importId });
  if (trust.fail_on_breaking_upgrade && release.breaking) pushIssue(issues, "error", "breaking_upgrade", "Release is marked as breaking and trust policy blocks automatic breaking upgrades", { import_id: importId, release_version: release.version });
  collectReleaseVerificationIssues(issues, importId, release, buildLock, contractDelta);
}

function collectReleaseVerificationIssues(
  issues: PlanIssue[], importId: string, release: ReleaseSummary, buildLock: ImportLock,
  contractDelta: ReturnType<typeof summarizeContractDelta>,
): void {
  const trust = buildLock.trust_policy;
  const minimum = trust.minimum_verification_status;
  if (minimum && compareVerification(release.verification_status, minimum) < 0) {
    pushIssue(issues, "error", "verification_below_policy", `Release verification status "${release.verification_status ?? "unverified"}" is below minimum "${minimum}"`, { import_id: importId, minimum_verification_status: minimum });
  }
  const hashes = isObject(release.raw_contract_hashes) ? release.raw_contract_hashes : null;
  if (trust.require_contract_hashes && (!hashes || Object.keys(hashes).length === 0)) {
    pushIssue(issues, "error", "missing_contract_hashes", "Trust policy requires release contract hashes, but none were provided", { import_id: importId });
  }
  if (!contractDelta.changed) return;
  const blocked = buildLock.verification_policy.fail_on_contract_delta;
  const message = blocked ? "Release changes env contract expectations and verification policy blocks contract deltas" : "Release changes env contract expectations and needs review";
  pushIssue(issues, blocked ? "error" : "warning", "contract_delta", message, { import_id: importId, delta: contractDelta });
}

function compareCurrentAlignment(importSnapshot: ImportSnapshot) {
  const importRecord = importSnapshot.import_record;
  const lockEntry = importSnapshot.lock_entry;
  const placementImport = importSnapshot.placement_import;

  const lockVsPlacement: JsonRecord = {
    comparable: Object.keys(lockEntry).length > 0 && Object.keys(placementImport).length > 0,
    artifact_type_match: compareOptional(lockEntry.artifact_type, placementImport.artifact_type),
    artifact_id_match: compareOptional(lockEntry.artifact_id, placementImport.artifact_id, artifactIdsMatch),
    release_version_match: compareOptional(lockEntry.release_version, placementImport.release_version),
    release_hash_match: compareOptional(lockEntry.release_hash, placementImport.release_hash)
  };
  const comparableFlags = [
    lockVsPlacement.artifact_type_match,
    lockVsPlacement.artifact_id_match,
    lockVsPlacement.release_version_match,
    lockVsPlacement.release_hash_match
  ].filter((value) => value !== null);
  lockVsPlacement.fully_aligned = comparableFlags.length > 0 ? comparableFlags.every(Boolean) : null;

  return {
    import_vs_lock: {
      comparable: Object.keys(importRecord).length > 0 && Object.keys(lockEntry).length > 0,
      artifact_type_match: compareOptional(importRecord.artifact_type, lockEntry.artifact_type),
      artifact_id_match: compareOptional(importRecord.artifact_id, lockEntry.artifact_id, artifactIdsMatch)
    },
    lock_vs_placement: lockVsPlacement
  };
}

function compareOptional(left: unknown, right: unknown, matcher: (a: unknown, b: unknown) => boolean = (a, b) => a === b): boolean | null {
  return left && right ? matcher(left, right) : null;
}

function createBuildGraphContext(buildLock: ImportLock) {
  const selectedBuilds = safeArray(buildLock.selected_builds);
  const resolvedBricks = safeArray(buildLock.resolved_bricks);
  const graphNodes = safeArray(buildLock.frozen_dependency_graph.nodes);
  const graphEdges = safeArray(buildLock.frozen_dependency_graph.edges);
  const selectedBuildsById = toRecordMap(selectedBuilds, (entry) => entry.import_id);
  const resolvedBricksById = toRecordMap(resolvedBricks, (entry) => entry.import_id);
  const nodeById = toRecordMap(graphNodes, (entry) => entry.node_id);
  const outgoing = new Map<string, typeof graphEdges>();
  const incoming = new Map<string, typeof graphEdges>();

  for (const edge of graphEdges) {
    if (!isObject(edge) || !isNonEmptyString(edge.from) || !isNonEmptyString(edge.to)) continue;
    const outgoingEdges = outgoing.get(edge.from) ?? [];
    outgoingEdges.push(edge);
    outgoing.set(edge.from, outgoingEdges);
    const incomingEdges = incoming.get(edge.to) ?? [];
    incomingEdges.push(edge);
    incoming.set(edge.to, incomingEdges);
  }

  return {
    selectedBuildsById,
    resolvedBricksById,
    nodeById,
    outgoing,
    incoming,
    selectedBuildIds: new Set(selectedBuilds.map((entry) => entry.import_id).filter(Boolean)),
    resolvedBrickIds: new Set(resolvedBricks.map((entry) => entry.import_id).filter(Boolean)),
    graphNodeCount: graphNodes.length,
    graphEdgeCount: graphEdges.length
  };
}

type BuildGraphContext = ReturnType<typeof createBuildGraphContext>;

function collectBuildContext(importSnapshot: ImportSnapshot, buildGraph: BuildGraphContext) {
  const importId = importSnapshot.import_id;
  const selectedBuildEntry = buildGraph.selectedBuildsById.get(importId) ?? null;
  const resolvedBrickEntry = buildGraph.resolvedBricksById.get(importId) ?? null;
  const role = selectedBuildEntry
    ? "selected_build"
    : resolvedBrickEntry
      ? "resolved_brick"
      : "standalone";
  const directDependencies = safeArray(buildGraph.outgoing.get(importId));
  const directDependents = safeArray(buildGraph.incoming.get(importId));
  const parentBuildIds = uniqStrings(
    directDependents
      .map((edge) => edge.from)
      .filter((edgeImportId) => buildGraph.selectedBuildIds.has(edgeImportId))
  );
  if (selectedBuildEntry) parentBuildIds.unshift(importId);
  const uniqueParentBuildIds = uniqStrings(parentBuildIds);
  const resolvedBrickIds = uniqStrings(
    directDependencies
      .map((edge) => edge.to)
      .filter((edgeImportId) => buildGraph.resolvedBrickIds.has(edgeImportId))
  );

  return {
    role,
    graph_node_present: buildGraph.nodeById.has(importId),
    selected_build_import_ids: uniqueParentBuildIds,
    selected_build_artifacts: uniqueParentBuildIds.map((buildImportId) => graphArtifact(buildImportId, buildGraph, "build")),
    resolved_brick_import_ids: role === "selected_build"
      ? resolvedBrickIds
      : resolvedBrickEntry
        ? [importId]
        : [],
    resolved_brick_artifacts: (role === "selected_build" ? resolvedBrickIds : resolvedBrickEntry ? [importId] : [])
      .map((brickImportId) => graphArtifact(brickImportId, buildGraph, "brick")),
    direct_dependency_import_ids: uniqStrings(directDependencies.map((edge) => edge.to)),
    direct_dependent_import_ids: uniqStrings(directDependents.map((edge) => edge.from)),
    graph_relations: {
      outgoing: directDependencies.map((edge) => ({ relation: edge.relation, to: edge.to })),
      incoming: directDependents.map((edge) => ({ relation: edge.relation, from: edge.from }))
    }
  };
}

function graphArtifact(importId: string, graph: BuildGraphContext, kind: "build" | "brick") {
  const entry = kind === "build" ? graph.selectedBuildsById.get(importId) : graph.resolvedBricksById.get(importId);
  const node = graph.nodeById.get(importId);
  return {
    import_id: importId,
    artifact_id: entry?.artifact_id ?? node?.artifact_id ?? null,
    verification_status: entry?.verification_status ?? null,
    trust_tier: entry?.trust_tier ?? null
  };
}

function summarizeReleaseCompatibility({ importSnapshot, releaseSummary, buildLock, placementImpacts, versionDelta }: { importSnapshot: ImportSnapshot; releaseSummary: ReleaseSummary | null; buildLock: ImportLock; placementImpacts: PlacementImpact[]; versionDelta: VersionDelta }) {
  const placementRelations: Record<string, number> = {};
  for (const placement of placementImpacts) incrementCounter(placementRelations, placement.release_match.relation || "no_release");
  const minimumVerificationStatus = buildLock.trust_policy.minimum_verification_status ?? null;
  const contractHashesPresent = (isObject(releaseSummary?.raw_contract_hashes) && Object.keys(releaseSummary.raw_contract_hashes).length > 0);
  return {
    current_alignment: compareCurrentAlignment(importSnapshot),
    candidate_alignment: releaseSummary ? {
      artifact_match: releaseAppliesToImport(importSnapshot, releaseSummary),
      allowed_status: uniqStrings(buildLock.trust_policy.allowed_release_statuses).length > 0
        ? Boolean(releaseSummary.status && uniqStrings(buildLock.trust_policy.allowed_release_statuses).includes(releaseSummary.status))
        : null,
      minimum_verification_status: minimumVerificationStatus,
      meets_minimum_verification: minimumVerificationStatus
        ? compareVerification(releaseSummary.verification_status, minimumVerificationStatus) >= 0
        : null,
      version_delta: versionDelta,
      breaking: releaseSummary.breaking,
      rollback_supported: releaseSummary.rollback_supported,
      contract_hashes_present: contractHashesPresent,
      dependency_ref_count: safeArray(releaseSummary.dependency_refs).length
    } : null,
    placement_coverage: {
      total: placementImpacts.length,
      by_relation: placementRelations,
      missing_from_release_count: placementRelations.missing_from_release || 0,
      exact_path_count: placementRelations.exact_path || 0,
      directory_member_count: placementRelations.directory_member || 0,
      included_path_count: placementRelations.included_path || 0,
      no_release_count: placementRelations.no_release || 0
    }
  };
}

function buildEnvPlan(currentBindings: EnvBinding[], releaseSummary: ReleaseSummary | null) {
  const releaseRequired = new Set(uniqStrings(releaseSummary?.required_env));
  const releaseOptional = new Set(uniqStrings(releaseSummary?.optional_env));
  const releaseForbidden = new Set(uniqStrings(releaseSummary?.forbidden_env));
  const currentNames = new Set<string>(currentBindings.map((binding) => binding.name));
  const allNames = new Set<string>([
    ...currentNames,
    ...releaseRequired,
    ...releaseOptional,
    ...releaseForbidden
  ]);

  const sets = { required: releaseRequired, optional: releaseOptional, forbidden: releaseForbidden };
  const items = [...allNames].sort((left, right) => left.localeCompare(right))
    .map((name) => buildEnvPlanItem(name, currentBindings, sets, Boolean(releaseSummary)));

  return {
    items,
    missing_required: items.filter((item) => item.release_state === "required" && item.current_state !== "present")
      .map((item) => item.name),
    forbidden_present: items.filter((item) => item.release_state === "forbidden" && item.current_state === "present")
      .map((item) => item.name)
  };
}

function buildEnvPlanItem(
  name: string,
  bindings: EnvBinding[],
  sets: { required: Set<string>; optional: Set<string>; forbidden: Set<string> },
  hasRelease: boolean,
): EnvPlanItem {
  const current = bindings.filter((binding) => binding.name === name);
  const present = isNonEmptyString(process.env[name]) || current.some((binding) => isNonEmptyString(binding.bound_to));
  const releaseState = releaseEnvState(name, sets, hasRelease);
  return {
    name,
    surface: current.at(0)?.surface ?? "server",
    required: current.some((binding) => binding.required) || releaseState === "required",
    current_state: present ? "present" : current.length > 0 ? "missing" : "undeclared",
    release_state: releaseState,
    action: envPlanAction(releaseState, present, current, hasRelease),
    bound_to: current.find((binding) => binding.bound_to)?.bound_to ?? null,
  };
}

function releaseEnvState(name: string, sets: { required: Set<string>; optional: Set<string>; forbidden: Set<string> }, hasRelease: boolean): string {
  if (sets.forbidden.has(name)) return "forbidden";
  if (sets.required.has(name)) return "required";
  if (sets.optional.has(name)) return "optional";
  return hasRelease ? "removed" : "unknown";
}

function envPlanAction(state: string, present: boolean, current: EnvBinding[], hasRelease: boolean): string {
  if (state === "required" && !present) return "set_before_update";
  if (state === "forbidden" && present) return "remove_before_update";
  if (state === "removed" && current.length > 0) return "review_unused_binding";
  if (state === "required" || state === "optional") return "verify_binding";
  if (!hasRelease && current.length > 0) return current.some((binding) => binding.required) && !present ? "set_before_update" : "verify_binding";
  return "none";
}

function summarizeContractDelta(importRecord: ImportRecord, releaseSummary: ReleaseSummary | null) {
  if (!releaseSummary) {
    return {
      changed: false,
      required_added: [],
      required_removed: [],
      forbidden_added: [],
      optional_added: []
    };
  }

  const envName = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (isObject(value) && isNonEmptyString(value.name)) return value.name;
    return "";
  };

  const currentRequired = new Set(uniqStrings(safeArray(importRecord.contracts?.env?.required).map(envName)));
  const currentDeclared = new Set(uniqStrings(importRecord.contracts?.env_bindings));
  for (const variable of safeArray(importRecord.contracts?.env?.variables)) {
    const name = envName(variable);
    if (name) currentDeclared.add(name);
  }

  const nextRequired = new Set(uniqStrings(releaseSummary.required_env));
  const nextOptional = new Set(uniqStrings(releaseSummary.optional_env));
  const nextForbidden = new Set(uniqStrings(releaseSummary.forbidden_env));

  const requiredAdded = [...nextRequired].filter((name) => !currentRequired.has(name));
  const requiredRemoved = [...currentRequired].filter((name) => !nextRequired.has(name));
  const optionalAdded = [...nextOptional].filter((name) => !currentDeclared.has(name) && !nextRequired.has(name));
  const forbiddenAdded = [...nextForbidden].filter((name) => currentDeclared.has(name) || currentRequired.has(name));

  return {
    changed: requiredAdded.length > 0 || requiredRemoved.length > 0 || optionalAdded.length > 0 || forbiddenAdded.length > 0,
    required_added: requiredAdded,
    required_removed: requiredRemoved,
    optional_added: optionalAdded,
    forbidden_added: forbiddenAdded
  };
}

function buildExpectedChecks({ importRecord, buildLock, releaseSummary, maxChecks }: { importRecord: ImportRecord; buildLock: ImportLock; releaseSummary: ReleaseSummary | null; maxChecks: number }) {
  const verificationPolicy = buildLock.verification_policy;
  const requiredStatus = verificationPolicy.required_check_status;
  const checks = [
    ...policyExpectedChecks(importRecord, buildLock, requiredStatus),
    ...releaseExpectedChecks(releaseSummary, requiredStatus),
  ];

  const deduped = dedupeBy(checks, (check) => JSON.stringify([
    check.kind,
    check.command ?? "",
    check.name ?? "",
    check.description ?? "",
    check.gate || ""
  ]));
  const { items, truncated } = clampItems(deduped, maxChecks);
  return { items, truncated, total: deduped.length };
}

function policyExpectedChecks(importRecord: ImportRecord, buildLock: ImportLock, requiredStatus: unknown): ExpectedCheck[] {
  const policy = buildLock.verification_policy;
  const checks: ExpectedCheck[] = [];
  const add = (enabled: boolean | undefined, kind: string, gate: string, description: string): void => {
    if (enabled) checks.push({ kind, gate, required_status: requiredStatus, source: "lock.verification_policy", description });
  };
  add(policy.run_import_resolution, "import_resolution", "post_update", "Resolve imports and runtime providers against the updated placements");
  add(policy.run_env_truthing, "env_truthing", "pre_update", "Verify required env bindings are present and forbidden env bindings are absent");
  add(policy.run_rls_truthing, "rls_truthing", "post_update", "Re-check RLS and authz assumptions after the update");
  if (policy.run_declared_tests) {
    for (const command of uniqStrings(importRecord.verification?.test_commands)) {
      checks.push({ kind: "declared_test_command", gate: "post_update", required_status: requiredStatus, source: "import.verification.test_commands", command });
    }
  }
  for (const description of uniqStrings(policy.post_install_checks)) {
    checks.push({ kind: "post_install_checklist", gate: "manual", required_status: "warning", source: "lock.verification_policy.post_install_checks", description });
  }
  return checks;
}

function releaseExpectedChecks(release: ReleaseSummary | null, requiredStatus: unknown): ExpectedCheck[] {
  const checks: ExpectedCheck[] = [];
  for (const command of uniqStrings(release?.smoke_commands)) checks.push({ kind: "release_smoke_command", gate: "post_update", required_status: requiredStatus, source: "release.verification.smoke_commands", command });
  for (const check of safeArray(release?.checks)) checks.push({ kind: "release_check", gate: "post_update", required_status: requiredStatus, source: "release.verification.checks", name: check.name, command: check.command ?? null, current_status: check.status });
  for (const command of uniqStrings(release?.migration_commands)) checks.push({ kind: "migration_command", gate: "post_update", required_status: requiredStatus, source: "release.migration.commands", command });
  for (const description of uniqStrings(release?.manual_steps)) checks.push({ kind: "manual_migration_step", gate: "manual", required_status: "warning", source: "release.migration.manual_steps", description });
  return checks;
}

function buildRollbackGuidance({ targetRoot, importSnapshot, journalEvents, releaseSummary, placementImpacts }: { targetRoot: string; importSnapshot: RollbackSnapshot; journalEvents: { record: JournalRecord }[]; releaseSummary: ReleaseSummary | null; placementImpacts: PlacementImpact[] }) {
  const impactedPaths = uniqStrings(placementImpacts.map((placement) => placement.target_path).filter(Boolean));
  const anchorEvent = latestSuccessfulJournalEvent(journalEvents);
  const releaseCommands = uniqStrings(releaseSummary?.rollback_commands);
  const actions = rollbackActions(targetRoot, impactedPaths);
  for (const command of releaseCommands) {
    actions.push({ kind: "release_rollback_command", description: command, command });
  }
  return {
    status: rollbackStatus(anchorEvent !== null, releaseCommands.length > 0 || isNonEmptyString(releaseSummary?.rollback_notes), impactedPaths.length),
    anchor_event_id: anchorEvent?.event_id ?? null,
    anchor_result: anchorEvent?.result ?? null,
    current_release_version: anchorEvent?.to_version ?? importSnapshot.current.release_version,
    current_release_hash: importSnapshot.current.release_hash ?? null,
    rollback_supported_by_release: releaseSummary?.rollback_supported ?? false,
    notes: rollbackNotes(importSnapshot.import_id, anchorEvent, releaseSummary?.rollback_notes),
    actions
  };
}

function latestSuccessfulJournalEvent(events: { record: JournalRecord }[]): JournalRecord | null {
  const successful = events.filter((event) => UPDATE_RESULT_SUCCESS.has(event.record.result ?? ""));
  return sortByDateDesc(successful).at(0)?.record ?? null;
}

function rollbackNotes(importId: string, anchor: JournalRecord | null, releaseNotes: string | null | undefined): string[] {
  return uniqStrings([
    releaseNotes ?? "",
    anchor ? `Use journal event ${String(anchor.event_id)} as the rollback anchor for ${importId}` : "",
    anchor ? "" : "No prior successful journal event was found for this import."
  ]);
}

function rollbackActions(targetRoot: string, impactedPaths: string[]) {
  return [
    {
      kind: "restore_target_paths",
      description: "Restore impacted target paths from version control or the current installed release snapshot",
      target_paths: impactedPaths
    },
    {
      kind: "restore_control_plane",
      description: "Restore .smarch control-plane files so placement hashes and release metadata match the rollback target",
      files: [
        ".smarch/imports.json",
        ".smarch/build-lock.json",
        ".smarch/placements.json",
        ".smarch/update-journal.jsonl"
      ]
    },
    {
      kind: "reverify_install",
      description: "Re-run post-rollback verification on the target project",
      command: `node tools/sma-import-verify.ts --target ${targetRoot}`
    }
  ];
}

function rollbackStatus(hasAnchor: boolean, hasReleaseRollback: boolean, impactedPathCount: number): string {
  if (hasAnchor && hasReleaseRollback) return "ready";
  return hasAnchor || impactedPathCount > 0 ? "partial" : "weak";
}

function buildDecision({ releaseSummary, issues, placementImpactSummary, envSummary, versionDelta }: { releaseSummary: ReleaseSummary | null; issues: PlanIssue[]; placementImpactSummary: PlacementImpactSummary; envSummary: ReturnType<typeof buildEnvPlan>; versionDelta: VersionDelta }) {
  const hasErrors = issues.some((issue) => issue.severity === "error");
  const hasWarnings = issues.some((issue) => issue.severity === "warning");
  const hasManualSignals = manualDecisionSignals(releaseSummary, placementImpactSummary, envSummary);
  const status = hasErrors ? "blocked" : hasWarnings || hasManualSignals || !releaseSummary ? "manual" : "safe";
  const reasons = decisionReasons(releaseSummary, placementImpactSummary, envSummary, versionDelta, issues);

  return {
    status,
    update_type: releaseSummary ? versionDelta.kind : "baseline",
    reasons: uniqStrings(reasons)
  };
}

function manualDecisionSignals(release: ReleaseSummary | null, impact: PlacementImpactSummary, env: ReturnType<typeof buildEnvPlan>): boolean {
  return impact.manual_count > 0 || impact.drifted_count > 0
    || env.forbidden_present.length > 0 || env.missing_required.length > 0
    || Boolean(release?.manual_steps.length);
}

function decisionReasons(
  release: ReleaseSummary | null, impact: PlacementImpactSummary, env: ReturnType<typeof buildEnvPlan>,
  versionDelta: VersionDelta, issues: PlanIssue[],
): string[] {
  const reasons: string[] = issues.map((issue) => issue.code);
  if (!release) reasons.push("no_release_artifact");
  if (versionDelta.kind === "same") reasons.push("same_version");
  if (versionDelta.major_changed) reasons.push("major_version_change");
  if (impact.blocked_count > 0) reasons.push("blocked_placements");
  if (impact.manual_count > 0) reasons.push("manual_review_placements");
  if (env.missing_required.length > 0) reasons.push("missing_required_env");
  if (env.forbidden_present.length > 0) reasons.push("forbidden_env_present");
  return uniqStrings(reasons);
}

async function loadPlanningContext(options: UpdatePlanArgs) {
  const targetRoot = path.resolve(options.target);
  const smarchRoot = options.smarchRoot || path.resolve(targetRoot, ".smarch");
  const buildLockPath = path.resolve(smarchRoot, "build-lock.json");
  if (!(await pathExists(buildLockPath))) fail(`missing build-lock.json at ${buildLockPath}`);
  const buildLock = await readJsonFile<ImportLock>(buildLockPath);
  const importsPath = resolveRelativeToTarget(targetRoot, buildLock.lock.imports_path, path.resolve(smarchRoot, "imports.json"));
  const placementsPath = resolveRelativeToTarget(targetRoot, buildLock.lock.placements_path, path.resolve(smarchRoot, "placements.json"));
  const updateJournalPath = resolveRelativeToTarget(targetRoot, buildLock.lock.update_journal_path, path.resolve(smarchRoot, "update-journal.jsonl"));
  if (!(await pathExists(importsPath))) fail(`missing imports.json at ${importsPath}`);
  if (!(await pathExists(placementsPath))) fail(`missing placements.json at ${placementsPath}`);
  const importsDoc = await readJsonFile<ImportsDocument>(importsPath);
  const placementsDoc = await readJsonFile<PlacementMap>(placementsPath);
  const journalRecords = await (await pathExists(updateJournalPath) ? readJsonLines(updateJournalPath) : Promise.resolve([]));
  const releaseArtifact = options.release ? await readJsonFile<Release>(options.release) : null;
  const releaseCandidate = releaseArtifact ? summarizeReleaseCandidate(releaseArtifact) : null;
  const releaseSummary: ReleaseSummary | null = releaseCandidate ? {
    ...releaseCandidate,
    raw_contract_hashes: isObject(releaseArtifact?.contracts.hashes) ? releaseArtifact.contracts.hashes : null,
  } : null;
  const buildGraph = createBuildGraphContext(buildLock);
  const lockEntries = [...safeArray(buildLock.selected_builds), ...safeArray(buildLock.resolved_bricks)];
  return { targetRoot, smarchRoot, buildLockPath, buildLock, importsPath, placementsPath, updateJournalPath,
    importsDoc, placementsDoc, journalRecords, releaseSummary, buildGraph, lockEntries };
}

type PlanningContext = Awaited<ReturnType<typeof loadPlanningContext>>;

function buildImportSnapshots(context: PlanningContext): ImportSnapshot[] {
  const { importsDoc, placementsDoc, journalRecords, lockEntries } = context;
  const lockByImportId = toRecordMap(lockEntries, (entry) => entry.import_id);
  const placementImportsByImportId = toRecordMap(placementsDoc.imports, (entry) => entry.import_id);
  const placementsByImportId = groupBy(placementsDoc.placements, (entry) => entry.import_id);
  const journalByImportId = groupBy(journalRecords.map((entry) => ({ ...entry.record, _line_number: entry.line_number })), (entry) => entry.import_id);
  const importIds = new Set<string>();
  for (const entry of safeArray(importsDoc.imports)) importIds.add(entry.import_id);
  for (const entry of placementsDoc.imports) importIds.add(entry.import_id);
  for (const entry of lockEntries) importIds.add(entry.import_id);
  return [...importIds].map((importId): ImportSnapshot => {
    const importRecord = safeArray(importsDoc.imports).find((entry) => entry.import_id === importId) ?? { import_id: importId };
    const lockEntry: Partial<LockEntry> = lockByImportId.get(importId) ?? {};
    const placementImport: Partial<PlacementImport> = placementImportsByImportId.get(importId) ?? {};
    return {
      import_id: importId,
      artifact_type: importRecord.artifact_type ?? placementImport.artifact_type ?? lockEntry.artifact_type ?? null,
      artifact_id: importRecord.artifact_id ?? placementImport.artifact_id ?? lockEntry.artifact_id ?? null,
      artifact_name: importRecord.artifact_name ?? null, source_project: importRecord.source_project ?? lockEntry.source_project ?? null,
      import_record: importRecord, lock_entry: lockEntry, placement_import: placementImport,
      placements: placementsByImportId.get(importId) ?? [],
      journal_events: sortByDateDesc(journalByImportId.get(importId) ?? []),
    };
  });
}

async function planImport(snapshot: ImportSnapshot, context: PlanningContext, options: UpdatePlanArgs) {
  const { targetRoot, buildLock, releaseSummary, buildGraph } = context;
  const exactRelease = releaseAppliesToImport(snapshot, releaseSummary) ? releaseSummary : null;
  const envSummary = buildEnvPlan(gatherCurrentEnvBindings(snapshot.import_record, snapshot.placements), exactRelease);
  const contractDelta = summarizeContractDelta(snapshot.import_record, exactRelease);
  const placementImpacts = await Promise.all(snapshot.placements.map((placement) => collectPlacementImpact({
    targetRoot, placement, releaseSummary: exactRelease, trustPolicy: buildLock.trust_policy,
  })));
  const impactSummary = summarizePlacementImpacts(placementImpacts);
  const trustIssues = collectTrustPolicyIssues({ importSnapshot: snapshot, releaseSummary: exactRelease,
    lockEntry: snapshot.lock_entry, buildLock, envSummary, contractDelta, placementImpactSummary: impactSummary });
  const currentVersion = snapshot.lock_entry.release_version ?? snapshot.placement_import.release_version ?? "";
  const versionDelta = summarizeVersionDelta(currentVersion, exactRelease?.version ?? currentVersion);
  const expectedChecks = buildExpectedChecks({ importRecord: snapshot.import_record, buildLock, releaseSummary: exactRelease,
    maxChecks: options.compact ? Math.min(25, options.maxChecks) : options.maxChecks });
  const decision = buildDecision({ releaseSummary: exactRelease, issues: trustIssues, placementImpactSummary: impactSummary, envSummary, versionDelta });
  const rollback = buildRollbackGuidance({ targetRoot, importSnapshot: rollbackSnapshot(snapshot),
    journalEvents: snapshot.journal_events.map((record) => ({ record })), releaseSummary: exactRelease, placementImpacts });
  const compatibility = summarizeReleaseCompatibility({ importSnapshot: snapshot, releaseSummary: exactRelease,
    buildLock, placementImpacts, versionDelta });
  return formatImportPlan(snapshot, exactRelease, options, { envSummary, contractDelta, placementImpacts,
    impactSummary, trustIssues, versionDelta, expectedChecks, decision, rollback, compatibility,
    buildContext: collectBuildContext(snapshot, buildGraph) });
}

function summarizePlacementImpacts(placements: PlacementImpact[]): PlacementImpactSummary {
  return {
    total_count: placements.length,
    replace_in_place_count: placements.filter((item) => item.impact === "replace_in_place").length,
    already_matches_count: placements.filter((item) => item.impact === "already_matches_candidate").length,
    manual_count: placements.filter((item) => item.impact === "manual_review").length,
    blocked_count: placements.filter((item) => item.impact === "blocked").length,
    drifted_count: placements.filter((item) => item.drifted).length,
  };
}

function rollbackSnapshot(snapshot: ImportSnapshot): RollbackSnapshot {
  return { import_id: snapshot.import_id, current: {
    release_version: snapshot.lock_entry.release_version ?? snapshot.placement_import.release_version ?? null,
    release_hash: snapshot.lock_entry.release_hash ?? snapshot.placement_import.release_hash ?? null,
  } };
}

interface ImportPlanParts {
  envSummary: ReturnType<typeof buildEnvPlan>;
  contractDelta: ReturnType<typeof summarizeContractDelta>;
  placementImpacts: PlacementImpact[];
  impactSummary: PlacementImpactSummary;
  trustIssues: PlanIssue[];
  versionDelta: VersionDelta;
  expectedChecks: ReturnType<typeof buildExpectedChecks>;
  decision: ReturnType<typeof buildDecision>;
  rollback: ReturnType<typeof buildRollbackGuidance>;
  compatibility: ReturnType<typeof summarizeReleaseCompatibility>;
  buildContext: ReturnType<typeof collectBuildContext>;
}

function formatImportPlan(
  snapshot: ImportSnapshot,
  release: ReleaseSummary | null,
  options: UpdatePlanArgs,
  parts: ImportPlanParts,
) {
  const placements = clampItems(parts.placementImpacts, options.compact ? Math.min(40, options.maxPlacements) : options.maxPlacements);
  const journal = clampItems(snapshot.journal_events.map(journalEventSummary), options.compact ? Math.min(8, options.maxJournal) : options.maxJournal);
  return {
    import_id: snapshot.import_id,
    artifact_type: snapshot.artifact_type,
    artifact_id: snapshot.artifact_id,
    artifact_name: snapshot.artifact_name,
    source_project: snapshot.source_project,
    current: currentImportState(snapshot),
    candidate: release ? releaseCandidateState(release) : null,
    build_context: parts.buildContext,
    release_compatibility: parts.compatibility,
    decision: parts.decision,
    version_delta: parts.versionDelta,
    trust_policy_issues: parts.trustIssues,
    env_bindings: parts.envSummary.items,
    impacts: importImpactCounts(snapshot, parts),
    impacted_placements: placements.items,
    impacted_placements_truncated: placements.truncated,
    contract_delta: parts.contractDelta,
    expected_checks: parts.expectedChecks.items,
    expected_checks_truncated: parts.expectedChecks.truncated,
    journal_context: { events: journal.items, truncated: journal.truncated },
    rollback_guidance: parts.rollback
  };
}

function currentImportState(snapshot: ImportSnapshot) {
  return {
    status: snapshot.import_record.status ?? snapshot.placement_import.status ?? null,
    imported_at: snapshot.import_record.imported_at ?? snapshot.placement_import.imported_at ?? null,
    release_version: snapshot.lock_entry.release_version ?? snapshot.placement_import.release_version ?? null,
    release_hash: snapshot.lock_entry.release_hash ?? snapshot.placement_import.release_hash ?? null,
    source_status: snapshot.import_record.source_status ?? null,
    clone_readiness: snapshot.import_record.clone_readiness ?? null,
    verification_status: snapshot.lock_entry.verification_status ?? null,
    trust_tier: snapshot.lock_entry.trust_tier ?? null,
    local_overrides: snapshot.lock_entry.local_overrides ?? 0,
    install_state: isObject(snapshot.import_record.install_state) ? snapshot.import_record.install_state : {}
  };
}

function releaseCandidateState(release: ReleaseSummary) {
  return {
    artifact_type: release.artifact_type, artifact_id: release.artifact_id, release_id: release.release_id,
    version: release.version, status: release.status, channel: release.channel, content_hash: release.content_hash,
    verification_status: release.verification_status, breaking: release.breaking,
    rollback_supported: release.rollback_supported
  };
}

function importImpactCounts(snapshot: ImportSnapshot, parts: ImportPlanParts) {
  return {
    placement_count: parts.impactSummary.total_count,
    replace_in_place_count: parts.impactSummary.replace_in_place_count,
    already_matches_count: parts.impactSummary.already_matches_count,
    manual_count: parts.impactSummary.manual_count,
    blocked_count: parts.impactSummary.blocked_count,
    drifted_count: parts.impactSummary.drifted_count,
    env_binding_count: parts.envSummary.items.length,
    expected_check_count: parts.expectedChecks.total,
    journal_event_count: snapshot.journal_events.length
  };
}

function journalEventSummary(event: JournalRecord) {
  return {
    event_id: event.event_id ?? null, event_type: event.event_type ?? null,
    created_at: event.created_at ?? null, result: event.result ?? null,
    from_version: event.from_version ?? null, to_version: event.to_version ?? null,
    rollback_ref: event.rollback_ref ?? null
  };
}

type ImportPlan = Awaited<ReturnType<typeof planImport>>;

function selectImports(snapshots: ImportSnapshot[], release: ReleaseSummary | null, options: UpdatePlanArgs): ImportSnapshot[] {
  const artifactId = options.artifactId || (release?.artifact_id ?? "");
  const artifactType = options.artifactType || (release?.artifact_type ?? "");
  return snapshots.filter((snapshot) => {
    if (options.importIds.length > 0 && !options.importIds.includes(snapshot.import_id)) return false;
    if (artifactId && !artifactIdsMatch(snapshot.artifact_id, artifactId)) return false;
    return !artifactType || snapshot.artifact_type === artifactType;
  });
}

function planCounts(plans: ImportPlan[], issueCount: number, checkCount: number) {
  const count = (predicate: (plan: ImportPlan) => boolean): number => plans.filter(predicate).length;
  return {
    import_count: plans.length,
    impacted_import_count: count((plan) => plan.impacts.placement_count > 0),
    placement_count: plans.reduce((sum, plan) => sum + plan.impacts.placement_count, 0),
    env_binding_count: plans.reduce((sum, plan) => sum + plan.impacts.env_binding_count, 0),
    trust_issue_count: issueCount,
    expected_check_count: checkCount,
    selected_build_count: count((plan) => plan.build_context.role === "selected_build"),
    resolved_brick_count: count((plan) => plan.build_context.role === "resolved_brick"),
    standalone_import_count: count((plan) => plan.build_context.role === "standalone"),
    safe_count: count((plan) => plan.decision.status === "safe"),
    manual_count: count((plan) => plan.decision.status === "manual"),
    blocked_count: count((plan) => plan.decision.status === "blocked")
  };
}

function aggregatePlans(plans: ImportPlan[], release: ReleaseSummary | null, options: UpdatePlanArgs) {
  const issues = dedupeBy(plans.flatMap((plan) => plan.trust_policy_issues),
    (issue) => JSON.stringify([issue.code, issue.import_id ?? "", issue.message]));
  const checks = dedupeBy(plans.flatMap((plan) => plan.expected_checks),
    (check) => JSON.stringify([check.kind, check.command ?? "", check.name ?? "", check.description ?? "", check.gate]));
  const explicit = release !== null || options.importIds.length > 0 || Boolean(options.artifactId) || Boolean(options.artifactType);
  const counts = planCounts(plans, issues.length, checks.length);
  if (counts.import_count === 0 && explicit) issues.push(noMatchingImportsIssue(release, options));
  counts.trust_issue_count = issues.length;
  const overallStatus = counts.import_count === 0 && explicit
    ? (release ? "blocked" : "manual")
    : counts.blocked_count > 0 ? "blocked" : counts.manual_count > 0 ? "manual" : "safe";
  return { issues, checks, counts, overallStatus };
}

function noMatchingImportsIssue(release: ReleaseSummary | null, options: UpdatePlanArgs): PlanIssue {
  return makeIssue(release ? "error" : "warning", "no_matching_imports",
    release ? "No installed import matches the selected release artifact." : "No installed import matches the requested selector.",
    { artifact_id: options.artifactId || (release?.artifact_id ?? null), artifact_type: options.artifactType || (release?.artifact_type ?? null) });
}

type PlanAggregate = ReturnType<typeof aggregatePlans>;

function buildPlanOutput(context: PlanningContext, options: UpdatePlanArgs, snapshots: ImportSnapshot[], plans: ImportPlan[], aggregate: PlanAggregate) {
  return {
    schema: PLAN_SCHEMA,
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    planner: { tool: "tools/sma-update-plan.ts", mode: context.releaseSummary ? "release_update" : "baseline_preflight", dry_run: options.dryRun, compact: options.compact },
    target: targetSummary(context),
    selection: selectionSummary(context, options, snapshots, plans),
    trust_policy: trustPolicySummary(context.buildLock),
    release_candidate: context.releaseSummary ? { ...releaseCandidateState(context.releaseSummary), source_project: context.releaseSummary.source_project, path: options.release } : null,
    summary: { overall_status: aggregate.overallStatus, ...aggregate.counts },
    trust_policy_issues: aggregate.issues,
    expected_checks: options.compact ? aggregate.checks.slice(0, 50) : aggregate.checks,
    imports: plans
  };
}

function targetSummary(context: PlanningContext) {
  return {
    root: context.targetRoot, smarch_root: context.smarchRoot, imports_path: context.importsPath,
    build_lock_path: context.buildLockPath, placements_path: context.placementsPath,
    update_journal_path: context.updateJournalPath
  };
}

function selectionSummary(context: PlanningContext, options: UpdatePlanArgs, snapshots: ImportSnapshot[], plans: ImportPlan[]) {
  return {
    import_ids: options.importIds,
    artifact_id: options.artifactId || (context.releaseSummary?.artifact_id ?? null),
    artifact_type: options.artifactType || (context.releaseSummary?.artifact_type ?? null),
    matched_import_count: plans.length,
    available_import_count: snapshots.length,
    build_context: {
      selected_build_count_in_lock: context.buildGraph.selectedBuildIds.size,
      resolved_brick_count_in_lock: context.buildGraph.resolvedBrickIds.size,
      matched_selected_build_count: plans.filter((plan) => plan.build_context.role === "selected_build").length,
      matched_resolved_brick_count: plans.filter((plan) => plan.build_context.role === "resolved_brick").length,
      graph_node_count: context.buildGraph.graphNodeCount,
      graph_edge_count: context.buildGraph.graphEdgeCount
    }
  };
}

function trustPolicySummary(buildLock: ImportLock) {
  return {
    allowed_release_statuses: uniqStrings(buildLock.trust_policy.allowed_release_statuses),
    minimum_verification_status: buildLock.trust_policy.minimum_verification_status ?? null,
    require_contract_hashes: buildLock.trust_policy.require_contract_hashes,
    allow_local_overrides: buildLock.trust_policy.allow_local_overrides,
    fail_on_yanked_release: Boolean(buildLock.trust_policy.fail_on_yanked_release),
    fail_on_breaking_upgrade: Boolean(buildLock.trust_policy.fail_on_breaking_upgrade),
    fail_on_missing_env: buildLock.verification_policy.fail_on_missing_env,
    fail_on_contract_delta: Boolean(buildLock.verification_policy.fail_on_contract_delta)
  };
}

async function emitPlan(output: ReturnType<typeof buildPlanOutput>, options: UpdatePlanArgs): Promise<void> {
  const json = JSON.stringify(output, null, 2);
  if (options.out && !options.dryRun) {
    await fs.mkdir(path.dirname(options.out), { recursive: true });
    await fs.writeFile(options.out, json);
  }
  if (options.stdout || !options.out || options.dryRun) console.log(json);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(HELP_TEXT); return; }
  const context = await loadPlanningContext(options);
  const snapshots = buildImportSnapshots(context);
  const selected = selectImports(snapshots, context.releaseSummary, options);
  const plans = await Promise.all(selected.map((snapshot) => planImport(snapshot, context, options)));
  const aggregate = aggregatePlans(plans, context.releaseSummary, options);
  await emitPlan(buildPlanOutput(context, options, snapshots, plans, aggregate), options);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
