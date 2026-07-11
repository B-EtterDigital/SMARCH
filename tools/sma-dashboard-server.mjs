#!/usr/bin/env node
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DashboardApiError,
  authenticateReadRequest,
  authenticateRequest,
  authorizePrincipal,
  createEventHub,
  createRequestId,
  createTelemetrySink,
  emitTelemetry,
  errorBody,
  handleConflicts,
  handleGraph,
  handleLeases,
  handleRegistry,
  loadAuthCredentials
} from "./lib/dash-api/index.mjs";

const toolPath = fileURLToPath(import.meta.url);
const defaultRoot = process.env.SMA_ROOT ? path.resolve(process.env.SMA_ROOT) : path.resolve(path.dirname(toolPath), "..");

export function parseArgs(argv) {
  const options = { root: defaultRoot, host: "127.0.0.1", port: 4777, selftest: false, unsafeMutations: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--root" && next) { options.root = path.resolve(next); index += 1; }
    else if (value === "--host" && next) { options.host = next; index += 1; }
    else if (value === "--port" && next) { options.port = Number(next); index += 1; }
    else if (value === "--selftest") options.selftest = true;
    else if (value === "--unsafe-mutations") options.unsafeMutations = true;
  }
  return options;
}

function send(res, status, body, type = "text/plain; charset=utf-8", method = "GET", headers = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
  res.end(method === "HEAD" ? undefined : body);
}

function sendJson(res, status, value, method, headers) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8", method, headers);
}

function contentType(filePath) {
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".map": "application/json; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
  return types[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isLoopbackAddress(address) {
  const normalized = String(address || "").toLowerCase();
  if (normalized === "::1") return true;
  const ipv4 = normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
  return ipv4.split(".")[0] === "127";
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("request body exceeds 64 KiB");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function structuredClientError(value) {
  const stackHead = String(value.stack || "").split("\n").slice(0, 2).join(" | ");
  return {
    event: "dashboard_client_error",
    area: String(value.area || "dashboard.client").slice(0, 120),
    severity: value.severity === "fatal" ? "fatal" : "error",
    message: String(value.message || "Unknown client error").slice(0, 1_000),
    stack_head: stackHead.slice(0, 1_000)
  };
}

async function serveSpa(res, root, requestUrl, method) {
  const dist = path.join(root, "web", "dist");
  let requested = decodeURIComponent(requestUrl.pathname);
  if (requested === "/") requested = "/index.html";
  let target = path.resolve(dist, `.${requested}`);
  if (!inside(dist, target)) { send(res, 403, "Forbidden", undefined, method); return; }
  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) target = path.join(target, "index.html");
    send(res, 200, await fsp.readFile(target), contentType(target), method);
  } catch {
    if (path.extname(requested)) { send(res, 404, "Not found", undefined, method); return; }
    const index = path.join(dist, "index.html");
    try { send(res, 200, await fsp.readFile(index), contentType(index), method); }
    catch { send(res, 503, "Dashboard SPA is not built. Run npm run build in web/.", undefined, method); }
  }
}

export function createDashboardServer(options) {
  const root = path.resolve(options.root || defaultRoot);
  const telemetry = createTelemetrySink(options.telemetry);
  const credentials = loadAuthCredentials(options);
  const events = createEventHub(root, { telemetry, heartbeatMs: options.heartbeatMs });
  const handlers = new Map([
    ["/api/leases", handleLeases],
    ["/api/conflicts", handleConflicts],
    ["/api/registry", handleRegistry],
    ["/api/graph", handleGraph]
  ]);
  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const requestId = createRequestId();
    try {
      const address = server.address();
      const loopback = Boolean(address && typeof address !== "string" && isLoopbackAddress(address.address));
      if (requestUrl.pathname.startsWith("/api/") && !loopback && credentials.length === 0) {
        authenticateRequest(req.headers, credentials);
      }
      if (handlers.has(requestUrl.pathname)) {
        if (req.method !== "GET") throw new DashboardApiError("DASH_API_METHOD_NOT_ALLOWED");
        const principal = authenticateReadRequest(req.headers, credentials, { loopback });
        const result = await handlers.get(requestUrl.pathname)({ root, principal, query: requestUrl.searchParams, requestId, telemetry });
        return sendJson(res, 200, result.data, undefined, { "X-Request-ID": result.requestId });
      }
      if (requestUrl.pathname === "/api/events") {
        if (req.method !== "GET") throw new DashboardApiError("DASH_API_METHOD_NOT_ALLOWED");
        const principal = authenticateReadRequest(req.headers, credentials, { loopback });
        events.add(req, res, { principal, query: requestUrl.searchParams, lastEventId: req.headers["last-event-id"], requestId });
        return;
      }
      if (req.method === "POST" && requestUrl.pathname === "/api/client-errors") {
        const principal = authenticateRequest(req.headers, credentials);
        authorizePrincipal(principal, "dashboard:telemetry:write");
        const body = await readBody(req);
        emitTelemetry(telemetry, { ...structuredClientError(body), request_id: requestId, subject: principal.subject });
        sendJson(res, 202, { accepted: true }, undefined, { "X-Request-ID": requestId });
        return;
      }
      if (requestUrl.pathname.startsWith("/api/")) throw new DashboardApiError("DASH_API_NOT_FOUND");
      if (req.method === "GET" || req.method === "HEAD") { await serveSpa(res, root, requestUrl, req.method); return; }
      send(res, 405, "Method not allowed");
    } catch (error) {
      const typed = error instanceof DashboardApiError ? error : new DashboardApiError("DASH_API_INTERNAL", { cause: error });
      emitTelemetry(telemetry, { event: "dashboard_api_transport_failed", area: "dashboard.api.transport", severity: "error", request_id: requestId, code: typed.code });
      const headers = { "X-Request-ID": requestId };
      if (typed.status === 401) headers["WWW-Authenticate"] = "Bearer";
      sendJson(res, typed.status, errorBody(typed, requestId), undefined, headers);
    }
  });
  server.on("close", () => events.close());
  return server;
}

