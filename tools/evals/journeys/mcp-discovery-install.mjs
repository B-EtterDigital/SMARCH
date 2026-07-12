#!/usr/bin/env node
/**
 * Journey: MCP discovery install
 * Entry state: a generated fixture portfolio, scanned registry, and isolated MCP root.
 * Steps: load the production MCP tool registry; discover Activity Feed with brick-search;
 * install its published fixture release through release-install into a fresh target.
 * Success signal: mcp_discovery_install_success_total / mcp_discovery_install_attempt_total
 * >= 0.99 over 15 minutes; alert below 0.97 or on any write outside the target root.
 * Failure branches: an unmatched discovery query returns zero results; a release artifact
 * using path traversal is refused with MCP_RELEASE_INSTALL_REFUSED before clone execution.
 */

import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { assert, fs, parseJourneyArgs, path, runNode, runSelftest, withTempRoot } from "./_helpers.mjs";
import { loadToolModules } from "../../mcp/server.mjs";
import { handler as installRelease } from "../../mcp/tools/release-install.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE_GEN = path.join(REPO_ROOT, "tools", "evals", "fixtures", "gen.mjs");
const SCAN = path.join(REPO_ROOT, "tools", "sma-scan.ts");
const BUDGET_MS = 8_000;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} error */
function isUnverifiedPayloadRefusal(error) {
  if (!isRecord(error) || !isRecord(error.details)) return false;
  return error.code === "MCP_RELEASE_INSTALL_REFUSED"
    && error.details.reason === "release-content-hash-invalid";
}

