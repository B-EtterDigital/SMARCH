#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

async function writeReleaseFixture(root, brick, version, artifactPath) {
  const releaseDirectory = path.join(root, "releases", brick);
  await mkdir(releaseDirectory, { recursive: true });
  await writeFile(
    path.join(releaseDirectory, `${version}.json`),
    `${JSON.stringify({
      release: {
        artifact_id: brick,
        version,
        status: "published",
      },
      content: {
        included_paths: [artifactPath],
        artifacts: [{
          path: artifactPath,
          kind: "file",
          sha256: "a".repeat(64),
        }],
      },
    }, null, 2)}\n`,
  );
}

async function assertInstallRefused(install, input, reason, artifactPath) {
  await assert.rejects(
    install.handler(input),
    (error) => {
      const structured = /** @type {{ code?: string, details?: Record<string, unknown> }} */ (error);
      assert.equal(structured?.code, "MCP_RELEASE_INSTALL_REFUSED");
      assert.equal(structured?.details?.reason, reason);
      assert.equal(structured?.details?.artifact_path, artifactPath);
      return true;
    },
  );
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

    const install = tools.find((tool) => tool.name === "release-install");
    const target = path.join(root, "target-project");
    const outside = path.join(root, "outside-target");
    await mkdir(target, { recursive: true });
    await mkdir(outside, { recursive: true });

    const attacks = [
      {
        brick: "attack.dot-dot",
        version: "1.0.0",
        artifactPath: "../escaped.txt",
        reason: "artifact-path-traversal",
      },
      {
        brick: "attack.absolute",
        version: "1.0.0",
        artifactPath: path.join(outside, "absolute.txt"),
        reason: "artifact-path-absolute",
      },
      {
        brick: "attack.symlink",
        version: "1.0.0",
        artifactPath: "linked/escaped.txt",
        reason: "artifact-symlink-outside-target",
      },
    ];
    await symlink(outside, path.join(target, "linked"), "dir");
    for (const attack of attacks) {
      await writeReleaseFixture(root, attack.brick, attack.version, attack.artifactPath);
      await assertInstallRefused(install, {
        brick: attack.brick,
        version: attack.version,
        target,
        write: false,
      }, attack.reason, attack.artifactPath);
    }
  } finally {
    if (previousRoot === undefined) delete process.env.SMA_ROOT;
    else process.env.SMA_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }

  console.log("mcp selftest: ok (8 tools; fixture trust search and install containment attacks passed)");
}

run().catch((error) => {
  console.error(`mcp selftest: ${error.stack || error.message}`);
  process.exitCode = 1;
});