async function writeFixture(root) {
  await fsp.mkdir(path.join(root, "registry"), { recursive: true });
  await fsp.mkdir(path.join(root, ".smarch", "agent-context"), { recursive: true });
  await fsp.mkdir(path.join(root, "graphify-out", "modules", "dash", "graphify-out"), { recursive: true });
  await fsp.mkdir(path.join(root, "web", "dist"), { recursive: true });
  const now = Date.now();
  await fsp.writeFile(path.join(root, "registry", "active-leases.generated.json"), JSON.stringify({ schema_version: "1.0.0", generated_at: new Date().toISOString(), leases: [{ lease_id: "fixture-lease", resource_kind: "brick", resource_id: "dash", agent_id: "fixture-agent", acquired_at: new Date(now - 1_000).toISOString(), expires_at: new Date(now + 600_000).toISOString(), intent: "fixture dashboard work" }] }));
  await fsp.writeFile(path.join(root, "registry", "global-modules.generated.json"), JSON.stringify({ generated_at: new Date().toISOString(), projects: [{ id: "fixture", brick_count: 1, average_score: 100 }], count: 1, bricks: [{ id: "fixture.dash", project: "fixture", status: "canonical", score: 100, health: { status: "ok" } }] }));
  await fsp.writeFile(path.join(root, ".smarch", "agent-context", "dash.ndjson"), `${JSON.stringify({ event_id: "fixture-conflict", kind: "conflict_detected", timestamp: new Date().toISOString(), project: "fixture", brick_id: "dash", actor_id: "agent-a", decision_rationale: "holder_agent=agent-b", intent: "fixture collision" })}\n`);
  await fsp.writeFile(path.join(root, "graphify-out", "modules", "dash", "graphify-out", "graph.json"), JSON.stringify({ nodes: [{ id: "dash" }], links: [] }));
  await fsp.writeFile(
    path.join(root, "web", "dist", "index.html"),
    '<!doctype html><html><head><title>SMARCH Blueprint Ledger</title></head><body><main id="app">SMARCH Blueprint Ledger</main></body></html>'
  );
}

