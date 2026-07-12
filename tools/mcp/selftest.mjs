#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { executeTool } from "./contract.mjs";
import { invokeTool, loadToolModules, parseGrantedCapabilities } from "./server.mjs";

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

/** @typedef {Awaited<ReturnType<typeof loadToolModules>>[number]} ToolModule */
/** @typedef {Record<string, unknown>} JsonObject */
/** @typedef {JsonObject & { id: string, project?: string }} FixtureBrick */
/** @typedef {JsonObject & { id?: string, project?: string }} FixtureProject */
/** @typedef {JsonObject & { generated_at?: string, projects?: FixtureProject[], bricks: FixtureBrick[] }} FixtureRegistry */

/**
 * @param {string} text
 * @returns {unknown}
 */
function parseJson(text) {
  return JSON.parse(text);
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {JsonObject}
 */
function requireObject(value, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return /** @type {JsonObject} */ (value);
}

/**
 * @param {unknown} result
 * @returns {JsonObject}
 */
function parsedTextContent(result) {
  const resultObject = requireObject(result, "tool result");
  assert.ok(Array.isArray(resultObject.content) && resultObject.content.length > 0, "tool result must contain content");
  const first = requireObject(resultObject.content[0], "tool content item");
  assert.equal(first.type, "text");
  assert.equal(typeof first.text, "string");
  return requireObject(parseJson(/** @type {string} */ (first.text)), "tool text payload");
}

/** @param {unknown} result */
function parsedErrorCode(result) {
  const error = requireObject(parsedTextContent(result).error, "tool error payload");
  assert.equal(typeof error.code, "string");
  return /** @type {string} */ (error.code);
}

/**
 * @param {ToolModule[]} tools
 * @param {string} name
 * @returns {ToolModule}
 */
function requireTool(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool: ${name}`);
  return tool;
}

/** @returns {Promise<FixtureRegistry>} */
async function fixtureRegistry() {
  try {
    const parsed = parseJson(await readFile(
      path.resolve(repoRoot, "registry/global-modules.generated.json"),
      "utf8",
    ));
    const registryObject = requireObject(parsed, "fixture registry");
    if (!Array.isArray(registryObject.bricks)) throw new Error("fixture registry bricks must be an array");
    const registry = /** @type {FixtureRegistry} */ (registryObject);
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

/**
 * @param {string} root
 * @param {string} brick
 * @param {string} version
 * @param {string} artifactPath
 */
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

/** @param {crypto.BinaryLike} value */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** @param {string} root @param {string} brick @param {string} version @param {string} artifactPath */
async function writeVerifiedReleaseFixture(root, brick, version, artifactPath) {
  const payload = "installed\n";
  const manifest = `${JSON.stringify({
    schema_version: "1.0.0",
    brick: { id: brick, version },
    source: { paths: [artifactPath], project: "mcp-selftest" },
    semantics: { purpose: "verified release install fixture" },
  }, null, 2)}\n`;
  const contentHash = sha256(`${brick}\0${version}\0${payload}`);
  const descriptor = {
    schema_version: "1.0.0",
    artifact_id: brick,
    version,
    content_hash: contentHash,
    manifest: { path: "manifest.json", sha256: sha256(manifest) },
    artifacts: [{ path: artifactPath, kind: "file", sha256: sha256(payload) }],
  };
  const snapshotRoot = path.join(root, "releases", ".artifacts", contentHash);
  await mkdir(path.join(snapshotRoot, "payload", path.dirname(artifactPath)), { recursive: true });
  await writeFile(path.join(snapshotRoot, "manifest.json"), manifest);
  await writeFile(path.join(snapshotRoot, "payload", artifactPath), payload);
  await writeFile(path.join(snapshotRoot, "snapshot.json"), `${JSON.stringify({
    ...descriptor,
    seal: { algorithm: "sha256", value: sha256(JSON.stringify(descriptor)) },
  }, null, 2)}\n`);

  const releaseDirectory = path.join(root, "releases", brick);
  await mkdir(releaseDirectory, { recursive: true });
  await writeFile(path.join(releaseDirectory, `${version}.json`), `${JSON.stringify({
    release: { artifact_id: brick, version, status: "published", content_hash: contentHash },
    content: { included_paths: [artifactPath], artifacts: descriptor.artifacts },
  }, null, 2)}\n`);
}

/** @param {string} root */
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
    plan_hash: "${"c".repeat(64)}",
  },
  ...(write ? { applied_plan_hash: "${"c".repeat(64)}" } : {}),
}));
`,
  );
}

