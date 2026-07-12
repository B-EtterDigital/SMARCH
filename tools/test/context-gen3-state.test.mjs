import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  PROJECT_ABSOLUTE_OVERRIDES,
  PROJECTS_ROOT,
  appendContextEvent,
  listBricksWithContext,
  logPath,
  projectRoot,
  readContextLog,
  resolveActorId,
  resolveSessionId,
} from "../lib/context-log.ts";
import {
  collectProjectGen3,
  isVolatileSmaRegenLease,
  readProjectContextCoverage,
} from "../lib/gen3-state.ts";

const GEN3_STATE_URL = pathToFileURL(path.resolve("tools/lib/gen3-state.ts")).href;
const SESSION_KEYS = [
  "SMA_SESSION", "SMA_SESSION_ID", "CODEX_THREAD_ID", "CODEX_SESSION_ID",
  "CLAUDE_SESSION_ID", "WARP_TERMINAL_SESSION_UUID", "XDG_SESSION_ID", "WARP_FOCUS_URL",
];

/** @param {Record<string, string | undefined>} changes @param {() => unknown} fn */
function withEnv(changes, fn) {
  const before = new Map(Object.keys(changes).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of before) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** @param {string} root @param {string} expression @param {NodeJS.ProcessEnv} [extraEnv] @returns {any} */
function runIsolatedGen3(root, expression, extraEnv = {}) {
  const stdout = execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    `const mod = await import(${JSON.stringify(GEN3_STATE_URL)}); console.log(JSON.stringify(await (${expression})));`,
  ], {
    encoding: "utf8",
    env: { ...process.env, SMA_ROOT: root, ...extraEnv },
  });
  return JSON.parse(stdout.trim());
}

test("context events reject every invalid public input before writing", async () => {
  const valid = { project: "fixture", brick: "brick", kind: "note", intent: "valid intent" };
  /** @type {Array<[Parameters<typeof appendContextEvent>[0], RegExp]>} */
  const cases = [
    [{ ...valid, project: "" }, /missing project/],
    [{ ...valid, brick: "" }, /missing brick/],
    [{ ...valid, kind: "" }, /missing kind/],
    [{ ...valid, intent: "abc" }, /intent must be at least 4 chars/],
    [{ ...valid, kind: "invented" }, /bad kind: invented/],
    [{ ...valid, actorKind: "robot" }, /bad actorKind: robot/],
    [{ ...valid, verification: { status: "maybe" } }, /bad verification\.status: maybe/],
  ];
  for (const [input, expected] of cases) assert.throws(() => appendContextEvent(input), expected);
  assert.throws(() => projectRoot(""), /missing project id/);
  const createdProjectsRoot = !existsSync(PROJECTS_ROOT);
  if (createdProjectsRoot) await mkdir(PROJECTS_ROOT, { recursive: true });
  try {
    assert.throws(() => projectRoot("definitely-not-a-real-project-7f4d"), /project not found/);
  } finally {
    if (createdProjectsRoot) await rm(PROJECTS_ROOT, { recursive: true, force: true });
  }
});

test("session and actor resolution honor explicit, configured, and terminal fallbacks", () => {
  const cleared = Object.fromEntries([...SESSION_KEYS, "SMA_AGENT", "CODEX_AGENT_ID", "CLAUDE_AGENT_ID"].map((key) => [key, undefined]));
  withEnv({ ...cleared, SMA_SESSION: " first ", CODEX_THREAD_ID: "second" }, () => {
    assert.equal(resolveSessionId(), "first");
    assert.equal(resolveSessionId(" direct "), "direct");
  });
  withEnv({ ...cleared, WARP_TERMINAL_SESSION_UUID: "terminal-42" }, () => {
    assert.equal(resolveSessionId(), "warp-terminal-42");
  });
  withEnv({ ...cleared, XDG_SESSION_ID: "7" }, () => assert.equal(resolveSessionId(), "xdg-7"));
  withEnv({ ...cleared, WARP_FOCUS_URL: "warp://host/session/focus-99?x=1" }, () => {
    assert.equal(resolveSessionId(), "warp-focus-99");
  });
  withEnv({ ...cleared, SMA_AGENT: "configured-agent", USER: "fixture-user" }, () => {
    assert.equal(resolveActorId(" explicit ", "session-123"), "explicit");
    assert.equal(resolveActorId(undefined, "session-123"), "configured-agent");
  });
  withEnv({ ...cleared, USER: "fixture-user" }, () => {
    assert.equal(resolveActorId(undefined, "session-123456789"), "fixture-user@session");
    assert.equal(resolveActorId(undefined, null), "fixture-user");
  });
});

