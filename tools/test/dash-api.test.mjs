import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DashboardApiError,
  authenticateReadRequest,
  authenticateRequest,
  authorizePrincipal,
  errorBody,
  loadAuthCredentials,
  readJsonFile,
  runReadHandler,
  validateQuery,
  withTimeout,
} from "../lib/dash-api/core.mjs";
import { GRAPH_SCOPE, handleGraph, loadGraph } from "../lib/dash-api/api-graph.mjs";
import { createEventHub } from "../lib/dash-api/api-events-sse.mjs";
import { LEASES_SCOPE, handleLeases, loadLeases, validateLeasesQuery } from "../lib/dash-api/api-leases.mjs";
import { loadRegistry, validateRegistryQuery } from "../lib/dash-api/api-registry.mjs";

test("dashboard authentication and query validation fail closed with typed errors", () => {
  const credentials = loadAuthCredentials({ authTokens: [
    { subject: "reader", token: "secret", scopes: [LEASES_SCOPE] },
    "legacy-secret",
    /** @type {any} */ ({ subject: "invalid", token: 7 }),
  ] });
  assert.equal(credentials.length, 2);
  assert.deepEqual(authenticateRequest({ authorization: "Bearer secret" }, credentials), { subject: "reader", scopes: [LEASES_SCOPE] });
  assert.throws(() => authenticateRequest({}, credentials), (error) => error instanceof DashboardApiError && error.code === "DASH_API_UNAUTHENTICATED" && error.status === 401);
  assert.throws(() => authenticateRequest({ authorization: "Bearer wrong" }, credentials), { code: "DASH_API_UNAUTHENTICATED" });
  assert.throws(() => authenticateRequest({ authorization: "Bearer secret" }, []), { code: "DASH_API_AUTH_UNAVAILABLE" });
  assert.deepEqual(authenticateReadRequest({}, [], { loopback: true }).subject, "loopback-readonly");
  assert.doesNotThrow(() => authorizePrincipal({ subject: "admin", scopes: ["dashboard:*"] }, GRAPH_SCOPE));
  assert.throws(() => authorizePrincipal({ subject: "reader", scopes: [LEASES_SCOPE] }, GRAPH_SCOPE), { code: "DASH_API_FORBIDDEN" });
  assert.throws(() => loadAuthCredentials({ authTokensJson: "{" }), { code: "DASH_API_AUTH_UNAVAILABLE" });

  assert.deepEqual(validateLeasesQuery(new URLSearchParams()), { limit: 200 });
  assert.deepEqual(validateRegistryQuery(new URLSearchParams("project=one&status=canonical&limit=2")), { project: "one", status: "canonical", limit: 2 });
  assert.throws(() => validateQuery(new URLSearchParams("extra=1"), {}), { code: "DASH_API_VALIDATION" });
  assert.throws(() => validateLeasesQuery(new URLSearchParams("limit=0")), { code: "DASH_API_VALIDATION" });
  assert.throws(() => validateRegistryQuery(new URLSearchParams("status=bogus")), { code: "DASH_API_VALIDATION" });
  assert.deepEqual(errorBody(new DashboardApiError("DASH_API_FORBIDDEN"), "req-1"), { error: { code: "DASH_API_FORBIDDEN", message: "The authenticated principal is not authorized for this operation", request_id: "req-1" } });
});

test("dashboard auth keeps loopback read access separate from every mutation path", () => {
  const credentials = loadAuthCredentials({ authTokens: [{
    subject: "operator",
    token: "operator-secret",
    scopes: [LEASES_SCOPE],
  }] });
  const bearer = { authorization: "Bearer operator-secret" };

  const loopbackRead = authenticateReadRequest({}, [], { loopback: true });
  assert.equal(loopbackRead.subject, "loopback-readonly");
  assert.doesNotThrow(() => authorizePrincipal(loopbackRead, LEASES_SCOPE));
  assert.throws(() => authenticateRequest({}, []), { code: "DASH_API_AUTH_UNAVAILABLE" });

  assert.deepEqual(authenticateReadRequest(bearer, credentials, { loopback: false }), {
    subject: "operator",
    scopes: [LEASES_SCOPE],
  });
  assert.deepEqual(authenticateRequest(bearer, credentials), {
    subject: "operator",
    scopes: [LEASES_SCOPE],
  });
  assert.throws(() => authenticateReadRequest({}, credentials, { loopback: false }), {
    code: "DASH_API_UNAUTHENTICATED",
  });
  assert.throws(() => authenticateRequest({}, credentials), { code: "DASH_API_UNAUTHENTICATED" });
});

