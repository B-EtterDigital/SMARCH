#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

async function writeCloneFixture(root) {
  const toolsDirectory = path.join(root, "tools");
  await mkdir(toolsDirectory, { recursive: true });
  await writeFile(
    path.join(toolsDirectory, "sma-clone.mjs"),
    `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const target = path.resolve(valueAfter("--target"));
const brick = valueAfter("--brick");
const write = args.includes("--write");
const destination = brick === "attack.computed"
  ? path.resolve(target, "../outside-target/computed-escape.txt")
  : path.resolve(target, "installed.txt");

if (write) {
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, "installed\\n");
}

console.log(JSON.stringify({
  dry_run: !write,
  plan: {
    actions: [{ kind: "copy_file", dst: destination }],
    control_plane: {},
  },
}));
`,
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
    await writeCloneFixture(root);
    for (const attack of attacks) {
      await writeReleaseFixture(root, attack.brick, attack.version, attack.artifactPath);
      await assertInstallRefused(install, {
        brick: attack.brick,
        version: attack.version,
        target,
        write: false,
      }, attack.reason, attack.artifactPath);
    }

    const computedAttack = {
      brick: "attack.computed",
      version: "1.0.0",
      artifactPath: "safe.txt",
    };
    await writeReleaseFixture(
      root,
      computedAttack.brick,
      computedAttack.version,
      computedAttack.artifactPath,
    );
    await assert.rejects(
      install.handler({
        brick: computedAttack.brick,
        version: computedAttack.version,
        target,
        write: true,
      }),
      (error) => {
        const structured = /** @type {{ code?: string, details?: Record<string, unknown> }} */ (error);
        assert.equal(structured?.code, "MCP_RELEASE_INSTALL_REFUSED");
        assert.equal(structured?.details?.reason, "write-path-outside-target");
        return true;
      },
    );
    await assert.rejects(
      readFile(path.join(outside, "computed-escape.txt"), "utf8"),
      { code: "ENOENT" },
    );

    const freshBrick = "fresh-target";
    const freshVersion = "1.0.0";
    const freshTarget = path.join(root, "fresh-target-project");
    await writeReleaseFixture(root, freshBrick, freshVersion, "installed.txt");
    const cli = spawnSync(process.execPath, [
      path.resolve(repoRoot, "tools/sma-store.mjs"),
      "install",
      "--brick",
      freshBrick,
      "--version",
      freshVersion,
      "--target",
      freshTarget,
      "--write",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, SMA_ROOT: root },
    });
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    assert.equal(await readFile(path.join(freshTarget, "installed.txt"), "utf8"), "installed\n");
  } finally {
    if (previousRoot === undefined) delete process.env.SMA_ROOT;
    else process.env.SMA_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }

  console.log("mcp selftest: ok (8 tools; fixture trust search, computed-write containment, and fresh-target install passed)");
}

run().catch((error) => {
  console.error(`mcp selftest: ${error.stack || error.message}`);
  process.exitCode = 1;
});
