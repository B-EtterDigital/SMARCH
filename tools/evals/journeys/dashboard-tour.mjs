#!/usr/bin/env node
/**
 * Journey: dashboard tour
 * Entry state: an isolated state snapshot and writable wiki directory.
 * Steps: build the real Gen3 dashboard; start the real loopback dashboard server;
 * wait for its listening signal; load the generated page over HTTP.
 * Success signal: dashboard_tour_http_success_total / dashboard_tour_attempt_total
 * >= 0.995 over 15 minutes; alert below 0.98 or when build-to-first-byte exceeds 2s p95.
 * Failure branches: a missing page returns the public 404; mutation without explicit
 * enablement returns the user-visible 403 safety message.
 * TODO(UV-EV-j-dashboard-tour-impl): the guided in-product M3 tour does not exist yet.
 * Extend this contract when that blocking task lands; today this proves build, serve,
 * navigation, missing-route, and safe-mutation behavior without inventing tour UI.
 */

import { fileURLToPath } from "node:url";
import {
  assert, fs, parseJourneyArgs, path, reservePort, runNode, runSelftest,
  spawnNode, waitForExit, waitForOutput, withTempRoot,
} from "./_helpers.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DASHBOARD_BUILD = path.join(REPO_ROOT, "tools", "sma-gen3-dashboard.ts");
const DASHBOARD_SERVER = path.join(REPO_ROOT, "tools", "sma-dashboard-server.ts");
const BUDGET_MS = 12_000;

export async function runJourney() {
  return withTempRoot("smarch-dashboard-journey-", async (root) => {
    const wiki = path.join(root, "wiki");
    const statePath = path.join(wiki, "SMA_STATE.generated.json");
    const outputPath = path.join(wiki, "DASHBOARD.generated.html");
    await fs.mkdir(wiki, { recursive: true });
    await fs.writeFile(statePath, `${JSON.stringify({
      generated_at: "2026-01-15T00:00:00.000Z",
      gen3: {
        context_coverage: { projects_with_logs: 0, total_bricks_with_context: 0, total_context_events: 0, by_project: {} },
        conflicts: { detected_count: 0, resolved_count: 0, open_count: 0 },
        merge_proposals: { open_count: 0, resolved_count: 0 },
      },
    })}\n`);
    const env = { ...process.env, CI: "1", NO_COLOR: "1", SMA_ROOT: root, SMA_DEV_ROOT: root };
    const built = runNode(DASHBOARD_BUILD, [
      "build", "--state", statePath, "--out", outputPath,
      "--no-dirty", "--no-graphs", "--no-goal-progress",
    ], { cwd: REPO_ROOT, env, timeoutMs: 10_000, label: "dashboard build" });
    assert.match(built.stdout, /(?:wrote|unchanged) .*DASHBOARD\.generated\.html/);
    assert.match(await fs.readFile(outputPath, "utf8"), /Sweetspot|Gen3/i);

    const port = await reservePort();
    const child = spawnNode(DASHBOARD_SERVER, [
      "--wiki", wiki, "--scans", path.join(root, "scans"),
      "--allow-root", root, "--host", "127.0.0.1", "--port", String(port),
    ], { cwd: REPO_ROOT, env });
    try {
      await waitForOutput(child, /dashboard server running/i);
      const base = `http://127.0.0.1:${port}`;
      const page = await fetch(`${base}/`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Sweetspot|Gen3/i);

      const missing = await fetch(`${base}/missing-tour-page`);
      assert.equal(missing.status, 404);
      assert.equal(await missing.text(), "Not found");

      const mutation = await fetch(`${base}/api/scan`, { method: "POST" });
      assert.equal(mutation.status, 403);
      const mutationBody = await mutation.json();
      assert.match(mutationBody.error, /mutations are disabled/i);
    } finally {
      child.kill("SIGTERM");
      await waitForExit(child);
    }

    return {
      build: "generated",
      page: 200,
      missing_route: 404,
      mutation_disabled: 403,
      guided_tour: "M3-TODO",
    };
  });
}

try {
  const { selftest } = parseJourneyArgs(process.argv.slice(2), "dashboard-tour");
  if (selftest) await runSelftest("dashboard-tour", runJourney, BUDGET_MS);
  else console.log(`PASS dashboard-tour ${JSON.stringify(await runJourney())}`);
} catch (error) {
  console.error(`FAIL dashboard-tour: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
