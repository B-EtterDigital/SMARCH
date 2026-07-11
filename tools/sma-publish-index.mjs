#!/usr/bin/env node
/**
 * What: Builds a local inventory of community-export bundles and their gate results.
 * Why: Operators need one view of publish candidates without opening every bundle directory.
 * How: Scans a publish root and writes or prints a structured index of valid bundle artifacts.
 * Callers: Publishing dashboards and release reviews consume the generated index.
 * Example: `node tools/sma-publish-index.mjs --help`
 */

import fs from "node:fs/promises";
import path from "node:path";

const SCHEMA_VERSION = "1.0.0";
const DEFAULT_ROOT = "publish";
const DEFAULT_OUT = "publish/publish-index.generated.json";
const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".nuxt", ".turbo", "dist", "coverage"]);
const EXPECTED_FILES = ["bundle.json", "publish-report.json", "manifest.community.json"];

const HELP_TEXT = `Usage: node tools/sma-publish-index.mjs [options]

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

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const bundleDirs = await collectBundleDirectories(options.root);
  const bundles = [];
  const skipped = [];

  for (const bundleDir of bundleDirs) {
    const result = await summarizeBundle(bundleDir, options.root);
    if (!result.ok) {
      skipped.push({
        bundle_path: toPosix(path.relative(process.cwd(), bundleDir)),
        reason: result.reason,
        error: result.error || null,
      });
      continue;
    }
    bundles.push(result.value);
  }

  bundles.sort(compareBundleEntries);
  skipped.sort((left, right) => String(left.bundle_path || "").localeCompare(String(right.bundle_path || "")));

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

function parseArgs(argv) {
  const options = {
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

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectBundleDirectories(rootPath) {
  const stat = await fs.stat(rootPath).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    return [];
  }

  const output = [];

  async function walk(currentPath) {
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

async function summarizeBundle(bundleDir, rootPath) {
  const filesPresent = Object.fromEntries(await Promise.all(EXPECTED_FILES.map(async (fileName) => [fileName, await pathExists(path.join(bundleDir, fileName))])));
  const bundleDoc = await maybeReadJson(path.join(bundleDir, "bundle.json"));
  const reportDoc = await maybeReadJson(path.join(bundleDir, "publish-report.json"));
  const manifestDoc = await maybeReadJson(path.join(bundleDir, "manifest.community.json"));

  if (!bundleDoc && !reportDoc && !manifestDoc) {
    return { ok: false, reason: "no_publish_files_found" };
  }

  const artifact = summarizeArtifact(bundleDoc, reportDoc, manifestDoc, bundleDir);
  const findings = Array.isArray(reportDoc?.findings) ? reportDoc.findings : [];
  const findingCounts = summarizeFindingCounts(findings);
  const scannedFiles = Array.isArray(reportDoc?.scanned_files) ? reportDoc.scanned_files : [];
  const decision = summarizeDecision(bundleDoc, reportDoc);
  const summary = {
    bundle_path: toPosix(path.relative(process.cwd(), bundleDir)),
    bundle_root: toPosix(path.relative(process.cwd(), rootPath)),
    complete: filesPresent["bundle.json"] && filesPresent["publish-report.json"] && filesPresent["manifest.community.json"],
    generated_at: firstDefined(bundleDoc?.generated_at, reportDoc?.generated_at) || null,
    artifact,
    decision,
    files_present: filesPresent,
    export_kind: bundleDoc?.export_kind || null,
    export_mode: firstDefined(bundleDoc?.export_mode, reportDoc?.export_mode) || null,
    artifact_visibility: inferArtifactVisibility(manifestDoc),
    publishing_visibility: inferPublishingVisibility(manifestDoc),
    declared_publishable: inferDeclaredPublishable(manifestDoc),
    license: inferLicense(manifestDoc),
    redaction_profile: inferRedactionProfile(manifestDoc),
    risk: inferRisk(manifestDoc),
    redaction_count: Number(reportDoc?.redaction_summary?.count || 0),
    scanned_file_count: scannedFiles.length,
    scanned_finding_count: scannedFiles.reduce((sum, file) => sum + Number(file?.finding_count || 0), 0),
    root_alias_count: Array.isArray(reportDoc?.root_aliases) ? reportDoc.root_aliases.length : 0,
    finding_counts: findingCounts,
    finding_categories: countBy(findings, (entry) => entry?.category || "unknown"),
    finding_scopes: countBy(findings, (entry) => entry?.scope || "unknown"),
    finding_rules: summarizeFindingRules(findings),
    top_blockers: selectTopFindings(findings, "blocker", 6),
    top_warnings: selectTopFindings(findings, "warning", 4),
    limitations: Array.isArray(reportDoc?.limitations) ? reportDoc.limitations : [],
    publish_safe: Boolean(
      decision.status !== "blocked" &&
      inferDeclaredPublishable(manifestDoc) === true &&
      filesPresent["bundle.json"] &&
      filesPresent["publish-report.json"] &&
      filesPresent["manifest.community.json"],
    ),
  };

  return { ok: true, value: summary };
}

function summarizeArtifact(bundleDoc, reportDoc, manifestDoc, bundleDir) {
  const artifact = firstDefined(bundleDoc?.artifact, reportDoc?.artifact, inferArtifactFromManifest(manifestDoc)) || {};
  const type = firstDefined(artifact?.type, manifestDoc?.build ? "build" : manifestDoc?.brick ? "brick" : "unknown");
  const communityId = firstDefined(artifact?.community_id, manifestDoc?.build?.id, manifestDoc?.brick?.id, path.basename(bundleDir));
  const originalArtifactId = firstDefined(
    bundleDoc?.source_artifact?.original_id,
    reportDoc?.source_artifact?.original_id,
  ) || null;
  const name = firstDefined(
    artifact?.name,
    manifestDoc?.build?.name,
    manifestDoc?.brick?.name,
    communityId,
  );
  const version = firstDefined(
    artifact?.version,
    manifestDoc?.build?.version,
    manifestDoc?.brick?.version,
    "0.0.0",
  );

  return {
    community_id: String(communityId || path.basename(bundleDir)),
    original_id: originalArtifactId ? String(originalArtifactId) : null,
    name: String(name || communityId || "publish bundle"),
    type: String(type || "unknown"),
    version: String(version || "0.0.0"),
  };
}

function inferArtifactFromManifest(manifestDoc) {
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

function summarizeDecision(bundleDoc, reportDoc) {
  const decision = firstDefined(reportDoc?.decision, bundleDoc?.decision) || {};
  const counts = {
    blocker: Number(decision?.counts?.blocker || 0),
    warning: Number(decision?.counts?.warning || 0),
    info: Number(decision?.counts?.info || 0),
  };
  return {
    status: String(decision?.status || "unknown"),
    counts,
    strict_mode: Boolean(decision?.strict_mode),
  };
}

function summarizeFindingCounts(findings) {
  return {
    blocker: findings.filter((entry) => entry?.severity === "blocker").length,
    warning: findings.filter((entry) => entry?.severity === "warning").length,
    info: findings.filter((entry) => entry?.severity === "info").length,
    total: findings.length,
  };
}

function inferArtifactVisibility(manifestDoc) {
  return firstDefined(manifestDoc?.build?.visibility, manifestDoc?.brick?.visibility) || "unknown";
}

function inferPublishingVisibility(manifestDoc) {
  return firstDefined(manifestDoc?.publishing?.visibility) || "unknown";
}

function inferDeclaredPublishable(manifestDoc) {
  if (typeof manifestDoc?.publishing?.publishable === "boolean") {
    return manifestDoc.publishing.publishable;
  }
  return null;
}

function inferLicense(manifestDoc) {
  return firstDefined(manifestDoc?.publishing?.license) || null;
}

function inferRedactionProfile(manifestDoc) {
  return firstDefined(manifestDoc?.publishing?.redaction_profile) || null;
}

function inferRisk(manifestDoc) {
  return firstDefined(manifestDoc?.classification?.risk) || null;
}

function selectTopFindings(findings, severity, limit) {
  return findings
    .filter((entry) => entry?.severity === severity)
    .slice(0, limit)
    .map((entry) => ({
      severity: entry.severity || severity,
      category: entry.category || "unknown",
      rule_id: entry.rule_id || "unknown",
      summary: entry.summary || "Finding recorded.",
      location: entry.location || null,
      scope: entry.scope || null,
    }));
}

function countBy(items, getKey) {
  const counts = {};
  for (const item of items || []) {
    const key = String(getKey(item) || "unknown");
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function summarizeFindingRules(findings) {
  const rows = new Map();
  for (const finding of findings || []) {
    const key = `${finding?.rule_id || "unknown"}:${finding?.severity || "unknown"}`;
    if (!rows.has(key)) {
      rows.set(key, {
        rule_id: finding?.rule_id || "unknown",
        severity: finding?.severity || "unknown",
        category: finding?.category || "unknown",
        summary: finding?.summary || "Finding recorded.",
        count: 0,
      });
    }
    rows.get(key).count += 1;
  }
  return [...rows.values()].sort((left, right) => right.count - left.count || String(left.rule_id || "").localeCompare(String(right.rule_id || "")));
}

function summarizeIndex(bundles) {
  const topRules = new Map();

  for (const bundle of bundles) {
    for (const finding of bundle.finding_rules || []) {
      const key = `${finding.rule_id || "unknown"}:${finding.severity || "unknown"}`;
      if (!topRules.has(key)) {
        topRules.set(key, {
          rule_id: finding.rule_id || "unknown",
          severity: finding.severity || "unknown",
          category: finding.category || "unknown",
          summary: finding.summary || "Finding recorded.",
          count: 0,
          sample_artifacts: [],
        });
      }
      const row = topRules.get(key);
      row.count += Number(finding.count || 0);
      if (row.sample_artifacts.length < 4 && !row.sample_artifacts.includes(bundle.artifact.community_id)) {
        row.sample_artifacts.push(bundle.artifact.community_id);
      }
    }
  }

  return {
    bundle_count: bundles.length,
    complete_bundle_count: bundles.filter((entry) => entry.complete).length,
    incomplete_bundle_count: bundles.filter((entry) => !entry.complete).length,
    publish_safe_count: bundles.filter((entry) => entry.publish_safe).length,
    blocker_bundle_count: bundles.filter((entry) => Number(entry.decision?.counts?.blocker || 0) > 0).length,
    warning_bundle_count: bundles.filter((entry) => Number(entry.decision?.counts?.warning || 0) > 0).length,
    by_artifact_type: countBy(bundles, (entry) => entry.artifact?.type || "unknown"),
    by_original_artifact_type: countBy(bundles, (entry) => entry.artifact?.original_id ? "linked" : "unlinked"),
    by_decision_status: countBy(bundles, (entry) => entry.decision?.status || "unknown"),
    by_artifact_visibility: countBy(bundles, (entry) => entry.artifact_visibility || "unknown"),
    by_publishing_visibility: countBy(bundles, (entry) => entry.publishing_visibility || "unknown"),
    by_license: countBy(bundles, (entry) => entry.license || "unknown"),
    by_risk: countBy(bundles, (entry) => entry.risk || "unknown"),
    publishable_declared_count: bundles.filter((entry) => entry.declared_publishable === true).length,
    total_redaction_count: bundles.reduce((sum, entry) => sum + Number(entry.redaction_count || 0), 0),
    total_scanned_file_count: bundles.reduce((sum, entry) => sum + Number(entry.scanned_file_count || 0), 0),
    total_scanned_finding_count: bundles.reduce((sum, entry) => sum + Number(entry.scanned_finding_count || 0), 0),
    total_finding_count: bundles.reduce((sum, entry) => sum + Number(entry.finding_counts?.total || 0), 0),
    top_rules: [...topRules.values()]
      .sort((left, right) => right.count - left.count || String(left.rule_id || "").localeCompare(String(right.rule_id || "")))
      .slice(0, 12),
  };
}

async function maybeReadJson(filePath) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return undefined;
}

function toPosix(value) {
  return String(value || "").split(path.sep).join("/");
}

function compareBundleEntries(left, right) {
  return String(left.artifact?.type || "").localeCompare(String(right.artifact?.type || ""))
    || String(left.decision?.status || "").localeCompare(String(right.decision?.status || ""))
    || String(left.artifact?.name || "").localeCompare(String(right.artifact?.name || ""))
    || String(left.bundle_path || "").localeCompare(String(right.bundle_path || ""));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}