test("dashboard SSE frames retry, replay, ready, live events, and resume validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-dash-sse-"));
  /** @type {Array<Record<string, unknown>>} */
  const telemetry = [];
  const hub = createEventHub(root, { heartbeatMs: 60_000, telemetry: (event) => telemetry.push(event) });
  try {
    const replay = hub.publish("registry", { source: "fixture" });
    assert.equal(replay.id, 1);

    const req = new EventEmitter();
    /** @type {string[]} */
    const chunks = [];
    /** @type {{ status: number, values: Record<string, string> } | undefined} */
    let headers;
    let ended = false;
    const res = {
      /** @param {number} status @param {Record<string, string>} values */
      writeHead(status, values) { headers = { status, values }; },
      /** @param {unknown} chunk */
      write(chunk) { chunks.push(String(chunk)); return true; },
      end() { ended = true; },
    };
    hub.add(/** @type {any} */ (req), /** @type {any} */ (res), {
      principal: { subject: "reader", scopes: ["dashboard:events:read"] },
      query: new URLSearchParams(),
      lastEventId: "0",
      requestId: "sse-request",
    });
    const live = hub.publish("graph", { module: "alpha" });
    assert.equal(live.id, 3);

    assert.ok(headers);
    assert.equal(headers.status, 200);
    assert.equal(headers.values["Content-Type"], "text/event-stream");
    const stream = chunks.join("");
    assert.match(stream, /^retry: 3000\n\nid: 1\nevent: registry\ndata: /);
    assert.match(stream, /\n\nid: 2\nevent: ready\ndata: \{"type":"ready","changed_at":"[^"]+","request_id":"sse-request","resumed_after":0\}\n\n/);
    assert.match(stream, /id: 3\nevent: graph\ndata: \{"type":"graph","changed_at":"[^"]+","module":"alpha"\}\n\n$/);
    assert.equal(telemetry[0].event, "dashboard_sse_connected");

    assert.throws(() => hub.add(/** @type {any} */ (new EventEmitter()), /** @type {any} */ (res), {
      principal: { subject: "reader", scopes: ["dashboard:events:read"] },
      query: new URLSearchParams(),
      lastEventId: "1.5",
    }), { code: "DASH_API_VALIDATION" });

    req.emit("close");
    assert.equal(telemetry.at(-1)?.event, "dashboard_sse_disconnected");
    hub.close();
    assert.equal(ended, false, "a disconnected response must not be ended twice during hub close");
  } finally {
    hub.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard read handlers enforce scope, timeout, telemetry, and storage semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-dash-core-"));
  try {
    assert.deepEqual(await readJsonFile(path.join(root, "missing.json"), { empty: true }), { empty: true });
    await writeFile(path.join(root, "bad.json"), "{");
    await assert.rejects(() => readJsonFile(path.join(root, "bad.json"), undefined), { code: "DASH_API_STORAGE" });
    await writeFile(path.join(root, "large.json"), "12345");
    await assert.rejects(() => readJsonFile(path.join(root, "large.json"), null, { maxBytes: 2 }), { code: "DASH_API_STORAGE" });
    await assert.rejects(() => withTimeout(() => new Promise(() => {}), 10), { code: "DASH_API_TIMEOUT" });

    /** @type {Array<Record<string, unknown> & { event?: string }>} */
    const events = [];
    const success = await runReadHandler({
      requestId: "req-success",
      telemetry: (event) => events.push(event),
      area: "dashboard.api.test",
      principal: { subject: "reader", scopes: [LEASES_SCOPE] },
      scope: LEASES_SCOPE,
      query: new URLSearchParams("limit=1"),
      validate: validateLeasesQuery,
      load: async (input) => ({ input }),
    });
    assert.deepEqual(success.data, { input: { limit: 1 } });
    assert.deepEqual(events.map((event) => event.event), ["dashboard_api_request_started", "dashboard_api_authorized", "dashboard_api_request_succeeded"]);

    await assert.rejects(() => runReadHandler({
      telemetry: (event) => events.push(event), area: "dashboard.api.test",
      principal: { subject: "reader", scopes: [] }, scope: LEASES_SCOPE,
      query: new URLSearchParams(), validate: validateLeasesQuery, load: async () => ({}),
    }), { code: "DASH_API_FORBIDDEN" });
    assert.equal(events.at(-1)?.event, "dashboard_api_request_failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dashboard endpoint loaders return bounded, filtered live data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "smarch-dash-loaders-"));
  try {
    await mkdir(path.join(root, "registry"), { recursive: true });
    const now = Date.now();
    await writeFile(path.join(root, "registry", "active-leases.generated.json"), JSON.stringify({
      generated_at: "fixture-time",
      leases: [
        { id: "active", expires_at: new Date(now + 60_000).toISOString() },
        { id: "expired", expires_at: new Date(now - 60_000).toISOString() },
        { id: "later", expires_at: new Date(now + 600_000).toISOString() },
      ],
    }));
    const leases = await loadLeases(root, { limit: 1 });
    assert.equal(leases.stats.active, 2);
    assert.equal(leases.stats.returned, 1);
    assert.equal(leases.stats.truncated, true);
    assert.equal(leases.leases[0].id, "active");

    await writeFile(path.join(root, "registry", "global-modules.generated.json"), JSON.stringify({
      generated_at: "fixture-time", projects: [{ id: "one", brick_count: "2", average_score: "91" }],
      bricks: [
        { id: "a", project: "one", status: "canonical", score: 90, health: { status: "pass" } },
        { id: "b", project: "two", status: "candidate", score: "bad" },
      ],
    }));
    const registry = await loadRegistry(root, { project: "one", status: "canonical", limit: 1 });
    assert.equal(registry.summary.bricks, 2);
    assert.equal(registry.summary.matching, 1);
    assert.equal(registry.projects[0].average_score, 91);

    const graphDir = path.join(root, "graphify-out", "modules", "mod-a", "graphify-out");
    await mkdir(graphDir, { recursive: true });
    await writeFile(path.join(graphDir, "graph.json"), JSON.stringify({ nodes: [{ id: "a" }, { id: "b" }], links: [{ source: "a", target: "b" }] }));
    const graph = await loadGraph(root, { limit: 1 });
    assert.deepEqual(graph.stats, { modules: 1, returned: 1, truncated: false, nodes: 2, links: 1 });

    const handledLease = await handleLeases({ root, principal: { subject: "reader", scopes: [LEASES_SCOPE] }, query: new URLSearchParams("limit=2"), requestId: "leases", telemetry: () => {} });
    assert.equal(/** @type {any} */ (handledLease.data).leases.length, 2);
    const handledGraph = await handleGraph({ root, principal: { subject: "reader", scopes: [GRAPH_SCOPE] }, query: new URLSearchParams(), requestId: "graph", telemetry: () => {} });
    assert.equal(/** @type {any} */ (handledGraph.data).modules[0].id, "mod-a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
