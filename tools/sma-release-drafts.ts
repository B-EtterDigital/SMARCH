#!/usr/bin/env node
/**
 * What: Explains why curated build releases remain drafts.
 * Why: A draft label alone does not tell operators which blockers must be cleared next.
 * How: Reads curated-build state, groups blocker codes, and writes a draft-status handoff.
 * Callers: Release operators and dashboards use it to prioritize remediation.
 * Example: `node tools/sma-release-drafts.ts --help`
 */

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
} from "./lib/curated-build-utils.ts";

const DEFAULT_OUT = "releases/release-drafts.generated.json";

interface DraftReason {
  code: string;
  message: string;
  first_action: string;
}

type CuratedBuild = Awaited<ReturnType<typeof loadCuratedBuildContext>>["curatedBuilds"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const HELP_TEXT = `Usage: node tools/sma-release-drafts.ts [options]

Generate explicit "why still draft" reporting for curated build releases.

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

  const outPath = path.resolve(typeof args.out === "string" ? args.out : DEFAULT_OUT);
  const contextOptions: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") contextOptions[key] = value;
  }
  const context = await loadCuratedBuildContext(contextOptions);
  const releases = filterCuratedBuilds(context.curatedBuilds, args).map(buildReleaseDraftEntry);

  const document = {
    generated_at: new Date().toISOString(),
    summary: {
      build_count: releases.length,
      published_count: releases.filter((entry) => entry.release_status === "published").length,
      draft_count: releases.filter((entry) => entry.release_status !== "published").length,
      top_draft_reasons: summarizeBlockerCodes(releases.flatMap((entry) => entry.draft_reasons.map((reason) => ({
        code: reason.code,
        message: reason.message,
      }))), 8),
    },
    releases,
  };

  if (args.stdout || args["dry-run"]) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  }

  if (!args["dry-run"]) {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
}

function buildReleaseDraftEntry(build: CuratedBuild) {
  const release = isRecord(build.release) ? build.release : null;
  const latestRelease = isRecord(release?.latest_release) ? release.latest_release : null;
  const manifest = isRecord(build.manifest) ? build.manifest : null;
  const manifestBuildValue = manifest ? Reflect.get(manifest, "build") : null;
  const manifestBuild = isRecord(manifestBuildValue) ? manifestBuildValue : null;
  const trustSummaryValue = latestRelease ? Reflect.get(latestRelease, "trust_summary") : null;
  const trustSummary = isRecord(trustSummaryValue) ? trustSummaryValue : null;
  const reasons = collectDraftReasons(build);
  const nextGate = deriveNextGate(reasons);

  return {
    build_id: build.build_id,
    name: build.name,
    source_project: build.source_project,
    manifest_path: build.manifest_path,
    release_path: latestRelease?.path ? `releases/${latestRelease.path}` : null,
    release_id: latestRelease?.release_id || null,
    release_version: (latestRelease ? Reflect.get(latestRelease, "version") : null) || (manifestBuild ? Reflect.get(manifestBuild, "version") : null) || null,
    release_channel: latestRelease?.channel || null,
    release_status: latestRelease?.status || "missing",
    release_verification_status: trustSummary?.verification_status || null,
    release_trust_level: trustSummary?.trust_level || null,
    published_at: latestRelease?.published_at || null,
    is_draft: latestRelease?.status !== "published",
    next_gate: nextGate,
    draft_reasons: reasons,
    first_actions: uniqueStrings([
      ...toArray(build.first_actions),
      ...reasons.map((reason) => reason.first_action),
    ]).slice(0, 10),
    handoff_refs: buildHandoffPaths({
      artifact_id: typeof build.artifact_id === "string" ? build.artifact_id : undefined,
      source_project: typeof build.source_project === "string" ? build.source_project : undefined,
      manifest_path: build.manifest_path ?? undefined,
      name: typeof build.name === "string" ? build.name : undefined,
    }),
  };
}

function collectDraftReasons(build: CuratedBuild): DraftReason[] {
  const reasons: DraftReason[] = [];
  const push = (code: string, message: string, firstAction: string): void => {
    reasons.push({ code, message, first_action: firstAction });
  };

  if (build.verified_ready !== true) {
    push(
      "verification.evidence",
      "Release should stay draft because runtime-grade build verification is still missing.",
      "Replace review-only evidence with real smoke or fixture results before publishing."
    );
  }
  const publishBundle = isRecord(build.publishBundle) ? build.publishBundle : null;
  if (publishBundle && Reflect.get(publishBundle, "publish_safe") !== true) {
    push(
      "private_publish_blocked",
      "Release should stay draft because the private publish lane still has leak-review blockers.",
      "Clear internal URLs, local paths, secret-like assignments, and other publish findings before publishing."
    );
  }
  const manifest = isRecord(build.manifest) ? build.manifest : null;
  const publishingValue = manifest ? Reflect.get(manifest, "publishing") : null;
  const publishing = isRecord(publishingValue) ? publishingValue : null;
  const clone = isRecord(build.clone) ? build.clone : null;
  const manifestCloneValue = manifest ? Reflect.get(manifest, "clone") : null;
  const manifestClone = isRecord(manifestCloneValue) ? manifestCloneValue : null;
  const release = isRecord(build.release) ? build.release : null;
  const latestRelease = isRecord(release?.latest_release) ? release.latest_release : null;
  const trustSummary = isRecord(latestRelease?.trust_summary) ? latestRelease.trust_summary : null;

  if (publishing?.publishable !== true) {
    push(
      "not_marked_publishable",
      "Manifest still explicitly says this build is not publishable.",
      "Leave publishability disabled until verification and leak cleanup are real, then toggle intentionally."
    );
  }
  if (String(publishing?.visibility || "").toLowerCase() === "private") {
    push(
      "publishing.visibility",
      "Visibility is still private/internal only.",
      "Decide the target sharing lane only after verification and publish review are clean."
    );
  }
  if (String(latestRelease?.status || "").toLowerCase() !== "published") {
    push(
      "release_not_published",
      "Latest release artifact remains draft.",
      "Do not publish the release until the earlier gates are green."
    );
  }
  if (String(trustSummary?.verification_status || "").toLowerCase() === "unverified") {
    push(
      "release_unverified",
      "Latest release still carries unverified release metadata.",
      "Raise build verification evidence before treating the release as reusable."
    );
  }
  if (String(clone?.readiness || manifestClone?.readiness || "").toLowerCase() === "manual_only") {
    push(
      "clone.readiness",
      "Manual-only install posture still makes the release a poor candidate for publication.",
      "Reduce manual-only install gaps and tighten post-clone checks."
    );
  }

  const unique = new Map(reasons.map((entry) => [`${entry.code}::${entry.message}`, entry]));
  return [...unique.values()];
}

function deriveNextGate(reasons: DraftReason[]): string {
  const codes = new Set(reasons.map((entry) => entry.code));
  if (codes.has("verification.evidence")) return "verified";
  if (codes.has("private_publish_blocked") || codes.has("not_marked_publishable") || codes.has("publishing.visibility")) return "private_publishable";
  if (codes.has("release_not_published")) return "published_release";
  return "review";
}
