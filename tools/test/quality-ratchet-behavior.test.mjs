import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildGoalProgressReport,
  goalProgressDashboardStyles,
  renderGoalProgressSection,
  runGoalProgressSelfTest,
} from "../lib/gen3-goal-progress.ts";
import {
  assertFreshPacketReport,
  formatPacketFreshness,
  maxAgeSeconds,
  packetFreshness,
  packetLeaseFingerprint,
} from "../lib/packet-freshness.ts";
import {
  buildActionReport,
  buildCleanupPacketReport,
  buildGraphPacketReport,
  renderActionReportMarkdown,
  renderCleanupPacketMarkdown,
  renderGraphPacketMarkdown,
} from "../lib/controller-action-report.ts";
import { sourceFreshness } from "../lib/graph-staleness.ts";
import { resolveBrickPath } from "../lib/source-path-resolver.ts";
import {
  capabilitiesHtml,
  canonicalizationHtml,
  buildRegistryHtml,
  proofSurfaceHtml,
} from "../lib/wiki-surface-pages.ts";
import {
  buildHandoffPaths,
  filterCuratedBuilds,
  parseArgs,
  summarizeBlockerCodes,
  uniqueStrings,
} from "../lib/curated-build-utils.ts";

test("goal progress reports durable verification and renders an operator-readable recovery story", () => {
  const selftest = runGoalProgressSelfTest();
  assert.ok(selftest.summary.event_count > 0);
  assert.ok(selftest.summary.failed_then_passed_count > 0);
  assert.match(renderGoalProgressSection(selftest), /failed.*passed/is);
  assert.match(goalProgressDashboardStyles(), /goal-progress/);

  const empty = buildGoalProgressReport({
    projects: [],
    hours: 0,
    now: "2026-07-12T00:00:00.000Z",
    maxBuckets: 1,
  });
  assert.equal(empty.window_hours, 1);
  assert.equal(empty.summary.event_count, 0);
  assert.equal(empty.summary.proof_coverage_percent, 0);
});

test("packet freshness is order-stable, project-scoped, and fails closed on age or lease drift", () => {
  const leases = [
    { lease_id: "b", resource_kind: "brick", resource_id: "two", project: "p2", agent_id: "z" },
    { lease_id: "regen", resource_kind: "registry-regen", resource_id: "global", project: "p1" },
    { lease_id: "a", resource_kind: "brick", resource_id: "one", project: "p1", agent_id: "a" },
  ];
  const all = packetLeaseFingerprint(leases);
  assert.deepEqual(packetLeaseFingerprint([...leases].reverse()), all);
  const project = packetLeaseFingerprint(leases, { project: "p1" });
  assert.equal(project.lease_count, 1);
  assert.deepEqual(project.lease_ids, ["a"]);
  assert.equal(maxAgeSeconds(true, 12), 12);
  assert.equal(maxAgeSeconds("12.9"), 12);
  assert.throws(() => maxAgeSeconds(-1), /invalid --max-age-seconds/);

  const current = packetFreshness(
    { generated_at: new Date().toISOString(), lease_fingerprint: project },
    { currentLeaseFingerprint: project, maxAge: 60 },
  );
  assert.equal(current.stale, false);
  assert.match(formatPacketFreshness(current), /lease [a-f0-9]{12}/);

  const changed = packetLeaseFingerprint([...leases, { lease_id: "c", resource_kind: "brick", resource_id: "three", project: "p1" }], { project: "p1" });
  assert.throws(
    () => assertFreshPacketReport(
      { generated_at: "2020-01-01T00:00:00.000Z", lease_fingerprint: project },
      { currentLeaseFingerprint: changed, maxAge: 1, label: "cleanup", refreshCommand: "refresh-now" },
    ),
    /cleanup packet file is stale.*active leases changed.*refresh-now/,
  );
});

