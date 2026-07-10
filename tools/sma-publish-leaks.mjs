#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import {
  buildHandoffPaths,
  filterCuratedBuilds,
  loadCuratedBuildContext,
  parseArgs,
  summarizeBlockerCodes,
  toArray,
  uniqueStrings,
} from "./lib/curated-build-utils.mjs";

const DEFAULT_OUT = "publish/publish-leaks.generated.json";
const REMEDIATION_ID_BY_RULE = {
  "absolute-local-path": "sanitize-local-paths",
  "internal-url": "sanitize-internal-urls",
  "publish-policy-disabled": "publish-policy-review",
  "publish-visibility-private": "publish-policy-review",
  "customer-specific-language": "manifest-cleanup",
  "missing-declared-path": "manifest-cleanup",
  "high-risk-classification": "manual-risk-review",
  "secret-assignment": "scrub-live-secrets",
};

const HELP_TEXT = `Usage: node tools/sma-publish-leaks.mjs [options]

Generate a machine-readable leak repair report for curated build publish bundles.

Options:
  --build <id>    Limit output to one build id. Repeatable.
  --out <file>    Output JSON path. Default: ${DEFAULT_OUT}
  --stdout        Print the generated JSON.
  --dry-run       Print only, do not write a file.
  --help          Show this help text.
`;

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  const outPath = path.resolve(args.out || DEFAULT_OUT);
  const context = await loadCuratedBuildContext(args);
  const builds = filterCuratedBuilds(context.curatedBuilds, args).map(summarizeBuildLeaks);
  const ruleSummary = summarizeRules(builds);
  const fileHotspots = summarizeFileHotspots(builds);
  const remediationClusters = summarizeRemediationClusters(builds);

  const document = {
    generated_at: new Date().toISOString(),
    summary: {
      build_count: builds.length,
      blocked_build_count: builds.filter((entry) => entry.publish_status === "blocked").length,
      publish_safe_build_count: builds.filter((entry) => entry.publish_safe === true).length,
      total_findings: builds.reduce((sum, entry) => sum + Number(entry.finding_count || 0), 0),
      total_blockers: builds.reduce((sum, entry) => sum + Number(entry.blocker_count || 0), 0),
      total_warnings: builds.reduce((sum, entry) => sum + Number(entry.warning_count || 0), 0),
      top_rules: ruleSummary.slice(0, 8),
      top_files: fileHotspots.slice(0, 10).map((entry) => ({
        path: entry.path,
        blocker_count: entry.blocker_count,
        warning_count: entry.warning_count,
        build_count: entry.build_ids.length,
      })),
    },
    rule_summary: ruleSummary,
    file_hotspots: fileHotspots,
    remediation_clusters: remediationClusters,
    builds,
  };

  if (args.stdout || args["dry-run"]) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  }

  if (!args["dry-run"]) {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
}

function summarizeBuildLeaks(build) {
  const findings = toArray(build.publishBundle?.resolved_findings);
  const fileGroups = new Map();
  for (const finding of findings) {
    const bucketKey = finding.scope === "source"
      ? String(finding.actual_path || finding.declared_root_path || finding.location || "unknown")
      : String(finding.location || "manifest");
    const current = fileGroups.get(bucketKey) || {
      path: bucketKey,
      scope: finding.scope || "unknown",
      blocker_count: 0,
      warning_count: 0,
      info_count: 0,
      finding_count: 0,
      builds: new Set(),
      rules: [],
      recommendations: [],
      evidence_samples: [],
    };
    current.finding_count += 1;
    current.builds.add(build.build_id);
    if (finding.severity === "blocker") current.blocker_count += 1;
    else if (finding.severity === "warning") current.warning_count += 1;
    else current.info_count += 1;
    current.rules.push({
      rule_id: finding.rule_id || "unknown",
      severity: finding.severity || "info",
      summary: finding.summary || null,
    });
    if (finding.recommendation) current.recommendations.push(finding.recommendation);
    if (finding.evidence && current.evidence_samples.length < 3) current.evidence_samples.push(String(finding.evidence));
    fileGroups.set(bucketKey, current);
  }

  const files = [...fileGroups.values()]
    .map((entry) => ({
      path: entry.path,
      scope: entry.scope,
      blocker_count: entry.blocker_count,
      warning_count: entry.warning_count,
      info_count: entry.info_count,
      finding_count: entry.finding_count,
      build_ids: [...entry.builds].sort(),
      top_rules: summarizeBlockerCodes(entry.rules, 6).map((rule) => ({
        rule_id: rule.code,
        remediation_id: remediationIdForRule(rule.code),
        count: rule.count,
        summary: rule.message || null,
      })),
      remediation_ids: uniqueStrings(entry.rules.map((rule) => remediationIdForRule(rule.rule_id))),
      recommendations: uniqueStrings(entry.recommendations).slice(0, 4),
      evidence_samples: entry.evidence_samples,
    }))
    .sort((left, right) =>
      right.blocker_count - left.blocker_count
      || right.warning_count - left.warning_count
      || right.finding_count - left.finding_count
      || String(left.path).localeCompare(String(right.path))
    );

  const topRules = summarizeBlockerCodes(findings.map((finding) => ({
    code: finding.rule_id,
    severity: finding.severity,
    message: finding.summary || finding.recommendation || null,
  })), 8).map((entry) => ({
    rule_id: entry.code,
    count: entry.count,
    summary: entry.message || null,
  }));

  return {
    build_id: build.build_id,
    name: build.name,
    source_project: build.source_project,
    bundle_path: build.publishBundle?.bundle_path || null,
    report_path: build.publishBundle?.bundle_dir ? `${build.publishBundle.bundle_dir}/publish-report.json` : null,
    publish_status: build.publishBundle?.decision?.status || build.private_publish_status || "unknown",
    publish_safe: build.publishBundle?.publish_safe === true,
    declared_publishable: build.publishBundle?.declared_publishable === true,
    visibility: build.publishBundle?.publishing_visibility || build.publishBundle?.artifact_visibility || null,
    finding_count: findings.length,
    blocker_count: findings.filter((entry) => entry.severity === "blocker").length,
    warning_count: findings.filter((entry) => entry.severity === "warning").length,
    top_rules: topRules,
    file_hotspots: files.slice(0, 12),
    leak_hotspots: toArray(build.leak_hotspots),
    first_actions: build.first_actions,
    handoff_refs: buildHandoffPaths(build),
  };
}

