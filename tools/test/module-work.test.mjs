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
  moduleObservationBigPicture,
  modulePrompt,
  moduleWatchBigPicture,
  renderDispatchMarkdown,
  renderModuleWatchConsole,
  renderObservationMarkdown,
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

test("module-work big-picture renderers cover missing, launchable, completed, and blocked wave states", () => {
  const progress = {
    assignment_count: 2,
    claimed: 1,
    active: 1,
    completed: 0,
    unclaimed: 1,
    claimable_unclaimed: 1,
    launch_blocked_unclaimed: 0,
    external_active_slot_count: 0,
    external_active_lease_count: 0,
    external_active_module_count: 0,
    open_conflicts: 0,
    graph_ready: 2,
  };
  const watch = {
    status: "ready",
    project: "sma",
    task: "cover renderers",
    active_lane: "module-work",
    launchable_agents: 1,
    blockers: [],
    warnings: [],
    next: "npm run module:claim -- --next",
    capacity: {
      launch_ready_slots: 2,
      requested_agents: 2,
      graph_ready_modules: 2,
      modules_total: 2,
      held_slots: 1,
      graph_blocked_modules: 1,
      path_overlap_blocked_slots: 1,
      held_modules: [{ module_id: "held", slot: 2, held_resource: "brick:held", held_by: "agent-a" }],
    },
    dispatch: { available: false },
    progress: { ...progress },
    gains: {
      predicted_graph_first_token_reduction_percent: 40,
      predicted_dirty_status_token_reduction_percent: 50,
      predicted_collision_reduction_percent: 60,
      observed_claimed_percent: 50,
      observed_completed_percent: 0,
    },
  };

  assert.match(moduleWatchBigPicture(/** @type {any} */ (watch)).tldr, /Dispatch missing/);
  const launchable = {
    ...watch,
    dispatch: {
      available: true,
      dispatch_id: "dispatch-fixture",
      assignment_count: 2,
      latest_observation: {
        json_path: "dispatch-fixture-observed-20260712T000000Z.json",
        markdown_path: "dispatch-fixture-observed-20260712T000000Z.md",
      },
    },
    progress: { ...progress, dispatch_age_ms: 600_000, dispatch_stale: true, dispatch_max_age_ms: 300_000 },
  };
  assert.match(moduleWatchBigPicture(/** @type {any} */ (launchable)).tldr, /launch-ready/);
  assert.match(moduleWatchBigPicture(/** @type {any} */ ({
    ...launchable,
    progress: { ...progress, completed: 2, claimable_unclaimed: 0, unclaimed: 0 },
  })).tldr, /is complete/);
  assert.match(moduleWatchBigPicture(/** @type {any} */ ({
    ...launchable,
    progress: { ...progress, claimable_unclaimed: 0, launch_blocked_unclaimed: 1 },
  })).tldr, /not claim-ready/);

  const consoleOutput = renderModuleWatchConsole(/** @type {any} */ (launchable), {
    blockedReasonSuffix: () => "",
    formatPercent: (value) => `${value.toFixed(1)}%`,
  });
  assert.match(consoleOutput, /dispatch-age:\s+10m stale \(max 5m\)/);
  assert.match(consoleOutput, /held-modules:\s+held#2:brick:held by agent-a/);
  assert.match(consoleOutput, /claim-ready:\s+1\/1 unclaimed/);

  const observation = {
    status: "active",
    generated_at: "2026-07-12T00:00:00.000Z",
    dispatch: { dispatch_id: "dispatch-fixture", project: "sma", task: "cover renderers", assignment_count: 2 },
    summary: { ...progress },
    gains: {
      predicted_graph_first_token_reduction_percent: 40,
      observed_claimed_percent: 50,
      observed_completed_percent: 0,
    },
    comparison: {
      predicted_requested_agents: 2,
      predicted_launch_ready_slots: 2,
      dispatched_slots: 2,
      observed_claimed_slots: 1,
      observed_active_slots: 1,
      observed_completed_slots: 0,
      observed_claimable_unclaimed_slots: 1,
      observed_launch_blocked_unclaimed_slots: 0,
      observed_external_active_slots: 0,
      observed_external_active_leases: 0,
      observed_open_conflicts: 0,
    },
    next: "npm run module:watch",
    blockers: ["fixture blocker"],
    warnings: ["fixture warning"],
    external_active_module_leases: [{ module_id: "other", held_resource: "brick:other", held_by: "agent-b", slot_count: 2, agent_slots: [3, 4] }],
    assignments: [{
      agent_slot: 1,
      module_id: "registry",
      slot: 1,
      status: "active",
      claim_event_count: 1,
      completion_event_count: 0,
      active_lease_count: 1,
      open_conflicts: 1,
      context_error: "bad line",
      dirty_scope_count: 1,
      held_resource: "brick:registry",
      agent_packet_markdown_path: "packet.md",
      conflict_command: "conflict module",
      dirty_scope_command: "claim dirty",
      dirty_scope_conflict_command: "conflict dirty",
    }],
  };
  assert.match(moduleObservationBigPicture(/** @type {any} */ (observation)).tldr, /launch-ready/);
  const markdown = renderObservationMarkdown(/** @type {any} */ (observation), {
    blockedReasonSuffix: () => "",
    formatPercent: (value) => `${value}%`,
  });
  assert.match(markdown, /## External Active Module Leases/);
  assert.match(markdown, /context error: bad line/);

  const prompt = modulePrompt({
    config: { project: "sma" },
    module: { id: "registry", paths: ["tools/lib/**"], excludePaths: ["tools/lib/private/**"] },
    partition: { id: "tests", description: "test-only partition" },
    slot: 2,
    task: "cover renderers",
    graphCommand: "npm run graphify:query:self -- -- registry",
    iterationGates: ["node --test tools/test/module-work.test.mjs"],
    gates: ["npm run check"],
    sharedWarnings: [{ id: "quality-ratchet" }],
    claimCommand: "npm run start:edit",
    moduleWorkBrick: (moduleId, slot) => `module-work-${moduleId}-${slot}`,
    shellArg,
  });
  assert.match(prompt, /explicit partition `tests`/);
  assert.match(prompt, /Shared hot-path warning: quality-ratchet/);
  assert.match(prompt, /conflict reporting is mandatory/);
});
