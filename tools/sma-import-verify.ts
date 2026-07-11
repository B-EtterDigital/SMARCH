#!/usr/bin/env node
/**
 * WHAT: Verifies imported brick and build records against their installed artifacts and evidence.
 * WHY: Import metadata can drift from placement, hashes, environment bindings, and verification state.
 * HOW: Cross-checks import records, receipts, manifests, files, and journals under one target.
 * INPUTS: A target project, architecture root, check limit, and optional compact output mode.
 * OUTPUTS: A structured verification report whose exit status reflects failed checks.
 * CALLERS: Import workflows and release gates confirming inherited artifacts remain trustworthy.
 * Usage: `node tools/sma-import-verify.ts --target . --max-checks 25 --compact`
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

type FalsyValue = false | 0 | 0n | '' | null | undefined;
function orElse<T, U>(value: T, fallback: () => U): Exclude<T, FalsyValue> | U {
  if (!value) return fallback();
  return value as Exclude<T, FalsyValue>;
}

const artifactTypes = new Set(["brick", "build"]);
const importStatuses = new Set(["planned", "installed", "partial", "blocked", "adapted", "drifted", "disabled", "removed"]);
const placementImportStatuses = new Set(["installed", "adapted", "drifted", "disabled", "removed"]);
const placementKinds = new Set(["file", "directory", "doc", "asset", "config", "migration", "test"]);
const envSurfaces = new Set(["server", "client", "edge", "worker", "shared"]);
const graphRelations = new Set(["depends_on", "composes_with", "optional", "adapter_for", "alternative_to"]);
const releaseStatuses = new Set(["draft", "published", "deprecated", "yanked", "superseded"]);
const verificationStatuses = new Set(["unverified", "candidate", "verified", "canonical"]);
const requiredCheckStatuses = new Set(["passed", "warning", "skipped"]);
const updateResults = new Set(["planned", "installed", "partial", "blocked", "updated", "failed", "rolled_back", "skipped"]);
const VERIFICATION_RANK: Record<string, number> = {
  unverified: 0,
  candidate: 1,
  verified: 2,
  canonical: 3
};

const hashPattern = /^[A-Fa-f0-9]{7,128}$/;
const semverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const importIdPattern = /^[a-z0-9][a-z0-9._:@-]{2,180}$/;
const integerPattern = /^[0-9]+$/;

type JsonObject = Record<string, unknown>;
type Detail = Record<string, unknown>;
type Counter = Record<string, number>;
type CheckLevel = 'pass' | 'warn' | 'fail';
interface VerifyArgs { target: string; smarchRoot: string; maxChecks: number; compact: boolean }
interface CheckRecord extends Detail { level: CheckLevel; code: string; message: string }
interface Recorder {
  counts: Record<CheckLevel, number>;
  checks: CheckRecord[];
  readonly checksTruncated: number;
  pass(code: string, message: string, detail?: Detail): void;
  warn(code: string, message: string, detail?: Detail): void;
  fail(code: string, message: string, detail?: Detail): void;
}
interface EnvBinding { name: string; required: boolean; surface: string; import_id: string; bound_to?: unknown }
interface EnvAggregate {
  name: string;
  required: boolean;
  surfaces: Set<string>;
  import_ids: Set<string>;
  placement_ids: Set<string>;
  aliases: Set<string>;
}
type EnvMap = Map<string, EnvAggregate>;
interface ImportSummaryEntry {
  import_id: string;
  artifact_type: string;
  artifact_id: string | null;
  status: string;
  imported_at: string | null;
  target_paths: string[];
}
interface ImportsSummary {
  total_imports: number;
  by_status: Counter;
  by_artifact_type: Counter;
  import_ids: string[];
  imports: ImportSummaryEntry[];
  env_bindings: EnvMap;
}
interface LockedArtifact {
  import_id: string;
  artifact_type: string;
  artifact_id: string;
  release_version: string;
  release_hash: string | null;
  channel: string | null;
  source_project: string | null;
  trust_tier: string | null;
  verification_status: string | null;
  local_overrides: number;
}
interface LockedCollection { import_ids: string[]; artifacts: LockedArtifact[] }
interface GraphNodeSummary { node_id: string; artifact_type: string | null; artifact_id: string | null; release_version: string | null; release_hash: string | null }
interface GraphEdgeSummary { from: string; to: string; relation: string }
interface BuildLockSummary {
  selected_builds: LockedCollection;
  resolved_bricks: LockedCollection;
  graph_node_ids: Set<string>;
  graph_nodes: GraphNodeSummary[];
  graph_edge_records: GraphEdgeSummary[];
  graph_edges: number;
  registry_snapshot_sha: string;
}
interface PlacementImportSummary extends Omit<LockedArtifact, 'channel' | 'source_project' | 'trust_tier' | 'verification_status' | 'local_overrides'> {
  status: string;
  portable_doc_paths: string[];
}
interface PlacementSummary {
  placement_id: string;
  import_id: string;
  kind: string;
  target_path: string;
  source_path: string;
  target_hash: string;
  ownership_mode: string;
  ownership_replaceable: boolean;
  local_overrides: number;
  adapter_points_total: number;
  adapter_points_pending: number;
  env_binding_count: number;
}
interface PlacementsSummary {
  imports: PlacementImportSummary[];
  import_ids: string[];
  placements: PlacementSummary[];
  env_bindings: EnvMap;
  registry_snapshot_sha: string;
}
interface JournalLine { line_number: number; record: unknown }
interface JournalLatest { event_id: string; event_type: string; result: string; created_at: string }
interface JournalSummary {
  total_events: number;
  by_result: Counter;
  by_event_type: Counter;
  latest_created_at: string | null;
  latest_by_import: Record<string, JournalLatest>;
}
interface PerImportPlacementHealth {
  placements: number;
  missing_targets: number;
  kind_mismatches: number;
  hash_mismatches: number;
  local_overrides: number;
  pending_adapter_points: number;
  replaceable_false: number;
  ownership_modes: Counter;
}
interface PlacementsHealth {
  total: number;
  existing_targets: number;
  missing_targets: number;
  kind_mismatches: number;
  hash_matches: number;
  hash_mismatches: number;
  local_overrides: number;
  pending_adapter_points: number;
  replaceable_false: number;
  env_binding_count: number;
  by_kind: Counter;
  ownership_modes: Counter;
  by_import: Record<string, PerImportPlacementHealth>;
}

function parseArgs(argv: string[]): VerifyArgs {
  const options: VerifyArgs = {
    target: process.cwd(),
    smarchRoot: "",
    maxChecks: 200,
    compact: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--target" && next) {
      options.target = path.resolve(next);
      i += 1;
    } else if (arg === "--smarch-root" && next) {
      options.smarchRoot = path.resolve(next);
      i += 1;
    } else if (arg === "--max-checks" && next && integerPattern.test(next)) {
      options.maxChecks = Math.max(0, Number.parseInt(next, 10));
      i += 1;
    } else if (arg === "--compact") {
      options.compact = true;
    }
  }

  return options;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDateTime(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function normalizePath(value: unknown): string {
  return String(orElse(value, () => "")).split(path.sep).join("/");
}

function normalizeMaybeAbsolutePath(root: string, value: unknown): string {
  const candidate = String(orElse(value, () => "")).trim();
  if (!candidate) return "";
  return path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(root, candidate);
}

function incrementCounter(map: Counter, key: unknown): void {
  const normalizedKey = String(orElse(key, () => 'unknown'));
  map[normalizedKey] = (map[normalizedKey] || 0) + 1;
}

function uniq<T>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}

function uniqStrings(values: unknown): string[] {
  return uniq(safeArray(values).map((value) => String(orElse(value, () => "")).trim()).filter(Boolean));
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function artifactIdAliases(value: unknown): string[] {
  const raw = String(orElse(value, () => "")).trim();
  if (!raw) return [];
  const aliases = new Set([raw]);
  const parts = raw.split(".");
  if (parts.length >= 2 && parts[0] === parts[1]) aliases.add(parts.slice(1).join("."));
  return [...aliases];
}

function artifactIdsMatch(left: unknown, right: unknown): boolean {
  const leftAliases = new Set(artifactIdAliases(left));
  return artifactIdAliases(right).some((alias) => leftAliases.has(alias));
}

function verificationRank(value: unknown): number {
  return VERIFICATION_RANK[String(orElse(value, () => "")).toLowerCase()] ?? -1;
}

function createRecorder(maxChecks: number): Recorder {
  const counts = { pass: 0, warn: 0, fail: 0 };
  const checks: CheckRecord[] = [];
  let checksTruncated = 0;

  function push(level: CheckLevel, code: string, message: string, detail: Detail = {}): void {
    counts[level] += 1;
    if (checks.length < maxChecks) {
      checks.push({ level, code, message, ...detail });
      return;
    }
    checksTruncated += 1;
  }

  return {
    counts,
    checks,
    get checksTruncated() {
      return checksTruncated;
    },
    pass(code: string, message: string, detail: Detail = {}) {
      push("pass", code, message, detail);
    },
    warn(code: string, message: string, detail: Detail = {}) {
      push("warn", code, message, detail);
    },
    fail(code: string, message: string, detail: Detail = {}) {
      push("fail", code, message, detail);
    }
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
}

async function readJsonLines(filePath: string): Promise<{ line_number: number; record: unknown }[]> {
  const lines = (await fs.readFile(filePath, "utf8")).split(/\r?\n/);
  const records: { line_number: number; record: unknown }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    records.push({
      line_number: i + 1,
      record: JSON.parse(line) as unknown
    });
  }
  return records;
}

function sha256(buffer: NodeJS.ArrayBufferView): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function sha256File(filePath: string): Promise<string> {
  return sha256(await fs.readFile(filePath));
}

function requireObject(recorder: Recorder, value: unknown, code: string, message: string, detail: Detail = {}): value is JsonObject {
  if (!isObject(value)) {
    recorder.fail(code, message, detail);
    return false;
  }
  return true;
}

function requireArray(recorder: Recorder, value: unknown, code: string, message: string, detail: Detail = {}): value is unknown[] {
  if (!Array.isArray(value)) {
    recorder.fail(code, message, detail);
    return false;
  }
  return true;
}

function requireString(recorder: Recorder, value: unknown, code: string, message: string, detail: Detail = {}): value is string {
  if (!isNonEmptyString(value)) {
    recorder.fail(code, message, detail);
    return false;
  }
  return true;
}

function requireBoolean(recorder: Recorder, value: unknown, code: string, message: string, detail: Detail = {}): value is boolean {
  if (typeof value !== "boolean") {
    recorder.fail(code, message, detail);
    return false;
  }
  return true;
}

function validateImportId(recorder: Recorder, importId: unknown, code: string, detail: Detail = {}): importId is string {
  if (!requireString(recorder, importId, `${code}.missing`, "Missing import_id", detail)) return false;
  if (!importIdPattern.test(importId)) {
    recorder.fail(`${code}.invalid`, `Invalid import_id "${importId}"`, detail);
    return false;
  }
  return true;
}

function validateHash(
  recorder: Recorder,
  value: unknown,
  code: string,
  message: string,
  detail: Detail = {},
  { required = false }: { required?: boolean } = {},
): value is string {
  if (!isNonEmptyString(value)) {
    if (required) recorder.fail(code, message, detail);
    return false;
  }
  if (!hashPattern.test(value)) {
    recorder.fail(code, `${message}: "${value}" is not hash-like`, detail);
    return false;
  }
  return true;
}

function validateSemver(recorder: Recorder, value: unknown, code: string, detail: Detail = {}): value is string {
  if (!requireString(recorder, value, `${code}.missing`, "Missing release_version", detail)) return false;
  if (!semverPattern.test(value)) {
    recorder.fail(`${code}.invalid`, `Invalid semver "${value}"`, detail);
    return false;
  }
  return true;
}

function validateArtifactType(recorder: Recorder, value: unknown, code: string, detail: Detail = {}): value is string {
  if (!requireString(recorder, value, `${code}.missing`, "Missing artifact_type", detail)) return false;
  if (!artifactTypes.has(value)) {
    recorder.fail(`${code}.invalid`, `Unsupported artifact_type "${value}"`, detail);
    return false;
  }
  return true;
}

function collectContractEnvBindings(importRecord: JsonObject): EnvBinding[] {
  const collected: EnvBinding[] = [];
  const contracts = isObject(importRecord.contracts) ? importRecord.contracts : {};
  const importId = isNonEmptyString(importRecord.import_id) ? importRecord.import_id : '';
  const envBindings = safeArray(contracts.env_bindings);
  for (const name of envBindings) {
    if (!isNonEmptyString(name)) continue;
    collected.push({
      name,
      required: false,
      surface: "server",
      import_id: importId
    });
  }

  const envContract = isObject(contracts.env) ? contracts.env : {};
  if (Array.isArray(envContract.required)) {
    for (const name of envContract.required) {
      if (!isNonEmptyString(name)) continue;
      collected.push({
        name,
        required: true,
        surface: "server",
        import_id: importId
      });
    }
  }

  if (Array.isArray(envContract.variables)) {
    for (const variable of envContract.variables) {
      if (typeof variable === "string" && variable.trim()) {
        collected.push({
          name: variable,
          required: false,
          surface: "server",
          import_id: importId
        });
        continue;
      }
      if (!isObject(variable) || !isNonEmptyString(variable.name)) continue;
      collected.push({
        name: variable.name,
        required: safeArray(variable.required_in).length > 0,
        surface: "server",
        import_id: importId
      });
    }
  }

  return collected;
}

function mergeEnvBinding(envMap: EnvMap, binding: EnvBinding, placementId = ""): void {
  const name = (binding.name || "").trim();
  if (!name) return;
  const current = envMap.get(name) ?? {
    name,
    required: false,
    surfaces: new Set<string>(),
    import_ids: new Set<string>(),
    placement_ids: new Set<string>(),
    aliases: new Set<string>()
  };
  current.required = current.required || binding.required;
  if (isNonEmptyString(binding.surface)) current.surfaces.add(binding.surface);
  if (isNonEmptyString(binding.import_id)) current.import_ids.add(binding.import_id);
  if (placementId) current.placement_ids.add(placementId);
  if (isNonEmptyString(binding.bound_to) && /^[A-Z][A-Z0-9_]*$/.test(binding.bound_to)) current.aliases.add(binding.bound_to);
  envMap.set(name, current);
}

function mergeEnvMap(targetMap: EnvMap, sourceMap: EnvMap): void {
  for (const binding of sourceMap.values()) {
    const current = targetMap.get(binding.name) ?? {
      name: binding.name,
      required: false,
      surfaces: new Set<string>(),
      import_ids: new Set<string>(),
      placement_ids: new Set<string>(),
      aliases: new Set<string>()
    };
    current.required = current.required || binding.required;
    for (const surface of binding.surfaces) current.surfaces.add(surface);
    for (const importId of binding.import_ids) current.import_ids.add(importId);
    for (const placementId of binding.placement_ids) current.placement_ids.add(placementId);
    for (const alias of binding.aliases) current.aliases.add(alias);
    targetMap.set(binding.name, current);
  }
}

function summarizeEnvMap(envMap: EnvMap, processEnv: NodeJS.ProcessEnv) {
  const variables: {
    name: string; required: boolean; satisfied: boolean; satisfied_by: string[];
    surfaces: string[]; import_ids: string[]; placement_ids: string[]; aliases: string[];
  }[] = [];
  let missingRequired = 0;
  let missingOptional = 0;
  let satisfied = 0;

  for (const binding of [...envMap.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const satisfiedBy: string[] = [];
    if (isNonEmptyString(processEnv[binding.name])) satisfiedBy.push(binding.name);
    for (const alias of binding.aliases) {
      if (isNonEmptyString(processEnv[alias])) satisfiedBy.push(alias);
    }
    const uniqueSatisfiedBy = uniq(satisfiedBy);
    const isSatisfied = uniqueSatisfiedBy.length > 0;
    if (isSatisfied) satisfied += 1;
    if (!isSatisfied && binding.required) missingRequired += 1;
    if (!isSatisfied && !binding.required) missingOptional += 1;
    variables.push({
      name: binding.name,
      required: binding.required,
      satisfied: isSatisfied,
      satisfied_by: uniqueSatisfiedBy,
      surfaces: [...binding.surfaces].sort(),
      import_ids: [...binding.import_ids].sort(),
      placement_ids: [...binding.placement_ids].sort(),
      aliases: [...binding.aliases].sort()
    });
  }

  return {
    total: variables.length,
    required: variables.filter((item) => item.required).length,
    optional: variables.filter((item) => !item.required).length,
    satisfied,
    missing_required: missingRequired,
    missing_optional: missingOptional,
    variables
  };
}

function validateImportsDocument(doc: unknown, recorder: Recorder): ImportsSummary {
  const summary: ImportsSummary = {
    total_imports: 0,
    by_status: {},
    by_artifact_type: {},
    import_ids: [],
    imports: [],
    env_bindings: new Map()
  };

  if (!requireObject(recorder, doc, "imports.document", "Expected .smarch/imports.json to be a JSON object")) return summary;
  if (doc.schema !== "smarch.imports.v0") {
    recorder.warn("imports.schema", `Unexpected imports schema "${String(orElse(doc.schema, () => "missing"))}"`, { expected: "smarch.imports.v0" });
  } else {
    recorder.pass("imports.schema", "Recognized imports schema", { schema: doc.schema });
  }
  if (doc.generated_at && !isDateTime(doc.generated_at)) {
    recorder.warn("imports.generated_at", "imports.json generated_at is not a valid date-time", { value: doc.generated_at });
  }
  if (!requireArray(recorder, doc.imports, "imports.entries", "imports.json is missing the imports array")) return summary;

  const seenImportIds = new Set<string>();
  for (let i = 0; i < doc.imports.length; i += 1) {
    const entry = doc.imports[i];
    const detail = { file: ".smarch/imports.json", index: i };
    if (!requireObject(recorder, entry, "imports.entry", "Import entry must be an object", detail)) continue;

    if (!validateImportId(recorder, entry.import_id, "imports.entry.import_id", detail)) continue;
    if (seenImportIds.has(entry.import_id)) {
      recorder.fail("imports.entry.duplicate", `Duplicate import_id "${entry.import_id}" in imports.json`, detail);
      continue;
    }
    seenImportIds.add(entry.import_id);

    const artifactTypeOk = validateArtifactType(recorder, entry.artifact_type, "imports.entry.artifact_type", detail);
    const artifactIdOk = requireString(recorder, entry.artifact_id, "imports.entry.artifact_id", "Missing artifact_id", detail);
    const importedAtOk = requireString(recorder, entry.imported_at, "imports.entry.imported_at", "Missing imported_at", detail);
    if (importedAtOk && !isDateTime(entry.imported_at)) {
      recorder.warn("imports.entry.imported_at.invalid", `Invalid imported_at "${String(entry.imported_at)}"`, detail);
    }
    if (!requireString(recorder, entry.status, "imports.entry.status", "Missing status", detail)) continue;
    if (!importStatuses.has(entry.status)) {
      recorder.warn("imports.entry.status.unknown", `Unexpected import status "${entry.status}"`, detail);
    }

    if (isObject(entry.source_registry) && isNonEmptyString(entry.source_registry.sha256)) {
      validateHash(recorder, entry.source_registry.sha256, "imports.entry.source_registry.sha256", "Invalid source_registry sha256", detail, { required: false });
    }

    if (entry.install_state !== undefined && !isObject(entry.install_state)) {
      recorder.warn("imports.entry.install_state", "install_state should be an object when present", detail);
    }

    if (entry.contracts !== undefined && !isObject(entry.contracts)) {
      recorder.warn("imports.entry.contracts", "contracts should be an object when present", detail);
    }

    for (const binding of collectContractEnvBindings(entry)) mergeEnvBinding(summary.env_bindings, binding);

    summary.total_imports += 1;
    incrementCounter(summary.by_status, entry.status);
    if (artifactTypeOk) incrementCounter(summary.by_artifact_type, entry.artifact_type);
    summary.import_ids.push(entry.import_id);
    summary.imports.push({
      import_id: entry.import_id,
      artifact_type: artifactTypeOk && isNonEmptyString(entry.artifact_type) ? entry.artifact_type : "unknown",
      artifact_id: artifactIdOk && isNonEmptyString(entry.artifact_id) ? entry.artifact_id : null,
      status: entry.status,
      imported_at: importedAtOk && isNonEmptyString(entry.imported_at) ? entry.imported_at : null,
      target_paths: safeArray(entry.target_paths).map((value) => normalizePath(value))
    });
  }

  recorder.pass("imports.parsed", `Parsed ${String(summary.total_imports)} import record(s)`, { count: summary.total_imports });
  return summary;
}

function validateLockedArtifacts(
  recorder: Recorder,
  artifacts: unknown[],
  expectedArtifactType: string,
  codePrefix: string,
): LockedCollection {
  const importIds = new Set<string>();
  const summary: LockedArtifact[] = [];
  for (let i = 0; i < artifacts.length; i += 1) {
    const artifact = artifacts[i];
    const detail = { index: i, section: codePrefix };
    if (!requireObject(recorder, artifact, `${codePrefix}.entry`, "Locked artifact must be an object", detail)) continue;
    if (!validateImportId(recorder, artifact.import_id, `${codePrefix}.import_id`, detail)) continue;
    if (importIds.has(artifact.import_id)) {
      recorder.fail(`${codePrefix}.duplicate`, `Duplicate import_id "${artifact.import_id}"`, detail);
      continue;
    }
    importIds.add(artifact.import_id);
    if (!validateArtifactType(recorder, artifact.artifact_type, `${codePrefix}.artifact_type`, detail)) continue;
    if (artifact.artifact_type !== expectedArtifactType) {
      recorder.fail(`${codePrefix}.artifact_type.const`, `Expected ${expectedArtifactType} lock but got "${artifact.artifact_type}"`, detail);
      continue;
    }
    requireString(recorder, artifact.artifact_id, `${codePrefix}.artifact_id`, "Missing artifact_id", detail);
    validateSemver(recorder, artifact.release_version, `${codePrefix}.release_version`, detail);
    validateHash(recorder, artifact.release_hash, `${codePrefix}.release_hash`, "Missing or invalid release_hash", detail, { required: false });
    if (isNonEmptyString(artifact.verification_status) && !verificationStatuses.has(artifact.verification_status)) {
      recorder.warn(`${codePrefix}.verification_status`, `Unexpected verification_status "${artifact.verification_status}"`, detail);
    }
    if (artifact.local_overrides !== undefined && !Number.isFinite(Number(artifact.local_overrides))) {
      recorder.warn(`${codePrefix}.local_overrides`, "local_overrides should be numeric when present", detail);
    }
    summary.push({
      import_id: artifact.import_id,
      artifact_type: artifact.artifact_type,
      artifact_id: isNonEmptyString(artifact.artifact_id) ? artifact.artifact_id : '',
      release_version: isNonEmptyString(artifact.release_version) ? artifact.release_version : '',
      release_hash: isNonEmptyString(artifact.release_hash) ? artifact.release_hash : null,
      channel: isNonEmptyString(artifact.channel) ? artifact.channel : null,
      source_project: isNonEmptyString(artifact.source_project) ? artifact.source_project : null,
      trust_tier: isNonEmptyString(artifact.trust_tier) ? artifact.trust_tier : null,
      verification_status: isNonEmptyString(artifact.verification_status) ? artifact.verification_status : null,
      local_overrides: Number(orElse(artifact.local_overrides, () => 0))
    });
  }
  return {
    import_ids: [...importIds],
    artifacts: summary
  };
}

function validateBuildLock(doc: unknown, recorder: Recorder, targetRoot: string): BuildLockSummary {
  const summary: BuildLockSummary = {
    selected_builds: { import_ids: [], artifacts: [] },
    resolved_bricks: { import_ids: [], artifacts: [] },
    graph_node_ids: new Set(),
    graph_nodes: [],
    graph_edge_records: [],
    graph_edges: 0,
    registry_snapshot_sha: ""
  };

  if (!requireObject(recorder, doc, "build_lock.document", "Expected .smarch/build-lock.json to be a JSON object")) return summary;
  if (doc.schema_version !== "1.0.0") {
    recorder.fail("build_lock.schema_version", `Expected schema_version 1.0.0 but found "${String(orElse(doc.schema_version, () => "missing"))}"`);
  } else {
    recorder.pass("build_lock.schema_version", "Recognized build-lock schema version", { schema_version: doc.schema_version });
  }
  if (!requireObject(recorder, doc.lock, "build_lock.lock", "build-lock is missing the lock object")) return summary;
  if (!requireObject(recorder, doc.target, "build_lock.target", "build-lock is missing the target object")) return summary;
  requireArray(recorder, doc.selected_builds, "build_lock.selected_builds", "build-lock is missing selected_builds");
  requireArray(recorder, doc.resolved_bricks, "build_lock.resolved_bricks", "build-lock is missing resolved_bricks");
  requireObject(recorder, doc.frozen_dependency_graph, "build_lock.graph", "build-lock is missing frozen_dependency_graph");
  requireObject(recorder, doc.trust_policy, "build_lock.trust_policy", "build-lock is missing trust_policy");
  requireObject(recorder, doc.verification_policy, "build_lock.verification_policy", "build-lock is missing verification_policy");

  if (isObject(doc.lock)) {
    if (isDateTime(doc.lock.generated_at)) recorder.pass("build_lock.generated_at", "build-lock generated_at looks valid", { generated_at: doc.lock.generated_at });
    else recorder.fail("build_lock.generated_at", "build-lock lock.generated_at is missing or invalid", { value: doc.lock.generated_at });
    if (doc.lock.registry_snapshot_sha) {
      if (validateHash(recorder, doc.lock.registry_snapshot_sha, "build_lock.registry_snapshot_sha", "Invalid registry_snapshot_sha", {}, { required: false })) {
        summary.registry_snapshot_sha = doc.lock.registry_snapshot_sha;
      }
    }
    if (!isNonEmptyString(doc.lock.mode) || !["exact", "channel", "mixed"].includes(doc.lock.mode)) {
      recorder.fail("build_lock.mode", `Unsupported lock mode "${String(orElse(doc.lock.mode, () => "missing"))}"`);
    }
    for (const [key, relativePath] of Object.entries({
      imports_path: doc.lock.imports_path,
      placements_path: doc.lock.placements_path,
      update_journal_path: doc.lock.update_journal_path
    })) {
      if (!isNonEmptyString(relativePath)) {
        recorder.warn(`build_lock.${key}`, `${key} is missing`, {});
        continue;
      }
      const resolved = normalizeMaybeAbsolutePath(targetRoot, relativePath);
      recorder.pass(`build_lock.${key}`, `${key} declared`, { path: relativePath, resolved });
    }

    // Federation: registry_origin consistency. When set on the lock and the
    // verifier knows an expected origin (env SMA_REGISTRY_ORIGIN or
    // --expected-registry-origin), warn on mismatch.
    const declaredOrigin = isNonEmptyString(doc.lock.registry_origin) ? doc.lock.registry_origin : null;
    const expectedOrigin = orElse(process.env.SMA_REGISTRY_ORIGIN, () => null);
    if (declaredOrigin && expectedOrigin && declaredOrigin !== expectedOrigin) {
      recorder.warn("build_lock.registry_origin.mismatch",
        `lock registry_origin (${declaredOrigin}) differs from expected (${expectedOrigin})`,
        { declared_origin: declaredOrigin, expected_origin: expectedOrigin });
    } else if (declaredOrigin) {
      recorder.pass("build_lock.registry_origin", "lock declares registry_origin", { origin: declaredOrigin });
    } else if (expectedOrigin) {
      recorder.warn("build_lock.registry_origin.missing",
        "lock has no registry_origin but env SMA_REGISTRY_ORIGIN is set",
        { expected_origin: expectedOrigin });
    }
  }

  if (isObject(doc.target)) {
    if (!requireString(recorder, doc.target.root, "build_lock.target.root", "build-lock target.root is missing")) return summary;
    const normalizedTargetRoot = path.resolve(doc.target.root);
    if (normalizedTargetRoot !== targetRoot) {
      recorder.warn("build_lock.target.root.mismatch", "build-lock target.root does not match the verified target root", {
        declared_root: normalizedTargetRoot,
        verified_root: targetRoot
      });
    } else {
      recorder.pass("build_lock.target.root", "build-lock target.root matches the verified target root", { root: normalizedTargetRoot });
    }
  }

  if (Array.isArray(doc.selected_builds)) summary.selected_builds = validateLockedArtifacts(recorder, doc.selected_builds, "build", "build_lock.selected_builds");
  if (Array.isArray(doc.resolved_bricks)) summary.resolved_bricks = validateLockedArtifacts(recorder, doc.resolved_bricks, "brick", "build_lock.resolved_bricks");

  if (isObject(doc.frozen_dependency_graph)) {
    if (requireArray(recorder, doc.frozen_dependency_graph.nodes, "build_lock.graph.nodes", "frozen_dependency_graph.nodes must be an array")) {
      for (let i = 0; i < doc.frozen_dependency_graph.nodes.length; i += 1) {
        const node = doc.frozen_dependency_graph.nodes[i];
        const detail = { index: i, section: "build_lock.graph.nodes" };
        if (!requireObject(recorder, node, "build_lock.graph.node", "Graph node must be an object", detail)) continue;
        if (!requireString(recorder, node.node_id, "build_lock.graph.node_id", "Graph node missing node_id", detail)) continue;
        summary.graph_node_ids.add(node.node_id);
        summary.graph_nodes.push({
          node_id: node.node_id,
          artifact_type: isNonEmptyString(node.artifact_type) ? node.artifact_type : null,
          artifact_id: isNonEmptyString(node.artifact_id) ? node.artifact_id : null,
          release_version: isNonEmptyString(node.release_version) ? node.release_version : null,
          release_hash: isNonEmptyString(node.release_hash) ? node.release_hash : null
        });
        validateArtifactType(recorder, node.artifact_type, "build_lock.graph.artifact_type", detail);
        requireString(recorder, node.artifact_id, "build_lock.graph.artifact_id", "Graph node missing artifact_id", detail);
        validateSemver(recorder, node.release_version, "build_lock.graph.release_version", detail);
        validateHash(recorder, node.release_hash, "build_lock.graph.release_hash", "Invalid graph release_hash", detail, { required: false });
      }
    }
    if (requireArray(recorder, doc.frozen_dependency_graph.edges, "build_lock.graph.edges", "frozen_dependency_graph.edges must be an array")) {
      summary.graph_edges = doc.frozen_dependency_graph.edges.length;
      for (let i = 0; i < doc.frozen_dependency_graph.edges.length; i += 1) {
        const edge = doc.frozen_dependency_graph.edges[i];
        const detail = { index: i, section: "build_lock.graph.edges" };
        if (!requireObject(recorder, edge, "build_lock.graph.edge", "Graph edge must be an object", detail)) continue;
        if (!requireString(recorder, edge.from, "build_lock.graph.edge.from", "Graph edge missing from", detail)) continue;
        if (!requireString(recorder, edge.to, "build_lock.graph.edge.to", "Graph edge missing to", detail)) continue;
        if (!isNonEmptyString(edge.relation) || !graphRelations.has(edge.relation)) {
          recorder.fail("build_lock.graph.edge.relation", `Unsupported edge relation "${String(orElse(edge.relation, () => "missing"))}"`, detail);
        }
        if (!summary.graph_node_ids.has(edge.from) || !summary.graph_node_ids.has(edge.to)) {
          recorder.fail("build_lock.graph.edge.references", "Graph edge points to a missing node", detail);
        }
        summary.graph_edge_records.push({
          from: edge.from,
          to: edge.to,
          relation: isNonEmptyString(edge.relation) ? edge.relation : 'unknown'
        });
      }
    }
  }

  if (isObject(doc.trust_policy)) {
    if (!requireArray(recorder, doc.trust_policy.allowed_release_statuses, "build_lock.trust.allowed_release_statuses", "trust_policy.allowed_release_statuses must be an array")) return summary;
    if (doc.trust_policy.allowed_release_statuses.length === 0) {
      recorder.fail("build_lock.trust.allowed_release_statuses.empty", "allowed_release_statuses cannot be empty");
    }
    for (const status of doc.trust_policy.allowed_release_statuses) {
      if (!isNonEmptyString(status) || !releaseStatuses.has(status)) {
        recorder.fail("build_lock.trust.allowed_release_statuses.invalid", `Unsupported release status "${String(status)}"`);
      }
    }
    if (isNonEmptyString(doc.trust_policy.minimum_verification_status)
      && !verificationStatuses.has(doc.trust_policy.minimum_verification_status)) {
      recorder.warn("build_lock.trust.minimum_verification_status", `Unexpected minimum_verification_status "${doc.trust_policy.minimum_verification_status}"`);
    }
    requireBoolean(recorder, doc.trust_policy.require_contract_hashes, "build_lock.trust.require_contract_hashes", "trust_policy.require_contract_hashes must be boolean");
    requireBoolean(recorder, doc.trust_policy.allow_local_overrides, "build_lock.trust.allow_local_overrides", "trust_policy.allow_local_overrides must be boolean");
  }

  if (isObject(doc.verification_policy)) {
    requireBoolean(recorder, doc.verification_policy.run_declared_tests, "build_lock.verify.run_declared_tests", "verification_policy.run_declared_tests must be boolean");
    if (doc.verification_policy.run_import_resolution !== undefined) {
      requireBoolean(recorder, doc.verification_policy.run_import_resolution, "build_lock.verify.run_import_resolution", "verification_policy.run_import_resolution must be boolean");
    }
    if (doc.verification_policy.run_env_truthing !== undefined) {
      requireBoolean(recorder, doc.verification_policy.run_env_truthing, "build_lock.verify.run_env_truthing", "verification_policy.run_env_truthing must be boolean");
    }
    if (doc.verification_policy.run_rls_truthing !== undefined) {
      requireBoolean(recorder, doc.verification_policy.run_rls_truthing, "build_lock.verify.run_rls_truthing", "verification_policy.run_rls_truthing must be boolean");
    }
    requireBoolean(recorder, doc.verification_policy.fail_on_missing_env, "build_lock.verify.fail_on_missing_env", "verification_policy.fail_on_missing_env must be boolean");
    if (!isNonEmptyString(doc.verification_policy.required_check_status)
      || !requiredCheckStatuses.has(doc.verification_policy.required_check_status)) {
      recorder.fail("build_lock.verify.required_check_status", `Unsupported required_check_status "${String(orElse(doc.verification_policy.required_check_status, () => "missing"))}"`);
    }
  }

  recorder.pass("build_lock.parsed", "Parsed build-lock control-plane artifact", {
    resolved_bricks: Array.isArray(doc.resolved_bricks) ? doc.resolved_bricks.length : 0,
    selected_builds: Array.isArray(doc.selected_builds) ? doc.selected_builds.length : 0
  });
  return summary;
}

function validatePlacementImports(recorder: Recorder, imports: unknown[]) {
  const seenImportIds = new Set<string>();
  const summary: PlacementImportSummary[] = [];
  for (let i = 0; i < imports.length; i += 1) {
    const entry = imports[i];
    const detail = { index: i, section: "placements.imports" };
    if (!requireObject(recorder, entry, "placements.imports.entry", "placements import entry must be an object", detail)) continue;
    if (!validateImportId(recorder, entry.import_id, "placements.imports.import_id", detail)) continue;
    if (seenImportIds.has(entry.import_id)) {
      recorder.fail("placements.imports.duplicate", `Duplicate placements import_id "${entry.import_id}"`, detail);
      continue;
    }
    seenImportIds.add(entry.import_id);
    validateArtifactType(recorder, entry.artifact_type, "placements.imports.artifact_type", detail);
    requireString(recorder, entry.artifact_id, "placements.imports.artifact_id", "placements import missing artifact_id", detail);
    validateSemver(recorder, entry.release_version, "placements.imports.release_version", detail);
    validateHash(recorder, entry.release_hash, "placements.imports.release_hash", "Invalid placements release_hash", detail, { required: false });
    if (entry.imported_at && !isDateTime(entry.imported_at)) {
      recorder.warn("placements.imports.imported_at", `Invalid placements imported_at "${String(entry.imported_at)}"`, detail);
    }
    if (isNonEmptyString(entry.status) && !placementImportStatuses.has(entry.status)) {
      recorder.warn("placements.imports.status", `Unexpected placements status "${entry.status}"`, detail);
    }
    summary.push({
      import_id: entry.import_id,
      artifact_type: isNonEmptyString(entry.artifact_type) ? entry.artifact_type : 'unknown',
      artifact_id: isNonEmptyString(entry.artifact_id) ? entry.artifact_id : '',
      release_version: isNonEmptyString(entry.release_version) ? entry.release_version : '',
      release_hash: isNonEmptyString(entry.release_hash) ? entry.release_hash : null,
      status: isNonEmptyString(entry.status) ? entry.status : "unknown",
      portable_doc_paths: safeArray(entry.portable_doc_paths).map((value) => normalizePath(value))
    });
  }
  return {
    import_ids: [...seenImportIds],
    imports: summary
  };
}

function validatePlacements(doc: unknown, recorder: Recorder, targetRoot: string): PlacementsSummary {
  const summary: PlacementsSummary = {
    imports: [],
    import_ids: [],
    placements: [],
    env_bindings: new Map(),
    registry_snapshot_sha: ""
  };

  if (!requireObject(recorder, doc, "placements.document", "Expected .smarch/placements.json to be a JSON object")) return summary;
  if (doc.schema_version !== "1.0.0") {
    recorder.fail("placements.schema_version", `Expected schema_version 1.0.0 but found "${String(orElse(doc.schema_version, () => "missing"))}"`);
  } else {
    recorder.pass("placements.schema_version", "Recognized placement-map schema version", { schema_version: doc.schema_version });
  }
  if (!requireObject(recorder, doc.map, "placements.map", "placements.json is missing the map object")) return summary;
  if (!requireObject(recorder, doc.target, "placements.target", "placements.json is missing the target object")) return summary;
  if (!requireArray(recorder, doc.imports, "placements.imports", "placements.json is missing the imports array")) return summary;
  if (!requireArray(recorder, doc.placements, "placements.entries", "placements.json is missing the placements array")) return summary;

  if (isObject(doc.map)) {
    if (isDateTime(doc.map.generated_at)) recorder.pass("placements.generated_at", "placements map generated_at looks valid", { generated_at: doc.map.generated_at });
    else recorder.fail("placements.generated_at", "placements map generated_at is missing or invalid", { value: doc.map.generated_at });
    if (doc.map.registry_snapshot_sha) {
      if (validateHash(recorder, doc.map.registry_snapshot_sha, "placements.registry_snapshot_sha", "Invalid placements registry_snapshot_sha", {}, { required: false })) {
        summary.registry_snapshot_sha = doc.map.registry_snapshot_sha;
      }
    }
  }

  if (isObject(doc.target)) {
    if (requireString(recorder, doc.target.root, "placements.target.root", "placements target.root is missing")) {
      const normalizedTargetRoot = path.resolve(doc.target.root);
      if (normalizedTargetRoot !== targetRoot) {
        recorder.warn("placements.target.root.mismatch", "placements target.root does not match the verified target root", {
          declared_root: normalizedTargetRoot,
          verified_root: targetRoot
        });
      } else {
        recorder.pass("placements.target.root", "placements target.root matches the verified target root", { root: normalizedTargetRoot });
      }
    }
  }

  const placementImports = validatePlacementImports(recorder, doc.imports);
  summary.imports = placementImports.imports;
  summary.import_ids = placementImports.import_ids;

  const seenPlacementIds = new Set<string>();
  const validImportIds = new Set(summary.import_ids);
  for (let i = 0; i < doc.placements.length; i += 1) {
    const entry = doc.placements[i];
    const detail = { index: i, section: "placements.entries" };
    if (!requireObject(recorder, entry, "placements.entry", "Placement entry must be an object", detail)) continue;
    if (!requireString(recorder, entry.placement_id, "placements.entry.placement_id", "Placement entry missing placement_id", detail)) continue;
    if (seenPlacementIds.has(entry.placement_id)) {
      recorder.fail("placements.entry.duplicate", `Duplicate placement_id "${entry.placement_id}"`, detail);
      continue;
    }
    seenPlacementIds.add(entry.placement_id);
    if (!validateImportId(recorder, entry.import_id, "placements.entry.import_id", detail)) continue;
    if (!validImportIds.has(entry.import_id)) {
      recorder.fail("placements.entry.orphan_import", `Placement references unknown import_id "${entry.import_id}"`, detail);
    }
    if (!isNonEmptyString(entry.kind) || !placementKinds.has(entry.kind)) {
      recorder.fail("placements.entry.kind", `Unsupported placement kind "${String(orElse(entry.kind, () => "missing"))}"`, detail);
    }
    requireString(recorder, entry.source_path, "placements.entry.source_path", "Placement missing source_path", detail);
    requireString(recorder, entry.target_path, "placements.entry.target_path", "Placement missing target_path", detail);
    if (!requireObject(recorder, entry.ownership, "placements.entry.ownership", "Placement missing ownership", detail)) continue;
    if (!requireString(recorder, entry.ownership.mode, "placements.entry.ownership.mode", "Placement ownership missing mode", detail)) continue;

    const envBindings: EnvBinding[] = [];
    for (const envBinding of safeArray(entry.env_bindings)) {
      if (!isObject(envBinding) || !isNonEmptyString(envBinding.name)) {
        recorder.warn("placements.entry.env_bindings", "Invalid env binding record", detail);
        continue;
      }
      if (!isNonEmptyString(envBinding.surface) || !envSurfaces.has(envBinding.surface)) {
        recorder.warn("placements.entry.env_bindings.surface", `Unexpected env binding surface "${String(orElse(envBinding.surface, () => "missing"))}"`, {
          ...detail,
          env_name: envBinding.name
        });
      }
      if (typeof envBinding.required !== "boolean") {
        recorder.warn("placements.entry.env_bindings.required", "env binding required flag should be boolean", {
          ...detail,
          env_name: envBinding.name
        });
      }
      envBindings.push({
        name: envBinding.name,
        required: Boolean(envBinding.required),
        surface: isNonEmptyString(envBinding.surface) ? envBinding.surface : "server",
        bound_to: envBinding.bound_to,
        import_id: entry.import_id
      });
    }

    for (const envBinding of envBindings) mergeEnvBinding(summary.env_bindings, envBinding, entry.placement_id);

    summary.placements.push({
      placement_id: entry.placement_id,
      import_id: entry.import_id,
      kind: isNonEmptyString(entry.kind) ? entry.kind : 'unknown',
      target_path: normalizePath(entry.target_path),
      source_path: normalizePath(entry.source_path),
      target_hash: isNonEmptyString(entry.target_hash) ? entry.target_hash : "",
      ownership_mode: entry.ownership.mode,
      ownership_replaceable: entry.ownership.replaceable !== false,
      local_overrides: safeArray(entry.local_overrides).length,
      adapter_points_total: safeArray(entry.adapter_points).length,
      adapter_points_pending: safeArray(entry.adapter_points)
        .filter((point) => !isObject(point) || point.status !== "bound").length,
      env_binding_count: envBindings.length
    });
  }

  recorder.pass("placements.parsed", `Parsed ${String(summary.placements.length)} placement record(s)`, {
    imports: summary.imports.length,
    placements: summary.placements.length
  });
  return summary;
}

function validateJournal(events: JournalLine[], recorder: Recorder): JournalSummary {
  const summary: JournalSummary = {
    total_events: 0,
    by_result: {},
    by_event_type: {},
    latest_created_at: null,
    latest_by_import: {}
  };

  const seenEventIds = new Set<string>();
  for (const { line_number, record } of events) {
    const detail = { file: ".smarch/update-journal.jsonl", line_number };
    if (!requireObject(recorder, record, "journal.entry", "Journal line must be a JSON object", detail)) continue;
    if (!requireString(recorder, record.event_id, "journal.event_id", "Journal entry missing event_id", detail)) continue;
    if (seenEventIds.has(record.event_id)) {
      recorder.fail("journal.event_id.duplicate", `Duplicate journal event_id "${record.event_id}"`, detail);
      continue;
    }
    seenEventIds.add(record.event_id);
    requireString(recorder, record.event_type, "journal.event_type", "Journal entry missing event_type", detail);
    if (!requireString(recorder, record.created_at, "journal.created_at", "Journal entry missing created_at", detail)) continue;
    if (!isDateTime(record.created_at)) recorder.warn("journal.created_at.invalid", `Invalid journal created_at "${String(record.created_at)}"`, detail);
    if (!validateImportId(recorder, record.import_id, "journal.import_id", detail)) continue;
    validateArtifactType(recorder, record.artifact_type, "journal.artifact_type", detail);
    requireString(recorder, record.artifact_id, "journal.artifact_id", "Journal entry missing artifact_id", detail);
    validateHash(recorder, record.plan_hash, "journal.plan_hash", "Invalid journal plan_hash", detail, { required: false });
    if (record.registry_snapshot_sha) validateHash(recorder, record.registry_snapshot_sha, "journal.registry_snapshot_sha", "Invalid journal registry_snapshot_sha", detail, { required: false });
    if (isNonEmptyString(record.result) && !updateResults.has(record.result)) {
      recorder.warn("journal.result", `Unexpected journal result "${record.result}"`, detail);
    }

    summary.total_events += 1;
    incrementCounter(summary.by_result, orElse(record.result, () => "unknown"));
    incrementCounter(summary.by_event_type, orElse(record.event_type, () => "unknown"));
    if (!summary.latest_created_at || Date.parse(record.created_at) > Date.parse(summary.latest_created_at)) {
      summary.latest_created_at = record.created_at;
    }
    const previous = summary.latest_by_import[record.import_id];
    if (!previous || Date.parse(record.created_at) >= Date.parse(previous.created_at)) {
      summary.latest_by_import[record.import_id] = {
        event_id: record.event_id,
        event_type: isNonEmptyString(record.event_type) ? record.event_type : 'unknown',
        result: isNonEmptyString(record.result) ? record.result : "unknown",
        created_at: record.created_at
      };
    }
  }

  if (summary.total_events === 0) recorder.warn("journal.empty", "update-journal.jsonl contains no events");
  else recorder.pass("journal.parsed", `Parsed ${String(summary.total_events)} update journal event(s)`, { count: summary.total_events });

  return summary;
}

async function verifyPlacementTargets(
  placementsSummary: PlacementsSummary,
  targetRoot: string,
  recorder: Recorder,
): Promise<PlacementsHealth> {
  const health: PlacementsHealth = {
    total: placementsSummary.placements.length,
    existing_targets: 0,
    missing_targets: 0,
    kind_mismatches: 0,
    hash_matches: 0,
    hash_mismatches: 0,
    local_overrides: 0,
    pending_adapter_points: 0,
    replaceable_false: 0,
    env_binding_count: 0,
    by_kind: {},
    ownership_modes: {},
    by_import: {}
  };

  for (const placement of placementsSummary.placements) {
    incrementCounter(health.by_kind, placement.kind || "unknown");
    const perImport = health.by_import[placement.import_id] || {
      placements: 0,
      missing_targets: 0,
      kind_mismatches: 0,
      hash_mismatches: 0,
      local_overrides: 0,
      pending_adapter_points: 0,
      replaceable_false: 0,
      ownership_modes: {}
    };
    perImport.placements += 1;
    perImport.local_overrides += (placement.local_overrides || 0);
    perImport.pending_adapter_points += (placement.adapter_points_pending || 0);
    if (!placement.ownership_replaceable) perImport.replaceable_false += 1;
    incrementCounter(perImport.ownership_modes, placement.ownership_mode || "unknown");
    health.by_import[placement.import_id] = perImport;
    health.local_overrides = (health.local_overrides || 0) + (placement.local_overrides || 0);
    health.pending_adapter_points = (health.pending_adapter_points || 0) + (placement.adapter_points_pending || 0);
    health.replaceable_false = (health.replaceable_false || 0) + (!placement.ownership_replaceable ? 1 : 0);
    health.env_binding_count = (health.env_binding_count || 0) + (placement.env_binding_count || 0);
    incrementCounter(health.ownership_modes || (health.ownership_modes = {}), placement.ownership_mode || "unknown");

    const targetPath = normalizeMaybeAbsolutePath(targetRoot, placement.target_path);
    let stat = null;
    try {
      stat = await fs.stat(targetPath);
    } catch {
      stat = null;
    }

    if (!stat) {
      health.missing_targets += 1;
      perImport.missing_targets += 1;
      recorder.fail("placements.target.missing", `Placement target is missing: ${placement.target_path}`, {
        import_id: placement.import_id,
        placement_id: placement.placement_id,
        target_path: placement.target_path
      });
      continue;
    }

    health.existing_targets += 1;
    const expectsDirectory = placement.kind === "directory";
    const kindMatches = expectsDirectory ? stat.isDirectory() : stat.isFile();
    if (!kindMatches) {
      health.kind_mismatches += 1;
      perImport.kind_mismatches += 1;
      recorder.fail("placements.target.kind", `Placement kind does not match filesystem object for ${placement.target_path}`, {
        import_id: placement.import_id,
        placement_id: placement.placement_id,
        expected_kind: placement.kind,
        actual_kind: stat.isDirectory() ? "directory" : "file"
      });
      continue;
    }

    if (!expectsDirectory && placement.target_hash) {
      const actualHash = await sha256File(targetPath);
      if (actualHash === placement.target_hash) {
        health.hash_matches += 1;
      } else {
        health.hash_mismatches += 1;
        perImport.hash_mismatches += 1;
        recorder.warn("placements.target.hash", `Placement target hash drift for ${placement.target_path}`, {
          import_id: placement.import_id,
          placement_id: placement.placement_id,
          expected_hash: placement.target_hash,
          actual_hash: actualHash
        });
      }
    }
  }

  return health;
}

function buildImportHealth(
  importsSummary: ImportsSummary,
  placementsHealth: PlacementsHealth,
  journalSummary: JournalSummary,
) {
  return importsSummary.imports.map((entry) => {
    const placement = placementsHealth.by_import[entry.import_id] || {
      placements: 0,
      missing_targets: 0,
      kind_mismatches: 0,
      hash_mismatches: 0,
      local_overrides: 0,
      pending_adapter_points: 0,
      replaceable_false: 0,
      ownership_modes: {}
    };
    const latestEvent = journalSummary.latest_by_import[entry.import_id] || null;
    return {
      import_id: entry.import_id,
      artifact_type: entry.artifact_type,
      artifact_id: entry.artifact_id,
      status: entry.status,
      placements: placement.placements,
      missing_targets: placement.missing_targets,
      kind_mismatches: placement.kind_mismatches,
      hash_mismatches: placement.hash_mismatches,
      local_overrides: placement.local_overrides,
      pending_adapter_points: placement.pending_adapter_points,
      replaceable_false: placement.replaceable_false,
      ownership_modes: placement.ownership_modes,
      latest_event: latestEvent
    };
  });
}

function compareReleaseAlignment(left: unknown, right: unknown) {
  if (!isObject(left) || !isObject(right)) {
    return {
      comparable: false,
      artifact_type_match: null,
      artifact_id_match: null,
      release_version_match: null,
      release_hash_match: null,
      fully_aligned: null
    };
  }
  const artifactTypeMatch = !left.artifact_type || !right.artifact_type ? null : left.artifact_type === right.artifact_type;
  const artifactIdMatch = !left.artifact_id || !right.artifact_id ? null : artifactIdsMatch(left.artifact_id, right.artifact_id);
  const releaseVersionMatch = !left.release_version || !right.release_version ? null : left.release_version === right.release_version;
  const releaseHashMatch = !left.release_hash || !right.release_hash ? null : left.release_hash === right.release_hash;
  const comparableFlags = [artifactTypeMatch, artifactIdMatch, releaseVersionMatch, releaseHashMatch].filter((value) => value !== null);
  return {
    comparable: true,
    artifact_type_match: artifactTypeMatch,
    artifact_id_match: artifactIdMatch,
    release_version_match: releaseVersionMatch,
    release_hash_match: releaseHashMatch,
    fully_aligned: comparableFlags.length > 0 ? comparableFlags.every(Boolean) : null
  };
}

function summarizeLockedArtifactEvidence(artifacts: LockedArtifact[], minimumVerificationStatus: string | null) {
  const byVerificationStatus: Counter = {};
  const byTrustTier: Counter = {};
  const byChannel: Counter = {};
  const bySourceProject: Counter = {};
  let meetsMinimumVerification = 0;
  let belowMinimumVerification = 0;
  let localOverrideImports = 0;

  for (const artifact of artifacts) {
    incrementCounter(byVerificationStatus, orElse(artifact.verification_status, () => "unknown"));
    incrementCounter(byTrustTier, orElse(artifact.trust_tier, () => "unknown"));
    incrementCounter(byChannel, orElse(artifact.channel, () => "unknown"));
    incrementCounter(bySourceProject, orElse(artifact.source_project, () => "unknown"));
    if ((artifact.local_overrides || 0) > 0) localOverrideImports += 1;
    if (minimumVerificationStatus) {
      if (verificationRank(artifact.verification_status) >= verificationRank(minimumVerificationStatus)) meetsMinimumVerification += 1;
      else belowMinimumVerification += 1;
    }
  }

  return {
    total: artifacts.length,
    by_verification_status: byVerificationStatus,
    by_trust_tier: byTrustTier,
    by_channel: byChannel,
    by_source_project: bySourceProject,
    meets_minimum_verification: meetsMinimumVerification,
    below_minimum_verification: belowMinimumVerification,
    imports_with_local_overrides: localOverrideImports,
    artifacts
  };
}

function summarizePlacementIntegrity(_placementsSummary: PlacementsSummary, placementsHealth: PlacementsHealth) {
  const byImport = placementsHealth.by_import;
  return {
    total_placements: placementsHealth.total,
    existing_targets: placementsHealth.existing_targets,
    missing_targets: placementsHealth.missing_targets,
    kind_mismatches: placementsHealth.kind_mismatches,
    hash_matches: placementsHealth.hash_matches,
    hash_mismatches: placementsHealth.hash_mismatches,
    local_override_count: placementsHealth.local_overrides,
    pending_adapter_point_count: placementsHealth.pending_adapter_points,
    non_replaceable_count: placementsHealth.replaceable_false,
    env_binding_count: placementsHealth.env_binding_count,
    ownership_modes: placementsHealth.ownership_modes,
    imports_with_drift: Object.values(byImport).filter((entry) => entry.hash_mismatches > 0).length,
    imports_with_missing_targets: Object.values(byImport).filter((entry) => entry.missing_targets > 0).length,
    imports_with_pending_adapter_points: Object.values(byImport).filter((entry) => entry.pending_adapter_points > 0).length,
    by_import: Object.entries(byImport)
      .map(([importId, entry]) => ({
        import_id: importId,
        placements: entry.placements,
        missing_targets: entry.missing_targets,
        kind_mismatches: entry.kind_mismatches,
        hash_mismatches: entry.hash_mismatches,
        local_overrides: entry.local_overrides,
        pending_adapter_points: entry.pending_adapter_points,
        replaceable_false: entry.replaceable_false,
        ownership_modes: entry.ownership_modes
      }))
      .sort((left, right) => left.import_id.localeCompare(right.import_id))
  };
}

function summarizeBuildResolution({ importsSummary, buildLockSummary, placementsSummary, buildLockDoc }: {
  importsSummary: ImportsSummary;
  buildLockSummary: BuildLockSummary;
  placementsSummary: PlacementsSummary;
  buildLockDoc: JsonObject | null;
}) {
  const selectedBuilds = buildLockSummary.selected_builds.artifacts;
  const resolvedBricks = buildLockSummary.resolved_bricks.artifacts;
  const graphNodes = buildLockSummary.graph_nodes;
  const graphEdges = buildLockSummary.graph_edge_records;
  const graphNodeIds = new Set(graphNodes.map((node) => node.node_id).filter(Boolean));
  const placementImportsById = new Map(placementsSummary.imports.map((entry) => [entry.import_id, entry]));
  const trustPolicy = isObject(buildLockDoc?.trust_policy) ? buildLockDoc.trust_policy : {};
  const minimumVerificationStatus = isNonEmptyString(trustPolicy.minimum_verification_status)
    ? trustPolicy.minimum_verification_status
    : null;
  const selectedEvidence = summarizeLockedArtifactEvidence(selectedBuilds, minimumVerificationStatus);
  const resolvedEvidence = summarizeLockedArtifactEvidence(resolvedBricks, minimumVerificationStatus);

  const outgoing = new Map<string, GraphEdgeSummary[]>();
  const incoming = new Map<string, GraphEdgeSummary[]>();
  for (const edge of graphEdges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    outgoing.get(edge.from)?.push(edge);
    incoming.get(edge.to)?.push(edge);
  }

  const selectedBuildIds = new Set(selectedBuilds.map((entry) => entry.import_id));
  const resolvedBrickIds = new Set(resolvedBricks.map((entry) => entry.import_id));
  const selectedBuildsWithoutResolvedBricks = selectedBuilds
    .filter((entry) => !(orElse(outgoing.get(entry.import_id), () => [])).some((edge) => resolvedBrickIds.has(edge.to)))
    .map((entry) => entry.import_id);
  const resolvedBricksWithoutParentBuild = resolvedBricks
    .filter((entry) => !(orElse(incoming.get(entry.import_id), () => [])).some((edge) => selectedBuildIds.has(edge.from)))
    .map((entry) => entry.import_id);

  let exactMatches = 0;
  let artifactMismatches = 0;
  let versionMismatches = 0;
  let hashMismatches = 0;
  let typeMismatches = 0;
  let comparedImports = 0;
  for (const entry of [...selectedBuilds, ...resolvedBricks]) {
    const placementImport = placementImportsById.get(entry.import_id);
    if (!placementImport) continue;
    comparedImports += 1;
    const alignment = compareReleaseAlignment(entry, placementImport);
    if (alignment.artifact_type_match === false) typeMismatches += 1;
    if (alignment.artifact_id_match === false) artifactMismatches += 1;
    if (alignment.release_version_match === false) versionMismatches += 1;
    if (alignment.release_hash_match === false) hashMismatches += 1;
    if (alignment.fully_aligned) exactMatches += 1;
  }

  return {
    selected_builds: selectedEvidence,
    resolved_bricks: resolvedEvidence,
    graph: {
      node_count: graphNodes.length,
      edge_count: graphEdges.length,
      build_node_count: graphNodes.filter((node) => node.artifact_type === "build").length,
      brick_node_count: graphNodes.filter((node) => node.artifact_type === "brick").length,
      selected_build_node_coverage: {
        covered: selectedBuilds.filter((entry) => graphNodeIds.has(entry.import_id)).length,
        missing: selectedBuilds.filter((entry) => !graphNodeIds.has(entry.import_id)).map((entry) => entry.import_id)
      },
      resolved_brick_node_coverage: {
        covered: resolvedBricks.filter((entry) => graphNodeIds.has(entry.import_id)).length,
        missing: resolvedBricks.filter((entry) => !graphNodeIds.has(entry.import_id)).map((entry) => entry.import_id)
      },
      selected_build_dependency_edges: graphEdges.filter((edge) => selectedBuildIds.has(edge.from) && resolvedBrickIds.has(edge.to)).length,
      selected_builds_without_resolved_bricks: selectedBuildsWithoutResolvedBricks,
      resolved_bricks_without_parent_build: resolvedBricksWithoutParentBuild
    },
    coverage: {
      imports_in_lock: importsSummary.imports.filter((entry) => selectedBuildIds.has(entry.import_id) || resolvedBrickIds.has(entry.import_id)).length,
      imports_missing_from_lock: importsSummary.imports.filter((entry) => !selectedBuildIds.has(entry.import_id) && !resolvedBrickIds.has(entry.import_id)).map((entry) => entry.import_id),
      placement_imports_in_lock: placementsSummary.imports.filter((entry) => selectedBuildIds.has(entry.import_id) || resolvedBrickIds.has(entry.import_id)).length,
      placement_imports_missing_from_lock: placementsSummary.imports.filter((entry) => !selectedBuildIds.has(entry.import_id) && !resolvedBrickIds.has(entry.import_id)).map((entry) => entry.import_id)
    },
    release_compatibility: {
      compared_imports: comparedImports,
      exact_matches: exactMatches,
      type_mismatches: typeMismatches,
      artifact_mismatches: artifactMismatches,
      version_mismatches: versionMismatches,
      hash_mismatches: hashMismatches,
      missing_placement_imports: [...selectedBuilds, ...resolvedBricks]
        .filter((entry) => !placementImportsById.has(entry.import_id))
        .map((entry) => entry.import_id)
    },
    trust_signals: {
      minimum_verification_status: minimumVerificationStatus,
      allow_local_overrides: Boolean(trustPolicy.allow_local_overrides),
      require_contract_hashes: Boolean(trustPolicy.require_contract_hashes),
      selected_builds_meeting_policy: selectedEvidence.meets_minimum_verification,
      resolved_bricks_meeting_policy: resolvedEvidence.meets_minimum_verification,
      selected_builds_below_policy: selectedEvidence.below_minimum_verification,
      resolved_bricks_below_policy: resolvedEvidence.below_minimum_verification
    },
    imports: importsSummary.imports
      .map((entry) => ({
        import_id: entry.import_id,
        artifact_type: entry.artifact_type,
        artifact_id: entry.artifact_id,
        lock_role: selectedBuildIds.has(entry.import_id)
          ? "selected_build"
          : resolvedBrickIds.has(entry.import_id)
            ? "resolved_brick"
            : "untracked",
        placement_import_present: placementImportsById.has(entry.import_id),
        graph_node_present: graphNodeIds.has(entry.import_id)
      }))
      .sort((left, right) => left.import_id.localeCompare(right.import_id))
  };
}

function findRegistrySnapshotValues(
  importsDoc: unknown,
  buildLockDoc: unknown,
  placementsDoc: unknown,
  journalEvents: JournalLine[],
): string[] {
  const imports = isObject(importsDoc) ? safeArray(importsDoc.imports) : [];
  const lock = isObject(buildLockDoc) && isObject(buildLockDoc.lock) ? buildLockDoc.lock : {};
  const placementMap = isObject(placementsDoc) && isObject(placementsDoc.map) ? placementsDoc.map : {};
  return uniqStrings([
    ...imports.map((entry) => isObject(entry) && isObject(entry.source_registry) ? entry.source_registry.sha256 : undefined),
    lock.registry_snapshot_sha,
    placementMap.registry_snapshot_sha,
    ...journalEvents.map(({ record }) => isObject(record) ? record.registry_snapshot_sha : undefined)
  ]);
}

function finalizeStatus(counts: Record<CheckLevel, number>): CheckLevel {
  if (counts.fail > 0) return "fail";
  if (counts.warn > 0) return "warn";
  return "pass";
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const targetRoot = path.resolve(options.target || process.cwd());
  const smarchRoot = options.smarchRoot ? path.resolve(options.smarchRoot) : path.resolve(targetRoot, ".smarch");

  const recorder = createRecorder(options.maxChecks);
  const files: Record<string, { path: string; exists: boolean; parsed: boolean }> & {
    imports: { path: string; exists: boolean; parsed: boolean };
    build_lock: { path: string; exists: boolean; parsed: boolean };
    placements: { path: string; exists: boolean; parsed: boolean };
    update_journal: { path: string; exists: boolean; parsed: boolean };
  } = {
    imports: { path: path.resolve(smarchRoot, "imports.json"), exists: false, parsed: false },
    build_lock: { path: path.resolve(smarchRoot, "build-lock.json"), exists: false, parsed: false },
    placements: { path: path.resolve(smarchRoot, "placements.json"), exists: false, parsed: false },
    update_journal: { path: path.resolve(smarchRoot, "update-journal.jsonl"), exists: false, parsed: false }
  };

  let importsDoc: unknown = null;
  let buildLockDoc: unknown = null;
  let placementsDoc: unknown = null;
  let journalEvents: JournalLine[] = [];

  for (const [key, file] of Object.entries(files)) {
    file.exists = await pathExists(file.path);
    if (!file.exists) {
      recorder.fail("file.missing", `Required SMARCH file is missing: ${file.path}`, { file: key, path: file.path });
      continue;
    }
    recorder.pass("file.exists", `Found required SMARCH file: ${file.path}`, { file: key, path: file.path });
    try {
      if (key === "update_journal") {
        journalEvents = await readJsonLines(file.path);
      } else {
        const parsed = await readJsonFile(file.path);
        if (key === "imports") importsDoc = parsed;
        if (key === "build_lock") buildLockDoc = parsed;
        if (key === "placements") placementsDoc = parsed;
      }
      file.parsed = true;
      recorder.pass("file.parsed", `Parsed ${file.path}`, { file: key, path: file.path });
    } catch (error: unknown) {
      recorder.fail("file.parse", `Failed to parse ${file.path}: ${error instanceof Error ? error.message : String(error)}`, { file: key, path: file.path });
    }
  }

  const importsSummary: ImportsSummary = files.imports.parsed ? validateImportsDocument(importsDoc, recorder) : {
    total_imports: 0,
    by_status: {},
    by_artifact_type: {},
    import_ids: [],
    imports: [],
    env_bindings: new Map<string, EnvAggregate>()
  };
  const buildLockSummary: BuildLockSummary = files.build_lock.parsed ? validateBuildLock(buildLockDoc, recorder, targetRoot) : {
    selected_builds: { import_ids: [], artifacts: [] },
    resolved_bricks: { import_ids: [], artifacts: [] },
    graph_node_ids: new Set(),
    graph_nodes: [],
    graph_edge_records: [],
    graph_edges: 0,
    registry_snapshot_sha: ""
  };
  const placementsSummary: PlacementsSummary = files.placements.parsed ? validatePlacements(placementsDoc, recorder, targetRoot) : {
    imports: [],
    import_ids: [],
    placements: [],
    env_bindings: new Map<string, EnvAggregate>(),
    registry_snapshot_sha: ""
  };
  const journalSummary: JournalSummary = files.update_journal.parsed ? validateJournal(journalEvents, recorder) : {
    total_events: 0,
    by_result: {},
    by_event_type: {},
    latest_created_at: null,
    latest_by_import: {}
  };

  const importIds = new Set(importsSummary.import_ids);
  const lockImportIds = new Set<string>([
    ...buildLockSummary.selected_builds.import_ids,
    ...buildLockSummary.resolved_bricks.import_ids
  ]);
  const placementImportIds = new Set(placementsSummary.import_ids);

  for (const importId of importIds) {
    if (!lockImportIds.has(importId)) {
      recorder.warn("crosscheck.lock.coverage", `Import "${importId}" is not represented in build-lock.json`, { import_id: importId });
    }
    if (!placementImportIds.has(importId)) {
      recorder.fail("crosscheck.placements.coverage", `Import "${importId}" is not represented in placements.json`, { import_id: importId });
    }
    if (!journalSummary.latest_by_import[importId]) {
      recorder.warn("crosscheck.journal.coverage", `Import "${importId}" has no journal event`, { import_id: importId });
    }
  }

  for (const importId of placementImportIds) {
    if (!importIds.has(importId)) {
      recorder.fail("crosscheck.imports.orphan_placement_import", `placements.json references import "${importId}" that is missing in imports.json`, { import_id: importId });
    }
  }

  const placementsHealth = await verifyPlacementTargets(placementsSummary, targetRoot, recorder);

  const envMap: EnvMap = new Map();
  mergeEnvMap(envMap, importsSummary.env_bindings);
  mergeEnvMap(envMap, placementsSummary.env_bindings);

  const envSummary = summarizeEnvMap(envMap, process.env);
  const buildLockDocObject = isObject(buildLockDoc) ? buildLockDoc : null;
  const verificationPolicy = isObject(buildLockDocObject?.verification_policy)
    ? buildLockDocObject.verification_policy
    : {};
  const failOnMissingEnv = Boolean(verificationPolicy.fail_on_missing_env);
  for (const variable of envSummary.variables) {
    if (variable.satisfied) continue;
    if (variable.required) {
      const detail = {
        env_name: variable.name,
        aliases: variable.aliases,
        import_ids: variable.import_ids,
        placement_ids: variable.placement_ids
      };
      if (failOnMissingEnv) recorder.fail("env.binding.missing_required", `Required env binding is missing from process env: ${variable.name}`, detail);
      else recorder.warn("env.binding.missing_required", `Required env binding is missing from process env: ${variable.name}`, detail);
      continue;
    }
    recorder.warn("env.binding.missing_optional", `Optional env binding is not present in process env: ${variable.name}`, {
      env_name: variable.name,
      import_ids: variable.import_ids,
      placement_ids: variable.placement_ids
    });
  }
  recorder.pass("env.summary", "Computed env binding summary", {
    total: envSummary.total,
    missing_required: envSummary.missing_required,
    missing_optional: envSummary.missing_optional
  });

  const registrySnapshots = findRegistrySnapshotValues(importsDoc, buildLockDoc, placementsDoc, journalEvents);
  if (registrySnapshots.length > 1) {
    recorder.warn("crosscheck.registry_snapshot", "Multiple registry snapshot hashes are present across SMARCH artifacts", {
      registry_snapshot_shas: registrySnapshots
    });
  } else if (registrySnapshots.length === 1) {
    recorder.pass("crosscheck.registry_snapshot", "Registry snapshot hash is consistent across SMARCH artifacts", {
      registry_snapshot_sha: registrySnapshots[0]
    });
  }

  const importHealth = buildImportHealth(importsSummary, placementsHealth, journalSummary);
  const placementIntegritySummary = summarizePlacementIntegrity(placementsSummary, placementsHealth);
  const buildResolutionSummary = summarizeBuildResolution({
    importsSummary,
    buildLockSummary,
    placementsSummary,
    buildLockDoc: buildLockDocObject
  });
  recorder.pass("placements.summary", "Computed placement health summary", {
    total: placementsHealth.total,
    missing_targets: placementsHealth.missing_targets,
    hash_mismatches: placementsHealth.hash_mismatches
  });
  recorder.pass("build_lock.resolution", "Computed build-level lock and graph integrity summary", {
    selected_builds: buildResolutionSummary.selected_builds.total,
    resolved_bricks: buildResolutionSummary.resolved_bricks.total,
    graph_nodes: buildResolutionSummary.graph.node_count,
    graph_edges: buildResolutionSummary.graph.edge_count,
    release_exact_matches: buildResolutionSummary.release_compatibility.exact_matches
  });
  const report = {
    schema: "smarch.import-verify-report.v0",
    generated_at: new Date().toISOString(),
    status: finalizeStatus(recorder.counts),
    target: {
      root: targetRoot,
      smarch_root: smarchRoot
    },
    counts: recorder.counts,
    checks_truncated: recorder.checksTruncated,
    files,
    summaries: {
      imports: {
        total_imports: importsSummary.total_imports,
        by_status: importsSummary.by_status,
        by_artifact_type: importsSummary.by_artifact_type,
        import_health: importHealth
      },
      build_lock: {
        selected_builds: safeArray(buildLockSummary.selected_builds.artifacts).length,
        resolved_bricks: safeArray(buildLockSummary.resolved_bricks.artifacts).length,
        graph_nodes: buildLockSummary.graph_node_ids instanceof Set ? buildLockSummary.graph_node_ids.size : 0,
        graph_edges: buildLockSummary.graph_edges
      },
      build_resolution: buildResolutionSummary,
      placements: {
        total_placements: placementsHealth.total,
        existing_targets: placementsHealth.existing_targets,
        missing_targets: placementsHealth.missing_targets,
        kind_mismatches: placementsHealth.kind_mismatches,
        hash_matches: placementsHealth.hash_matches,
        hash_mismatches: placementsHealth.hash_mismatches,
        by_kind: placementsHealth.by_kind
      },
      placement_integrity: placementIntegritySummary,
      env: {
        total_bindings: envSummary.total,
        required_bindings: envSummary.required,
        optional_bindings: envSummary.optional,
        satisfied_bindings: envSummary.satisfied,
        missing_required: envSummary.missing_required,
        missing_optional: envSummary.missing_optional,
        variables: envSummary.variables
      },
      journal: {
        total_events: journalSummary.total_events,
        by_result: journalSummary.by_result,
        by_event_type: journalSummary.by_event_type,
        latest_created_at: journalSummary.latest_created_at
      },
      registry_snapshots: registrySnapshots
    },
    checks: recorder.checks
  };

  const output = options.compact ? JSON.stringify(report) : JSON.stringify(report, null, 2);
  console.log(output);
  process.exit(report.counts.fail > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