/** @param {string} root @param {string} brick @param {string} version @param {string} artifactPath */
async function writeRelease(root, brick, version, artifactPath) {
  const directory = path.join(root, "releases", brick);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${version}.json`), `${JSON.stringify({
    release: { artifact_id: brick, version, status: "published" },
    content: {
      included_paths: [artifactPath],
      artifacts: [{ path: artifactPath, kind: "file", sha256: "a".repeat(64) }],
    },
  }, null, 2)}\n`);
}

/** @param {crypto.BinaryLike} value */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** @param {string} root @param {string} brick @param {string} version @param {string} artifactPath @param {string} payload */
async function writeVerifiedRelease(root, brick, version, artifactPath, payload) {
  const manifest = `${JSON.stringify({
    schema_version: "1.0.0",
    brick: { id: brick, version },
    source: { paths: [artifactPath], project: "journey-fixture" },
    semantics: { purpose: "MCP discovery install journey" },
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
  await fs.mkdir(path.join(snapshotRoot, "payload", path.dirname(artifactPath)), { recursive: true });
  await fs.writeFile(path.join(snapshotRoot, "manifest.json"), manifest);
  await fs.writeFile(path.join(snapshotRoot, "payload", artifactPath), payload);
  await fs.writeFile(path.join(snapshotRoot, "snapshot.json"), `${JSON.stringify({
    ...descriptor,
    seal: { algorithm: "sha256", value: sha256(JSON.stringify(descriptor)) },
  }, null, 2)}\n`);
  const releaseDirectory = path.join(root, "releases", brick);
  await fs.mkdir(releaseDirectory, { recursive: true });
  await fs.writeFile(path.join(releaseDirectory, `${version}.json`), `${JSON.stringify({
    release: { artifact_id: brick, version, status: "published", content_hash: contentHash },
    content: { included_paths: [artifactPath], artifacts: descriptor.artifacts },
  }, null, 2)}\n`);
}

export async function runJourney() {
  return withTempRoot("smarch-mcp-journey-", async (root) => {
    const portfolio = path.join(root, "fixture-portfolio");
    const registryDirectory = path.join(root, "scans", "all-projects");
    const registryPath = path.join(registryDirectory, "latest.registry.json");
    const env = { ...process.env, CI: "1", NO_COLOR: "1", SMA_ROOT: root };
    await fs.mkdir(registryDirectory, { recursive: true });
    runNode(FIXTURE_GEN, ["--out", portfolio], { cwd: REPO_ROOT, env, label: "fixture generation" });
    runNode(SCAN, ["--root", portfolio, "--out", registryPath], {
      cwd: REPO_ROOT, env, timeoutMs: 10_000, label: "fixture scan",
    });

    const tools = await loadToolModules();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.ok(byName.has("brick-search"));
    assert.ok(byName.has("release-install"));
    const previousRoot = process.env.SMA_ROOT;
    process.env.SMA_ROOT = root;
    try {
      const searchTool = byName.get("brick-search");
      const releaseTool = byName.get("release-install");
      assert(searchTool, "brick-search tool must be loaded");
      assert(releaseTool, "release-install tool must be loaded");
      const search = await searchTool.handler({ query: "activity feed", limit: 1 });
      assert(isRecord(search) && typeof search.count === "number" && Array.isArray(search.results));
      assert.equal(search.count, 1);
      const firstResult = search.results[0];
      assert(isRecord(firstResult));
      assert.equal(firstResult.id, "acme-desktop.activity-feed");
      const noMatch = await searchTool.handler({ query: "no-such-journey-brick-zzzz", limit: 1 });
      assert(isRecord(noMatch) && typeof noMatch.count === "number");
      assert.equal(noMatch.count, 0);

      await fs.mkdir(path.join(root, "tools"), { recursive: true });
      await fs.cp(path.join(REPO_ROOT, "tools", "lib"), path.join(root, "tools", "lib"), { recursive: true });
      await fs.copyFile(path.join(REPO_ROOT, "tools", "sma-clone.ts"), path.join(root, "tools", "sma-clone.ts"));
      const brick = "acme-desktop.activity-feed";
      const version = "1.0.0";
      await fs.mkdir(path.join(root, "registry"), { recursive: true });
      await fs.writeFile(path.join(root, "registry", "license-ledger.generated.json"), `${JSON.stringify({
        licenses: [{
          brick_id: brick,
          project: "acme-desktop",
          spdx: "MIT",
          license_class: "permissive",
          openness: "open",
          visibility: "community",
          attribution_required: true,
          source_of_truth: "journey-fixture",
        }],
      }, null, 2)}\n`);
      const artifactPath = "src/modules/activity-feed/index.mjs";
      await writeVerifiedRelease(
        root,
        brick,
        version,
        artifactPath,
        await fs.readFile(path.join(portfolio, "acme-desktop", artifactPath), "utf8"),
      );
      const target = path.join(root, "target-project");
      let installed;
      try {
        installed = await installRelease({ brick, version, target, write: true });
      } catch (error) {
        throw error instanceof Error && error.cause ? error.cause : error;
      }
      assert(isRecord(installed));
      assert.equal(installed.ok, true);
      assert.equal(installed.write, true);
      assert.equal(await fs.readFile(path.join(target, "src", "modules", "activity-feed", "index.mjs"), "utf8"),
        await fs.readFile(path.join(portfolio, "acme-desktop", "src", "modules", "activity-feed", "index.mjs"), "utf8"));

      const malicious = "journey.path-traversal";
      await writeRelease(root, malicious, version, "../outside-target.txt");
      await assert.rejects(
        installRelease({ brick: malicious, version, target, write: true }),
        isUnverifiedPayloadRefusal,
      );
      await assert.rejects(fs.readFile(path.join(root, "outside-target.txt")), { code: "ENOENT" });

      return {
        tools: tools.length,
        discovered: brick,
        installed: true,
        unmatched: 0,
        traversal: "MCP_RELEASE_INSTALL_REFUSED",
      };
    } finally {
      if (previousRoot === undefined) delete process.env.SMA_ROOT;
      else process.env.SMA_ROOT = previousRoot;
    }
  });
}

try {
  const { selftest } = parseJourneyArgs(process.argv.slice(2), "mcp-discovery-install");
  if (selftest) await runSelftest("mcp-discovery-install", runJourney, BUDGET_MS);
  else console.log(`PASS mcp-discovery-install ${JSON.stringify(await runJourney())}`);
} catch (error) {
  console.error(`FAIL mcp-discovery-install: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
