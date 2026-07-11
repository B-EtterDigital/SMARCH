import fs from "node:fs";
import path from "node:path";
import { DashboardApiError, authorizePrincipal, createRequestId, createTelemetrySink, emitTelemetry, validateQuery } from "./core.mjs";

export const EVENTS_SCOPE = "dashboard:events:read";
export const EVENTS_CONTRACT = Object.freeze({ method: "GET", path: "/api/events", idempotent: true, retry: "EventSource reconnects after 3000 ms with Last-Event-ID", heartbeat_ms: 15_000, replay_events: 100 });

export function prepareEventStream(options) {
  authorizePrincipal(options.principal, EVENTS_SCOPE);
  validateQuery(options.query, {});
  const raw = options.lastEventId;
  if (raw === undefined || raw === null || raw === "") return { lastEventId: 0 };
  if (!/^\d+$/.test(String(raw))) throw new DashboardApiError("DASH_API_VALIDATION");
  const lastEventId = Number(raw);
  if (!Number.isSafeInteger(lastEventId) || lastEventId < 0) throw new DashboardApiError("DASH_API_VALIDATION");
  return { lastEventId };
}

export function createEventHub(root, options = {}) {
  const telemetry = createTelemetrySink(options.telemetry);
  const heartbeatMs = options.heartbeatMs || EVENTS_CONTRACT.heartbeat_ms;
  const clients = new Set();
  const watchers = [];
  const history = [];
  let debounceTimer;
  let heartbeatTimer;
  let sequence = 0;

  const writeEvent = (response, event) => response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  const publish = (type, context = {}) => {
    const event = { id: ++sequence, type, data: { type, changed_at: new Date().toISOString(), ...context } };
    history.push(event);
    if (history.length > EVENTS_CONTRACT.replay_events) history.shift();
    for (const client of clients) writeEvent(client.response, event);
    return event;
  };
  const broadcast = (type) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => publish(type), 100);
    debounceTimer.unref?.();
  };
  for (const [directory, type] of [[path.join(root, "registry"), "registry"], [path.join(root, ".smarch", "agent-context"), "conflicts"], [path.join(root, "graphify-out", "modules"), "graph"]]) {
    try {
      const watcher = fs.watch(directory, { persistent: false }, (_event, file) => {
        if (type !== "registry" || String(file || "").includes("lease")) broadcast(type === "registry" ? "leases" : type);
      });
      watcher.on("error", (error) => emitTelemetry(telemetry, { event: "dashboard_sse_watcher_failed", area: "dashboard.api.events", severity: "error", code: "DASH_API_STORAGE", message: error.message }));
      watchers.push(watcher);
    } catch (error) {
      if (error?.code !== "ENOENT") emitTelemetry(telemetry, { event: "dashboard_sse_watcher_failed", area: "dashboard.api.events", severity: "error", code: "DASH_API_STORAGE", message: error instanceof Error ? error.message : String(error) });
    }
  }
  heartbeatTimer = setInterval(() => {
    const timestamp = Date.now();
    for (const client of clients) client.response.write(`: heartbeat ${timestamp}\n\n`);
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  return {
    add(req, res, context) {
      const requestId = context.requestId || createRequestId();
      const prepared = prepareEventStream(context);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      res.write("retry: 3000\n\n");
      for (const event of history.filter((candidate) => candidate.id > prepared.lastEventId)) writeEvent(res, event);
      const client = { response: res, requestId };
      clients.add(client);
      const ready = publish("ready", { request_id: requestId, resumed_after: prepared.lastEventId });
      emitTelemetry(telemetry, { event: "dashboard_sse_connected", area: "dashboard.api.events", severity: "info", request_id: requestId, subject: context.principal.subject, last_event_id: prepared.lastEventId, ready_event_id: ready.id });
      req.on("close", () => {
        clients.delete(client);
        emitTelemetry(telemetry, { event: "dashboard_sse_disconnected", area: "dashboard.api.events", severity: "info", request_id: requestId });
      });
    },
    publish,
    close() {
      clearTimeout(debounceTimer);
      clearInterval(heartbeatTimer);
      for (const watcher of watchers) watcher.close();
      for (const client of clients) client.response.end();
      clients.clear();
    }
  };
}
