// Dashboard transport types are derived from the repository schema-types output.
export interface Lease {
  lease_id: string;
  resource_kind: string;
  resource_id: string;
  agent_id: string;
  acquired_at: string;
  expires_at: string;
  intent: string;
  project?: string;
  renewals?: number;
}

export interface LeasesResponse {
  schema_version: "1.0.0";
  generated_at: string;
  leases: Lease[];
  stats: { active: number; expiring_soon: number };
}

export interface Conflict {
  event_id: string;
  timestamp: string;
  project: string;
  brick_id: string;
  agents: string[];
  intent: string;
  status: "open" | "resolved";
}

export interface ConflictsResponse {
  generated_at: string;
  conflicts: Conflict[];
  stats: { open: number; matching: number; returned: number; truncated: boolean };
}

export interface RegistryBrick {
  id: string;
  project: string;
  status: string;
  score: number;
  health_status: string;
  reuse_count?: number;
}

export interface RegistryResponse {
  generated_at: string;
  summary: { bricks: number; canonical: number; projects: number };
  projects: { id: string; brick_count: number; average_score: number }[];
  bricks: RegistryBrick[];
}

export interface ModuleGraph {
  id: string;
  nodes: number;
  links: number;
  updated_at: string | null;
}

export interface GraphResponse {
  generated_at: string;
  stats: { modules: number; nodes: number; links: number };
  modules: ModuleGraph[];
}

export interface DashboardSnapshot {
  leases: LeasesResponse;
  conflicts: ConflictsResponse;
  registry: RegistryResponse;
  graph: GraphResponse;
}

export interface DashboardEvent {
  type: "ready" | "leases" | "conflicts" | "registry" | "graph";
  changed_at: string;
}
