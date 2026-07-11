import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  agentPacketDescriptor,
  agentPacketPayload,
  writeAgentPackets,
} from "../lib/module-work-agent-packets.ts";
import { latestObservationForDispatch } from "../lib/module-work-observations.ts";
import {
  modulePathSamples,
  modulesOverlap,
  overlappingModulePathPairs,
  overlappingSharedHotPaths,
  pathPatternCovers,
} from "../lib/module-work-paths.ts";
import {
  formatExternalActiveLeases,
  moduleConflictCommand,
  renderDispatchMarkdown,
} from "../lib/module-work-renderers.ts";
import {
  blockedReasonCounts,
  blockedReasonSuffix,
  dashCase,
  externalActiveModuleLeaseGroups,
  formatDuration,
  formatPercent,
  hasConcreteModuleTask,
  isPathLike,
  number,
  parseArgs,
  percent,
  positiveInt,
  projectDashboardCommand,
  safeId,
  shellArg,
  timestampSlug,
} from "../lib/module-work-utils.ts";

test("module-work path helpers respect exclusions and shared hot paths", () => {
  const registry = { paths: ["tools/lib/**"], excludePaths: ["tools/lib/private/**"] };
  const dashboard = { paths: ["tools/lib/dash-api/**"] };
  const privateFiles = { paths: ["tools/lib/private/**"] };

  assert.deepEqual(modulePathSamples(registry), ["tools/lib/**"]);
  assert.equal(modulesOverlap(registry, dashboard), true);
  assert.equal(modulesOverlap(registry, privateFiles), false);
  assert.deepEqual(overlappingModulePathPairs(registry, dashboard), [
    { left: "tools/lib/**", right: "tools/lib/dash-api/**" },
  ]);
  assert.equal(pathPatternCovers("tools/lib/**", "tools/lib/module-work-paths.ts"), true);
  assert.deepEqual(
    overlappingSharedHotPaths([
      { id: "lib", paths: ["tools/lib/**"], requiredGates: ["node --test"] },
      { id: "web", paths: ["web/src/**"] },
    ], dashboard),
    [{ id: "lib", label: "lib", risk: "unknown", required_gates: ["node --test"] }],
  );
});