async function assertServedSpaAndLiveData(base, headers) {
  const spa = await fetch(`${base}/`);
  if (!spa.ok || !/SMARCH Blueprint Ledger/.test(await spa.text())) {
    throw new Error("selftest: served SPA shell was unavailable from the live-data origin");
  }

  const expected = new Map([
    ["leases", ["leases", "fixture-lease"]],
    ["registry", ["bricks", "fixture.dash"]],
    ["conflicts", ["conflicts", "fixture-conflict"]]
  ]);
  for (const [endpoint, [collection, fixtureId]] of expected) {
    const response = await fetch(`${base}/api/${endpoint}`, { headers });
    if (!response.ok) throw new Error(`selftest: ${endpoint} returned ${response.status}`);
    const body = await response.json();
    if (!Array.isArray(body[collection]) || !JSON.stringify(body[collection]).includes(fixtureId)) {
      throw new Error(`selftest: ${endpoint} did not expose fixture live data to the served SPA`);
    }
  }
}

async function runSelftest() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sma-dashboard-"));
  await writeFixture(root);
  const telemetry = [];
  const readerToken = "fixture-reader-token";
  const limitedToken = "fixture-limited-token";
  const readerHeaders = { Authorization: `Bearer ${readerToken}` };
  const authTokens = [
    { subject: "fixture-reader", token: readerToken, scopes: ["dashboard:leases:read", "dashboard:conflicts:read", "dashboard:registry:read", "dashboard:graph:read", "dashboard:events:read", "dashboard:telemetry:write"] },
    { subject: "fixture-limited", token: limitedToken, scopes: ["dashboard:leases:read"] }
  ];
  const loopbackOpenServer = createDashboardServer({ root, telemetry: () => {}, authTokens: [] });
  await new Promise((resolve) => loopbackOpenServer.listen(0, "127.0.0.1", () => resolve()));
  const loopbackOpenAddress = loopbackOpenServer.address();
  if (!loopbackOpenAddress || typeof loopbackOpenAddress === "string") throw new Error("selftest: loopback-open server did not bind a TCP address");
  try {
    const response = await fetch(`http://127.0.0.1:${loopbackOpenAddress.port}/api/leases`);
    if (response.status !== 200 || !Array.isArray((await response.json()).leases)) throw new Error("selftest: loopback read without auth configuration was not open");
  } finally {
    await new Promise((resolve) => loopbackOpenServer.close(resolve));
  }

  const authenticatedRemoteServer = createDashboardServer({ root, telemetry: () => {}, authTokens });
  await new Promise((resolve) => authenticatedRemoteServer.listen(0, "0.0.0.0", () => resolve()));
  const authenticatedRemoteAddress = authenticatedRemoteServer.address();
  if (!authenticatedRemoteAddress || typeof authenticatedRemoteAddress === "string") throw new Error("selftest: authenticated non-loopback server did not bind a TCP address");
  const authenticatedRemoteBase = `http://127.0.0.1:${authenticatedRemoteAddress.port}`;
  try {
    const unauthenticated = await fetch(`${authenticatedRemoteBase}/api/leases`);
    if (unauthenticated.status !== 401 || (await unauthenticated.json()).error?.code !== "DASH_API_UNAUTHENTICATED") throw new Error("selftest: non-loopback read did not require Bearer authentication");
    const underprivileged = await fetch(`${authenticatedRemoteBase}/api/conflicts`, { headers: { Authorization: `Bearer ${limitedToken}` } });
    if (underprivileged.status !== 403 || (await underprivileged.json()).error?.code !== "DASH_API_FORBIDDEN") throw new Error("selftest: non-loopback under-privileged request was not rejected");
    const authenticated = await fetch(`${authenticatedRemoteBase}/api/leases`, { headers: readerHeaders });
    if (!authenticated.ok) throw new Error("selftest: authenticated non-loopback read was rejected");
  } finally {
    await new Promise((resolve) => authenticatedRemoteServer.close(resolve));
  }

  const unavailableRemoteServer = createDashboardServer({ root, telemetry: () => {}, authTokens: [] });
  await new Promise((resolve) => unavailableRemoteServer.listen(0, "0.0.0.0", () => resolve()));
  const unavailableRemoteAddress = unavailableRemoteServer.address();
  if (!unavailableRemoteAddress || typeof unavailableRemoteAddress === "string") throw new Error("selftest: unauthenticated non-loopback server did not bind a TCP address");
  const unavailableRemoteBase = `http://127.0.0.1:${unavailableRemoteAddress.port}`;
  try {
    const unavailableResponses = [
      await fetch(`${unavailableRemoteBase}/api/leases`),
      await fetch(`${unavailableRemoteBase}/api/client-errors`, { method: "POST", body: "{}" })
    ];
    for (const response of unavailableResponses) {
      if (response.status !== 503 || (await response.json()).error?.code !== "DASH_API_AUTH_UNAVAILABLE") throw new Error("selftest: missing auth configuration on a non-loopback API route did not fail closed");
    }
  } finally {
    await new Promise((resolve) => unavailableRemoteServer.close(resolve));
  }

  const server = createDashboardServer({
    root,
    heartbeatMs: 20,
    telemetry: (event) => telemetry.push(event),
    authTokens
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("selftest: server did not bind a TCP address");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    await assertServedSpaAndLiveData(base, readerHeaders);
    let unavailableCode = "";
    try { authenticateRequest({}, []); } catch (error) { unavailableCode = error?.code; }
    if (unavailableCode !== "DASH_API_AUTH_UNAVAILABLE") throw new Error("selftest: missing authentication configuration did not fail closed");
    const unauthenticated = await fetch(`${base}/api/leases`);
    if (!unauthenticated.ok || !Array.isArray((await unauthenticated.json()).leases)) throw new Error("selftest: configured loopback read was not open");
    const malformed = await fetch(`${base}/api/leases?limit=0`, { headers: readerHeaders });
    if (malformed.status !== 400 || (await malformed.json()).error?.code !== "DASH_API_VALIDATION") throw new Error("selftest: malformed input did not return a validation error");
    const overLimit = await fetch(`${base}/api/leases?limit=501`, { headers: readerHeaders });
    if (overLimit.status !== 400) throw new Error("selftest: result limit boundary was not enforced");
    const boundary = await fetch(`${base}/api/leases?limit=500`, { headers: readerHeaders });
    if (!boundary.ok) throw new Error("selftest: valid result limit boundary was rejected");
    for (const endpoint of ["leases", "conflicts", "registry", "graph"]) {
      const response = await fetch(`${base}/api/${endpoint}`, { headers: readerHeaders });
      if (!response.ok) throw new Error(`selftest: ${endpoint} returned ${response.status}`);
      const body = await response.json();
      if (!body || typeof body !== "object") throw new Error(`selftest: ${endpoint} returned invalid JSON`);
    }
    const duplicateLeft = await (await fetch(`${base}/api/leases`, { headers: readerHeaders })).text();
    const duplicateRight = await (await fetch(`${base}/api/leases`, { headers: readerHeaders })).text();
    if (duplicateLeft !== duplicateRight) throw new Error("selftest: duplicate idempotent read changed state");
    const initialEventId = await new Promise((resolve, reject) => {
      const request = http.get(`${base}/api/events`, { headers: readerHeaders }, (response) => {
        response.setEncoding("utf8");
        const timeout = setTimeout(() => { request.destroy(); reject(new Error("selftest: SSE did not emit ready event within 1s")); }, 1_000);
        response.on("data", (chunk) => {
          const match = String(chunk).match(/id: (\d+)\nevent: ready/);
          if (match) { clearTimeout(timeout); request.destroy(); resolve(Number(match[1])); }
        });
      });
    });
    await fsp.appendFile(path.join(root, "registry", "active-leases.generated.json"), " ");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await new Promise((resolve, reject) => {
      const request = http.get(`${base}/api/events`, { headers: { ...readerHeaders, "Last-Event-ID": String(initialEventId) } }, (response) => {
        response.setEncoding("utf8");
        let content = "";
        const timeout = setTimeout(() => { request.destroy(); reject(new Error("selftest: SSE reconnect did not replay a lease event and heartbeat within 1s")); }, 1_000);
        response.on("data", (chunk) => {
          content += chunk;
          if (content.includes("event: leases") && content.includes(": heartbeat")) { clearTimeout(timeout); request.destroy(); resolve(); }
        });
      });
    });
    const report = await fetch(`${base}/api/client-errors`, { method: "POST", headers: { ...readerHeaders, "Content-Type": "application/json" }, body: JSON.stringify({ area: "fixture.client", severity: "fatal", message: "forced client error", stack: "Error: forced client error\n at fixture" }) });
    if (report.status !== 202 || !telemetry.some((event) => event.area === "fixture.client" && event.severity === "fatal")) throw new Error("selftest: client error did not produce structured telemetry");
    const mutation = await fetch(`${base}/api/scan`, { method: "POST", body: "{}" });
    if (mutation.status !== 404) throw new Error("selftest: unknown mutating API route was exposed");
    const wrongMethod = await fetch(`${base}/api/leases`, { method: "POST", headers: readerHeaders });
    if (wrongMethod.status !== 405 || (await wrongMethod.json()).error?.code !== "DASH_API_METHOD_NOT_ALLOWED") throw new Error("selftest: wrong method did not return a typed error");

    const principal = { subject: "unit-reader", scopes: ["dashboard:registry:read", "dashboard:leases:read"] };
    let timeoutCode = "";
    try {
      await handleRegistry({ root, principal, query: new URLSearchParams(), timeoutMs: 5, telemetry: (event) => telemetry.push(event), load: () => new Promise((resolve) => setTimeout(resolve, 50)) });
    } catch (error) {
      timeoutCode = error?.code;
    }
    if (timeoutCode !== "DASH_API_TIMEOUT") throw new Error("selftest: timeout did not produce a typed error");
    for (const query of [null, {}, [], "", 7]) {
      let code = "";
      try { await handleLeases({ root, principal, query, telemetry: () => {} }); } catch (error) { code = error?.code; }
      if (code !== "DASH_API_VALIDATION") throw new Error("selftest: fuzzed query shape escaped validation");
    }

    const graphPath = path.join(root, "graphify-out", "modules", "dash", "graphify-out", "graph.json");
    const graphFixture = await fsp.readFile(graphPath, "utf8");
    await fsp.writeFile(graphPath, "{");
    const failedStorage = await fetch(`${base}/api/graph`, { headers: readerHeaders });
    await fsp.writeFile(graphPath, graphFixture);
    if (failedStorage.status !== 502 || (await failedStorage.json()).error?.code !== "DASH_API_STORAGE") throw new Error("selftest: storage failure did not produce a typed error");
    if (!telemetry.some((event) => event.event === "dashboard_api_request_failed" && event.code === "DASH_API_STORAGE")) throw new Error("selftest: storage failure was not captured by telemetry");

    const durations = [];
    for (let index = 0; index < 20; index += 1) {
      const startedAt = performance.now();
      const response = await fetch(`${base}/api/${["leases", "conflicts", "registry", "graph"][index % 4]}`, { headers: readerHeaders });
      if (!response.ok) throw new Error(`selftest: perf request returned ${response.status}`);
      await response.arrayBuffer();
      durations.push(performance.now() - startedAt);
    }
    durations.sort((left, right) => left - right);
    const p95 = durations[Math.ceil(durations.length * 0.95) - 1];
    if (p95 >= 500) throw new Error(`selftest: dashboard API P95 ${p95.toFixed(1)}ms exceeds 500ms budget`);
    if (!telemetry.some((event) => event.event === "dashboard_api_authorized")) throw new Error("selftest: privileged API use was not audit logged");
    console.log("sma-dashboard-server selftest passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.unsafeMutations) throw new Error("This dashboard server is read-only; --unsafe-mutations is not supported by the SPA API");
  if (options.selftest) { await runSelftest(); return; }
  const server = createDashboardServer(options);
  server.listen(options.port, options.host, () => {
    console.log(`SMA dashboard server running at http://${options.host}:${options.port}/`);
    console.log(`SMA_ROOT ${options.root}`);
    console.log("Dashboard mode read-only");
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === toolPath) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