test("context append/read preserves optional evidence and reports malformed lines", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-context-test-"));
  const project = `context-fixture-${process.pid}`;
  PROJECT_ABSOLUTE_OVERRIDES[project] = root;
  try {
    const event = appendContextEvent({
      project,
      brick: "trust/brick",
      kind: "verification_run",
      intent: "prove the complete event contract",
      actorKind: "automation",
      actorId: "runner",
      sessionId: "session-a",
      model: "fixture-model",
      taskId: "task-a",
      leaseId: "lease-a",
      decisionRationale: "behavior is the contract",
      rejectedAlternatives: ["skip tests", "mock only :: misses failures", { alternative: "manual", reason: "not repeatable" }],
      linkedBacklog: ["B-1"],
      filesTouched: ["tools/lib/context-log.ts"],
      commit: "abc123",
      verification: { status: "pass", command: "node --test" },
    });
    assert.equal(event.actor_id, "runner");
    assert.deepEqual(event.rejected_alternatives, [
      { alternative: "skip tests", reason: "" },
      { alternative: "mock only", reason: "misses failures" },
      { alternative: "manual", reason: "not repeatable" },
    ]);
    assert.match(logPath(project, "trust/brick"), /trust_brick\.ndjson$/);
    await appendFile(logPath(project, "trust/brick"), "not-json\n[]\n");
    const errors = [];
    const originalError = console.error;
    console.error = (message) => errors.push(String(message));
    try {
      const records = readContextLog(project, "trust/brick");
      assert.equal(records.length, 3);
      assert.equal(records[0].event_id, event.event_id);
      assert.deepEqual(records.slice(1), [
        { _malformed: true, _raw: "not-json" },
        { _malformed: true, _raw: "[]" },
      ]);
    } finally {
      console.error = originalError;
    }
    assert.equal(errors.length, 2);
    assert.deepEqual(listBricksWithContext(project), ["trust_brick"]);
  } finally {
    delete PROJECT_ABSOLUTE_OVERRIDES[project];
    await rm(root, { recursive: true, force: true });
  }
});