test("module-work agent packets serialize a complete first-read handoff", () => {
  const root = mkdtempSync(join(tmpdir(), "smarch-module-packet-"));
  try {
    const dispatchBase = join(root, "handoffs", "dispatch-demo");
    const descriptor = agentPacketDescriptor({
      dispatchBase,
      slot: { agent_slot: 2, module_id: "Registry API" },
      smaRoot: root,
    });
    const assignment = {
      project: "sma",
      task: "cover extracted seams",
      agent_slot: 2,
      module_id: "registry-api",
      slot: 1,
      brick: "module-work-registry-api-slot-1",
      paths: ["tools/lib/**"],
      exclude_paths: ["tools/lib/private/**"],
      shared_hot_paths: [{ id: "quality" }],
      iteration_gates: ["node --test tools/test/module-work.test.mjs"],
      required_gates: ["node tools/sma-quality-gate.mjs"],
      graph_query_command: "npm run graphify:query:self -- -- registry",
      claim_command: "npm run start:edit -- --project sma --brick registry-api",
      prompt: "Stay inside the packet scope.",
      agent_packet: descriptor,
    };
    const manifest = {
      created_at: "2026-07-12T00:00:00.000Z",
      dispatch_id: "dispatch-demo",
      project: "sma",
      task: assignment.task,
      assignments: [assignment],
      blocked_slots: [],
      gains: {
        module_graph_first_token_reduction_percent_estimate: 42,
        dirty_status_token_reduction_percent_estimate: 55,
        collision_reduction_percent_estimate: 60,
      },
      controller_commands: {
        observe: "npm run module:observe",
        observe_write: "npm run module:observe:write",
        claim_next: "npm run module:claim -- --next",
        project_preflight: "npm run parallel:preflight",
        project_dashboard: "npm run gen3:dashboard",
        conflict_summary: "npm run conflict:summary",
      },
      dispatch_paths: { json_path: "handoffs/dispatch-demo.json", markdown_path: "handoffs/dispatch-demo.md" },
    };

    const payload = agentPacketPayload(manifest, assignment);
    assert.equal(payload.first_read, true);
    assert.equal(payload.gains.graph_first_token_reduction_percent_estimate, 42);
    assert.match(renderDispatchMarkdown(manifest), /registry-api slot 1/);

    writeAgentPackets(manifest, { smaRoot: root });
    const json = JSON.parse(readFileSync(join(root, descriptor.json_path), "utf8"));
    const markdown = readFileSync(join(root, descriptor.markdown_path), "utf8");
    assert.equal(json.dispatch_id, "dispatch-demo");
    assert.match(markdown, /SMA Gen3 Agent Packet dispatch-demo \/ 2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("module-work observations select the newest matching receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "smarch-module-observation-"));
  try {
    writeFileSync(join(root, "demo-observed-20260711T010000Z.json"), "{}\n");
    writeFileSync(join(root, "demo-observed-20260711T020000Z.json"), "{}\n");
    writeFileSync(join(root, "demo-observed-20260711T020000Z.md"), "# observation\n");
    writeFileSync(join(root, "other-observed-20260711T030000Z.json"), "{}\n");

    assert.deepEqual(latestObservationForDispatch({ dispatchId: "demo", observationDir: root, rootDir: root }), {
      json_path: "demo-observed-20260711T020000Z.json",
      markdown_path: "demo-observed-20260711T020000Z.md",
    });
    assert.equal(latestObservationForDispatch({ dispatchId: "missing", observationDir: root }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("module-work utility and renderer seams keep controller output deterministic", () => {
  const blocked = [
    { launch_blocked: true, launch_blocked_reason: "held", held_match: "module-related-active-lease", module_id: "registry", held_resource: "brick:registry", held_lease_id: "lease-1", held_by: "agent-a", agent_slot: 2, brick: "dispatch-registry" },
    { launch_blocked: true, launch_blocked_reason: "dirty-scope" },
    { launch_blocked: true, launch_blocked_reason: "other" },
    { launch_blocked: true, launch_blocked_reason: "held", claimed: true },
  ];
  assert.deepEqual(blockedReasonCounts(blocked), { held: 1, dirtyScope: 1, other: 1 });
  const groups = externalActiveModuleLeaseGroups(blocked);
  assert.equal(groups[0].slot_count, 1);
  assert.equal(formatExternalActiveLeases(groups), "registry:brick:registry");
  assert.equal(blockedReasonSuffix({ held_blocked_unclaimed: 2, dirty_scope_blocked_unclaimed: 1 }), " (2 active leases, 1 dirty scope)");
  assert.equal(positiveInt("3.8", 1), 3);
  assert.equal(safeId("Registry API"), "Registry-API");
  assert.equal(isPathLike("tools/lib"), true);
  assert.equal(timestampSlug(new Date("2026-07-12T01:02:03.456Z")), "20260712T010203Z");
  assert.equal(number("bad"), 0);
  assert.equal(percent(1, 4), 25);
  assert.equal(formatPercent(12.5), "12.5%");
  assert.equal(formatDuration(3_600_000), "1h");
  assert.equal(shellArg("it's"), "'it'\\''s'");
  assert.equal(dashCase("claimNext"), "claim-next");
  assert.equal(hasConcreteModuleTask("cover the seam"), true);
  assert.equal(hasConcreteModuleTask("<describe module task>"), false);
  assert.match(projectDashboardCommand({ project: "sma", task: "cover", summary: { requested_agents: 2 } }), /--max-agents 2$/);
  const parsed = parseArgs(["--project", "sma", "--fill-capacity", "--max-agents", "4"]);
  assert.equal(parsed.project, "sma");
  assert.equal(parsed.fillCapacity, true);
  assert.equal(parsed.maxAgents, "4");
  assert.match(moduleConflictCommand({
    project: "sma",
    moduleId: "registry",
    slot: 2,
    task: "cover",
    moduleWorkBrick: (moduleId, slot) => `module-work-${moduleId}-${slot}`,
    shellArg,
  }), /module-work-registry-2/);
});
