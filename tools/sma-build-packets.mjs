#!/usr/bin/env node

/**
 * WHAT: Generates bounded repair packets for curated builds that are not ready to promote.
 * WHY: Agents need precise blockers and next commands instead of loading the full build registry and verification reports.
 * HOW: Reads curated-build context and manifests, then writes or prints handoff packets consumed by repair controllers and agents.
 * Usage: `node tools/sma-build-packets.mjs --dry-run --stdout`
 */
import fs from "node:fs/promises";
import path from "node:path";

import {
  buildHandoffPaths,
  filterCuratedBuilds,
  loadCuratedBuildContext,
  parseArgs,
  relativeFromRepo,
  summarizeBlockerCodes,
  selectedBuildIdsFromArgs,
  toArray,
  uniqueStrings,
} from "./lib/curated-build-utils.ts";

const DEFAULT_OUT = "handoffs/build-packets.generated.json";

const HELP_TEXT = `Usage: node tools/sma-build-packets.mjs [options]

Generate repair packets for curated builds before repo-level hardening work.

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
  const rows = filterCuratedBuilds(context.curatedBuilds, args).map((entry) => buildPacket(entry));

  const document = {
    generated_at: new Date().toISOString(),
    summary: {
      build_count: rows.length,
      project_count: new Set(rows.map((entry) => entry.source_project)).size,
      blocked_build_count: rows.filter((entry) => entry.current.private_publish_status === "blocked" || entry.current.verification_ready === false).length,
    },
    packets: rows,
  };

  if (args.stdout || args["dry-run"]) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
  }

  if (!args["dry-run"]) {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  }
}

function buildPacket(build) {
  const manifest = build.manifest || {};
  const composition = manifest.composition || {};
  const verification = manifest.verification || {};
  const clone = manifest.clone || {};
  const requiredRefs = toArray(composition.brick_refs).filter((entry) => entry?.required !== false);
  const optionalRefs = [
    ...toArray(composition.brick_refs).filter((entry) => entry?.required === false),
    ...toArray(composition.optional_bricks),
  ];
  const leakHotspots = build.leak_hotspots || [];
  const touchPaths = fileTouchOrder(build, requiredRefs, optionalRefs, leakHotspots);

  return {
    build_id: build.build_id,
    name: build.name,
    source_project: build.source_project,
    manifest_path: build.manifest_path,
    project_root: build.project_root,
    acceptance_target: "candidate -> verified -> private publishable -> published release",
    handoff_refs: buildHandoffPaths(build),
    current: {
      status: build.status,
      trust_tier: build.promotion?.current?.trust_tier || manifest.build?.trust_tier || null,
      verification_ready: build.verified_ready === true,
      publish_ready: build.publish_ready === true,
      release_status: build.latest_release_status || build.release?.latest_release?.status || null,
      latest_verification_status: build.latest_verification_status || build.release?.latest_release?.trust_summary?.verification_status || null,
      private_publish_status: build.private_publish_status || null,
    },
    source: {
      declared_paths: toArray(manifest.source?.paths),
      required_bricks: requiredRefs.map((entry) => ({
        brick_id: entry.brick_id,
        role: entry.role || null,
        path: entry.path || null,
      })),
      optional_bricks: optionalRefs.map((entry) => ({
        brick_id: entry.brick_id,
        role: entry.role || null,
        path: entry.path || null,
      })),
    },
    blockers: {
      promotion: toArray(build.promotion?.blockers),
      verification: toArray(build.verification_top_blockers),
      private_publish: toArray(build.private_publish_top_blockers),
    },
    blocker_summary: {
      top_codes: summarizeBlockerCodes([
        ...toArray(build.promotion?.blockers),
        ...toArray(build.verification_top_blockers),
        ...toArray(build.private_publish_top_blockers),
      ], 10),
    },
    leak_hotspots: leakHotspots,
    file_touch_order: touchPaths,
    verification_harness: {
      fixture_targets: toArray(verification.fixture_targets),
      smoke_commands: toArray(verification.smoke_commands),
      integration_targets: toArray(verification.integration_targets),
      post_clone_checks: toArray(clone.post_clone_checks),
      template_paths: [
        "templates/build-verification/README.md",
        "templates/build-verification/verification-checklist.md",
        "templates/build-verification/smoke-commands.example.json",
        "templates/build-verification/evidence-record.example.json",
      ],
      evidence_gap: build.verified_ready === true
        ? null
        : "Replace review-only evidence with real command output, environment notes, and linked artifacts.",
    },
    first_actions: uniqueStrings([
      ...toArray(build.first_actions),
      "Use the repo prompt packet and queue doc together before editing source.",
      "Keep the build at candidate until runtime proof and leak cleanup are real.",
    ]).slice(0, 10),
    recommended_commands: [
      `npm run why:blocked -- --build ${build.build_id}`,
      `node tools/sma-publish.mjs --manifest ${build.manifest_path}`,
      `npm run build:promote -- --build ${build.build_id} --stdout`,
    ],
  };
}

function fileTouchOrder(build, requiredRefs, optionalRefs, leakHotspots) {
  const ordered = [];
  const push = (value) => {
    const text = String(value || "").trim();
    if (text && !ordered.includes(text)) ordered.push(text);
  };

  for (const root of toArray(build.source_roots)) push(root.declared_path);
  for (const ref of requiredRefs) push(ref.path);
  for (const hotspot of leakHotspots) push(hotspot.actual_path || hotspot.declared_root_path);
  for (const ref of optionalRefs) push(ref.path);

  return ordered.slice(0, 16);
}