test("gen3 project summaries count conflicts and merge resolutions while tolerating corrupt records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-gen3-test-"));
  try {
    const contextDir = path.join(root, ".smarch", "agent-context");
    const proposalsDir = path.join(root, ".smarch", "merge-proposals");
    await mkdir(contextDir, { recursive: true });
    await mkdir(proposalsDir, { recursive: true });
    await writeFile(path.join(contextDir, "a.ndjson"), [
      { event_id: "ctx-conflict-1", timestamp: "2026-01-01T00:00:00Z", kind: "conflict_detected", intent: "first conflict" },
      { event_id: "ctx-conflict-2", timestamp: "2026-01-01T00:01:00Z", kind: "conflict_detected", intent: "second conflict" },
      { event_id: "ctx-resolution-2", timestamp: "2026-01-01T00:02:00Z", kind: "conflict_resolved", intent: "resolved second", decision_rationale: "conflict_event_id=ctx-conflict-2" },
      { event_id: "ctx-resolution-duplicate", timestamp: "2026-01-01T00:03:00Z", kind: "conflict_resolved", intent: "duplicate resolution", decision_rationale: "conflict_event_id=ctx-conflict-2" },
      { event_id: "ctx-resolution-orphan", timestamp: "2026-01-01T00:04:00Z", kind: "conflict_resolved", intent: "orphan resolution", decision_rationale: "conflict_event_id=ctx-conflict-missing" },
    ].map((value) => JSON.stringify(value)).join("\n") + "\nmalformed\n");
    await writeFile(path.join(contextDir, "empty.ndjson"), "\n");
    await writeFile(path.join(proposalsDir, "open.json"), JSON.stringify({ proposal_id: "open", brick_id: "a", generated_at: "2026-01-02T00:00:00Z", chains: [{}, {}], recommendation: { preferred_chain: "chain-b" } }));
    await writeFile(path.join(proposalsDir, "done.json"), JSON.stringify({ proposal_id: "done", generated_at: "2026-01-01T00:00:00Z", resolved_at: "2026-01-03T00:00:00Z", resolution_kind: "selected" }));
    await writeFile(path.join(proposalsDir, "bad.json"), "{");

    const originalError = console.error;
    console.error = () => {};
    let coverage;
    let project;
    try {
      coverage = readProjectContextCoverage(root);
      project = collectProjectGen3({ projectId: "fixture", projectRoot: root });
    } finally {
      console.error = originalError;
    }
    assert.equal(coverage.bricks_with_context, 1);
    assert.equal(coverage.total_events, 6);
    assert.deepEqual([coverage.conflict_detected, coverage.conflict_resolved, coverage.open_conflicts], [2, 3, 1]);
    assert.equal(coverage.malformed_conflict_resolutions, 2);
    assert.equal(coverage.bricks[0].malformed_conflict_resolutions, 2);
    assert.equal(coverage.bricks[0].last_intent, "orphan resolution");
    assert.equal(project.merge_proposals.open_count, 1);
    assert.equal(project.merge_proposals.resolved_count, 1);
    assert.equal(project.merge_proposals.proposals[0].chain_count, 2);
    const global = runIsolatedGen3(root, `(async () => {
      const originalError = console.error;
      console.error = () => {};
      try {
        return mod.collectGlobalGen3({ projects: [
          { id: "fixture", absoluteRoot: ${JSON.stringify(root)} },
          { id: "empty", absoluteRoot: ${JSON.stringify(path.join(root, "empty-project"))} },
          { id: "skipped", absoluteRoot: "" }
        ] });
      } finally {
        console.error = originalError;
      }
    })()`);
    assert.equal(global.context_coverage.projects_with_logs, 1);
    assert.equal(global.context_coverage.total_bricks_with_context, 1);
    assert.deepEqual(global.conflicts, { detected_count: 2, resolved_count: 3, open_count: 1, malformed_resolution_count: 2 });
    assert.deepEqual(global.merge_proposals, { open_count: 1, resolved_count: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gen3 lease summaries filter expiry, wrapper, and volatile maintenance leases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-gen3-leases-"));
  try {
    await mkdir(path.join(root, "registry"), { recursive: true });
    const future = new Date(Date.now() + 600_000).toISOString();
    const past = new Date(Date.now() - 600_000).toISOString();
    /** @param {string} lease_id @param {string} resource_kind @param {string} project @param {string} [expires_at] @param {string} [agent_id] */
    const lease = (lease_id, resource_kind, project, expires_at = future, agent_id = "agent-a") => ({
      lease_id, resource_kind, resource_id: lease_id, agent_id,
      project, acquired_at: "2026-01-01T00:00:00Z", expires_at, intent: `intent ${lease_id}`,
    });
    await writeFile(path.join(root, "registry", "active-leases.generated.json"), JSON.stringify({
      generated_at: "2026-01-01T00:00:00Z",
      leases: [
        lease("active", "brick", "fixture"),
        lease("wrapper", "brick", "fixture"),
        lease("regen", "state-regen", "sma"),
        lease("expired", "brick", "fixture", past, "agent-b"),
      ],
    }));
    const summary = runIsolatedGen3(root, `mod.readActiveLeases({ excludeCurrentWrapperLease: true, excludeVolatileSmaRegenLeases: true })`, { SMA_ACTIVE_LEASE_ID: "wrapper" });
    assert.equal(summary.active_count, 1);
    assert.deepEqual(summary.by_resource_kind, { brick: 1 });
    assert.deepEqual(summary.by_agent, { "agent-a": 1 });
    assert.equal(summary.leases[0].lease_id, "active");
    const all = runIsolatedGen3(root, `mod.readActiveLeases({ includeExpired: true })`);
    assert.equal(all.active_count, 4);
    assert.equal(all.leases.find((/** @type {{lease_id: string}} */ entry) => entry.lease_id === "expired").ttl_remaining_seconds, 0);
    assert.equal(isVolatileSmaRegenLease({ project: "sma", resource_kind: "wiki-regen" }), true);
    assert.equal(isVolatileSmaRegenLease({ project: "fixture", resource_kind: "wiki-regen" }), false);
    await writeFile(path.join(root, "registry", "active-leases.generated.json"), "{");
    const corrupt = runIsolatedGen3(root, `mod.readActiveLeases()`);
    assert.equal(corrupt._error, "lease registry is corrupt");
    const missingRoot = path.join(root, "missing-sma-root");
    const missing = runIsolatedGen3(missingRoot, `mod.readActiveLeases()`);
    assert.deepEqual(missing, { generated_at: null, active_count: 0, by_resource_kind: {}, by_agent: {}, leases: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("gen3 empty and unreadable context inputs fail soft", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-gen3-empty-"));
  try {
    assert.deepEqual(readProjectContextCoverage(root), {
      bricks_with_context: 0, total_events: 0, last_event_at: null,
      conflict_detected: 0, conflict_resolved: 0, open_conflicts: 0, bricks: [],
      malformed_conflict_resolutions: 0,
    });
    const contextDir = path.join(root, ".smarch", "agent-context");
    await mkdir(path.join(contextDir, "unreadable.ndjson"), { recursive: true });
    const originalError = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(readProjectContextCoverage(root).bricks, []);
    } finally {
      console.error = originalError;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
