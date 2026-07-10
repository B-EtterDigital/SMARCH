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

const DEFAULT_OUT = "releases/release-drafts.generated.json";

const HELP_TEXT = `Usage: node tools/sma-release-drafts.mjs [options]

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

  const outPath = path.resolve(args.out || DEFAULT_OUT);
  const context = await loadCuratedBuildContext(args);
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

function buildReleaseDraftEntry(build) {
  const latestRelease = build.release?.latest_release || null;
  const reasons = collectDraftReasons(build);
  const nextGate = deriveNextGate(reasons);

  return {
    build_id: build.build_id,
    name: build.name,
    source_project: build.source_project,
    manifest_path: build.manifest_path,
    release_path: latestRelease?.path ? `releases/${latestRelease.path}` : null,
    release_id: latestRelease?.release_id || null,
    release_version: latestRelease?.version || build.manifest?.build?.version || null,
    release_channel: latestRelease?.channel || null,
    release_status: latestRelease?.status || "missing",
    release_verification_status: latestRelease?.trust_summary?.verification_status || null,
    release_trust_level: latestRelease?.trust_summary?.trust_level || null,
    published_at: latestRelease?.published_at || null,
    is_draft: latestRelease?.status !== "published",
    next_gate: nextGate,
    draft_reasons: reasons,
    first_actions: uniqueStrings([
      ...toArray(build.first_actions),
      ...reasons.map((reason) => reason.first_action),
    ]).slice(0, 10),
    handoff_refs: buildHandoffPaths(build),
  };
}

function collectDraftReasons(build) {
  const reasons = [];
  const push = (code, message, firstAction) => {
    reasons.push({ code, message, first_action: firstAction });
  };

  if (build.verified_ready !== true) {
    push(
      "verification.evidence",
      "Release should stay draft because runtime-grade build verification is still missing.",
      "Replace review-only evidence with real smoke or fixture results before publishing."
    );
  }
  if (build.publishBundle?.publish_safe !== true) {
    push(
      "private_publish_blocked",
      "Release should stay draft because the private publish lane still has leak-review blockers.",
      "Clear internal URLs, local paths, secret-like assignments, and other publish findings before publishing."
    );
  }
  if (build.manifest?.publishing?.publishable !== true) {
    push(
      "not_marked_publishable",
      "Manifest still explicitly says this build is not publishable.",
      "Leave publishability disabled until verification and leak cleanup are real, then toggle intentionally."
    );
  }
  if (String(build.manifest?.publishing?.visibility || "").toLowerCase() === "private") {
    push(
      "publishing.visibility",
      "Visibility is still private/internal only.",
      "Decide the target sharing lane only after verification and publish review are clean."
    );
  }
  if (String(build.release?.latest_release?.status || "").toLowerCase() !== "published") {
    push(
      "release_not_published",
      "Latest release artifact remains draft.",
      "Do not publish the release until the earlier gates are green."
    );
  }
  if (String(build.release?.latest_release?.trust_summary?.verification_status || "").toLowerCase() === "unverified") {
    push(
      "release_unverified",
      "Latest release still carries unverified release metadata.",
      "Raise build verification evidence before treating the release as reusable."
    );
  }
  if (String(build.clone?.readiness || build.manifest?.clone?.readiness || "").toLowerCase() === "manual_only") {
    push(
      "clone.readiness",
      "Manual-only install posture still makes the release a poor candidate for publication.",
      "Reduce manual-only install gaps and tighten post-clone checks."
    );
  }

  return uniqueStrings(reasons.map((entry) => `${entry.code}::${entry.message}`)).map((key) => {
    const [code, message] = key.split("::");
    return reasons.find((entry) => entry.code === code && entry.message === message);
  });
}

function deriveNextGate(reasons) {
  const codes = new Set(reasons.map((entry) => entry.code));
  if (codes.has("verification.evidence")) return "verified";
  if (codes.has("private_publish_blocked") || codes.has("not_marked_publishable") || codes.has("publishing.visibility")) return "private_publishable";
  if (codes.has("release_not_published")) return "published_release";
  return "review";
}