test("controller reports preserve claim commands, graph repair guidance, and lease-bound packets", () => {
  const snapshot = {
    generated_at: "2026-07-12T00:00:00.000Z",
    leases: [{ lease_id: "l1", resource_kind: "brick", resource_id: "owned", project: "alpha", agent_id: "worker" }],
    projects: [{ id: "alpha" }, { id: "beta" }],
    summary: { projects: 2, active_leases: 1, open_conflicts: 0, dirty_unleased_projects: 1, graph_gaps: 2 },
    parallel_wave: {
      recommended_agent_count: 1,
      total_candidate_count: 1,
      overflow_count: 0,
      selection_rule: "highest impact first",
      commands: [{ rank: 1, project: "alpha", group: "tools", count: 3, parent_dirty_count: 6, brick: "dirty-tools", command: "claim alpha", inspect: "inspect alpha", conflict: "report alpha", sample_paths: ["tools/a.ts"], wave_gain_percent: 50, project_gain_percent: 50 }],
    },
    action_items: [
      { severity: "high", kind: "dirty-unleased", project: "alpha", title: "claim dirty tools", impact_score: 3, command: "claim alpha" },
      { severity: "medium", kind: "active-dirty-scope", project: "alpha", title: "claim uncovered scope", dirty_count: 5, parallel_claims: [{ group: "docs", count: 2, brick: "dirty-docs", command: "claim docs", conflict: "report docs", sample_paths: ["docs/a.md"] }] },
      { severity: "high", kind: "graph-gap", project: "beta", title: "refresh project graph", impact_score: 4, command: "refresh beta", repair_kind: "project" },
      { severity: "medium", kind: "module-graph-gap", project: "alpha", title: "refresh modules", impact_score: 2, module_graph_gap_count: 2, command: "refresh alpha modules", repair_kind: "module", target_fixes: [{ module: "reg" }] },
    ],
  };
  const actions = buildActionReport(snapshot);
  assert.deepEqual(actions.summary.by_kind, { "dirty-unleased": 1, "active-dirty-scope": 1, "graph-gap": 1, "module-graph-gap": 1 });
  assert.equal(actions.lease_fingerprints_by_project.alpha.lease_count, 1);
  assert.equal(actions.lease_fingerprints_by_project.beta.lease_count, 0);

  const cleanup = buildCleanupPacketReport(actions);
  assert.equal(cleanup.packets.length, 2);
  assert.deepEqual(cleanup.packets.map((packet) => packet.claim_command), ["claim alpha", "claim docs"]);
  assert.ok(cleanup.packets.every((packet) => packet.lease_fingerprint));
  assert.match(renderCleanupPacketMarkdown(cleanup), /claim docs/);

  const graphs = buildGraphPacketReport(actions);
  assert.equal(graphs.summary.packet_count, 2);
  assert.match(renderGraphPacketMarkdown(graphs), /refresh beta/);
  assert.match(renderActionReportMarkdown(actions), /claim dirty tools/);
});

