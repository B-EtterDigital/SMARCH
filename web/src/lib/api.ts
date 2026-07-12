import type {
  ConflictsResponse,
  DashboardEvent,
  DashboardSnapshot,
  GraphResponse,
  LeasesResponse,
  RegistryResponse
} from "../schema-types";

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} returned ${String(response.status)}`);
  return response.json() as Promise<T>;
}

export async function fetchSnapshot(signal?: AbortSignal): Promise<DashboardSnapshot> {
  const [leases, conflicts, registry, graph] = await Promise.all([
    getJson<LeasesResponse>("/api/leases", signal),
    getJson<ConflictsResponse>("/api/conflicts", signal),
    getJson<RegistryResponse>("/api/registry", signal),
    getJson<GraphResponse>("/api/graph", signal)
  ]);
  return { leases, conflicts, registry, graph };
}

export function subscribeToDashboardEvents(
  onEvent: (event: DashboardEvent) => void,
  onError: () => void
): () => void {
  const source = new EventSource("/api/events");
  source.onmessage = (event: MessageEvent<string>) => {
    try {
      const parsed: unknown = JSON.parse(event.data);
      onEvent(parsed as DashboardEvent);
    } catch (error) {
      reportClientError("dashboard.sse", "error", error);
    }
  };
  source.onerror = onError;
  return () => { source.close(); };
}

export function reportClientError(area: string, severity: "error" | "fatal", value: unknown): void {
  const error = value instanceof Error ? value : new Error(String(value));
  const body = JSON.stringify({ area, severity, message: error.message, stack: error.stack ?? "" });
  const sendBeacon = (navigator as Partial<Navigator>).sendBeacon;
  if (sendBeacon) {
    sendBeacon.call(navigator, "/api/client-errors", new Blob([body], { type: "application/json" }));
    return;
  }
  void fetch("/api/client-errors", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true
  });
}
