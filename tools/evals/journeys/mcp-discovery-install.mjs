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
import { assert, fs, parseJourneyArgs, path, runNode, runSelftest, withTempRoot } from "./_helpers.mjs";
import { loadToolModules } from "../../mcp/server.mjs";
import { handler as installRelease } from "../../mcp/tools/release-install.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE_GEN = path.join(REPO_ROOT, "tools", "evals", "fixtures", "gen.mjs");
const SCAN = path.join(REPO_ROOT, "tools", "sma-scan.ts");
const BUDGET_MS = 8_000;

/** @param {unknown} error */
function isTraversalRefusal(error) {
  if (!error || typeof error !== "object") return false;
  const candidate = /** @type {{ code?: string, details?: { reason?: string } }} */ (error);
  return candidate.code === "MCP_RELEASE_INSTALL_REFUSED"
    && candidate.details?.reason === "artifact-path-traversal";
}

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
      const search = await byName.get("brick-search").handler({ query: "activity feed", limit: 1 });
      assert.equal(search.count, 1);
      assert.equal(search.results[0].id, "acme-desktop.activity-feed");
      const noMatch = await byName.get("brick-search").handler({ query: "no-such-journey-brick-zzzz", limit: 1 });
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
      await writeRelease(root, brick, version, "src/modules/activity-feed/index.mjs");
      const target = path.join(root, "target-project");
      let installed;
      try {
        installed = await installRelease({ brick, version, target, write: true });
      } catch (error) {
        throw error?.cause || error;
      }
      assert.equal(installed.ok, true);
      assert.equal(installed.write, true);
      assert.equal(await fs.readFile(path.join(target, "src", "modules", "activity-feed", "index.mjs"), "utf8"),
        await fs.readFile(path.join(portfolio, "acme-desktop", "src", "modules", "activity-feed", "index.mjs"), "utf8"));

      const malicious = "journey.path-traversal";
      await writeRelease(root, malicious, version, "../outside-target.txt");
      await assert.rejects(
        installRelease({ brick: malicious, version, target, write: true }),
        isTraversalRefusal,
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
