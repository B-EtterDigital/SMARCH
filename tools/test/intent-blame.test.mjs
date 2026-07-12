import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildIntentBlame, renderIntentBlame } from "../lib/intent-blame.ts";

/** @param {string} root @param {string[]} args @param {NodeJS.ProcessEnv} [env] */
function git(root, args, env = {}) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function fixtureRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-intent-blame-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Intent Fixture"]);
  git(root, ["config", "user.email", "intent@example.test"]);
  return root;
}

/** @param {string} root @param {string} message @param {string} timestamp */
function commit(root, message, timestamp) {
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", message], {
    GIT_AUTHOR_DATE: timestamp,
    GIT_COMMITTER_DATE: timestamp,
  });
  return git(root, ["rev-parse", "HEAD"]);
}

test("intent blame follows renames and joins old-path intent plus evidence", async () => {
  const root = await fixtureRepo();
  try {
    await writeFile(path.join(root, "legacy.ts"), "export const answer = 42;\n");
    const originalCommit = commit(root, "add legacy answer", "2026-01-01T00:00:00Z");
    git(root, ["mv", "legacy.ts", "current.ts"]);
    commit(root, "rename answer module", "2026-01-01T00:10:00Z");

    await mkdir(path.join(root, ".smarch", "agent-context"), { recursive: true });
    await writeFile(path.join(root, ".smarch", "agent-context", "rename.ndjson"), `${JSON.stringify({
      timestamp: "2026-01-01T00:01:00Z",
      kind: "decision_recorded",
      actor_id: "agent-rename",
      intent: "Preserve the answer while moving its public path.",
      decision_rationale: "The old import path was misleading.",
      files_touched: ["legacy.ts"],
      commit: originalCommit,
      verification: { command: "node --test rename", status: "pass" },
    })}\n`);
    await writeFile(path.join(root, ".smarch", "rename-evidence.ndjson"), `${JSON.stringify({
      timestamp: "2026-01-01T00:02:00Z",
      command: "npx tsc --noEmit",
      exit_code: 0,
      commit: originalCommit,
      files: ["legacy.ts"],
    })}\n`);

    const result = buildIntentBlame({ repoRoot: root, file: "current.ts", lines: "1" });
    assert.deepEqual(result.historical_paths, ["current.ts", "legacy.ts"]);
    assert.equal(result.line_filter, "1");
    assert.equal(result.ranges.length, 1);
    assert.equal(result.ranges[0].actor, "agent-rename");
    assert.match(result.ranges[0].intent, /old import path was misleading/);
    assert.deepEqual(result.ranges[0].evidence.map((entry) => [entry.command, entry.exit_code]), [
      ["node --test rename", 0],
      ["npx tsc --noEmit", 0],
    ]);
    assert.match(renderIntentBlame(result), /agent-rename/);
    assert.match(renderIntentBlame(result), /exit 0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("intent blame uses the two-hour window only when no commit is recorded", async () => {
  const root = await fixtureRepo();
  try {
    await writeFile(path.join(root, "window.ts"), "export const windowed = true;\n");
    commit(root, "add windowed behavior", "2026-01-02T12:00:00Z");
    await mkdir(path.join(root, ".smarch", "agent-context"), { recursive: true });
    const records = [
      {
        timestamp: "2026-01-02T16:01:00Z",
        actor_id: "too-far",
        intent: "This record must not match.",
        files_touched: ["window.ts"],
      },
      {
        timestamp: "2026-01-02T12:30:00Z",
        kind: "edit_applied",
        actor_id: "nearby-agent",
        intent: "Explain the nearby change.",
        decision_rationale: "Timestamp evidence is all the pre-commit agent had.",
        files_touched: ["window.ts"],
        proof: ["node --test window"],
      },
    ];
    await writeFile(
      path.join(root, ".smarch", "agent-context", "window.ndjson"),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );

    const result = buildIntentBlame({ repoRoot: root, file: "window.ts" });
    assert.equal(result.ranges[0].actor, "nearby-agent");
    assert.equal(result.ranges[0].evidence[0].command, "node --test window");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("intent blame reports an honest pre-Gen3 fallback when no intent record exists", async () => {
  const root = await fixtureRepo();
  try {
    await writeFile(path.join(root, "history.ts"), "export const history = 'git-only';\n");
    commit(root, "add git-only history", "2025-12-31T23:00:00Z");

    const result = buildIntentBlame({ repoRoot: root, file: "history.ts" });
    assert.equal(result.ranges[0].actor, "pre-Gen3 history");
    assert.equal(result.ranges[0].intent, "pre-Gen3 history");
    assert.equal(result.ranges[0].context_source, null);
    assert.deepEqual(result.ranges[0].evidence, []);
    assert.match(renderIntentBlame(result), /pre-Gen3 history/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
