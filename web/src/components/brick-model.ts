export type BrickTrust = "candidate" | "verified" | "canonical";
type GateVerdict = "pass" | "fail" | "waived";

export type BrickGate = {
  id: string;
  label: string;
  verdict: GateVerdict;
};

export type BrickRecord = {
  id: string;
  project: string;
  status: string;
  score: number;
  health_status: string;
  reuse_count?: number;
  owner_trail?: string[];
  gates?: BrickGate[];
  clone_command?: string;
};

export function brickTrust(status: string): BrickTrust {
  if (status === "canonical" || status === "verified") return status;
  return "candidate";
}

export function brickSize(reuseCount = 0): "s" | "m" | "l" {
  if (reuseCount >= 10) return "l";
  if (reuseCount >= 4) return "m";
  return "s";
}

export function brickOwners(brick: BrickRecord): string[] {
  return brick.owner_trail?.length ? brick.owner_trail : [brick.project];
}

export function brickGates(brick: BrickRecord): BrickGate[] {
  if (brick.gates?.length) return brick.gates;
  return [{ id: "health", label: "", verdict: brick.health_status === "ok" ? "pass" : "fail" }];
}

export function brickCloneCommand(brick: BrickRecord): string {
  return brick.clone_command ?? `npx sma clone ${brick.id}`;
}
