#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadToolModules } from "./server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const EXPECTED_TOOLS = [
  "brick-search",
  "brick-get",
  "brick-trust",
  "registry-doctor",
  "registry-why-blocked",
  "release-install",
  "build-list",
  "server-card",
].sort();

async function fixtureRegistry() {
  try {
    const registry = JSON.parse(await readFile(
      path.resolve(repoRoot, "registry/global-modules.generated.json"),
      "utf8",
    ));
    const fixtureBricks = (registry.bricks || []).filter((brick) => String(brick.project || "").startsWith("acme-"));
    if (fixtureBricks.length > 0) return { ...registry, bricks: fixtureBricks };
  } catch {
    // Fall through to the minimal deterministic registry below.
  }
  return {
    schema_version: 1,
    generated_at: "2026-01-15T00:00:00.000Z",
    projects: [{ id: "acme-cms" }],
    bricks: [{
      id: "acme-cms.approval-flow",
      name: "Approval Flow",
      project: "acme-cms",
      kind: "module",
      status: "project_bound",
      score: 92,
      risk: "low",
      clone_readiness: "guided",
      source_paths: ["src/modules/approval-flow"],
      health: { status: "ok", calculated_score: 91, error_count: 0, warning_count: 0 },
      verification: [{ status: "pass" }],
    }],
  };
}

async function run() {
  const tools = await loadToolModules();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
  for (const tool of tools) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.inputSchema?.type, "object");
    assert.equal(typeof tool.handler, "function");
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-mcp-selftest-"));
  const previousRoot = process.env.SMA_ROOT;
  try {
    await mkdir(path.join(root, "scans/all-projects"), { recursive: true });
    await mkdir(path.join(root, "wiki"), { recursive: true });
    const registry = await fixtureRegistry();
    const state = {
      generated_at: registry.generated_at,
      totals: {
        brick_count: registry.bricks.length,
        project_count: registry.projects?.length || 0,
      },
      projects: (registry.projects || []).map((project) => ({ project: project.id || project.project })),
      trust: {},
      build_plane: { curated_builds: [] },
    };
    await writeFile(
      path.join(root, "scans/all-projects/latest.registry.json"),
      `${JSON.stringify(registry, null, 2)}\n`,
    );
    await writeFile(
      path.join(root, "wiki/SMA_STATE.generated.json"),
      `${JSON.stringify(state, null, 2)}\n`,
    );
    process.env.SMA_ROOT = root;

    const search = tools.find((tool) => tool.name === "brick-search");
    const response = await search.handler({ query: "approval", limit: 10 });
    assert.ok(response.results.length > 0, "brick-search should return fixture bricks");
    assert.ok(response.results.every((brick) => Number.isFinite(brick.trust.score)));
    assert.ok(response.results.every((brick) => Object.hasOwn(brick.trust, "health_status")));
    assert.ok(response.results.every((brick) => Object.hasOwn(brick.trust, "clone_readiness")));
  } finally {
    if (previousRoot === undefined) delete process.env.SMA_ROOT;
    else process.env.SMA_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }

  console.log("mcp selftest: ok (8 tools; fixture trust search passed)");
}

run().catch((error) => {
  console.error(`mcp selftest: ${error.stack || error.message}`);
  process.exitCode = 1;
});

