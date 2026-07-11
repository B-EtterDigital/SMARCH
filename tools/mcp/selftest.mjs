#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { executeTool } from "./contract.mjs";
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
    path.join(toolsDirectory, "sma-clone.ts"),
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

async function assertCode(promise, code) {
  await assert.rejects(promise, (error) => {
    const structured = /** @type {{ code?: string }} */ (error);
    assert.equal(structured?.code, code);
    return true;
  });
}

async function assertP95UnderBudget(label, operation, samples = 10, budgetMs = 500) {
  const durations = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    await operation();
    durations.push(performance.now() - started);
  }
  durations.sort((left, right) => left - right);
  const p95 = durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)];
  assert.ok(p95 < budgetMs, `${label} P95 was ${p95.toFixed(1)}ms (budget ${budgetMs}ms)`);
}

async function assertStdioIntegration(root) {
  const telemetry = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(repoRoot, "tools/mcp/server.mjs")],
    env: { ...process.env, SMA_ROOT: root },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => telemetry.push(String(chunk)));
  const client = new Client({ name: "smarch-mcp-selftest", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
    for (const toolName of [
      "brick-get",
      "brick-search",
      "brick-trust",
      "build-list",
      "registry-doctor",
      "registry-why-blocked",
      "server-card",
    ]) {
      assert.equal(
        listed.tools.find((tool) => tool.name === toolName)?.annotations?.readOnlyHint,
        true,
        `${toolName} must advertise read-only authorization`,
      );
    }

    const search = await client.callTool({
      name: "brick-search",
      arguments: { query: "approval", limit: 1 },
    });
    assert.equal(search.isError, undefined);
    assert.equal(JSON.parse(search.content[0].text).count, 1);
    const brickId = JSON.parse(search.content[0].text).results[0].id;
    const brick = await client.callTool({ name: "brick-get", arguments: { brick: brickId } });
    assert.equal(JSON.parse(brick.content[0].text).id, brickId);
    const trust = await client.callTool({ name: "brick-trust", arguments: { brick: brickId } });
    assert.equal(JSON.parse(trust.content[0].text).brick, brickId);
    const builds = await client.callTool({ name: "build-list", arguments: { limit: 1 } });
    assert.equal(JSON.parse(builds.content[0].text).count, 1);

    const doctor = await client.callTool({ name: "registry-doctor", arguments: {} });
    assert.equal(doctor.isError, undefined);
    assert.equal(JSON.parse(doctor.content[0].text).healthy, true);

    const registryPath = path.join(root, "scans/all-projects/latest.registry.json");
    const hiddenRegistryPath = `${registryPath}.failure-injection`;
    await rename(registryPath, hiddenRegistryPath);
    try {
      for (const request of [
        { name: "brick-get", arguments: { brick: brickId } },
        { name: "brick-search", arguments: {} },
        { name: "brick-trust", arguments: { brick: brickId } },
        { name: "build-list", arguments: {} },
        { name: "registry-doctor", arguments: {} },
      ]) {
        const missing = await client.callTool(request);
        assert.equal(missing.isError, true);
        assert.equal(JSON.parse(missing.content[0].text).error.code, "MCP_REGISTRY_MISSING");
      }
    } finally {
      await rename(hiddenRegistryPath, registryPath);
    }

    const missingBrick = await client.callTool({
      name: "brick-get",
      arguments: { brick: "does-not-exist" },
    });
    assert.equal(missingBrick.isError, true);
    assert.equal(JSON.parse(missingBrick.content[0].text).error.code, "MCP_BRICK_NOT_FOUND");

    const blocked = await client.callTool({
      name: "registry-why-blocked",
      arguments: { query: "does-not-exist", type: "brick" },
    });
    assert.equal(blocked.isError, true);
    assert.equal(JSON.parse(blocked.content[0].text).error.code, "MCP_TARGET_NOT_FOUND");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const event = telemetry
      .join("")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === "tool_failed" && entry.code === "MCP_TARGET_NOT_FOUND");
    assert.equal(event?.area, "mcp:registry-why-blocked");
    assert.equal(event?.severity, "error");
    assert.equal(event?.code, "MCP_TARGET_NOT_FOUND");
    const brickEvent = telemetry
      .join("")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === "tool_failed" && entry.code === "MCP_BRICK_NOT_FOUND");
    assert.equal(brickEvent?.area, "mcp:brick-get");
    assert.equal(brickEvent?.severity, "error");
  } finally {
    await client.close();
  }
}

