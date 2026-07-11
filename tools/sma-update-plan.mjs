#!/usr/bin/env node
/**
 * WHAT: Produces a machine-readable update plan for an installed project.
 * WHY: Version changes need explicit placements, checks, and rollback data before files move.
 * HOW: Reads the target .smarch control plane and selected release metadata without editing targets.
 * OUTPUTS: Prints or writes a bounded update-plan document.
 * CALLERS: Propagation and installation workflows use the plan before applying a release.
 * USAGE: `node tools/sma-update-plan.mjs --help`
 * Glossary: [SMA](../docs/GLOSSARY.md).
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const PLAN_SCHEMA = "smarch.update-plan.v0";
const SCHEMA_VERSION = "1.0.0";
const DEFAULT_MAX_PLACEMENTS = 200;
const DEFAULT_MAX_CHECKS = 200;
const DEFAULT_MAX_JOURNAL = 20;
const SEMVER_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HASH_RE = /^[A-Fa-f0-9]{7,128}$/;
const VERIFICATION_RANK = {
  failed: -1,
  unverified: 0,
  candidate: 1,
  verified: 2,
  canonical: 3
};
const UPDATE_RESULT_SUCCESS = new Set(["installed", "updated", "partial", "rolled_back"]);
const HELP_TEXT = `Usage: node tools/sma-update-plan.mjs [options]

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
  --max-placements <n>       Max impacted placements per import in output. Default: ${DEFAULT_MAX_PLACEMENTS}
  --max-checks <n>           Max expected checks per import in output. Default: ${DEFAULT_MAX_CHECKS}
  --max-journal <n>          Max journal events per import in output. Default: ${DEFAULT_MAX_JOURNAL}
  --help                     Show this help.

Examples:
  node tools/sma-update-plan.mjs --target /path/to/project
  node tools/sma-update-plan.mjs --target /path/to/project --release releases/foo/1.2.0.json
  node tools/sma-update-plan.mjs --target /path/to/project --artifact-id foo.bar.baz --stdout
`;

function fail(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = {
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

    const next = argv[index + 1];
    if (next === undefined) fail(`missing value for ${arg}`);

    switch (arg) {
      case "--target":
        options.target = path.resolve(next);
        break;
      case "--smarch-root":
        options.smarchRoot = path.resolve(next);
        break;
      case "--release":
        options.release = path.resolve(next);
        break;
      case "--out":
        options.out = path.resolve(next);
        break;
      case "--import-id":
        options.importIds.push(next);
        break;
      case "--artifact-id":
        options.artifactId = next;
        break;
      case "--artifact-type":
        options.artifactType = next;
        break;
      case "--max-placements":
        options.maxPlacements = parsePositiveInt(next, "--max-placements");
        break;
      case "--max-checks":
        options.maxChecks = parsePositiveInt(next, "--max-checks");
        break;
      case "--max-journal":
        options.maxJournal = parsePositiveInt(next, "--max-journal");
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }

    index += 1;
  }

  if (!options.stdout && !options.out) options.stdout = true;
  if (options.artifactType && !["brick", "build"].includes(options.artifactType)) {
    fail(`--artifact-type must be "brick" or "build", got "${options.artifactType}"`);
  }

  return options;
}

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`${label} must be a non-negative integer`);
  return parsed;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniq(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ""))];
}

function uniqStrings(values) {
  return uniq(
    safeArray(values)
      .map((value) => (typeof value === "string" ? value.trim() : String(value || "").trim()))
      .filter(Boolean)
  );
}

function incrementCounter(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function artifactIdAliases(value) {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const aliases = new Set([raw]);
  const parts = raw.split(".");
  if (parts.length >= 2 && parts[0] === parts[1]) {
    aliases.add(parts.slice(1).join("."));
  }
  return [...aliases];
}

function artifactIdsMatch(left, right) {
  const leftAliases = new Set(artifactIdAliases(left));
  const rightAliases = artifactIdAliases(right);
  return rightAliases.some((alias) => leftAliases.has(alias));
}

function normalizePath(value) {
  return String(value || "").split(path.sep).join("/");
}

function sortByDateDesc(values, key = "created_at") {
  return [...values].sort((left, right) => {
    const l = Date.parse(left?.[key] || left?.record?.[key] || 0);
    const r = Date.parse(right?.[key] || right?.record?.[key] || 0);
    return r - l;
  });
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readJsonLines(filePath) {
  const records = [];
  const lines = (await fs.readFile(filePath, "utf8")).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    records.push({
      line_number: index + 1,
      record: JSON.parse(trimmed)
    });
  }
  return records;
}

function relativeTo(root, targetPath) {
  return normalizePath(path.relative(root, targetPath));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

function verificationRank(value) {
  return VERIFICATION_RANK[String(value || "").toLowerCase()] ?? -1;
}

function compareVerification(left, right) {
  return verificationRank(left) - verificationRank(right);
}

function parseSemver(value) {
  const trimmed = String(value || "").trim();
  if (!SEMVER_RE.test(trimmed)) return null;
  const [core, pre = ""] = trimmed.split("-", 2);
  const [major, minor, patch] = core.split(".").map((part) => Number.parseInt(part, 10));
  return { raw: trimmed, major, minor, patch, prerelease: pre };
}

function compareSemver(left, right) {
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

function summarizeVersionDelta(currentVersion, nextVersion) {
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

function dedupeBy(values, keyFn) {
  const map = new Map();
  for (const value of values) {
    const key = keyFn(value);
    if (!key || map.has(key)) continue;
    map.set(key, value);
  }
  return [...map.values()];
}

function makeIssue(severity, code, message, extra = {}) {
  return {
    severity,
    code,
    message,
    ...extra
  };
}

function pushIssue(issues, severity, code, message, extra = {}) {
  issues.push(makeIssue(severity, code, message, extra));
}

function resolveRelativeToTarget(targetRoot, value, fallback) {
  const candidate = String(value || "").trim();
  if (!candidate) return fallback;
  return path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(targetRoot, candidate);
}

function toRecordMap(values, keyField) {
  const map = new Map();
  for (const value of safeArray(values)) {
    const key = value?.[keyField];
    if (!isNonEmptyString(key)) continue;
    map.set(key, value);
  }
  return map;
}

function groupBy(values, keyField) {
  const map = new Map();
  for (const value of safeArray(values)) {
    const key = value?.[keyField];
    if (!isNonEmptyString(key)) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }
  return map;
}

function clampItems(values, maxItems) {
  if (maxItems < 0) return { items: values, truncated: 0 };
  if (values.length <= maxItems) return { items: values, truncated: 0 };
  return {
    items: values.slice(0, maxItems),
    truncated: values.length - maxItems
  };
}

function gatherCurrentEnvBindings(importRecord, placementsForImport) {
  const results = [];
  const importEnv = isObject(importRecord?.contracts?.env) ? importRecord.contracts.env : {};
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
      surface: variable.surface || variable.scope || "server",
      required: requiredSet.has(variable.name),
      bound_to: variable.bound_to || variable.example || null,
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

  for (const name of uniqStrings(importRecord?.contracts?.env_bindings)) {
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

  for (const placement of placementsForImport) {
    for (const binding of safeArray(placement.env_bindings)) {
      if (!isObject(binding) || !isNonEmptyString(binding.name)) continue;
      results.push({
        name: binding.name,
        surface: binding.surface || "server",
        required: Boolean(binding.required),
        bound_to: binding.bound_to || null,
        source: `placement:${placement.placement_id}`
      });
    }
  }

  const merged = new Map();
  for (const binding of results) {
    const key = `${binding.name}::${binding.surface}`;
    if (!merged.has(key)) {
      merged.set(key, { ...binding });
      continue;
    }
    const current = merged.get(key);
    current.required = current.required || binding.required;
    current.bound_to = current.bound_to || binding.bound_to || null;
    current.source = uniqStrings([current.source, binding.source]).join(", ");
  }
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function summarizeReleaseCandidate(releaseArtifact) {
  if (!isObject(releaseArtifact) || !isObject(releaseArtifact.release)) return null;
  const release = releaseArtifact.release;
  return {
    artifact_type: release.artifact_type || null,
    artifact_id: release.artifact_id || null,
    release_id: release.release_id || null,
    version: release.version || null,
    status: release.status || null,
    channel: release.channel || null,
    content_hash: release.content_hash || null,
    breaking: Boolean(release.breaking),
    verification_status: releaseArtifact?.verification?.status || null,
    rollback_supported: Boolean(releaseArtifact?.verification?.rollback_supported),
    source_project: release.source_project || null,
    required_env: uniqStrings(releaseArtifact?.contracts?.required_env),
    optional_env: uniqStrings(releaseArtifact?.contracts?.optional_env),
    forbidden_env: uniqStrings(releaseArtifact?.contracts?.forbidden_env),
    smoke_commands: uniqStrings(releaseArtifact?.verification?.smoke_commands),
    manual_steps: uniqStrings(releaseArtifact?.migration?.manual_steps),
    migration_commands: uniqStrings(releaseArtifact?.migration?.commands),
    rollback_commands: uniqStrings(releaseArtifact?.rollback?.commands),
    rollback_notes: releaseArtifact?.rollback?.notes || null,
    dependency_refs: safeArray(releaseArtifact?.contracts?.dependency_refs)
      .filter((ref) => isObject(ref) && isNonEmptyString(ref.artifact_id) && isNonEmptyString(ref.artifact_type))
      .map((ref) => ({
        artifact_type: ref.artifact_type,
        artifact_id: ref.artifact_id,
        required: Boolean(ref.required),
        version_range: ref.version_range || null,
        release_ref: ref.release_ref || null
      })),
    artifacts: safeArray(releaseArtifact?.content?.artifacts)
      .filter((artifact) => isObject(artifact) && isNonEmptyString(artifact.path))
      .map((artifact) => ({
        path: normalizePath(artifact.path),
        kind: artifact.kind || "file",
        sha256: HASH_RE.test(String(artifact.sha256 || "")) ? artifact.sha256 : null
      })),
    included_paths: uniqStrings(releaseArtifact?.content?.included_paths).map((entry) => normalizePath(entry)),
    checks: safeArray(releaseArtifact?.verification?.checks)
      .filter((check) => isObject(check) && isNonEmptyString(check.name))
      .map((check) => ({
        name: check.name,
        status: check.status || "skipped",
        command: check.command || null,
        evidence_path: check.evidence_path || null
      }))
  };
}

function releaseAppliesToImport(importSnapshot, releaseSummary) {
  if (!releaseSummary) return false;
  return importSnapshot.artifact_type === releaseSummary.artifact_type
    && artifactIdsMatch(importSnapshot.artifact_id, releaseSummary.artifact_id);
}

function matchReleaseArtifactToPlacement(placement, releaseSummary) {
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
        candidate_sha256: artifact.sha256 || null,
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

async function collectPlacementImpact({ targetRoot, placement, releaseSummary, trustPolicy }) {
  const targetAbsolutePath = path.resolve(targetRoot, placement.target_path || "");
  const exists = await pathExists(targetAbsolutePath);
  const currentHash = exists ? await sha256File(targetAbsolutePath) : null;
  const recordedHash = placement.target_hash || null;
  const sourceHash = placement.source_hash || null;
  const drifted = Boolean(exists && recordedHash && currentHash && currentHash !== recordedHash);
  const localOverrides = safeArray(placement.local_overrides);
  const overrideCount = localOverrides.length;
  const requiredAdapterPoints = safeArray(placement.adapter_points).filter((point) => point?.required);
  const pendingAdapterCount = requiredAdapterPoints.filter((point) => point.status !== "bound").length;
  const ownership = isObject(placement.ownership) ? placement.ownership : {};
  const replaceable = ownership.replaceable !== false;
  const managed = String(ownership.mode || "").toLowerCase() === "managed";
  const releaseMatch = matchReleaseArtifactToPlacement(placement, releaseSummary);
  const reasons = [];
  let impact = "verify_only";

  if (!exists) {
    impact = "blocked";
    reasons.push("target_missing");
  }
  if (drifted) {
    impact = "manual_review";
    reasons.push("target_drifted");
  }
  if (overrideCount > 0) {
    impact = "manual_review";
    reasons.push("local_overrides");
  }
  if (!managed || !replaceable) {
    if (impact !== "blocked") impact = "manual_review";
    reasons.push("non_replaceable_ownership");
  }
  if (pendingAdapterCount > 0) {
    if (impact !== "blocked") impact = "manual_review";
    reasons.push("pending_adapter_points");
  }
  if (releaseSummary) {
    if (releaseMatch.included === false) {
      if (impact !== "blocked") impact = "manual_review";
      reasons.push("placement_not_in_release");
    } else if (impact === "verify_only") {
      impact = "replace_in_place";
    }
    if (releaseMatch.candidate_sha256 && currentHash && currentHash === releaseMatch.candidate_sha256) {
      impact = "already_matches_candidate";
      reasons.push("candidate_hash_matches_current");
    }
  }
  if (trustPolicy?.allow_local_overrides === false && overrideCount > 0) {
    impact = "blocked";
    reasons.push("trust_policy_blocks_local_overrides");
  }

  return {
    placement_id: placement.placement_id || null,
    target_path: placement.target_path || null,
    kind: placement.kind || null,
    exists,
    ownership: {
      mode: ownership.mode || null,
      owner: ownership.owner || null,
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
    local_override_kinds: uniqStrings(localOverrides.map((override) => override?.kind).filter(Boolean))
  };
}

function collectTrustPolicyIssues({
  importSnapshot,
  releaseSummary,
  lockEntry,
  buildLock,
  envSummary,
  contractDelta,
  placementImpactSummary
}) {
  const issues = [];
  const trustPolicy = isObject(buildLock?.trust_policy) ? buildLock.trust_policy : {};
  const verificationPolicy = isObject(buildLock?.verification_policy) ? buildLock.verification_policy : {};

  if (Number(lockEntry?.local_overrides || 0) > 0 && trustPolicy.allow_local_overrides === false) {
    pushIssue(
      issues,
      "error",
      "local_overrides_disallowed",
      "Local overrides are present but trust_policy.allow_local_overrides is false",
      { import_id: importSnapshot.import_id, local_overrides: lockEntry.local_overrides }
    );
  }

  if (envSummary.missing_required.length > 0 && verificationPolicy.fail_on_missing_env) {
    pushIssue(
      issues,
      "error",
      "missing_required_env",
      "Required env bindings are missing for this import",
      { import_id: importSnapshot.import_id, env_names: envSummary.missing_required }
    );
  } else if (envSummary.missing_required.length > 0) {
    pushIssue(
      issues,
      "warning",
      "missing_required_env",
      "Required env bindings are missing and must be set before update",
      { import_id: importSnapshot.import_id, env_names: envSummary.missing_required }
    );
  }

  if (placementImpactSummary.drifted_count > 0) {
    pushIssue(
      issues,
      trustPolicy.allow_local_overrides === false ? "error" : "warning",
      "placement_drift",
      "One or more managed placements have drifted from their recorded target hash",
      { import_id: importSnapshot.import_id, drifted_count: placementImpactSummary.drifted_count }
    );
  }

  if (placementImpactSummary.blocked_count > 0) {
    pushIssue(
      issues,
      "error",
      "blocked_placements",
      "One or more placements cannot be safely replaced automatically",
      { import_id: importSnapshot.import_id, blocked_count: placementImpactSummary.blocked_count }
    );
  }

  if (releaseSummary) {
    const allowedStatuses = uniqStrings(trustPolicy.allowed_release_statuses);
    if (allowedStatuses.length > 0 && !allowedStatuses.includes(releaseSummary.status)) {
      pushIssue(
        issues,
        "error",
        "release_status_disallowed",
        `Release status "${releaseSummary.status}" is not allowed by trust policy`,
        { import_id: importSnapshot.import_id, allowed_statuses: allowedStatuses }
      );
    }

    if (releaseSummary.status === "yanked" && trustPolicy.fail_on_yanked_release !== false) {
      pushIssue(
        issues,
        "error",
        "yanked_release",
        "Trust policy blocks updates to yanked releases",
        { import_id: importSnapshot.import_id }
      );
    }

    if (trustPolicy.fail_on_breaking_upgrade !== false && releaseSummary.breaking) {
      pushIssue(
        issues,
        "error",
        "breaking_upgrade",
        "Release is marked as breaking and trust policy blocks automatic breaking upgrades",
        { import_id: importSnapshot.import_id, release_version: releaseSummary.version }
      );
    }

    if (isNonEmptyString(trustPolicy.minimum_verification_status)
        && compareVerification(releaseSummary.verification_status, trustPolicy.minimum_verification_status) < 0) {
      pushIssue(
        issues,
        "error",
        "verification_below_policy",
        `Release verification status "${releaseSummary.verification_status || "unverified"}" is below minimum "${trustPolicy.minimum_verification_status}"`,
        {
          import_id: importSnapshot.import_id,
          minimum_verification_status: trustPolicy.minimum_verification_status
        }
      );
    }

    if (trustPolicy.require_contract_hashes) {
      const hashes = isObject(releaseSummary.raw_contract_hashes) ? releaseSummary.raw_contract_hashes : null;
      if (!hashes || Object.keys(hashes).length === 0) {
        pushIssue(
          issues,
          "error",
          "missing_contract_hashes",
          "Trust policy requires release contract hashes, but none were provided",
          { import_id: importSnapshot.import_id }
        );
      }
    }

    if (verificationPolicy.fail_on_contract_delta && contractDelta.changed) {
      pushIssue(
        issues,
        "error",
        "contract_delta",
        "Release changes env contract expectations and verification policy blocks contract deltas",
        { import_id: importSnapshot.import_id, delta: contractDelta }
      );
    } else if (contractDelta.changed) {
      pushIssue(
        issues,
        "warning",
        "contract_delta",
        "Release changes env contract expectations and needs review",
        { import_id: importSnapshot.import_id, delta: contractDelta }
      );
    }
  }

  return issues;
}

function compareCurrentAlignment(importSnapshot) {
  const importRecord = isObject(importSnapshot?.import_record) ? importSnapshot.import_record : {};
  const lockEntry = isObject(importSnapshot?.lock_entry) ? importSnapshot.lock_entry : {};
  const placementImport = isObject(importSnapshot?.placement_import) ? importSnapshot.placement_import : {};

  const lockVsPlacement = {
    comparable: Object.keys(lockEntry).length > 0 && Object.keys(placementImport).length > 0,
    artifact_type_match: lockEntry.artifact_type && placementImport.artifact_type ? lockEntry.artifact_type === placementImport.artifact_type : null,
    artifact_id_match: lockEntry.artifact_id && placementImport.artifact_id ? artifactIdsMatch(lockEntry.artifact_id, placementImport.artifact_id) : null,
    release_version_match: lockEntry.release_version && placementImport.release_version ? lockEntry.release_version === placementImport.release_version : null,
    release_hash_match: lockEntry.release_hash && placementImport.release_hash ? lockEntry.release_hash === placementImport.release_hash : null
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
      artifact_type_match: importRecord.artifact_type && lockEntry.artifact_type ? importRecord.artifact_type === lockEntry.artifact_type : null,
      artifact_id_match: importRecord.artifact_id && lockEntry.artifact_id ? artifactIdsMatch(importRecord.artifact_id, lockEntry.artifact_id) : null
    },
    lock_vs_placement: lockVsPlacement
  };
}

function createBuildGraphContext(buildLock) {
  const selectedBuilds = safeArray(buildLock?.selected_builds);
  const resolvedBricks = safeArray(buildLock?.resolved_bricks);
  const graphNodes = safeArray(buildLock?.frozen_dependency_graph?.nodes);
  const graphEdges = safeArray(buildLock?.frozen_dependency_graph?.edges);
  const selectedBuildsById = toRecordMap(selectedBuilds, "import_id");
  const resolvedBricksById = toRecordMap(resolvedBricks, "import_id");
  const nodeById = toRecordMap(graphNodes, "node_id");
  const outgoing = new Map();
  const incoming = new Map();

  for (const edge of graphEdges) {
    if (!isObject(edge) || !isNonEmptyString(edge.from) || !isNonEmptyString(edge.to)) continue;
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    outgoing.get(edge.from).push(edge);
    incoming.get(edge.to).push(edge);
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

function collectBuildContext(importSnapshot, buildGraph) {
  const importId = importSnapshot.import_id;
  const selectedBuildEntry = buildGraph.selectedBuildsById.get(importId) || null;
  const resolvedBrickEntry = buildGraph.resolvedBricksById.get(importId) || null;
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
    selected_build_artifacts: uniqueParentBuildIds.map((buildImportId) => {
      const entry = buildGraph.selectedBuildsById.get(buildImportId) || buildGraph.nodeById.get(buildImportId) || {};
      return {
        import_id: buildImportId,
        artifact_id: entry.artifact_id || null,
        verification_status: entry.verification_status || null,
        trust_tier: entry.trust_tier || null
      };
    }),
    resolved_brick_import_ids: role === "selected_build"
      ? resolvedBrickIds
      : resolvedBrickEntry
        ? [importId]
        : [],
    resolved_brick_artifacts: (role === "selected_build" ? resolvedBrickIds : resolvedBrickEntry ? [importId] : [])
      .map((brickImportId) => {
        const entry = buildGraph.resolvedBricksById.get(brickImportId) || buildGraph.nodeById.get(brickImportId) || {};
        return {
          import_id: brickImportId,
          artifact_id: entry.artifact_id || null,
          verification_status: entry.verification_status || null,
          trust_tier: entry.trust_tier || null
        };
      }),
    direct_dependency_import_ids: uniqStrings(directDependencies.map((edge) => edge.to)),
    direct_dependent_import_ids: uniqStrings(directDependents.map((edge) => edge.from)),
    graph_relations: {
      outgoing: directDependencies.map((edge) => ({ relation: edge.relation || null, to: edge.to })),
      incoming: directDependents.map((edge) => ({ relation: edge.relation || null, from: edge.from }))
    }
  };
}

function summarizeReleaseCompatibility({ importSnapshot, releaseSummary, buildLock, placementImpacts, versionDelta }) {
  const placementRelations = {};
  for (const placement of placementImpacts) incrementCounter(placementRelations, placement?.release_match?.relation || "no_release");
  const minimumVerificationStatus = buildLock?.trust_policy?.minimum_verification_status || null;
  const contractHashesPresent = Boolean(
    isObject(releaseSummary?.raw_contract_hashes) && Object.keys(releaseSummary.raw_contract_hashes).length > 0
  );
  return {
    current_alignment: compareCurrentAlignment(importSnapshot),
    candidate_alignment: releaseSummary ? {
      artifact_match: releaseAppliesToImport(importSnapshot, releaseSummary),
      allowed_status: uniqStrings(buildLock?.trust_policy?.allowed_release_statuses).length > 0
        ? uniqStrings(buildLock?.trust_policy?.allowed_release_statuses).includes(releaseSummary.status)
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

function buildEnvPlan(currentBindings, releaseSummary) {
  const releaseRequired = new Set(uniqStrings(releaseSummary?.required_env));
  const releaseOptional = new Set(uniqStrings(releaseSummary?.optional_env));
  const releaseForbidden = new Set(uniqStrings(releaseSummary?.forbidden_env));
  const currentNames = new Set(currentBindings.map((binding) => binding.name));
  const allNames = new Set([
    ...currentNames,
    ...releaseRequired,
    ...releaseOptional,
    ...releaseForbidden
  ]);

  const items = [];
  for (const name of [...allNames].sort((left, right) => left.localeCompare(right))) {
    const current = currentBindings.filter((binding) => binding.name === name);
    const envValue = process.env[name];
    const present = isNonEmptyString(envValue) || current.some((binding) => isNonEmptyString(binding.bound_to));
    const releaseState = releaseForbidden.has(name)
      ? "forbidden"
      : releaseRequired.has(name)
        ? "required"
        : releaseOptional.has(name)
          ? "optional"
          : releaseSummary
            ? "removed"
            : "unknown";

    let action = "none";
    if (releaseState === "required" && !present) action = "set_before_update";
    else if (releaseState === "forbidden" && present) action = "remove_before_update";
    else if (releaseState === "removed" && current.length > 0) action = "review_unused_binding";
    else if (releaseState === "required" || releaseState === "optional") action = "verify_binding";
    else if (!releaseSummary && current.length > 0) action = current.some((binding) => binding.required) && !present ? "set_before_update" : "verify_binding";

    items.push({
      name,
      surface: current[0]?.surface || "server",
      required: current.some((binding) => binding.required) || releaseState === "required",
      current_state: present ? "present" : current.length > 0 ? "missing" : "undeclared",
      release_state: releaseState,
      action,
      bound_to: current.find((binding) => binding.bound_to)?.bound_to || null
    });
  }

  return {
    items,
    missing_required: items.filter((item) => item.release_state === "required" && item.current_state !== "present")
      .map((item) => item.name),
    forbidden_present: items.filter((item) => item.release_state === "forbidden" && item.current_state === "present")
      .map((item) => item.name)
  };
}

function summarizeContractDelta(importRecord, releaseSummary) {
  if (!releaseSummary) {
    return {
      changed: false,
      required_added: [],
      required_removed: [],
      forbidden_added: [],
      optional_added: []
    };
  }

  const envName = (value) => {
    if (typeof value === "string") return value;
    if (isObject(value) && isNonEmptyString(value.name)) return value.name;
    return "";
  };

  const currentRequired = new Set(uniqStrings(safeArray(importRecord?.contracts?.env?.required).map(envName)));
  const currentDeclared = new Set(uniqStrings(importRecord?.contracts?.env_bindings));
  for (const variable of safeArray(importRecord?.contracts?.env?.variables)) {
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

function buildExpectedChecks({ importRecord, buildLock, releaseSummary, maxChecks }) {
  const verificationPolicy = isObject(buildLock?.verification_policy) ? buildLock.verification_policy : {};
  const checks = [];
  const requiredStatus = verificationPolicy.required_check_status || "warning";

  if (verificationPolicy.run_import_resolution) {
    checks.push({
      kind: "import_resolution",
      gate: "post_update",
      required_status: requiredStatus,
      source: "lock.verification_policy",
      description: "Resolve imports and runtime providers against the updated placements"
    });
  }
  if (verificationPolicy.run_env_truthing) {
    checks.push({
      kind: "env_truthing",
      gate: "pre_update",
      required_status: requiredStatus,
      source: "lock.verification_policy",
      description: "Verify required env bindings are present and forbidden env bindings are absent"
    });
  }
  if (verificationPolicy.run_rls_truthing) {
    checks.push({
      kind: "rls_truthing",
      gate: "post_update",
      required_status: requiredStatus,
      source: "lock.verification_policy",
      description: "Re-check RLS and authz assumptions after the update"
    });
  }

  if (verificationPolicy.run_declared_tests) {
    for (const command of uniqStrings(importRecord?.verification?.test_commands)) {
      checks.push({
        kind: "declared_test_command",
        gate: "post_update",
        required_status: requiredStatus,
        source: "import.verification.test_commands",
        command
      });
    }
  }

  for (const command of uniqStrings(releaseSummary?.smoke_commands)) {
    checks.push({
      kind: "release_smoke_command",
      gate: "post_update",
      required_status: requiredStatus,
      source: "release.verification.smoke_commands",
      command
    });
  }

  for (const check of safeArray(releaseSummary?.checks)) {
    checks.push({
      kind: "release_check",
      gate: "post_update",
      required_status: requiredStatus,
      source: "release.verification.checks",
      name: check.name,
      command: check.command || null,
      current_status: check.status
    });
  }

  for (const item of uniqStrings(buildLock?.verification_policy?.post_install_checks)) {
    checks.push({
      kind: "post_install_checklist",
      gate: "manual",
      required_status: "warning",
      source: "lock.verification_policy.post_install_checks",
      description: item
    });
  }

  for (const command of uniqStrings(releaseSummary?.migration_commands)) {
    checks.push({
      kind: "migration_command",
      gate: "post_update",
      required_status: requiredStatus,
      source: "release.migration.commands",
      command
    });
  }

  for (const step of uniqStrings(releaseSummary?.manual_steps)) {
    checks.push({
      kind: "manual_migration_step",
      gate: "manual",
      required_status: "warning",
      source: "release.migration.manual_steps",
      description: step
    });
  }

  const deduped = dedupeBy(checks, (check) => JSON.stringify([
    check.kind,
    check.command || "",
    check.name || "",
    check.description || "",
    check.gate || ""
  ]));
  const { items, truncated } = clampItems(deduped, maxChecks);
  return { items, truncated, total: deduped.length };
}

function buildRollbackGuidance({ targetRoot, importSnapshot, journalEvents, releaseSummary, placementImpacts }) {
  const successfulEvents = sortByDateDesc(journalEvents.filter((event) => UPDATE_RESULT_SUCCESS.has(String(event?.record?.result || ""))));
  const anchorEvent = successfulEvents[0]?.record || null;
  const anchorVersion = anchorEvent?.to_version || importSnapshot.current.release_version || null;
  const hasReleaseRollback = uniqStrings(releaseSummary?.rollback_commands).length > 0 || isNonEmptyString(releaseSummary?.rollback_notes);
  const impactedPaths = uniqStrings(placementImpacts.map((placement) => placement.target_path).filter(Boolean));

  let status = "partial";
  if (anchorEvent && hasReleaseRollback) status = "ready";
  else if (anchorEvent || impactedPaths.length > 0) status = "partial";
  else status = "weak";

  const actions = [
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
      command: `node tools/sma-import-verify.mjs --target ${targetRoot}`
    }
  ];

  for (const command of uniqStrings(releaseSummary?.rollback_commands)) {
    actions.push({
      kind: "release_rollback_command",
      description: command,
      command
    });
  }

  return {
    status,
    anchor_event_id: anchorEvent?.event_id || null,
    anchor_result: anchorEvent?.result || null,
    current_release_version: anchorVersion,
    current_release_hash: importSnapshot.current.release_hash || null,
    rollback_supported_by_release: Boolean(releaseSummary?.rollback_supported),
    notes: uniqStrings([
      releaseSummary?.rollback_notes || "",
      anchorEvent ? `Use journal event ${anchorEvent.event_id} as the rollback anchor for ${importSnapshot.import_id}` : "",
      !anchorEvent ? "No prior successful journal event was found for this import." : ""
    ]),
    actions
  };
}

function buildDecision({ releaseSummary, issues, placementImpactSummary, envSummary, versionDelta }) {
  const hasErrors = issues.some((issue) => issue.severity === "error");
  const hasWarnings = issues.some((issue) => issue.severity === "warning");
  const hasManualSignals = placementImpactSummary.manual_count > 0
    || placementImpactSummary.drifted_count > 0
    || envSummary.forbidden_present.length > 0
    || envSummary.missing_required.length > 0
    || Boolean(releaseSummary?.manual_steps?.length);

  let status = "safe";
  if (hasErrors) status = "blocked";
  else if (hasWarnings || hasManualSignals || !releaseSummary) status = "manual";

  const reasons = [];
  if (!releaseSummary) reasons.push("no_release_artifact");
  if (versionDelta.kind === "same") reasons.push("same_version");
  if (versionDelta.major_changed) reasons.push("major_version_change");
  if (placementImpactSummary.blocked_count > 0) reasons.push("blocked_placements");
  if (placementImpactSummary.manual_count > 0) reasons.push("manual_review_placements");
  if (envSummary.missing_required.length > 0) reasons.push("missing_required_env");
  if (envSummary.forbidden_present.length > 0) reasons.push("forbidden_env_present");
  for (const issue of issues) reasons.push(issue.code);

  return {
    status,
    update_type: releaseSummary ? versionDelta.kind : "baseline",
    reasons: uniqStrings(reasons)
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP_TEXT);
    return;
  }

  const targetRoot = path.resolve(options.target);
  const smarchRoot = options.smarchRoot || path.resolve(targetRoot, ".smarch");
  const buildLockPath = path.resolve(smarchRoot, "build-lock.json");
  if (!(await pathExists(buildLockPath))) fail(`missing build-lock.json at ${buildLockPath}`);

  const buildLock = await readJsonFile(buildLockPath);
  const importsPath = resolveRelativeToTarget(
    targetRoot,
    buildLock?.lock?.imports_path,
    path.resolve(smarchRoot, "imports.json")
  );
  const placementsPath = resolveRelativeToTarget(
    targetRoot,
    buildLock?.lock?.placements_path,
    path.resolve(smarchRoot, "placements.json")
  );
  const updateJournalPath = resolveRelativeToTarget(
    targetRoot,
    buildLock?.lock?.update_journal_path,
    path.resolve(smarchRoot, "update-journal.jsonl")
  );

  if (!(await pathExists(importsPath))) fail(`missing imports.json at ${importsPath}`);
  if (!(await pathExists(placementsPath))) fail(`missing placements.json at ${placementsPath}`);

  const importsDoc = await readJsonFile(importsPath);
  const placementsDoc = await readJsonFile(placementsPath);
  const journalRecords = await (await pathExists(updateJournalPath) ? readJsonLines(updateJournalPath) : Promise.resolve([]));

  const releaseArtifact = options.release ? await readJsonFile(options.release) : null;
  const releaseSummary = releaseArtifact ? {
    ...summarizeReleaseCandidate(releaseArtifact),
    raw_contract_hashes: isObject(releaseArtifact?.contracts?.hashes) ? releaseArtifact.contracts.hashes : null
  } : null;
  const buildGraph = createBuildGraphContext(buildLock);

  const lockEntries = [
    ...safeArray(buildLock?.selected_builds),
    ...safeArray(buildLock?.resolved_bricks)
  ];
  const lockByImportId = toRecordMap(lockEntries, "import_id");
  const placementImportsByImportId = toRecordMap(placementsDoc?.imports, "import_id");
  const placementsByImportId = groupBy(placementsDoc?.placements, "import_id");
  const journalByImportId = groupBy(journalRecords.map((entry) => ({ ...entry.record, _line_number: entry.line_number })), "import_id");

  const importIds = new Set();
  for (const entry of safeArray(importsDoc?.imports)) if (isNonEmptyString(entry.import_id)) importIds.add(entry.import_id);
  for (const entry of safeArray(placementsDoc?.imports)) if (isNonEmptyString(entry.import_id)) importIds.add(entry.import_id);
  for (const entry of lockEntries) if (isNonEmptyString(entry.import_id)) importIds.add(entry.import_id);

  const importSnapshots = [...importIds].map((importId) => {
    const importRecord = safeArray(importsDoc?.imports).find((entry) => entry.import_id === importId) || {};
    const lockEntry = lockByImportId.get(importId) || {};
    const placementImport = placementImportsByImportId.get(importId) || {};
    const placementsForImport = placementsByImportId.get(importId) || [];
    const journalForImport = journalByImportId.get(importId) || [];

    return {
      import_id: importId,
      artifact_type: importRecord.artifact_type || placementImport.artifact_type || lockEntry.artifact_type || null,
      artifact_id: importRecord.artifact_id || placementImport.artifact_id || lockEntry.artifact_id || null,
      artifact_name: importRecord.artifact_name || null,
      source_project: importRecord.source_project || lockEntry.source_project || null,
      import_record: importRecord,
      lock_entry: lockEntry,
      placement_import: placementImport,
      placements: placementsForImport,
      journal_events: sortByDateDesc(journalForImport)
    };
  }).filter((snapshot) => isNonEmptyString(snapshot.import_id));

  const selectedImports = importSnapshots.filter((snapshot) => {
    if (options.importIds.length > 0 && !options.importIds.includes(snapshot.import_id)) return false;
    const effectiveArtifactId = options.artifactId || releaseSummary?.artifact_id || "";
    const effectiveArtifactType = options.artifactType || releaseSummary?.artifact_type || "";
    if (effectiveArtifactId && !artifactIdsMatch(snapshot.artifact_id, effectiveArtifactId)) return false;
    if (effectiveArtifactType && snapshot.artifact_type !== effectiveArtifactType) return false;
    return true;
  });

  const plans = [];
  for (const snapshot of selectedImports) {
    const buildContext = collectBuildContext(snapshot, buildGraph);
    const currentBindings = gatherCurrentEnvBindings(snapshot.import_record, snapshot.placements);
    const exactRelease = releaseAppliesToImport(snapshot, releaseSummary) ? releaseSummary : null;
    const envSummary = buildEnvPlan(currentBindings, exactRelease);
    const contractDelta = summarizeContractDelta(snapshot.import_record, exactRelease);
    const placementImpactsAll = [];
    for (const placement of snapshot.placements) {
      placementImpactsAll.push(await collectPlacementImpact({
        targetRoot,
        placement,
        releaseSummary: exactRelease,
        trustPolicy: buildLock?.trust_policy
      }));
    }

    const placementImpactSummary = {
      total_count: placementImpactsAll.length,
      replace_in_place_count: placementImpactsAll.filter((placement) => placement.impact === "replace_in_place").length,
      already_matches_count: placementImpactsAll.filter((placement) => placement.impact === "already_matches_candidate").length,
      manual_count: placementImpactsAll.filter((placement) => placement.impact === "manual_review").length,
      blocked_count: placementImpactsAll.filter((placement) => placement.impact === "blocked").length,
      drifted_count: placementImpactsAll.filter((placement) => placement.drifted).length
    };

    const trustIssues = collectTrustPolicyIssues({
      importSnapshot: snapshot,
      releaseSummary: exactRelease,
      lockEntry: snapshot.lock_entry,
      buildLock,
      envSummary,
      contractDelta,
      placementImpactSummary
    });

    const versionDelta = summarizeVersionDelta(
      snapshot.lock_entry.release_version || snapshot.placement_import.release_version || "",
      exactRelease?.version || snapshot.lock_entry.release_version || snapshot.placement_import.release_version || ""
    );
    const expectedChecks = buildExpectedChecks({
      importRecord: snapshot.import_record,
      buildLock,
      releaseSummary: exactRelease,
      maxChecks: options.compact ? Math.min(25, options.maxChecks) : options.maxChecks
    });
    const decision = buildDecision({
      releaseSummary: exactRelease,
      issues: trustIssues,
      placementImpactSummary,
      envSummary,
      versionDelta
    });
    const rollbackGuidance = buildRollbackGuidance({
      targetRoot,
      importSnapshot: {
        import_id: snapshot.import_id,
        current: {
          release_version: snapshot.lock_entry.release_version || snapshot.placement_import.release_version || null,
          release_hash: snapshot.lock_entry.release_hash || snapshot.placement_import.release_hash || null
        }
      },
      journalEvents: snapshot.journal_events.map((event) => ({ record: event })),
      releaseSummary: exactRelease,
      placementImpacts: placementImpactsAll
    });
    const releaseCompatibility = summarizeReleaseCompatibility({
      importSnapshot: snapshot,
      releaseSummary: exactRelease,
      buildLock,
      placementImpacts: placementImpactsAll,
      versionDelta
    });

    const placementList = clampItems(
      placementImpactsAll,
      options.compact ? Math.min(40, options.maxPlacements) : options.maxPlacements
    );
    const journalList = clampItems(
      snapshot.journal_events.map((event) => ({
        event_id: event.event_id || null,
        event_type: event.event_type || null,
        created_at: event.created_at || null,
        result: event.result || null,
        from_version: event.from_version || null,
        to_version: event.to_version || null,
        rollback_ref: event.rollback_ref || null
      })),
      options.compact ? Math.min(8, options.maxJournal) : options.maxJournal
    );

    plans.push({
      import_id: snapshot.import_id,
      artifact_type: snapshot.artifact_type,
      artifact_id: snapshot.artifact_id,
      artifact_name: snapshot.artifact_name,
      source_project: snapshot.source_project,
      current: {
        status: snapshot.import_record.status || snapshot.placement_import.status || null,
        imported_at: snapshot.import_record.imported_at || snapshot.placement_import.imported_at || null,
        release_version: snapshot.lock_entry.release_version || snapshot.placement_import.release_version || null,
        release_hash: snapshot.lock_entry.release_hash || snapshot.placement_import.release_hash || null,
        source_status: snapshot.import_record.source_status || null,
        clone_readiness: snapshot.import_record.clone_readiness || null,
        verification_status: snapshot.lock_entry.verification_status || null,
        trust_tier: snapshot.lock_entry.trust_tier || null,
        local_overrides: Number(snapshot.lock_entry.local_overrides || 0),
        install_state: isObject(snapshot.import_record.install_state) ? snapshot.import_record.install_state : {}
      },
      candidate: exactRelease ? {
        artifact_type: exactRelease.artifact_type,
        artifact_id: exactRelease.artifact_id,
        release_id: exactRelease.release_id,
        version: exactRelease.version,
        status: exactRelease.status,
        channel: exactRelease.channel,
        content_hash: exactRelease.content_hash,
        verification_status: exactRelease.verification_status,
        breaking: exactRelease.breaking,
        rollback_supported: exactRelease.rollback_supported
      } : null,
      build_context: buildContext,
      release_compatibility: releaseCompatibility,
      decision,
      version_delta: versionDelta,
      trust_policy_issues: trustIssues,
      env_bindings: envSummary.items,
      impacts: {
        placement_count: placementImpactSummary.total_count,
        replace_in_place_count: placementImpactSummary.replace_in_place_count,
        already_matches_count: placementImpactSummary.already_matches_count,
        manual_count: placementImpactSummary.manual_count,
        blocked_count: placementImpactSummary.blocked_count,
        drifted_count: placementImpactSummary.drifted_count,
        env_binding_count: envSummary.items.length,
        expected_check_count: expectedChecks.total,
        journal_event_count: snapshot.journal_events.length
      },
      impacted_placements: placementList.items,
      impacted_placements_truncated: placementList.truncated,
      contract_delta: contractDelta,
      expected_checks: expectedChecks.items,
      expected_checks_truncated: expectedChecks.truncated,
      journal_context: {
        events: journalList.items,
        truncated: journalList.truncated
      },
      rollback_guidance: rollbackGuidance
    });
  }

  const globalIssues = dedupeBy(
    plans.flatMap((plan) => safeArray(plan.trust_policy_issues)),
    (issue) => JSON.stringify([issue.code, issue.import_id || "", issue.message])
  );
  const globalChecks = dedupeBy(
    plans.flatMap((plan) => safeArray(plan.expected_checks)),
    (check) => JSON.stringify([check.kind, check.command || "", check.name || "", check.description || "", check.gate || ""])
  );

  const counts = {
    import_count: plans.length,
    impacted_import_count: plans.filter((plan) => plan.impacts.placement_count > 0).length,
    placement_count: plans.reduce((sum, plan) => sum + plan.impacts.placement_count, 0),
    env_binding_count: plans.reduce((sum, plan) => sum + plan.impacts.env_binding_count, 0),
    trust_issue_count: globalIssues.length,
    expected_check_count: globalChecks.length,
    selected_build_count: plans.filter((plan) => plan.build_context?.role === "selected_build").length,
    resolved_brick_count: plans.filter((plan) => plan.build_context?.role === "resolved_brick").length,
    standalone_import_count: plans.filter((plan) => plan.build_context?.role === "standalone").length,
    safe_count: plans.filter((plan) => plan.decision.status === "safe").length,
    manual_count: plans.filter((plan) => plan.decision.status === "manual").length,
    blocked_count: plans.filter((plan) => plan.decision.status === "blocked").length
  };

  const hasExplicitSelection = Boolean(
    releaseSummary
    || options.importIds.length > 0
    || options.artifactId
    || options.artifactType
  );
  if (counts.import_count === 0 && hasExplicitSelection) {
    globalIssues.push(makeIssue(
      releaseSummary ? "error" : "warning",
      "no_matching_imports",
      releaseSummary
        ? "No installed import matches the selected release artifact."
        : "No installed import matches the requested selector.",
      {
        artifact_id: options.artifactId || releaseSummary?.artifact_id || null,
        artifact_type: options.artifactType || releaseSummary?.artifact_type || null
      }
    ));
  }
  counts.trust_issue_count = globalIssues.length;

  const overallStatus = counts.import_count === 0 && hasExplicitSelection
    ? (releaseSummary ? "blocked" : "manual")
    : counts.blocked_count > 0
      ? "blocked"
      : counts.manual_count > 0
        ? "manual"
        : "safe";
  const output = {
    schema: PLAN_SCHEMA,
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    planner: {
      tool: "tools/sma-update-plan.mjs",
      mode: releaseSummary ? "release_update" : "baseline_preflight",
      dry_run: Boolean(options.dryRun),
      compact: Boolean(options.compact)
    },
    target: {
      root: targetRoot,
      smarch_root: smarchRoot,
      imports_path: importsPath,
      build_lock_path: buildLockPath,
      placements_path: placementsPath,
      update_journal_path: updateJournalPath
    },
    selection: {
      import_ids: options.importIds,
      artifact_id: options.artifactId || releaseSummary?.artifact_id || null,
      artifact_type: options.artifactType || releaseSummary?.artifact_type || null,
      matched_import_count: plans.length,
      available_import_count: importSnapshots.length,
      build_context: {
        selected_build_count_in_lock: buildGraph.selectedBuildIds.size,
        resolved_brick_count_in_lock: buildGraph.resolvedBrickIds.size,
        matched_selected_build_count: plans.filter((plan) => plan.build_context?.role === "selected_build").length,
        matched_resolved_brick_count: plans.filter((plan) => plan.build_context?.role === "resolved_brick").length,
        graph_node_count: buildGraph.graphNodeCount,
        graph_edge_count: buildGraph.graphEdgeCount
      }
    },
    trust_policy: {
      allowed_release_statuses: uniqStrings(buildLock?.trust_policy?.allowed_release_statuses),
      minimum_verification_status: buildLock?.trust_policy?.minimum_verification_status || null,
      require_contract_hashes: Boolean(buildLock?.trust_policy?.require_contract_hashes),
      allow_local_overrides: Boolean(buildLock?.trust_policy?.allow_local_overrides),
      fail_on_yanked_release: Boolean(buildLock?.trust_policy?.fail_on_yanked_release),
      fail_on_breaking_upgrade: Boolean(buildLock?.trust_policy?.fail_on_breaking_upgrade),
      fail_on_missing_env: Boolean(buildLock?.verification_policy?.fail_on_missing_env),
      fail_on_contract_delta: Boolean(buildLock?.verification_policy?.fail_on_contract_delta)
    },
    release_candidate: releaseSummary ? {
      artifact_type: releaseSummary.artifact_type,
      artifact_id: releaseSummary.artifact_id,
      release_id: releaseSummary.release_id,
      version: releaseSummary.version,
      status: releaseSummary.status,
      channel: releaseSummary.channel,
      content_hash: releaseSummary.content_hash,
      verification_status: releaseSummary.verification_status,
      breaking: releaseSummary.breaking,
      rollback_supported: releaseSummary.rollback_supported,
      source_project: releaseSummary.source_project,
      path: options.release
    } : null,
    summary: {
      overall_status: overallStatus,
      ...counts
    },
    trust_policy_issues: globalIssues,
    expected_checks: options.compact ? globalChecks.slice(0, 50) : globalChecks,
    imports: plans
  };

  const json = JSON.stringify(output, null, 2);
  if (options.out && !options.dryRun) {
    await fs.mkdir(path.dirname(options.out), { recursive: true });
    await fs.writeFile(options.out, json);
  }
  if (options.stdout || !options.out || options.dryRun) {
    console.log(json);
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