/**
 * @param {ToolModule} install
 * @param {JsonObject} input
 * @param {string} reason
 */
async function assertInstallRefused(install, input, reason) {
  await assert.rejects(
    install.handler(input),
    (error) => {
      const structured = /** @type {{ code?: string, details?: Record<string, unknown> }} */ (error);
      assert.equal(structured?.code, "MCP_RELEASE_INSTALL_REFUSED");
      assert.equal(structured?.details?.reason, reason);
      return true;
    },
  );
}

/**
 * @param {Promise<unknown>} promise
 * @param {string} code
 */
async function assertCode(promise, code) {
  await assert.rejects(promise, (error) => {
    const structured = /** @type {{ code?: string }} */ (error);
    assert.equal(structured?.code, code);
    return true;
  });
}

/**
 * @param {string} label
 * @param {() => Promise<unknown>} operation
 * @param {number} [samples]
 * @param {number} [budgetMs]
 */
async function assertP95UnderBudget(label, operation, samples = 10, budgetMs = 500) {
  /** @type {number[]} */
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

/** @param {string} root */
async function assertStdioIntegration(root) {
  /** @type {string[]} */
  const telemetry = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(repoRoot, "tools/mcp/server.mjs")],
    env: { ...process.env, SMA_ROOT: root, SMARCH_MCP_CAPABILITIES: "registry:read" },
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
    const searchPayload = parsedTextContent(search);
    assert.equal(searchPayload.count, 1);
    assert.ok(Array.isArray(searchPayload.results) && searchPayload.results.length > 0);
    const brickId = requireObject(searchPayload.results[0], "brick search result").id;
    assert.equal(typeof brickId, "string");
    const brick = await client.callTool({ name: "brick-get", arguments: { brick: brickId } });
    assert.equal(parsedTextContent(brick).id, brickId);
    const trust = await client.callTool({ name: "brick-trust", arguments: { brick: brickId } });
    assert.equal(parsedTextContent(trust).brick, brickId);
    const builds = await client.callTool({ name: "build-list", arguments: { limit: 1 } });
    assert.equal(parsedTextContent(builds).count, 1);

    const doctor = await client.callTool({ name: "registry-doctor", arguments: {} });
    assert.equal(doctor.isError, undefined);
    assert.equal(parsedTextContent(doctor).healthy, true);

    const deniedInstall = await client.callTool({ name: "release-install", arguments: {} });
    assert.equal(deniedInstall.isError, true);
    assert.equal(
      parsedErrorCode(deniedInstall),
      "MCP_CAPABILITY_REQUIRED",
      "stdio server must enforce capability declarations before handler input validation",
    );

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
        assert.equal(parsedErrorCode(missing), "MCP_REGISTRY_MISSING");
      }
    } finally {
      await rename(hiddenRegistryPath, registryPath);
    }

    const missingBrick = await client.callTool({
      name: "brick-get",
      arguments: { brick: "does-not-exist" },
    });
    assert.equal(missingBrick.isError, true);
    assert.equal(parsedErrorCode(missingBrick), "MCP_BRICK_NOT_FOUND");

    const blocked = await client.callTool({
      name: "registry-why-blocked",
      arguments: { query: "does-not-exist", type: "brick" },
    });
    assert.equal(blocked.isError, true);
    assert.equal(parsedErrorCode(blocked), "MCP_TARGET_NOT_FOUND");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const event = telemetry
      .join("")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => requireObject(parseJson(line), "telemetry event"))
      .find((entry) => entry.event === "tool_failed" && entry.code === "MCP_TARGET_NOT_FOUND");
    assert.equal(event?.area, "mcp:registry-why-blocked");
    assert.equal(event?.severity, "error");
    assert.equal(event?.code, "MCP_TARGET_NOT_FOUND");
    const deniedEvent = telemetry
      .join("")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => requireObject(parseJson(line), "telemetry event"))
      .find((entry) => entry.event === "tool_denied" && entry.code === "MCP_CAPABILITY_REQUIRED");
    assert.equal(deniedEvent?.area, "mcp:release-install");
    assert.equal(deniedEvent?.required_capability, "release:install");
    const brickEvent = telemetry
      .join("")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => requireObject(parseJson(line), "telemetry event"))
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
    assert.equal(requireObject(tool.inputSchema, `${tool.name} input schema`).type, "object");
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
    "MCP_CAPABILITY_REQUIRED",
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

    const search = requireTool(tools, "brick-search");
    const response = requireObject(
      await search.handler({ query: "approval", limit: 10 }),
      "brick-search response",
    );
    assert.ok(Array.isArray(response.results), "brick-search results must be an array");
    const responseBricks = response.results.map((brick) => requireObject(brick, "brick-search result"));
    assert.ok(responseBricks.length > 0, "brick-search should return fixture bricks");
    assert.ok(responseBricks.every((brick) => Number.isFinite(Number(requireObject(brick.trust, "brick trust").score))));
    assert.ok(responseBricks.every((brick) => Object.hasOwn(requireObject(brick.trust, "brick trust"), "health_status")));
    assert.ok(responseBricks.every((brick) => Object.hasOwn(requireObject(brick.trust, "brick trust"), "clone_readiness")));
    assert.equal(responseBricks.length, 1, "brick-search must honor its bounded limit");

    const brickGet = requireTool(tools, "brick-get");
    const brickTrust = requireTool(tools, "brick-trust");
    const buildList = requireTool(tools, "build-list");
    const brickId = registry.bricks[0].id;
    assert.equal(requireObject(await brickGet.handler({ brick: brickId }), "brick-get response").id, brickId);
    assert.equal(requireObject(await brickTrust.handler({ brick: brickId }), "brick-trust response").brick, brickId);
    assert.equal(requireObject(await buildList.handler({ project: "acme-cms", limit: 1 }), "build-list response").count, 1);
    assert.deepEqual(
      await brickGet.handler({ brick: brickId }),
      await brickGet.handler({ brick: brickId }),
      "duplicate read-only delivery must be idempotent",
    );
    await assertCode(brickGet.handler({ brick: "does-not-exist" }), "MCP_BRICK_NOT_FOUND");
    await assertCode(brickTrust.handler({ brick: "does-not-exist" }), "MCP_BRICK_NOT_FOUND");

    const selected = /** @type {Record<string, ToolModule>} */ (Object.fromEntries(tools
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
      .map((tool) => [tool.name, tool])));
    for (const tool of Object.values(selected)) {
      assert.equal(tool.authorization?.boundary, "stdio-parent-process");
      assert.equal(typeof tool.authorization?.required_capability, "string");
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean");
      assert.equal(Number.isFinite(tool.timeoutMs), true);
    }
    assert.equal(selected["release-install"].authorization.effect, "filesystem-write");
    assert.equal(selected["release-install"].authorization.enforcement, "target-containment");
    assert.equal(selected["release-install"].annotations?.destructiveHint, true);
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
      assert.equal(selected[toolName].annotations?.readOnlyHint, true);
    }

    assert.deepEqual([...parseGrantedCapabilities(undefined)], ["registry:read"]);
    assert.deepEqual(
      [...parseGrantedCapabilities("release:install, registry:read")].sort(),
      ["registry:read", "release:install"],
    );
    let deniedHandlerInvoked = false;
    await assertCode(invokeTool({
      name: "denied-fixture",
      authorization: { required_capability: "release:install" },
      handler: async () => { deniedHandlerInvoked = true; },
    }, {}, new Set(["registry:read"])), "MCP_CAPABILITY_REQUIRED");
    assert.equal(deniedHandlerInvoked, false, "denied tool handler must not be invoked");

    const serverCard = await selected["server-card"].handler({});
    assert.deepEqual(
      parseJson(await readFile(path.join(repoRoot, ".well-known/mcp/server-card.json"), "utf8")),
      serverCard,
      "published server card must match the in-memory discovery response",
    );
    const cardCheck = spawnSync(process.execPath, [
      path.join(repoRoot, "tools/mcp/generate-server-card.mjs"),
      "--check",
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(cardCheck.status, 0, cardCheck.stderr || cardCheck.stdout);

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

    const install = requireTool(tools, "release-install");
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
      }, "release-content-hash-invalid");
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
    await assertInstallRefused(install, {
      brick: computedAttack.brick,
      version: computedAttack.version,
      target,
      write: true,
    }, "release-content-hash-invalid");
    await assert.rejects(
      readFile(path.join(outside, "computed-escape.txt"), "utf8"),
      { code: "ENOENT" },
    );

    const freshBrick = "fresh-target";
    const freshVersion = "1.0.0";
    const freshTarget = path.join(root, "fresh-target-project");
    await writeVerifiedReleaseFixture(root, freshBrick, freshVersion, "installed.txt");
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
  const message = error instanceof Error ? (error.stack || error.message) : String(error);
  console.error(`mcp selftest: ${message}`);
  process.exitCode = 1;
});