async function run() {
  const tools = await loadToolModules();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), EXPECTED_TOOLS);
  for (const tool of tools) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.inputSchema?.type, "object");
    assert.equal(typeof tool.handler, "function");
  }
  const apiDocs = await readFile(path.resolve(repoRoot, "docs/MCP_SERVER.md"), "utf8");
  for (const toolName of [
    "brick-get",
    "brick-search",
    "brick-trust",
    "build-list",
    "registry-doctor",
    "registry-why-blocked",
    "release-install",
    "server-card",
  ]) {
    assert.ok(apiDocs.includes(`| \`${toolName}\` |`), `docs missing ${toolName}`);
  }
  for (const errorCode of [
    "MCP_INVALID_INPUT",
    "MCP_BRICK_NOT_FOUND",
    "MCP_TARGET_NOT_FOUND",
    "MCP_REGISTRY_MISSING",
    "MCP_RELEASE_INSTALL_REFUSED",
    "MCP_TIMEOUT",
    "MCP_INTERNAL_ERROR",
  ]) {
    assert.match(apiDocs, new RegExp(`\\b${errorCode}\\b`));
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
      build_plane: {
        curated_builds: [{
          build_id: "acme-cms.starter",
          project: "acme-cms",
          readiness_score: 94,
          installable: true,
        }],
      },
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
    assert.equal(response.results.length, 1, "brick-search must honor its bounded limit");

    const brickGet = tools.find((tool) => tool.name === "brick-get");
    const brickTrust = tools.find((tool) => tool.name === "brick-trust");
    const buildList = tools.find((tool) => tool.name === "build-list");
    const brickId = registry.bricks[0].id;
    assert.equal((await brickGet.handler({ brick: brickId })).id, brickId);
    assert.equal((await brickTrust.handler({ brick: brickId })).brick, brickId);
    assert.equal((await buildList.handler({ project: "acme-cms", limit: 1 })).count, 1);
    assert.deepEqual(
      await brickGet.handler({ brick: brickId }),
      await brickGet.handler({ brick: brickId }),
      "duplicate read-only delivery must be idempotent",
    );
    await assertCode(brickGet.handler({ brick: "does-not-exist" }), "MCP_BRICK_NOT_FOUND");
    await assertCode(brickTrust.handler({ brick: "does-not-exist" }), "MCP_BRICK_NOT_FOUND");

    const selected = Object.fromEntries(tools
      .filter((tool) => [
        "brick-get",
        "brick-search",
        "brick-trust",
        "build-list",
        "registry-doctor",
        "registry-why-blocked",
        "release-install",
        "server-card",
      ].includes(tool.name))
      .map((tool) => [tool.name, tool]));
    for (const tool of Object.values(selected)) {
      assert.equal(tool.authorization?.boundary, "stdio-parent-process");
      assert.equal(typeof tool.authorization?.required_capability, "string");
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean");
      assert.equal(Number.isFinite(tool.timeoutMs), true);
    }
    assert.equal(selected["release-install"].authorization.effect, "filesystem-write");
    assert.equal(selected["release-install"].authorization.enforcement, "target-containment");
    assert.equal(selected["release-install"].annotations.destructiveHint, true);
    for (const toolName of [
      "brick-get",
      "brick-search",
      "brick-trust",
      "build-list",
      "registry-doctor",
      "registry-why-blocked",
      "server-card",
    ]) {
      assert.equal(selected[toolName].authorization.effect, "read");
      assert.equal(selected[toolName].annotations.readOnlyHint, true);
    }

    for (const tool of Object.values(selected)) {
      for (const malformed of [null, [], "not-an-object", 42, true, { unexpected: true }]) {
        await assertCode(tool.handler(malformed), "MCP_INVALID_INPUT");
      }
    }
    await assertCode(
      selected["registry-why-blocked"].handler({ query: "x", type: "unknown" }),
      "MCP_INVALID_INPUT",
    );
    await assertCode(
      selected["release-install"].handler({ brick: "x", version: "1", target: root, write: "yes" }),
      "MCP_INVALID_INPUT",
    );
    await assertCode(selected["brick-get"].handler({ brick: "" }), "MCP_INVALID_INPUT");
    await assertCode(selected["brick-search"].handler({ limit: 0 }), "MCP_INVALID_INPUT");
    await assertCode(selected["brick-search"].handler({ query: 42 }), "MCP_INVALID_INPUT");
    await assertCode(selected["brick-trust"].handler({ brick: "" }), "MCP_INVALID_INPUT");
    await assertCode(selected["build-list"].handler({ limit: 101 }), "MCP_INVALID_INPUT");
    await assertCode(executeTool({
      name: "timeout-fixture",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      args: {},
      timeoutMs: 10,
      operation: async () => new Promise(() => {}),
    }), "MCP_TIMEOUT");
    await assertCode(executeTool({
      name: "internal-error-fixture",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      args: {},
      operation: async () => { throw new Error("private dependency detail"); },
    }), "MCP_INTERNAL_ERROR");

    await assertP95UnderBudget("brick-get", () => selected["brick-get"].handler({ brick: brickId }));
    await assertP95UnderBudget("brick-search", () => selected["brick-search"].handler({ query: "approval" }));
    await assertP95UnderBudget("brick-trust", () => selected["brick-trust"].handler({ brick: brickId }));
    await assertP95UnderBudget("build-list", () => selected["build-list"].handler({ limit: 1 }));
    await assertP95UnderBudget("registry-doctor", () => selected["registry-doctor"].handler({}));
    await assertP95UnderBudget(
      "registry-why-blocked",
      () => selected["registry-why-blocked"].handler({
        query: registry.bricks[0].id,
        type: "brick",
      }),
    );
    await assertP95UnderBudget("server-card", () => selected["server-card"].handler({}));

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
    await assertP95UnderBudget("release-install dry run", () => install.handler({
      brick: freshBrick,
      version: freshVersion,
      target: freshTarget,
      write: false,
    }), 5);
    await assertStdioIntegration(root);
    const cli = spawnSync(process.execPath, [
      path.resolve(repoRoot, "tools/sma-store.ts"),
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

  console.log("mcp selftest: ok (8 tools; strict contracts, auth declarations, typed failures, <500ms fixture P95, stdio, containment, and install passed)");
}

run().catch((error) => {
  console.error(`mcp selftest: ${error.stack || error.message}`);
  process.exitCode = 1;
});