test("graph freshness honors ownership globs, exclusions, fallbacks, and missing graph boundaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-graph-freshness-"));
  try {
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    await writeFile(path.join(root, "src", "old.ts"), "old");
    await writeFile(path.join(root, "src", "nested", "new.ts"), "new");
    await writeFile(path.join(root, "src", "ignored.test.ts"), "ignored");
    const now = Date.now();
    const config = { modules: [{ id: "core", label: "Core", paths: ["src/**/*.ts", "!src/**/*.test.ts"] }] };
    const stale = sourceFreshness(root, { id: "core" }, { mtimeMs: now - 60_000 }, config);
    assert.equal(stale.graphFreshness, "stale");
    assert.deepEqual(stale.sourceGlobs, ["src/**/*.ts", "!src/**/*.test.ts"]);
    const fresh = sourceFreshness(root, { name: "CORE" }, { mtimeMs: now + 60_000 }, config);
    assert.equal(fresh.graphFresh, true);
    assert.deepEqual(sourceFreshness(root, null, { mtimeMs: now }, config), { graphFreshness: null, graphFresh: null, graphStale: false, sourceUpdatedAt: null, sourceGlobs: [] });
    assert.deepEqual(sourceFreshness(root, { id: "none", root: path.join(root, "src") }, { mtimeMs: now + 60_000 }, config).sourceGlobs, ["src/**"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("brick path resolution prefers real manifests and safely repairs doubled project prefixes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-source-path-"));
  try {
    await mkdir(path.join(root, "src", "feature"), { recursive: true });
    const manifest = path.join(root, "src", "feature", "module.sweetspot.json");
    await writeFile(manifest, "{}");
    assert.deepEqual(resolveBrickPath({ manifest_path: manifest }, root), { absolutePath: path.dirname(manifest), gitRelativePath: "src/feature", source: "manifest" });
    assert.equal(resolveBrickPath({ source_paths: ["missing"] }, root), null);
    assert.deepEqual(resolveBrickPath({ source_paths: ["project/src/feature"] }, root), { absolutePath: path.join(root, "src", "feature"), gitRelativePath: "src/feature", source: "src-stripped" });
    assert.equal(resolveBrickPath(null, root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("wiki surfaces and curated-build helpers expose honest empty and populated operator states", () => {
  /** @type {Parameters<typeof proofSurfaceHtml>[0]} */
  const registry = { schema_version: "1.0.0", generated_at: "2026-07-12T00:00:00.000Z", projects: [], bricks: [] };
  for (const html of [proofSurfaceHtml(registry), buildRegistryHtml(registry), capabilitiesHtml(registry), canonicalizationHtml(registry)]) {
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /Sweetspot Modular Architecture|SMARCH/);
    assert.doesNotMatch(html, /undefined/);
  }

  assert.deepEqual(uniqueStrings([" alpha ", "alpha", "", null, "beta"]), ["alpha", "beta"]);
  assert.deepEqual(parseArgs(["--project", "alpha", "--stdout", "query"]), { _: ["query"], project: "alpha", stdout: true });
  const curatedFixture = { manifest: null, manifest_path: null, project_root: null, project_state: null, promotion: null, verificationEntry: null, release: null, publishBundle: null, source_roots: [], leak_hotspots: [], first_actions: [] };
  /** @type {Parameters<typeof filterCuratedBuilds>[0]} */
  const builds = [
    { ...curatedFixture, build_id: "alpha", title: "Alpha", status: "ready", tags: ["trusted"] },
    { ...curatedFixture, build_id: "beta", title: "Beta", status: "blocked", tags: ["experimental"] },
  ];
  assert.deepEqual(filterCuratedBuilds(builds, { build: "alpha" }).map((item) => item.build_id), ["alpha"]);
  assert.deepEqual(filterCuratedBuilds(builds, { _: ["build:beta"] }).map((item) => item.build_id), ["beta"]);
  assert.deepEqual(buildHandoffPaths({ source_project: "alpha", artifact_id: "build-one" }), {
    queue_doc: "handoffs/repo-queues/alpha.md",
    repo_prompt: "handoffs/repo-builds/build-one.prompt.md",
    build_packets: "handoffs/build-packets.generated.json",
    repo_queues: "handoffs/repo-queues.generated.json",
    publish_leaks: "publish/publish-leaks.generated.json",
    manifest_scaffolds: "scaffolds/build-manifest-repairs.generated.json",
    scaffold_output: "scaffolds/build-manifest-repairs.generated.json",
    release_drafts: "releases/release-drafts.generated.json",
    acceptance_definitions: "docs/CURATED_BUILD_ACCEPTANCE_DEFINITIONS.md",
    verification_templates: "templates/build-verification/",
  });
  assert.deepEqual(summarizeBlockerCodes([{ code: "A", message: "first" }, { code: "A" }, { code: "B" }]), [
    { code: "A", message: "first", count: 2 },
    { code: "B", message: "", count: 1 },
  ]);
});