function summarizeRules(builds) {
  const rules = new Map();
  for (const build of builds) {
    for (const rule of toArray(build.top_rules)) {
      const current = rules.get(rule.rule_id) || {
        rule_id: rule.rule_id,
        count: 0,
        build_ids: new Set(),
        example_summary: rule.summary || null,
      };
      current.count += Number(rule.count || 0);
      current.build_ids.add(build.build_id);
      rules.set(rule.rule_id, current);
    }
  }
  return [...rules.values()]
    .map((entry) => ({
      rule_id: entry.rule_id,
      remediation_id: remediationIdForRule(entry.rule_id),
      count: entry.count,
      build_ids: [...entry.build_ids].sort(),
      example_summary: entry.example_summary,
    }))
    .sort((left, right) => right.count - left.count || String(left.rule_id).localeCompare(String(right.rule_id)));
}

function summarizeFileHotspots(builds) {
  const hotspots = new Map();
  for (const build of builds) {
    for (const file of toArray(build.file_hotspots)) {
      const key = `${file.scope || "unknown"}::${file.path || "unknown"}`;
      const current = hotspots.get(key) || {
        path: file.path,
        scope: file.scope || "unknown",
        blocker_count: 0,
        warning_count: 0,
        info_count: 0,
        finding_count: 0,
        build_ids: new Set(),
        rules: new Map(),
        recommendations: new Set(),
      };
      current.blocker_count += Number(file.blocker_count || 0);
      current.warning_count += Number(file.warning_count || 0);
      current.info_count += Number(file.info_count || 0);
      current.finding_count += Number(file.finding_count || 0);
      current.build_ids.add(build.build_id);
      for (const rule of toArray(file.top_rules)) {
        const ruleEntry = current.rules.get(rule.rule_id) || { rule_id: rule.rule_id, count: 0, summary: rule.summary || null };
        ruleEntry.count += Number(rule.count || 0);
        current.rules.set(rule.rule_id, ruleEntry);
      }
      for (const recommendation of toArray(file.recommendations)) current.recommendations.add(recommendation);
      hotspots.set(key, current);
    }
  }
  return [...hotspots.values()]
    .map((entry) => ({
      path: entry.path,
      scope: entry.scope,
      blocker_count: entry.blocker_count,
      warning_count: entry.warning_count,
      info_count: entry.info_count,
      finding_count: entry.finding_count,
      build_ids: [...entry.build_ids].sort(),
      top_rules: [...entry.rules.values()]
        .sort((left, right) => right.count - left.count || String(left.rule_id).localeCompare(String(right.rule_id)))
        .slice(0, 6)
        .map((rule) => ({
          ...rule,
          remediation_id: remediationIdForRule(rule.rule_id),
        })),
      remediation_ids: uniqueStrings([...entry.rules.keys()].map((ruleId) => remediationIdForRule(ruleId))),
      recommendations: [...entry.recommendations].sort().slice(0, 4),
    }))
    .sort((left, right) =>
      right.blocker_count - left.blocker_count
      || right.warning_count - left.warning_count
      || right.finding_count - left.finding_count
      || String(left.path).localeCompare(String(right.path))
    );
}

function summarizeRemediationClusters(builds) {
  const clusters = new Map();
  for (const build of builds) {
    for (const file of toArray(build.file_hotspots)) {
      for (const rule of toArray(file.top_rules)) {
        const remediationId = remediationIdForRule(rule.rule_id);
        const current = clusters.get(remediationId) || {
          remediation_id: remediationId,
          rule_ids: new Set(),
          total_hits: 0,
          build_ids: new Set(),
          paths: new Set(),
          recommendations: new Set(),
          target_surfaces: new Set(),
          example_summary: rule.summary || null,
        };
        current.rule_ids.add(rule.rule_id);
        current.total_hits += Number(rule.count || 0);
        current.build_ids.add(build.build_id);
        current.paths.add(file.path);
        current.target_surfaces.add(file.scope || "unknown");
        for (const recommendation of toArray(file.recommendations)) current.recommendations.add(recommendation);
        clusters.set(remediationId, current);
      }
    }
  }
  return [...clusters.values()]
    .map((entry) => ({
      remediation_id: entry.remediation_id,
      total_hits: entry.total_hits,
      rule_ids: [...entry.rule_ids].sort(),
      build_ids: [...entry.build_ids].sort(),
      path_count: entry.paths.size,
      sample_paths: [...entry.paths].sort().slice(0, 8),
      target_surfaces: [...entry.target_surfaces].sort(),
      recommendations: [...entry.recommendations].sort().slice(0, 4),
      example_summary: entry.example_summary,
    }))
    .sort((left, right) => right.total_hits - left.total_hits || String(left.remediation_id).localeCompare(String(right.remediation_id)));
}

function remediationIdForRule(ruleId) {
  return REMEDIATION_ID_BY_RULE[String(ruleId || "")] || `review-${String(ruleId || "unknown")}`;
}
